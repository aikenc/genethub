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
        if let Stage::Paired { enrollment, .. } = &*self.stage.lock().await {
            anyhow::bail!(
                "this machine is already paired with {}; unpair first",
                enrollment.hub_url
            );
        }

        let client = hub::Client::new(hub_url);
        let name = display_name.unwrap_or_else(default_display_name);
        let code = client.start_pairing(&name).await?;

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

        Ok(pairing_status(hub_url, &code))
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
}
