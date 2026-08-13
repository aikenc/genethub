//! Who is allowed to reach this machine from outside.
//!
//! The list lives here, on the machine, in the shape `authorized_keys` has:
//! one line per device, revoked by deleting it. No server is consulted, which
//! is the point — a control plane that is down, or hostile, must not be able to
//! decide who gets in (`docs/security-model.md` §4).
//!
//! A device never sends its secret after the exchange that created it. Both
//! sides prove knowledge of it over a fresh nonce instead, so occupying the
//! rendezvous slot in front of a client buys nothing: the impostor cannot
//! answer, and the client refuses to go on.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use chrono::{DateTime, Duration, Utc};
use genehub_proto::{DeviceAuth, DeviceCredential, DeviceInfo, DeviceInvite, InviteAuth};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use crate::authz::GrantSet;
use crate::channel_auth::{self, SessionKey};

/// How long an invite is worth anything. Short because it is the one moment
/// this machine will talk to a stranger.
const INVITE_LIFETIME_MINUTES: i64 = 15;

/// How many recently used nonces to remember. Generous next to the handful of
/// connections a machine actually gets, and bounded so it cannot grow forever.
const NONCE_MEMORY: usize = 1024;
const MAX_INVITES: usize = 32;
const MAX_DEVICES: usize = 128;
const MAX_DEVICE_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    /// Stored in the clear, deliberately: this side has to compute its half of
    /// the mutual proof, which a hash of the secret cannot do. It sits in a
    /// 0600 file next to the machine identity, which is the same exposure.
    secret: String,
    paired_at: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
    /// What this device may ask for. Absent in files written before grants
    /// existed, which `GrantSet::default` reads as everything.
    #[serde(default)]
    grants: GrantSet,
}

/// Invites are not persisted. An invite means "right now I am waiting for a new
/// device"; surviving a restart would turn it into a standing offer.
struct Invite {
    id: String,
    secret: String,
    expires_at: DateTime<Utc>,
    /// Decided when the invitation is minted, not when it is redeemed. The
    /// device being paired does not get to say how much it is worth.
    grants: GrantSet,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    devices: Vec<Device>,
}

struct State {
    devices: Vec<Device>,
    invites: Vec<Invite>,
    seen_nonces: VecDeque<String>,
    connected: HashMap<String, usize>,
}

pub struct Devices {
    path: PathBuf,
    state: Mutex<State>,
    /// Carries the id of a device that just lost its authorization, so live
    /// connections can be dropped instead of surviving until they feel like
    /// reconnecting.
    revoked: broadcast::Sender<String>,
}

impl Devices {
    pub fn load(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let devices = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Persisted>(&raw).ok())
            .map(|file| file.devices)
            .unwrap_or_default()
            .into_iter()
            .take(MAX_DEVICES)
            .collect();
        let (revoked, _) = broadcast::channel(16);
        Devices {
            path,
            state: Mutex::new(State {
                devices,
                invites: Vec::new(),
                seen_nonces: VecDeque::new(),
                connected: HashMap::new(),
            }),
            revoked,
        }
    }

    pub fn subscribe_revocations(&self) -> broadcast::Receiver<String> {
        self.revoked.subscribe()
    }

    pub fn list(&self) -> Vec<DeviceInfo> {
        let state = self.state.lock().unwrap();
        state
            .devices
            .iter()
            .map(|device| DeviceInfo {
                id: device.id.clone(),
                name: device.name.clone(),
                paired_at: device.paired_at.to_rfc3339(),
                last_seen_at: device.last_seen_at.map(|at| at.to_rfc3339()),
                connected: state.connected.contains_key(&device.id),
                grants: Some(device.grants.names()),
            })
            .collect()
    }

    /// What a device may ask for, or `None` if it is no longer authorized.
    pub fn grants(&self, device_id: &str) -> Option<GrantSet> {
        let state = self.state.lock().unwrap();
        state
            .devices
            .iter()
            .find(|device| device.id == device_id)
            .map(|device| device.grants.clone())
    }

    /// Mints a one-time code. `rendezvous_url` is filled in by the caller,
    /// which is the only part of the system that knows whether this machine is
    /// currently reachable from outside.
    pub fn invite(&self) -> DeviceInvite {
        self.invite_with(GrantSet::full())
    }

    /// Mints an invitation worth only part of this machine.
    pub fn invite_with(&self, grants: GrantSet) -> DeviceInvite {
        let id = format!("inv_{}", uuid::Uuid::new_v4().simple());
        let secret = random_token();
        let code = format!("{id}.{secret}");
        let expires_at = Utc::now() + Duration::minutes(INVITE_LIFETIME_MINUTES);
        let mut state = self.state.lock().unwrap();
        let now = Utc::now();
        state.invites.retain(|invite| invite.expires_at > now);
        if state.invites.len() >= MAX_INVITES {
            state.invites.remove(0);
        }
        let names = grants.names();
        state.invites.push(Invite {
            id,
            secret,
            expires_at,
            grants,
        });
        DeviceInvite {
            code,
            rendezvous_url: None,
            expires_at: expires_at.to_rfc3339(),
            grants: Some(names),
        }
    }

    /// Authenticates a pairing-link PSK without consuming it. Consumption is
    /// the later encrypted claim, so a Relay cannot steal the invite merely by
    /// replaying or racing the public Hello.
    pub fn authenticate_invite(
        &self,
        auth: &InviteAuth,
        server_nonce: &str,
    ) -> Result<(String, String, SessionKey)> {
        validate_nonce(&auth.nonce)?;
        let mut state = self.state.lock().unwrap();
        let now = Utc::now();
        state.invites.retain(|invite| invite.expires_at > now);
        let invite = state
            .invites
            .iter()
            .find(|invite| invite.id == auth.invite_id)
            .ok_or_else(|| anyhow!("this pairing link is no longer valid"))?;
        let secret = invite.secret.clone();
        let context = format!("invite:{}", auth.invite_id);
        channel_auth::verify_proof(
            &channel_auth::client_proof(&secret, &context, &auth.nonce),
            &auth.proof,
        )?;
        self.remember_nonce(&mut state, &auth.nonce)?;
        Ok((
            auth.invite_id.clone(),
            channel_auth::server_proof(&secret, &context, &auth.nonce, server_nonce),
            channel_auth::derive_key(&secret, &context, &auth.nonce, server_nonce),
        ))
    }

    /// Atomically consumes a previously authenticated invite on the encrypted
    /// bootstrap channel and creates the real long-lived device credential.
    pub fn claim_authenticated(
        &self,
        invite_id: &str,
        device_name: &str,
    ) -> Result<(DeviceCredential, String)> {
        let device_name = validate_device_name(device_name)?;
        let mut state = self.state.lock().unwrap();
        let now = Utc::now();
        state.invites.retain(|invite| invite.expires_at > now);
        let position = state
            .invites
            .iter()
            .position(|invite| invite.id == invite_id)
            .ok_or_else(|| anyhow!("this pairing link is no longer valid"))?;
        if state.devices.len() >= MAX_DEVICES {
            return Err(anyhow!(
                "this machine has reached its authorized-device limit"
            ));
        }
        let invite = state.invites.remove(position);
        let device = Device {
            id: format!("d_{}", random_token()),
            name: device_name,
            secret: random_token(),
            paired_at: now,
            last_seen_at: None,
            grants: invite.grants,
        };
        let credential = DeviceCredential {
            device_id: device.id.clone(),
            machine_id: String::new(),
            secret: device.secret.clone(),
            machine_name: String::new(),
            fingerprint: String::new(),
        };
        let id = device.id.clone();
        state.devices.push(device);
        self.persist(&state)?;
        Ok((credential, id))
    }

    /// Authenticates a device and derives a connection-specific key.
    ///
    /// Both fresh nonces and the device id are bound into the transcript. A
    /// relay that records one whole connection
    /// therefore cannot replay its signed requests after reconnect or on a
    /// different device channel.
    pub fn authenticate_session(
        &self,
        auth: &DeviceAuth,
        server_nonce: &str,
    ) -> Result<(String, String, SessionKey)> {
        let mut state = self.state.lock().unwrap();
        validate_nonce(&auth.nonce)?;
        let position = state
            .devices
            .iter()
            .position(|device| device.id == auth.device_id)
            .ok_or_else(|| anyhow!("this device is not authorized on this machine"))?;
        let device_id = state.devices[position].id.clone();
        let secret = state.devices[position].secret.clone();
        let context = channel_auth::device_context(&device_id);
        channel_auth::verify_proof(
            &channel_auth::client_proof(&secret, &context, &auth.nonce),
            &auth.proof,
        )?;
        self.remember_nonce(&mut state, &auth.nonce)?;
        let answer = channel_auth::server_proof(&secret, &context, &auth.nonce, server_nonce);
        let key = channel_auth::derive_key(&secret, &context, &auth.nonce, server_nonce);
        let device = &mut state.devices[position];
        device.last_seen_at = Some(Utc::now());
        let id = device.id.clone();
        self.persist(&state)?;
        Ok((id, answer, key))
    }

    /// Forgets a device and tells any live connection of its to go away.
    pub fn revoke(&self, device_id: &str) -> Result<bool> {
        let mut state = self.state.lock().unwrap();
        let before = state.devices.len();
        state.devices.retain(|device| device.id != device_id);
        if state.devices.len() == before {
            return Ok(false);
        }
        self.persist(&state)?;
        drop(state);
        let _ = self.revoked.send(device_id.to_string());
        Ok(true)
    }

    pub fn mark_connected(&self, device_id: &str) {
        let mut state = self.state.lock().unwrap();
        *state.connected.entry(device_id.to_string()).or_insert(0) += 1;
    }

    pub fn mark_disconnected(&self, device_id: &str) {
        let mut state = self.state.lock().unwrap();
        if let Some(count) = state.connected.get_mut(device_id) {
            *count -= 1;
            if *count == 0 {
                state.connected.remove(device_id);
            }
        }
    }

    /// Rejects a nonce that has been used before.
    ///
    /// Without this, a proof observed once could be replayed forever, and the
    /// whole point of not sending the secret would be lost.
    fn remember_nonce(&self, state: &mut State, nonce: &str) -> Result<()> {
        if state.seen_nonces.iter().any(|seen| seen == nonce) {
            return Err(anyhow!("this challenge has already been used"));
        }
        if state.seen_nonces.len() >= NONCE_MEMORY {
            state.seen_nonces.pop_front();
        }
        state.seen_nonces.push_back(nonce.to_string());
        Ok(())
    }

    fn persist(&self, state: &State) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_string_pretty(&Persisted {
            devices: state.devices.clone(),
        })?;
        crate::config::save_private(&self.path, body.as_bytes())
    }
}

fn validate_device_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_DEVICE_NAME_CHARS {
        return Err(anyhow!(
            "the device name must contain 1 through {MAX_DEVICE_NAME_CHARS} characters"
        ));
    }
    if name.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            )
    }) {
        return Err(anyhow!(
            "the device name cannot contain control or bidirectional-formatting characters"
        ));
    }
    Ok(name.to_string())
}

fn validate_nonce(nonce: &str) -> Result<()> {
    if nonce.len() != 32
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(anyhow!(
            "the challenge must be exactly 16 random bytes in lowercase hexadecimal"
        ));
    }
    Ok(())
}

/// Where clients meet this machine.
///
/// Derived from the machine identity so it survives restarts, and from the
/// secret so it cannot be guessed by anyone who merely knows the machine id.
pub fn rendezvous_id(machine_id: &str, machine_secret: &str) -> String {
    let digest =
        Sha256::digest(format!("genehub-rendezvous:{machine_id}:{machine_secret}").as_bytes());
    digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn random_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn devices() -> (Devices, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let devices = Devices::load(dir.path().join("devices.json"));
        (devices, dir)
    }

    fn nonce() -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }

    /// Completes the protocol-v3 invitation handshake and its one encrypted
    /// claim RPC, which is the shape every other test leans on.
    fn claim(devices: &Devices, name: &str) -> (String, String) {
        let invite = devices.invite();
        let (invite_id, invite_secret) = invite.code.split_once('.').unwrap();
        let client_nonce = nonce();
        let server_nonce = nonce();
        let context = format!("invite:{invite_id}");
        devices
            .authenticate_invite(
                &InviteAuth {
                    invite_id: invite_id.to_string(),
                    nonce: client_nonce.clone(),
                    proof: channel_auth::client_proof(invite_secret, &context, &client_nonce),
                },
                &server_nonce,
            )
            .expect("a fresh invitation authenticates");
        let (credential, _) = devices
            .claim_authenticated(invite_id, name)
            .expect("the authenticated invitation is redeemable");
        (credential.device_id, credential.secret)
    }

    #[test]
    fn a_claimed_device_establishes_a_fresh_mutually_authenticated_session() {
        let (devices, _dir) = devices();
        let (device_id, secret) = claim(&devices, "phone");

        let client_nonce = nonce();
        let server_nonce = nonce();
        let context = channel_auth::device_context(&device_id);
        let (_, answer, _key) = devices
            .authenticate_session(
                &DeviceAuth {
                    device_id,
                    nonce: client_nonce.clone(),
                    proof: channel_auth::client_proof(&secret, &context, &client_nonce),
                },
                &server_nonce,
            )
            .expect("an authorized device gets in");
        channel_auth::verify_proof(
            &channel_auth::server_proof(&secret, &context, &client_nonce, &server_nonce),
            &answer,
        )
        .unwrap();
    }

    #[test]
    fn invalid_device_names_do_not_consume_the_invite_or_touch_disk() {
        let (devices, dir) = devices();
        let invite = devices.invite();
        let (invite_id, _) = invite.code.split_once('.').unwrap();
        let invalid = format!("phone\u{202e}{}", "x".repeat(80));
        let error = devices
            .claim_authenticated(invite_id, &invalid)
            .unwrap_err();
        assert!(format!("{error:#}").contains("device name"));
        assert!(!dir.path().join("devices.json").exists());
        assert!(devices.claim_authenticated(invite_id, "手机浏览器").is_ok());
    }

    #[test]
    fn invite_and_device_collections_have_hard_limits() {
        let (devices, _dir) = devices();
        for _ in 0..MAX_INVITES + 5 {
            devices.invite();
        }
        assert_eq!(devices.state.lock().unwrap().invites.len(), MAX_INVITES);
    }

    #[test]
    fn an_invite_works_exactly_once() {
        let (devices, _dir) = devices();
        let invite = devices.invite();
        let (invite_id, _) = invite.code.split_once('.').unwrap();
        devices
            .claim_authenticated(invite_id, "phone")
            .expect("the first use is the one that counts");
        let error = devices
            .claim_authenticated(invite_id, "laptop")
            .expect_err("a spent invite is worthless");
        assert!(format!("{error:#}").contains("no longer valid"));
    }

    #[test]
    fn an_invitation_id_without_its_secret_cannot_open_the_bootstrap_channel() {
        let (devices, _dir) = devices();
        let invite = devices.invite();
        let (invite_id, _) = invite.code.split_once('.').unwrap();
        let client_nonce = nonce();
        assert!(devices
            .authenticate_invite(
                &InviteAuth {
                    invite_id: invite_id.to_string(),
                    nonce: client_nonce,
                    proof: "not-the-proof".into(),
                },
                &nonce(),
            )
            .is_err());
    }

    #[test]
    fn a_forged_credential_is_refused() {
        let (devices, _dir) = devices();
        let (device_id, _) = claim(&devices, "phone");

        let client_nonce = nonce();
        let context = channel_auth::device_context(&device_id);
        assert!(devices
            .authenticate_session(
                &DeviceAuth {
                    device_id,
                    nonce: client_nonce.clone(),
                    proof: channel_auth::client_proof("a-guess", &context, &client_nonce),
                },
                &nonce(),
            )
            .is_err());
    }

    #[test]
    fn an_unknown_device_is_refused() {
        let (devices, _dir) = devices();
        let client_nonce = nonce();
        assert!(
            devices
                .authenticate_session(
                    &DeviceAuth {
                        device_id: "d_nobody".into(),
                        nonce: client_nonce.clone(),
                        proof: channel_auth::client_proof(
                            "whatever",
                            "device:d_nobody",
                            &client_nonce,
                        ),
                    },
                    &nonce(),
                )
                .is_err()
        );
    }

    /// An observed proof is bound to its nonce, and a nonce is good once. This
    /// is what keeps the exchange safe on a wire someone else can read.
    #[test]
    fn replaying_a_proof_does_not_work() {
        let (devices, _dir) = devices();
        let (device_id, secret) = claim(&devices, "phone");

        let client_nonce = nonce();
        let context = channel_auth::device_context(&device_id);
        let auth = DeviceAuth {
            device_id,
            nonce: client_nonce.clone(),
            proof: channel_auth::client_proof(&secret, &context, &client_nonce),
        };
        devices
            .authenticate_session(&auth, &nonce())
            .expect("the first use is fine");
        assert!(devices.authenticate_session(&auth, &nonce()).is_err());
    }

    #[test]
    fn revoking_removes_the_device_and_announces_it() {
        let (devices, _dir) = devices();
        let (device_id, secret) = claim(&devices, "phone");
        let mut revocations = devices.subscribe_revocations();

        assert!(devices.revoke(&device_id).unwrap());
        assert_eq!(revocations.try_recv().unwrap(), device_id);
        assert!(devices.list().is_empty());

        let client_nonce = nonce();
        let context = channel_auth::device_context(&device_id);
        assert!(devices
            .authenticate_session(
                &DeviceAuth {
                    device_id,
                    nonce: client_nonce.clone(),
                    proof: channel_auth::client_proof(&secret, &context, &client_nonce),
                },
                &nonce(),
            )
            .is_err());
    }

    #[test]
    fn revoking_something_that_is_not_there_is_not_an_error() {
        let (devices, _dir) = devices();
        assert!(!devices.revoke("d_nobody").unwrap());
    }

    #[test]
    fn the_list_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let (device_id, secret) = {
            let devices = Devices::load(&path);
            claim(&devices, "phone")
        };

        let devices = Devices::load(&path);
        assert_eq!(devices.list().len(), 1);
        let client_nonce = nonce();
        let context = channel_auth::device_context(&device_id);
        assert!(devices
            .authenticate_session(
                &DeviceAuth {
                    device_id,
                    nonce: client_nonce.clone(),
                    proof: channel_auth::client_proof(&secret, &context, &client_nonce),
                },
                &nonce(),
            )
            .is_ok());
    }

    #[test]
    fn an_expired_invite_is_gone() {
        let (devices, _dir) = devices();
        let invite = devices.invite();
        let (invite_id, invite_secret) = invite.code.split_once('.').unwrap();
        {
            let mut state = devices.state.lock().unwrap();
            for entry in state.invites.iter_mut() {
                entry.expires_at = Utc::now() - Duration::minutes(1);
            }
        }
        let client_nonce = nonce();
        let context = format!("invite:{invite_id}");
        assert!(devices
            .authenticate_invite(
                &InviteAuth {
                    invite_id: invite_id.to_string(),
                    nonce: client_nonce.clone(),
                    proof: channel_auth::client_proof(invite_secret, &context, &client_nonce,),
                },
                &nonce(),
            )
            .is_err());
    }

    /// Two machines must not share a slot, and knowing a machine id must not be
    /// enough to work out where it meets its clients.
    #[test]
    fn the_rendezvous_id_is_stable_and_depends_on_the_secret() {
        assert_eq!(rendezvous_id("m1", "s1"), rendezvous_id("m1", "s1"));
        assert_ne!(rendezvous_id("m1", "s1"), rendezvous_id("m1", "s2"));
        assert_eq!(rendezvous_id("m1", "s1").len(), 32);
    }
}
