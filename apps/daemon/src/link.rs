//! This machine's relationship with a Hub.
//!
//! Pairing has to work while the daemon is running, not only at startup: the
//! user pairs from the app they already have open, and the uplink must come up
//! right then rather than after a restart nobody told them to do. So the
//! enrollment lives here, behind a lock, together with the uplink it owns.

use std::sync::{Arc, Weak};

use anyhow::Result;
use genehub_proto::{HubMachine, HubStatus, HubTicket, ServerFrame};
use tokio::sync::{broadcast, Mutex};

use crate::config::{Enrollment, Paths};
use crate::hub;
use crate::state::AppState;
use crate::transport::uplink::{Admission, Uplink};

enum Stage {
    Unpaired,
    Pairing {
        hub_url: String,
        code: hub::PairingCode,
        /// Aborted if a second pairing starts before this one finishes.
        task: tokio::task::JoinHandle<()>,
    },
    Paired {
        enrollment: Enrollment,
        uplink: Uplink,
        catalog_sync: CatalogSync,
    },
    /// Kept until the next attempt, so the reason stays on screen rather than
    /// reverting to "unpaired" as if nothing had happened.
    Failed {
        hub_url: String,
        message: String,
    },
}

struct CatalogSync {
    task: tokio::task::JoinHandle<()>,
}

impl CatalogSync {
    fn stop(&self) {
        self.task.abort();
    }
}

pub struct Link {
    stage: Mutex<Stage>,
    /// Terminal output has to reach relayed clients too, so the uplink needs
    /// the same fanout the local listener uses.
    pty: broadcast::Sender<ServerFrame>,
    /// Weak, because the state owns this link: an `Arc` both ways would keep
    /// the whole daemon alive after shutdown.
    state: Weak<AppState>,
}

pub type SharedLink = Arc<Link>;

impl Link {
    pub fn new(_paths: Paths, pty: broadcast::Sender<ServerFrame>) -> SharedLink {
        Arc::new(Link {
            stage: Mutex::new(Stage::Unpaired),
            pty,
            state: Weak::new(),
        })
    }

    /// Called once the state exists, since the uplink needs it to serve
    /// requests. Dials the Hub straight away if this machine is already
    /// enrolled; an unenrolled machine is simply local-only, which is a
    /// perfectly good way to use the product.
    pub async fn attach(self: &mut Arc<Self>, state: &Arc<AppState>) {
        let link = Arc::get_mut(self).expect("attach happens before the link is shared");
        link.state = Arc::downgrade(state);

        if let Some(enrollment) = state.machine.enrollment.clone() {
            let uplink = dial(state, &link.pty, &enrollment);
            let catalog_sync = start_catalog_sync(state, &enrollment);
            *link.stage.lock().await = Stage::Paired {
                enrollment,
                uplink,
                catalog_sync,
            };
        }
    }

    pub async fn status(&self) -> HubStatus {
        match &*self.stage.lock().await {
            Stage::Unpaired => HubStatus::Unpaired,
            Stage::Pairing { hub_url, code, .. } => pairing_status(hub_url, code),
            Stage::Paired {
                enrollment, uplink, ..
            } => HubStatus::Paired {
                hub_url: enrollment.hub_url.clone(),
                machine_id: enrollment.machine_id.clone(),
                online: uplink.is_online(),
            },
            Stage::Failed { hub_url, message } => HubStatus::Failed {
                hub_url: hub_url.clone(),
                message: message.clone(),
            },
        }
    }

    /// Asks the Hub for a code and returns as soon as there is one to show.
    ///
    /// Approval happens in someone's browser and can take minutes, so the wait
    /// runs in the background: the caller gets the code immediately and watches
    /// `status` for the rest.
    pub async fn pair(
        self: &Arc<Self>,
        hub_url: &str,
        display_name: Option<String>,
    ) -> Result<HubStatus> {
        let (status, _) = self.start(hub_url, display_name, false).await?;
        Ok(status)
    }

    /// Pairs without anyone approving anything: the Hub mints a temporary
    /// identity and approves this machine in the same breath.
    ///
    /// Returns the way back into that identity — a one-time link to open in a
    /// browser, and a recovery key. Nothing else knows them, so a caller that
    /// drops them has thrown away the only ways in.
    pub async fn trial(
        self: &Arc<Self>,
        hub_url: &str,
        display_name: Option<String>,
    ) -> Result<(HubStatus, hub::Trial)> {
        let (status, trial) = self.start(hub_url, display_name, true).await?;
        let trial = trial.ok_or_else(|| anyhow::anyhow!("the Hub started no trial"))?;
        Ok((status, trial))
    }

    /// A fresh link into this machine's owner, for showing as a QR code.
    pub async fn claim_link(&self) -> Result<hub::Trial> {
        match &*self.stage.lock().await {
            Stage::Paired { enrollment, .. } => {
                hub::Client::new(&enrollment.hub_url)
                    .claim_link(enrollment)
                    .await
            }
            // Worth spelling out: this is what the tray's "mint another link"
            // hits on a machine that was never connected to a Hub, and the
            // message is the only thing the user will see.
            _ => anyhow::bail!("这台机器还没有连到 Hub，没有可分享的身份；先在设置里连一个"),
        }
    }

    /// The owner's other machines, so a client can offer to switch to one.
    ///
    /// An empty list for a machine with no Hub, rather than an error: "nowhere
    /// else to go" is the truth on a self-hosted machine, and a switcher that
    /// refuses to draw is not an improvement over one with a single entry.
    pub async fn machines(&self) -> Result<Vec<HubMachine>> {
        match &*self.stage.lock().await {
            Stage::Paired { enrollment, .. } => {
                hub::Client::new(&enrollment.hub_url)
                    .machines(enrollment)
                    .await
            }
            _ => Ok(Vec::new()),
        }
    }

    /// A one-time address for reaching one of them.
    pub async fn connect(&self, machine_id: &str) -> Result<HubTicket> {
        match &*self.stage.lock().await {
            Stage::Paired { enrollment, .. } => {
                hub::Client::new(&enrollment.hub_url)
                    .ticket(enrollment, machine_id)
                    .await
            }
            _ => anyhow::bail!("这台机器还没有连到 Hub，没法替你去连别的机器"),
        }
    }

    async fn start(
        self: &Arc<Self>,
        hub_url: &str,
        display_name: Option<String>,
        trial: bool,
    ) -> Result<(HubStatus, Option<hub::Trial>)> {
        if let Stage::Paired { enrollment, .. } = &*self.stage.lock().await {
            anyhow::bail!(
                "this machine is already paired with {}; unpair first",
                enrollment.hub_url
            );
        }

        let client = hub::Client::new(hub_url);
        let name = display_name.unwrap_or_else(default_display_name);
        let code = client.start_pairing(&name).await?;
        // Claimed before the waiting starts, so a failure here is reported to
        // the caller rather than disappearing into a background task.
        let claimed = match trial {
            true => Some(client.claim_trial(&code).await?),
            false => None,
        };

        // Nobody has to approve a trial — the Hub already did, in the call
        // above — so there is nothing to wait for in the background. Finishing
        // here is what makes the difference between handing back a machine that
        // is paired and handing back a screen that asks for a code no one will
        // ever type. It also means a failed enrollment is reported to the caller
        // instead of leaving the machine stuck half-paired.
        if let Some(claim) = claimed {
            let outcome = self.complete(&client, &code).await;
            self.settle(hub_url, outcome).await;
            return Ok((self.status().await, Some(claim)));
        }

        let task = tokio::spawn({
            let link = self.clone();
            let hub_url = hub_url.to_string();
            let code = code.clone();
            async move {
                let outcome = link.complete(&client, &code).await;
                link.settle(&hub_url, outcome).await;
            }
        });

        let mut stage = self.stage.lock().await;
        let previous = std::mem::replace(
            &mut *stage,
            Stage::Pairing {
                hub_url: hub_url.to_string(),
                code: code.clone(),
                task,
            },
        );
        // A second attempt supersedes the first. Leaving both polling would let
        // the older one win a race and enroll under a code nobody is reading.
        if let Stage::Pairing { task, .. } = previous {
            task.abort();
        }

        Ok((pairing_status(hub_url, &code), claimed))
    }

    /// Waits for approval, enrolls, and persists the result.
    async fn complete(&self, client: &hub::Client, code: &hub::PairingCode) -> Result<Enrollment> {
        let token = client.await_approval(code).await?;
        let state = self.state()?;
        let enrollment = client
            .enroll(
                &token,
                &state.machine.machine_id,
                &state.machine.fingerprint(),
            )
            .await?;

        state
            .mutate_machine_state(|machine| {
                machine.enrollment = Some(enrollment.clone());
                Ok(())
            })
            .await?;
        Ok(enrollment)
    }

    async fn settle(&self, hub_url: &str, outcome: Result<Enrollment>) {
        let mut stage = self.stage.lock().await;
        match outcome {
            Ok(enrollment) => match self.state() {
                Ok(state) => {
                    tracing::info!("paired with {}", enrollment.hub_url);
                    *stage = Stage::Paired {
                        uplink: dial(&state, &self.pty, &enrollment),
                        catalog_sync: start_catalog_sync(&state, &enrollment),
                        enrollment,
                    };
                }
                Err(error) => {
                    *stage = Stage::Failed {
                        hub_url: hub_url.to_string(),
                        message: format!("{error:#}"),
                    }
                }
            },
            Err(error) => {
                tracing::warn!("pairing failed: {error:#}");
                *stage = Stage::Failed {
                    hub_url: hub_url.to_string(),
                    message: format!("{error:#}"),
                };
            }
        }
    }

    /// Forgets the Hub.
    ///
    /// Best effort on the Hub's side: a machine that cannot reach the Hub must
    /// still be able to stop talking to it, so a failed call there does not
    /// keep the enrollment on disk.
    pub async fn unpair(&self) -> Result<()> {
        let previous = std::mem::replace(&mut *self.stage.lock().await, Stage::Unpaired);
        match previous {
            Stage::Paired {
                enrollment,
                uplink,
                catalog_sync,
            } => {
                uplink.stop();
                catalog_sync.stop();
                if let Err(error) = hub::Client::new(&enrollment.hub_url)
                    .unenroll(&enrollment)
                    .await
                {
                    tracing::warn!("the Hub was not told about the unpair: {error:#}");
                }
                self.forget().await?;
            }
            Stage::Pairing { task, .. } => task.abort(),
            _ => {}
        }
        Ok(())
    }

    /// Drops the outbound connection without forgetting the enrollment.
    pub async fn stop(&self) {
        match &*self.stage.lock().await {
            Stage::Paired {
                uplink,
                catalog_sync,
                ..
            } => {
                uplink.stop();
                catalog_sync.stop();
            }
            Stage::Pairing { task, .. } => task.abort(),
            _ => {}
        }
    }

    async fn forget(&self) -> Result<()> {
        self.state()?
            .mutate_machine_state(|machine| {
                machine.enrollment = None;
                Ok(())
            })
            .await
    }

    fn state(&self) -> Result<Arc<AppState>> {
        self.state
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("the daemon is shutting down"))
    }
}

/// Keeps Hub discovery current without giving every workspace mutation a
/// network dependency. Only a changed revision is uploaded; failures retry and
/// never prevent the local daemon from serving the workspace.
fn start_catalog_sync(state: &Arc<AppState>, enrollment: &Enrollment) -> CatalogSync {
    let weak_state = Arc::downgrade(state);
    let enrollment = enrollment.clone();
    let task = tokio::spawn(async move {
        let client = hub::Client::new(&enrollment.hub_url);
        let mut published: Option<(String, u64)> = None;
        let mut acknowledged_generation = enrollment.workspace_catalog_generation.clone();
        let mut retry_seconds = 5u64;
        loop {
            let Some(state) = weak_state.upgrade() else {
                return;
            };
            let catalog = state.workspaces.catalog().await;
            let version = (catalog.generation.clone(), catalog.revision);
            let changed = published.as_ref() != Some(&version);
            drop(state);

            let delay = if changed {
                match sync_catalog_version(
                    &client,
                    &weak_state,
                    &enrollment,
                    &catalog,
                    &mut acknowledged_generation,
                    &mut published,
                )
                .await
                {
                    Ok(()) => {
                        retry_seconds = 5;
                        std::time::Duration::from_secs(30)
                    }
                    Err(error) => {
                        if weak_state.upgrade().is_none() {
                            return;
                        }
                        tracing::warn!(
                            %error,
                            "workspace catalogue was not published and durably acknowledged"
                        );
                        let delay = std::time::Duration::from_secs(retry_seconds);
                        retry_seconds = (retry_seconds * 2).min(300);
                        delay
                    }
                }
            } else {
                std::time::Duration::from_secs(30)
            };
            tokio::time::sleep(delay).await;
        }
    });
    CatalogSync { task }
}

/// Uploads one catalogue version and advances both local cursors only after
/// the Hub acknowledgement is durable.
///
/// A successful PUT followed by a failed `state.json` save is deliberately an
/// error. Keeping both cursors unchanged makes the outer loop replay the same
/// generation. Hub catalogue PUTs are idempotent for that case, so the replay
/// also recovers after a process restart whose durable cursor is still old.
async fn sync_catalog_version(
    client: &hub::Client,
    weak_state: &Weak<AppState>,
    enrollment: &Enrollment,
    catalog: &crate::workspace::WorkspaceCatalog,
    acknowledged_generation: &mut Option<String>,
    published: &mut Option<(String, u64)>,
) -> Result<()> {
    let replaces_generation = acknowledged_generation
        .as_deref()
        .filter(|generation| *generation != catalog.generation);
    client
        .sync_workspace_catalog(enrollment, catalog, replaces_generation)
        .await?;

    if acknowledged_generation.as_deref() != Some(&catalog.generation) {
        let state = weak_state
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("the daemon is shutting down"))?;
        remember_catalog_generation(&state, enrollment, &catalog.generation).await?;
    }

    *acknowledged_generation = Some(catalog.generation.clone());
    *published = Some((catalog.generation.clone(), catalog.revision));
    Ok(())
}

/// Persists the catalogue CAS cursor without letting a stale background task
/// overwrite a newer enrollment created while its HTTP request was in flight.
async fn remember_catalog_generation(
    state: &AppState,
    expected: &Enrollment,
    generation: &str,
) -> Result<()> {
    state
        .mutate_machine_state(|machine| set_catalog_generation(machine, expected, generation))
        .await
}

fn set_catalog_generation(
    machine: &mut crate::config::MachineState,
    expected: &Enrollment,
    generation: &str,
) -> Result<()> {
    let enrollment = machine
        .enrollment
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("the Hub enrollment was removed"))?;
    if enrollment.hub_url != expected.hub_url
        || enrollment.machine_id != expected.machine_id
        || enrollment.daemon_id != expected.daemon_id
        || enrollment.secret != expected.secret
    {
        anyhow::bail!("the Hub enrollment changed while publishing the catalogue");
    }
    enrollment.workspace_catalog_generation = Some(generation.to_string());
    Ok(())
}

fn pairing_status(hub_url: &str, code: &hub::PairingCode) -> HubStatus {
    HubStatus::Pairing {
        hub_url: hub_url.to_string(),
        user_code: code.user_code.clone(),
        verification_uri: code.verification_uri.clone(),
        verification_uri_complete: code.verification_uri_complete.clone(),
        expires_at: code.expires_at.clone(),
    }
}

fn dial(
    state: &Arc<AppState>,
    pty: &broadcast::Sender<ServerFrame>,
    enrollment: &Enrollment,
) -> Uplink {
    Uplink::start(
        state.clone(),
        pty.clone(),
        enrollment.uplink_url.clone(),
        enrollment.ticket(),
        // The Hub only opens a channel for a client it already authorized, so
        // this path does not ask for a device credential on top.
        Admission::Vouched,
    )
}

/// What the owner will see this machine called in their list.
pub fn default_display_name() -> String {
    std::env::var(crate::channel::ENV_MACHINE_NAME)
        .ok()
        .or_else(hostname)
        .unwrap_or_else(|| crate::channel::DEFAULT_MACHINE_NAME.to_string())
}

fn hostname() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MachineState;

    fn enrollment(generation: Option<&str>) -> Enrollment {
        Enrollment {
            hub_url: "https://hub.example/subpath".into(),
            machine_id: "machine-row".into(),
            uplink_url: "wss://relay.example/forward/daemon".into(),
            fabric_url: Some("wss://relay.example/fabric/v2".into()),
            daemon_id: "daemon-stable".into(),
            secret: "node-secret".into(),
            workspace_catalog_generation: generation.map(str::to_string),
        }
    }

    fn link() -> SharedLink {
        let dir = tempfile::tempdir().unwrap();
        let (pty, _) = broadcast::channel(4);
        Link::new(Paths::new(dir.keep()), pty)
    }

    #[tokio::test]
    async fn a_fresh_machine_reports_no_hub_rather_than_an_error() {
        assert!(matches!(link().status().await, HubStatus::Unpaired));
    }

    #[tokio::test]
    async fn a_hub_that_cannot_be_reached_fails_the_call_instead_of_hanging() {
        // Port 1 is not a Hub, and connecting to it fails immediately.
        let error = link()
            .pair("http://127.0.0.1:1", Some("test".into()))
            .await
            .expect_err("pairing should fail");
        assert!(format!("{error:#}").contains("pairing code"));
    }

    #[tokio::test]
    async fn unpairing_a_machine_that_was_never_paired_is_not_an_error() {
        link().unpair().await.unwrap();
    }

    #[test]
    fn catalog_acknowledgement_survives_config_recreation_without_crossing_enrollments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let expected = enrollment(Some("wcg_old"));
        MachineState {
            machine_id: "local-machine".into(),
            secret: "local-secret".into(),
            enrollment: Some(expected.clone()),
            rendezvous: None,
        }
        .save(&path)
        .unwrap();

        let mut state = MachineState::load(&path).unwrap();
        set_catalog_generation(&mut state, &expected, "wcg_new").unwrap();
        state.save(&path).unwrap();
        let persisted = MachineState::load_or_create(&path).unwrap();
        assert_eq!(
            persisted
                .enrollment
                .as_ref()
                .and_then(|value| value.workspace_catalog_generation.as_deref()),
            Some("wcg_new")
        );

        let stale = enrollment(Some("wcg_old"));
        let mut replacement = enrollment(Some("wcg_other"));
        replacement.secret = "rotated-secret".into();
        let mut state = persisted;
        state.enrollment = Some(replacement);
        state.save(&path).unwrap();
        let mut state = MachineState::load(&path).unwrap();
        assert!(set_catalog_generation(&mut state, &stale, "wcg_stale").is_err());
        assert_eq!(
            MachineState::load_or_create(&path)
                .unwrap()
                .enrollment
                .unwrap()
                .workspace_catalog_generation
                .as_deref(),
            Some("wcg_other"),
            "a stale publisher must not overwrite a rotated enrollment"
        );
    }

    #[tokio::test]
    async fn catalog_upload_retries_until_its_acknowledgement_is_durable() {
        let (hub_url, mut requests) = fake_catalog_hub(3).await;
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_path_buf());
        let state_path = paths.state_file();
        let mut expected = enrollment(Some("wcg_previous"));
        expected.hub_url = hub_url.clone();
        MachineState {
            machine_id: "local-machine".into(),
            secret: "local-secret".into(),
            enrollment: Some(expected.clone()),
            rendezvous: None,
        }
        .save(&state_path)
        .unwrap();
        let (state, _) = AppState::build(paths.clone()).await.unwrap();
        let weak_state = Arc::downgrade(&state);
        let client = hub::Client::new(&hub_url);
        let catalog = state.workspaces.catalog().await;
        let version = (catalog.generation.clone(), catalog.revision);
        let mut acknowledged_generation = Some("wcg_previous".to_string());
        let mut published = None;

        // MachineState::save writes this temporary sibling before renaming it.
        // A directory at that exact path reliably simulates a failed durable
        // write even when the tests run as root.
        let save_blocker = state_path.with_extension("json.tmp");
        std::fs::create_dir(&save_blocker).unwrap();
        sync_catalog_version(
            &client,
            &weak_state,
            &expected,
            &catalog,
            &mut acknowledged_generation,
            &mut published,
        )
        .await
        .expect_err("the successful PUT must not hide a failed cursor save");

        assert_eq!(acknowledged_generation.as_deref(), Some("wcg_previous"));
        assert_eq!(published, None);
        assert_eq!(
            MachineState::load(&state_path)
                .unwrap()
                .enrollment
                .unwrap()
                .workspace_catalog_generation
                .as_deref(),
            Some("wcg_previous")
        );
        let first = requests.recv().await.unwrap();
        assert_eq!(first["generation"], catalog.generation);
        assert_eq!(first["replacesGeneration"], "wcg_previous");

        // The outer sync loop sees `published == None` and retries. The fake
        // Hub has already advanced to the incoming generation, just like the
        // real idempotent endpoint, and accepts this replay instead of wedging
        // the daemon behind a permanent generation-conflict response.
        std::fs::remove_dir(&save_blocker).unwrap();
        sync_catalog_version(
            &client,
            &weak_state,
            &expected,
            &catalog,
            &mut acknowledged_generation,
            &mut published,
        )
        .await
        .unwrap();
        assert_eq!(
            acknowledged_generation.as_deref(),
            Some(&*catalog.generation)
        );
        assert_eq!(published.as_ref(), Some(&version));
        assert_eq!(
            MachineState::load(&state_path)
                .unwrap()
                .enrollment
                .unwrap()
                .workspace_catalog_generation
                .as_deref(),
            Some(&*catalog.generation)
        );
        let replay = requests.recv().await.unwrap();
        assert_eq!(replay["generation"], catalog.generation);
        assert_eq!(replay["replacesGeneration"], "wcg_previous");

        // A restarted publisher takes its CAS cursor from state.json. It may
        // harmlessly republish the current snapshot, but no longer claims to
        // replace the old generation.
        let restarted = MachineState::load(&state_path).unwrap().enrollment.unwrap();
        let mut restarted_acknowledgement = restarted.workspace_catalog_generation.clone();
        let mut restarted_published = None;
        sync_catalog_version(
            &client,
            &weak_state,
            &restarted,
            &catalog,
            &mut restarted_acknowledgement,
            &mut restarted_published,
        )
        .await
        .unwrap();
        let after_restart = requests.recv().await.unwrap();
        assert_eq!(after_restart["generation"], catalog.generation);
        assert!(after_restart.get("replacesGeneration").is_none());
    }

    #[tokio::test]
    async fn a_trial_comes_back_with_the_only_ways_into_the_identity() {
        let hub = fake_hub().await;
        let (status, trial) = link()
            .trial(&hub, Some("测试机".into()))
            .await
            .expect("the trial should start");

        // Nothing on this machine keeps a copy, so a caller that drops these
        // has thrown away the identity. They have to come back with the call —
        // and they do even though enrolling cannot finish here, because this
        // `Link` has no daemon behind it. That is the property worth pinning:
        // the way back in must survive a failed enrollment, or someone ends up
        // with an identity they cannot reach and a machine that is not in it.
        assert_eq!(trial.claim_url, "http://hub.test/link/abc");
        assert_eq!(trial.recovery_key.as_deref(), Some("rk-1"));

        // And nobody is left staring at a code to type: a trial was approved by
        // the Hub in the same breath as it was asked for.
        assert!(
            !matches!(status, HubStatus::Pairing { .. }),
            "a trial has nothing for anyone to approve, so it must not ask"
        );
    }

    #[tokio::test]
    async fn a_hub_that_refuses_the_trial_fails_the_call_rather_than_pairing_anyway() {
        let hub = fake_hub_refusing_trials().await;
        let error = link()
            .trial(&hub, Some("测试机".into()))
            .await
            .expect_err("the trial should fail");
        assert!(format!("{error:#}").contains("trial"));
    }

    /// A Hub that answers the two calls a trial makes, and nothing else.
    ///
    /// Hand-rolled rather than mocked: what is being checked is that the daemon
    /// reads a real HTTP reply the way the control plane writes one.
    async fn fake_hub() -> String {
        serve(|path| match path {
            "/api/device-authorizations" => Some(
                r#"{"deviceCode":"dc","userCode":"AAAA-BBBB","verificationUri":"http://hub.test/activate","verificationUriComplete":"http://hub.test/activate?code=AAAA-BBBB","expiresAt":"2030-01-01T00:00:00Z","interval":5}"#,
            ),
            "/api/trial" => Some(
                r#"{"claimUrl":"http://hub.test/link/abc","recoveryKey":"rk-1","expiresAt":"2030-01-01T00:00:00Z"}"#,
            ),
            _ => None,
        })
        .await
    }

    async fn fake_hub_refusing_trials() -> String {
        serve(|path| match path {
            "/api/device-authorizations" => Some(
                r#"{"deviceCode":"dc","userCode":"AAAA-BBBB","verificationUri":"http://hub.test/activate","verificationUriComplete":"http://hub.test/activate?code=AAAA-BBBB","expiresAt":"2030-01-01T00:00:00Z","interval":5}"#,
            ),
            _ => None,
        })
        .await
    }

    /// A strict but idempotent catalogue endpoint: replacing a different
    /// generation needs the current cursor, while replaying the already
    /// applied generation succeeds regardless of an old replacement cursor.
    async fn fake_catalog_hub(
        request_count: usize,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (requests_tx, requests_rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut current_generation = "wcg_previous".to_string();
            for _ in 0..request_count {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = vec![0u8; 4096];
                let mut used = 0usize;
                let (header_end, content_length) = loop {
                    if used == buffer.len() {
                        buffer.resize(buffer.len() * 2, 0);
                    }
                    let read = socket.read(&mut buffer[used..]).await.unwrap();
                    assert!(read > 0, "catalogue request ended before its body");
                    used += read;
                    let request = String::from_utf8_lossy(&buffer[..used]);
                    let Some(end) = request.find("\r\n\r\n") else {
                        continue;
                    };
                    let length = request[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if used >= end + 4 + length {
                        break (end, length);
                    }
                };
                let body = &buffer[header_end + 4..header_end + 4 + content_length];
                let json: serde_json::Value = serde_json::from_slice(body).unwrap();
                let incoming = json["generation"].as_str().unwrap();
                let replacement = json
                    .get("replacesGeneration")
                    .and_then(serde_json::Value::as_str);
                let accepted = incoming == current_generation
                    || replacement == Some(current_generation.as_str());
                if accepted {
                    current_generation = incoming.to_string();
                }
                requests_tx.send(json).unwrap();
                let status = if accepted {
                    "204 No Content"
                } else {
                    "409 Conflict"
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        (origin, requests_rx)
    }

    async fn serve(answer: fn(&str) -> Option<&'static str>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buffer = [0u8; 2048];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let path = request
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                let response = match answer(&path) {
                    Some(body) => format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                    None => "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string(),
                };
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        origin
    }
}
