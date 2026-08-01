//! Being reachable from outside without anyone's permission but your own.
//!
//! The machine dials a relay and waits at a rendezvous slot. The relay matches
//! whoever asks for that slot with this connection and stops there — it is not
//! asked whether the client should be allowed in, because it could not answer:
//! the authorized-devices list is on this machine (`crate::devices`).
//!
//! This is the whole of what a self-hosted deployment needs. No control plane,
//! no database, no account.

use std::sync::{Arc, Weak};

use anyhow::{anyhow, Result};
use genehub_proto::{RemoteAccess, ServerFrame};
use tokio::sync::{broadcast, Mutex};

use crate::config::{MachineState, Paths, Rendezvous};
use crate::devices::rendezvous_id;
use crate::state::AppState;
use crate::transport::uplink::{Admission, Uplink};

pub struct Remote {
    attached: Mutex<Option<Attached>>,
    paths: Paths,
    pty: broadcast::Sender<ServerFrame>,
    /// Weak for the same reason the Hub link's is: the state owns this.
    state: Weak<AppState>,
}

struct Attached {
    config: Rendezvous,
    uplink: Uplink,
}

pub type SharedRemote = Arc<Remote>;

impl Remote {
    pub fn new(paths: Paths, pty: broadcast::Sender<ServerFrame>) -> SharedRemote {
        Arc::new(Remote {
            attached: Mutex::new(None),
            paths,
            pty,
            state: Weak::new(),
        })
    }

    /// Dials straight away if this machine was already attached before the
    /// last restart. Remote access is a setting, not a session.
    pub async fn attach(self: &mut Arc<Self>, state: &Arc<AppState>) {
        let remote = Arc::get_mut(self).expect("attach happens before the remote is shared");
        remote.state = Arc::downgrade(state);
        if let Some(config) = state.machine.rendezvous.clone() {
            let uplink = dial(state, &remote.pty, &config, &state.machine);
            *remote.attached.lock().await = Some(Attached { config, uplink });
        }
    }

    pub async fn status(&self) -> RemoteAccess {
        match &*self.attached.lock().await {
            None => RemoteAccess {
                relay_url: None,
                rendezvous_url: None,
                online: false,
            },
            Some(attached) => {
                let id = self
                    .state
                    .upgrade()
                    .map(|state| rendezvous_id(&state.machine.machine_id, &state.machine.secret));
                RemoteAccess {
                    relay_url: Some(attached.config.relay_url.clone()),
                    rendezvous_url: id
                        .map(|id| client_url(&attached.config.relay_url, &id))
                        .transpose()
                        .ok()
                        .flatten(),
                    online: attached.uplink.is_online(),
                }
            }
        }
    }

    pub async fn set(&self, relay_url: &str, join_token: Option<String>) -> Result<RemoteAccess> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("the daemon is shutting down"))?;
        let relay_url = relay_url.trim().trim_end_matches('/').to_string();
        // Fail before persisting: a stored address nobody can build a URL from
        // would come back every restart and fail again just as quietly.
        let id = rendezvous_id(&state.machine.machine_id, &state.machine.secret);
        client_url(&relay_url, &id)?;

        let config = Rendezvous {
            relay_url,
            join_token,
        };
        let mut attached = self.attached.lock().await;
        if let Some(previous) = attached.take() {
            previous.uplink.stop();
        }
        let uplink = dial(&state, &self.pty, &config, &state.machine);
        *attached = Some(Attached {
            config: config.clone(),
            uplink,
        });
        drop(attached);

        self.persist(Some(config))?;
        Ok(self.status().await)
    }

    /// Stops being reachable from outside. Authorized devices stay authorized:
    /// turning the door off is not the same as changing the locks.
    pub async fn clear(&self) -> Result<RemoteAccess> {
        if let Some(previous) = self.attached.lock().await.take() {
            previous.uplink.stop();
        }
        self.persist(None)?;
        Ok(self.status().await)
    }

    /// Drops the connection without forgetting the setting.
    pub async fn stop(&self) {
        if let Some(attached) = &*self.attached.lock().await {
            attached.uplink.stop();
        }
    }

    fn persist(&self, config: Option<Rendezvous>) -> Result<()> {
        let path = self.paths.state_file();
        let mut machine = MachineState::load_or_create(&path)?;
        machine.rendezvous = config;
        machine.save(&path)
    }
}

fn dial(
    state: &Arc<AppState>,
    pty: &broadcast::Sender<ServerFrame>,
    config: &Rendezvous,
    machine: &MachineState,
) -> Uplink {
    let id = rendezvous_id(&machine.machine_id, &machine.secret);
    let ticket = match &config.join_token {
        Some(token) if !token.is_empty() => format!("{token}.{id}"),
        _ => id.clone(),
    };
    Uplink::start(
        state.clone(),
        pty.clone(),
        daemon_url(&config.relay_url).unwrap_or_default(),
        ticket,
        // Nobody vouched for the clients arriving here, so each one has to
        // present a credential this machine issued.
        Admission::DeviceRequired,
    )
}

/// Where the machine hangs its uplink.
pub fn daemon_url(relay_url: &str) -> Result<String> {
    Ok(format!("{}/forward/daemon", websocket_base(relay_url)?))
}

/// Where a client goes to meet this machine.
pub fn client_url(relay_url: &str, rendezvous: &str) -> Result<String> {
    Ok(format!(
        "{}/forward/client?ticket={rendezvous}",
        websocket_base(relay_url)?
    ))
}

/// Accepts what a human would type. `https://relay.example.com` and
/// `wss://relay.example.com` mean the same thing here, and refusing one of them
/// would only teach people to guess.
fn websocket_base(relay_url: &str) -> Result<String> {
    let trimmed = relay_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(anyhow!("a relay address is required"));
    }
    let converted = match trimmed.split_once("://") {
        Some(("http", rest)) => format!("ws://{rest}"),
        Some(("https", rest)) => format!("wss://{rest}"),
        Some(("ws" | "wss", _)) => trimmed.to_string(),
        Some((scheme, _)) => return Err(anyhow!("{scheme} is not an address this can dial")),
        None => format!("wss://{trimmed}"),
    };
    Ok(converted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_host_is_assumed_to_be_encrypted() {
        assert_eq!(
            daemon_url("relay.example.com").unwrap(),
            "wss://relay.example.com/forward/daemon"
        );
    }

    #[test]
    fn http_and_https_are_accepted_and_converted() {
        assert_eq!(
            daemon_url("http://127.0.0.1:8787").unwrap(),
            "ws://127.0.0.1:8787/forward/daemon"
        );
        assert_eq!(
            daemon_url("https://relay.example.com/").unwrap(),
            "wss://relay.example.com/forward/daemon"
        );
        assert_eq!(
            daemon_url("http://myteam.devcloud.woa.com/dev-0").unwrap(),
            "ws://myteam.devcloud.woa.com/dev-0/forward/daemon"
        );
    }

    #[test]
    fn the_client_url_carries_the_rendezvous_as_its_ticket() {
        assert_eq!(
            client_url("ws://127.0.0.1:8787", "abc123").unwrap(),
            "ws://127.0.0.1:8787/forward/client?ticket=abc123"
        );
    }

    #[test]
    fn an_address_that_cannot_be_dialed_is_refused_rather_than_guessed_at() {
        assert!(daemon_url("").is_err());
        assert!(daemon_url("ftp://relay.example.com").is_err());
    }
}
