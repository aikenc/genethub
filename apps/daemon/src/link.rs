//! This machine's relationship with a Hub.
//!
//! Pairing has to work while the daemon is running, not only at startup: the
//! user pairs from the app they already have open, and the uplink must come up
//! right then rather than after a restart nobody told them to do. So the
//! enrollment lives here, behind a lock, together with the uplink it owns.

use std::sync::{Arc, Weak};

use anyhow::Result;
use genehub_proto::{HubStatus, ServerFrame};
use tokio::sync::{broadcast, Mutex};

use crate::config::{Enrollment, MachineState, Paths};
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
    },
    /// Kept until the next attempt, so the reason stays on screen rather than
    /// reverting to "unpaired" as if nothing had happened.
    Failed {
        hub_url: String,
        message: String,
    },
}

pub struct Link {
    stage: Mutex<Stage>,
    paths: Paths,
    /// Terminal output has to reach relayed clients too, so the uplink needs
    /// the same fanout the local listener uses.
    pty: broadcast::Sender<ServerFrame>,
    /// Weak, because the state owns this link: an `Arc` both ways would keep
    /// the whole daemon alive after shutdown.
    state: Weak<AppState>,
}

pub type SharedLink = Arc<Link>;

impl Link {
    pub fn new(paths: Paths, pty: broadcast::Sender<ServerFrame>) -> SharedLink {
        Arc::new(Link {
            stage: Mutex::new(Stage::Unpaired),
            paths,
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
            *link.stage.lock().await = Stage::Paired { enrollment, uplink };
        }
    }

    pub async fn status(&self) -> HubStatus {
        match &*self.stage.lock().await {
            Stage::Unpaired => HubStatus::Unpaired,
            Stage::Pairing { hub_url, code, .. } => pairing_status(hub_url, code),
            Stage::Paired { enrollment, uplink } => HubStatus::Paired {
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

        let path = self.paths.state_file();
        let mut machine = MachineState::load_or_create(&path)?;
        machine.enrollment = Some(enrollment.clone());
        machine.save(&path)?;
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
            Stage::Paired { enrollment, uplink } => {
                uplink.stop();
                if let Err(error) = hub::Client::new(&enrollment.hub_url)
                    .unenroll(&enrollment)
                    .await
                {
                    tracing::warn!("the Hub was not told about the unpair: {error:#}");
                }
                self.forget()?;
            }
            Stage::Pairing { task, .. } => task.abort(),
            _ => {}
        }
        Ok(())
    }

    /// Drops the outbound connection without forgetting the enrollment.
    pub async fn stop(&self) {
        match &*self.stage.lock().await {
            Stage::Paired { uplink, .. } => uplink.stop(),
            Stage::Pairing { task, .. } => task.abort(),
            _ => {}
        }
    }

    fn forget(&self) -> Result<()> {
        let path = self.paths.state_file();
        let mut machine = MachineState::load_or_create(&path)?;
        machine.enrollment = None;
        machine.save(&path)
    }

    fn state(&self) -> Result<Arc<AppState>> {
        self.state
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("the daemon is shutting down"))
    }
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
    std::env::var("GENEHUB_MACHINE_NAME")
        .ok()
        .or_else(hostname)
        .unwrap_or_else(|| "GeneHub machine".to_string())
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
