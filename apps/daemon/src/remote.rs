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

use anyhow::{anyhow, Context, Result};
use genehub_proto::{RemoteAccess, ServerFrame};
use tokio::sync::{broadcast, Mutex};

use crate::config::{MachineState, Paths, Rendezvous};
use crate::devices::rendezvous_id;
use crate::state::AppState;
use crate::transport::fabric::FabricUplink;

pub struct Remote {
    attached: Mutex<Option<Attached>>,
    pty: broadcast::Sender<ServerFrame>,
    /// Weak for the same reason the Hub link's is: the state owns this.
    state: Weak<AppState>,
}

struct Attached {
    config: Rendezvous,
    uplink: FabricUplink,
}

pub type SharedRemote = Arc<Remote>;

impl Remote {
    pub fn new(_paths: Paths, pty: broadcast::Sender<ServerFrame>) -> SharedRemote {
        Arc::new(Remote {
            attached: Mutex::new(None),
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
        let join_token = join_token
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty());
        if join_token.as_deref().is_some_and(|token| {
            token.len() > 512 || !token.bytes().all(|byte| byte.is_ascii_graphic())
        }) {
            return Err(anyhow!(
                "the relay join token must be at most 512 visible ASCII characters"
            ));
        }
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

        self.persist(Some(config)).await?;
        Ok(self.status().await)
    }

    /// Stops being reachable from outside. Authorized devices stay authorized:
    /// turning the door off is not the same as changing the locks.
    pub async fn clear(&self) -> Result<RemoteAccess> {
        if let Some(previous) = self.attached.lock().await.take() {
            previous.uplink.stop();
        }
        self.persist(None).await?;
        Ok(self.status().await)
    }

    /// Drops the connection without forgetting the setting.
    pub async fn stop(&self) {
        if let Some(attached) = &*self.attached.lock().await {
            attached.uplink.stop();
        }
    }

    async fn persist(&self, config: Option<Rendezvous>) -> Result<()> {
        self.state
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("the daemon is shutting down"))?
            .mutate_machine_state(|machine| {
                machine.rendezvous = config;
                Ok(())
            })
            .await
    }
}

fn dial(
    state: &Arc<AppState>,
    pty: &broadcast::Sender<ServerFrame>,
    config: &Rendezvous,
    machine: &MachineState,
) -> FabricUplink {
    let id = rendezvous_id(&machine.machine_id, &machine.secret);
    let ticket = match &config.join_token {
        Some(token) if !token.is_empty() => format!("{token}.{id}"),
        _ => id.clone(),
    };
    let _ = pty;
    FabricUplink::start_rendezvous(
        state.clone(),
        daemon_url(&config.relay_url, &ticket).unwrap_or_default(),
    )
}

/// Where the machine hangs its uplink.
pub fn daemon_url(relay_url: &str, ticket: &str) -> Result<String> {
    fabric_url(relay_url, ticket, None)
}

/// Where a client goes to meet this machine.
pub fn client_url(relay_url: &str, rendezvous: &str) -> Result<String> {
    fabric_url(relay_url, &format!("client:{rendezvous}"), Some(rendezvous))
}

fn fabric_url(relay_url: &str, ticket: &str, route: Option<&str>) -> Result<String> {
    if ticket.is_empty() || ticket.len() > 1024 || route.is_some_and(|value| value.is_empty()) {
        return Err(anyhow!("invalid rendezvous Fabric ticket"));
    }
    let mut url = reqwest::Url::parse(&format!("{}/fabric/v2", websocket_base(relay_url)?))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("ticket", ticket);
        if let Some(route) = route {
            query.append_pair("route", route);
        }
    }
    Ok(url.to_string())
}

/// Accepts what a human would type. `https://relay.example.com` and
/// `wss://relay.example.com` mean the same thing here, and refusing one of them
/// would only teach people to guess.
fn websocket_base(relay_url: &str) -> Result<String> {
    let trimmed = relay_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(anyhow!("a relay address is required"));
    }
    let address = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("wss://{trimmed}")
    };
    let mut parsed = reqwest::Url::parse(&address).context("reading the relay address")?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(anyhow!(
            "the relay address cannot contain credentials, a query, or a fragment"
        ));
    }
    let loopback = parsed
        .host_str()
        .and_then(|host| {
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .ok()
        })
        .is_some_and(|address| address.is_loopback());
    let secure = match parsed.scheme() {
        "https" => {
            parsed.set_scheme("wss").expect("wss is a valid URL scheme");
            true
        }
        "wss" => true,
        "http" => {
            parsed.set_scheme("ws").expect("ws is a valid URL scheme");
            false
        }
        "ws" => false,
        scheme => return Err(anyhow!("{scheme} is not an address this can dial")),
    };
    if !secure && !loopback {
        return Err(anyhow!(
            "plaintext relay WebSockets are allowed only on 127.0.0.1 or [::1]; use https:// or wss://"
        ));
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_host_is_assumed_to_be_encrypted() {
        assert_eq!(
            daemon_url("relay.example.com", "slot").unwrap(),
            "wss://relay.example.com/fabric/v2?ticket=slot"
        );
    }

    #[test]
    fn loopback_http_and_public_https_are_accepted_and_converted() {
        assert_eq!(
            daemon_url("http://127.0.0.1:8787", "slot").unwrap(),
            "ws://127.0.0.1:8787/fabric/v2?ticket=slot"
        );
        assert_eq!(
            daemon_url("https://relay.example.com/", "slot").unwrap(),
            "wss://relay.example.com/fabric/v2?ticket=slot"
        );
        assert_eq!(
            daemon_url("http://[::1]:8787", "slot").unwrap(),
            "ws://[::1]:8787/fabric/v2?ticket=slot"
        );
        assert_eq!(
            daemon_url("http://127.42.0.9:8787", "slot").unwrap(),
            "ws://127.42.0.9:8787/fabric/v2?ticket=slot"
        );
    }

    #[test]
    fn plaintext_non_loopback_relay_addresses_fail_closed() {
        for address in [
            "http://myteam.devcloud.woa.com/relay-dev-0",
            "ws://relay.example.com",
            "http://10.0.0.2:8787",
            "http://172.16.1.2:8787",
            "http://192.168.1.20:8787",
            "http://localhost:8787",
            // A DNS name which currently resolves to loopback is not a stable
            // trust decision: its answer can be rebound after validation.
            "http://loopback.attacker.test:8787",
        ] {
            assert!(
                daemon_url(address, "slot").is_err(),
                "{address} was accepted"
            );
        }
    }

    #[test]
    fn relay_origins_cannot_smuggle_credentials_or_url_suffixes() {
        for address in [
            "wss://user:secret@relay.example.com",
            "wss://relay.example.com?token=secret",
            "wss://relay.example.com/#credential",
        ] {
            assert!(
                daemon_url(address, "slot").is_err(),
                "{address} was accepted"
            );
        }
    }

    #[tokio::test]
    async fn invalid_join_tokens_are_refused_before_they_enter_the_reconnect_loop() {
        let dir = tempfile::tempdir().unwrap();
        let paths = crate::config::Paths::new(dir.path());
        let state_path = paths.state_file();
        let (state, _pty_rx) = crate::AppState::build(paths).await.unwrap();
        let (pty, _) = broadcast::channel(1);
        let mut remote = Remote::new(crate::config::Paths::new(dir.path()), pty);
        remote.attach(&state).await;

        for token in [
            "line\nbreak".to_string(),
            "x".repeat(513),
            "秘密".to_string(),
        ] {
            assert!(remote
                .set("http://127.0.0.1:8787", Some(token))
                .await
                .is_err());
        }
        assert!(MachineState::load(&state_path)
            .unwrap()
            .rendezvous
            .is_none());
    }

    #[test]
    fn the_client_url_carries_the_rendezvous_as_its_ticket() {
        assert_eq!(
            client_url("ws://127.0.0.1:8787", "abc123").unwrap(),
            "ws://127.0.0.1:8787/fabric/v2?ticket=client%3Aabc123&route=abc123"
        );
    }

    #[test]
    fn an_address_that_cannot_be_dialed_is_refused_rather_than_guessed_at() {
        assert!(daemon_url("", "slot").is_err());
        assert!(daemon_url("ftp://relay.example.com", "slot").is_err());
    }
}
