//! Portable authorized-device policy.
//!
//! Native code owns sockets and AEAD record processing. This module owns the
//! durable authorization list, one-use invitations, nonce replay protection,
//! connection presence and the PSK handshake decision. Native transport asks
//! through `PlatformRequest`; it never keeps a second copy of these records.

use std::collections::{BTreeMap, VecDeque};

use chrono::{SecondsFormat, TimeZone, Utc};
use genehub_proto::{
    DeviceAuth, DeviceCredential, DeviceInfo, DeviceInvite, ErrorCode, InviteAuth, ProtocolError,
    RemoteAccess,
};
use genet_daemon_logic_api::{
    CapabilityFailure, CapabilityFailureKind, CapabilityRequest, CapabilityValue, LogicBoot,
    PlatformReply, Publication,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::capability::Client;
use crate::CapabilityExecutor;

const STORAGE_KEY: &str = "devices.json";
const STORAGE_BYTES: u32 = 1024 * 1024;
const INVITE_LIFETIME_MILLIS: i64 = 15 * 60 * 1000;
const NONCE_MEMORY: usize = 1024;
const MAX_INVITES: usize = 32;
const MAX_DEVICES: usize = 128;
const MAX_DEVICE_NAME_CHARS: usize = 64;
const HANDSHAKE_DOMAIN: &[u8] = b"genehub-channel-handshake-v1";
const KEY_DOMAIN: &[u8] = b"genehub-channel-key-v1";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    loaded: bool,
    devices: Vec<Device>,
    /// Intentionally snapshot-only. A normal daemon restart does not restore a
    /// stale invitation; a live Wasm replacement does preserve the open flow.
    invites: Vec<Invite>,
    seen_nonces: VecDeque<String>,
    connected: BTreeMap<String, u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    secret: String,
    #[serde(rename = "pairedAt", with = "legacy_time")]
    paired_at_ms: i64,
    #[serde(rename = "lastSeenAt", default, with = "legacy_optional_time")]
    last_seen_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Invite {
    id: String,
    secret: String,
    expires_at_ms: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    devices: Vec<Device>,
}

impl Devices {
    pub fn list(
        &mut self,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Vec<DeviceInfo>, ProtocolError> {
        self.ensure_loaded(executor, next)?;
        Ok(self
            .devices
            .iter()
            .map(|device| DeviceInfo {
                id: device.id.clone(),
                name: device.name.clone(),
                paired_at: timestamp(device.paired_at_ms),
                last_seen_at: device.last_seen_at_ms.map(timestamp),
                connected: self.connected.contains_key(&device.id),
            })
            .collect())
    }

    pub fn invite(
        &mut self,
        remote: &RemoteAccess,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<DeviceInvite, ProtocolError> {
        self.ensure_loaded(executor, next)?;
        let now = clock(executor, next)?;
        self.purge_invites(now);
        if self.invites.len() >= MAX_INVITES {
            self.invites.remove(0);
        }
        let id = format!("inv_{}", random_hex(16, executor, next)?);
        let secret = random_hex(32, executor, next)?;
        let expires_at_ms = now.saturating_add(INVITE_LIFETIME_MILLIS);
        self.invites.push(Invite {
            id: id.clone(),
            secret: secret.clone(),
            expires_at_ms,
        });
        Ok(DeviceInvite {
            code: format!("{id}.{secret}"),
            rendezvous_url: remote.rendezvous_url.clone(),
            expires_at: timestamp(expires_at_ms),
        })
    }

    pub fn revoke(
        &mut self,
        device_id: &str,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Vec<Publication>, ProtocolError> {
        self.ensure_loaded(executor, next)?;
        let before = self.devices.len();
        self.devices.retain(|device| device.id != device_id);
        if self.devices.len() == before {
            return Ok(Vec::new());
        }
        self.connected.remove(device_id);
        self.persist(executor, next)?;
        Ok(vec![Publication::DeviceRevoked {
            device_id: device_id.to_string(),
        }])
    }

    pub fn authenticate_device(
        &mut self,
        auth: &DeviceAuth,
        server_nonce: &str,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<PlatformReply, ProtocolError> {
        self.ensure_loaded(executor, next)?;
        validate_nonce(&auth.nonce)?;
        validate_nonce(server_nonce)?;
        let position = self
            .devices
            .iter()
            .position(|device| device.id == auth.device_id)
            .ok_or_else(|| unauthorized("this device is not authorized on this machine"))?;
        let device_id = self.devices[position].id.clone();
        let secret = self.devices[position].secret.clone();
        let context = device_context(&device_id);
        verify_proof(&client_proof(&secret, &context, &auth.nonce), &auth.proof)?;
        self.remember_nonce(&auth.nonce)?;
        self.devices[position].last_seen_at_ms = Some(clock(executor, next)?);
        self.persist(executor, next)?;
        Ok(authenticated(
            device_id,
            secret,
            context,
            &auth.nonce,
            server_nonce,
        ))
    }

    pub fn authenticate_invite(
        &mut self,
        auth: &InviteAuth,
        server_nonce: &str,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<PlatformReply, ProtocolError> {
        self.ensure_loaded(executor, next)?;
        validate_nonce(&auth.nonce)?;
        validate_nonce(server_nonce)?;
        let now = clock(executor, next)?;
        self.purge_invites(now);
        let invite = self
            .invites
            .iter()
            .find(|invite| invite.id == auth.invite_id)
            .ok_or_else(|| unauthorized("this pairing link is no longer valid"))?;
        let id = invite.id.clone();
        let secret = invite.secret.clone();
        let context = format!("invite:{id}");
        verify_proof(&client_proof(&secret, &context, &auth.nonce), &auth.proof)?;
        self.remember_nonce(&auth.nonce)?;
        Ok(authenticated(
            id,
            secret,
            context,
            &auth.nonce,
            server_nonce,
        ))
    }

    pub fn claim_authenticated(
        &mut self,
        invite_id: &str,
        device_name: &str,
        boot: &LogicBoot,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<PlatformReply, ProtocolError> {
        self.ensure_loaded(executor, next)?;
        let name = validate_device_name(device_name)?;
        let now = clock(executor, next)?;
        self.purge_invites(now);
        let position = self
            .invites
            .iter()
            .position(|invite| invite.id == invite_id)
            .ok_or_else(|| unauthorized("this pairing link is no longer valid"))?;
        if self.devices.len() >= MAX_DEVICES {
            return Err(conflict(
                "this machine has reached its authorized-device limit",
            ));
        }
        self.invites.remove(position);
        let device = Device {
            id: format!("d_{}", random_hex(32, executor, next)?),
            name,
            secret: random_hex(32, executor, next)?,
            paired_at_ms: now,
            last_seen_at_ms: None,
        };
        let credential = DeviceCredential {
            device_id: device.id.clone(),
            machine_id: boot.machine_id.clone(),
            secret: device.secret.clone(),
            machine_name: boot.machine_name.clone(),
            fingerprint: boot.fingerprint.clone(),
        };
        self.devices.push(device);
        self.persist(executor, next)?;
        Ok(PlatformReply::Claimed(credential))
    }

    pub fn connection(
        &mut self,
        device_id: &str,
        connected: bool,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<PlatformReply, ProtocolError> {
        self.ensure_loaded(executor, next)?;
        if !self.devices.iter().any(|device| device.id == device_id) {
            return Err(unauthorized(
                "this device is not authorized on this machine",
            ));
        }
        if connected {
            let count = self.connected.entry(device_id.to_string()).or_default();
            *count = count.saturating_add(1);
        } else if let Some(count) = self.connected.get_mut(device_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.connected.remove(device_id);
            }
        }
        Ok(PlatformReply::Ack)
    }

    fn ensure_loaded(
        &mut self,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<(), ProtocolError> {
        if self.loaded {
            return Ok(());
        }
        let mut client = Client::new(executor, next);
        match client.call_raw(CapabilityRequest::SecureRead {
            key: STORAGE_KEY.to_string(),
            max_bytes: STORAGE_BYTES,
        })? {
            Ok(CapabilityValue::Bytes(bytes)) => {
                let persisted: Persisted = serde_json::from_slice(&bytes)
                    .map_err(|error| internal(format!("reading authorized devices: {error}")))?;
                self.devices = persisted.devices.into_iter().take(MAX_DEVICES).collect();
            }
            Err(error) if error.kind == CapabilityFailureKind::NotFound => {}
            Err(error) => return Err(capability_error(error)),
            Ok(_) => {
                return Err(internal(
                    "authorized-device storage returned the wrong value",
                ))
            }
        }
        self.loaded = true;
        Ok(())
    }

    fn persist(
        &self,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<(), ProtocolError> {
        let bytes = serde_json::to_vec_pretty(&Persisted {
            devices: self.devices.clone(),
        })
        .map_err(|error| internal(format!("encoding authorized devices: {error}")))?;
        let mut client = Client::new(executor, next);
        match client.call(CapabilityRequest::SecureWrite {
            key: STORAGE_KEY.to_string(),
            bytes,
        })? {
            CapabilityValue::Unit => Ok(()),
            _ => Err(internal(
                "authorized-device storage returned the wrong value",
            )),
        }
    }

    fn purge_invites(&mut self, now: i64) {
        self.invites.retain(|invite| invite.expires_at_ms > now);
    }

    fn remember_nonce(&mut self, nonce: &str) -> Result<(), ProtocolError> {
        if self.seen_nonces.iter().any(|seen| seen == nonce) {
            return Err(unauthorized("this challenge has already been used"));
        }
        if self.seen_nonces.len() >= NONCE_MEMORY {
            self.seen_nonces.pop_front();
        }
        self.seen_nonces.push_back(nonce.to_string());
        Ok(())
    }
}

fn authenticated(
    subject_id: String,
    secret: String,
    context: String,
    client_nonce: &str,
    server_nonce: &str,
) -> PlatformReply {
    PlatformReply::Authenticated {
        proof: server_proof(&secret, &context, client_nonce, server_nonce),
        encryption_key: derive_key(&secret, &context, client_nonce, server_nonce),
        subject_id,
        context,
    }
}

fn device_context(device_id: &str) -> String {
    format!("device:{device_id}")
}

fn client_proof(secret: &str, context: &str, client_nonce: &str) -> String {
    authenticate(
        secret.as_bytes(),
        HANDSHAKE_DOMAIN,
        &[b"client", context.as_bytes(), client_nonce.as_bytes()],
    )
}

fn server_proof(secret: &str, context: &str, client_nonce: &str, server_nonce: &str) -> String {
    authenticate(
        secret.as_bytes(),
        HANDSHAKE_DOMAIN,
        &[
            b"server",
            context.as_bytes(),
            client_nonce.as_bytes(),
            server_nonce.as_bytes(),
        ],
    )
}

fn derive_key(secret: &str, context: &str, client_nonce: &str, server_nonce: &str) -> [u8; 32] {
    authenticate_bytes(
        secret.as_bytes(),
        KEY_DOMAIN,
        &[
            b"encryption",
            context.as_bytes(),
            client_nonce.as_bytes(),
            server_nonce.as_bytes(),
        ],
    )
}

fn authenticate(key: &[u8], domain: &[u8], fields: &[&[u8]]) -> String {
    authenticate_bytes(key, domain, fields)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn authenticate_bytes(key: &[u8], domain: &[u8], fields: &[&[u8]]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts every key size");
    field(&mut mac, domain);
    for value in fields {
        field(&mut mac, value);
    }
    mac.finalize().into_bytes().into()
}

fn field(mac: &mut Hmac<Sha256>, value: &[u8]) {
    mac.update(&(value.len() as u64).to_be_bytes());
    mac.update(value);
}

fn verify_proof(expected: &str, presented: &str) -> Result<(), ProtocolError> {
    if expected.len() != presented.len()
        || expected
            .bytes()
            .zip(presented.bytes())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            != 0
    {
        return Err(unauthorized("channel handshake authentication failed"));
    }
    Ok(())
}

fn validate_nonce(nonce: &str) -> Result<(), ProtocolError> {
    if nonce.len() != 32
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(unauthorized(
            "the challenge must be exactly 16 random bytes in lowercase hexadecimal",
        ));
    }
    Ok(())
}

fn validate_device_name(name: &str) -> Result<String, ProtocolError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_DEVICE_NAME_CHARS {
        return Err(bad_request(format!(
            "the device name must contain 1 through {MAX_DEVICE_NAME_CHARS} characters"
        )));
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
        return Err(bad_request(
            "the device name cannot contain control or bidirectional-formatting characters",
        ));
    }
    Ok(name.to_string())
}

fn random_hex(
    bytes: u32,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<String, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Random { bytes })? {
        CapabilityValue::Bytes(bytes) => {
            Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
        }
        _ => Err(internal("random capability returned the wrong value")),
    }
}

fn clock(executor: &mut impl CapabilityExecutor, next: &mut u64) -> Result<i64, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Clock)? {
        CapabilityValue::Clock { unix_millis, .. } => Ok(unix_millis),
        _ => Err(internal("clock capability returned the wrong value")),
    }
}

fn timestamp(millis: i64) -> String {
    Utc.timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(|| Utc.timestamp_millis_opt(0).single().expect("unix epoch"))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn capability_error(error: CapabilityFailure) -> ProtocolError {
    ProtocolError {
        code: match error.kind {
            CapabilityFailureKind::Invalid => ErrorCode::BadRequest,
            CapabilityFailureKind::Denied => ErrorCode::Forbidden,
            CapabilityFailureKind::NotFound => ErrorCode::NotFound,
            CapabilityFailureKind::Conflict => ErrorCode::Conflict,
            CapabilityFailureKind::Unavailable
            | CapabilityFailureKind::TooLarge
            | CapabilityFailureKind::Internal => ErrorCode::Internal,
        },
        message: error.message,
    }
}

fn bad_request(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BadRequest,
        message: message.into(),
    }
}

fn unauthorized(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Unauthorized,
        message: message.into(),
    }
}

fn conflict(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Conflict,
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}

// The legacy native store serialized `chrono::DateTime<Utc>` strings. These
// adapters read that exact shape and write it back unchanged at the boundary,
// while the guest keeps integer milliseconds internally for deterministic
// clock handling.
mod legacy_time {
    use chrono::DateTime;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(millis: &i64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&super::timestamp(*millis))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<i64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        DateTime::parse_from_rfc3339(&value)
            .map(|value| value.timestamp_millis())
            .map_err(serde::de::Error::custom)
    }
}

mod legacy_optional_time {
    use chrono::DateTime;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(millis: &Option<i64>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match millis {
            Some(millis) => serializer.serialize_some(&super::timestamp(*millis)),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Option::<String>::deserialize(deserializer)?;
        value
            .map(|value| {
                DateTime::parse_from_rfc3339(&value)
                    .map(|value| value.timestamp_millis())
                    .map_err(serde::de::Error::custom)
            })
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genet_daemon_logic_api::{
        CapabilityBatch, CapabilityResult, CapabilityResults, LogicBoot, PlatformReply,
    };

    #[derive(Default)]
    struct FakeCapabilities {
        secure: BTreeMap<String, Vec<u8>>,
        random: u8,
        now: i64,
    }

    impl CapabilityExecutor for FakeCapabilities {
        fn execute(&mut self, batch: CapabilityBatch) -> Result<CapabilityResults, String> {
            let results = batch
                .calls
                .into_iter()
                .map(|call| {
                    let result = match call.request {
                        CapabilityRequest::SecureRead { key, .. } => self
                            .secure
                            .get(&key)
                            .cloned()
                            .map(CapabilityValue::Bytes)
                            .ok_or_else(|| CapabilityFailure {
                                kind: CapabilityFailureKind::NotFound,
                                message: "missing".to_string(),
                            }),
                        CapabilityRequest::SecureWrite { key, bytes } => {
                            self.secure.insert(key, bytes);
                            Ok(CapabilityValue::Unit)
                        }
                        CapabilityRequest::Random { bytes } => {
                            self.random = self.random.wrapping_add(1);
                            Ok(CapabilityValue::Bytes(
                                (0..bytes)
                                    .map(|offset| self.random.wrapping_add(offset as u8))
                                    .collect(),
                            ))
                        }
                        CapabilityRequest::Clock => Ok(CapabilityValue::Clock {
                            unix_millis: self.now,
                            monotonic_millis: 1,
                        }),
                        other => panic!("unexpected device capability: {other:?}"),
                    };
                    CapabilityResult {
                        call_id: call.call_id,
                        result,
                    }
                })
                .collect();
            Ok(CapabilityResults {
                batch_id: batch.batch_id,
                results,
            })
        }
    }

    fn boot() -> LogicBoot {
        LogicBoot {
            daemon_version: "test".into(),
            protocol_version: genehub_proto::PROTOCOL_VERSION,
            machine_id: "machine".into(),
            fingerprint: "fingerprint".into(),
            machine_name: "workstation".into(),
            rtc_supported: true,
            log_directory: ".".into(),
            log_display_directory: ".".into(),
            default_workspace: None,
            home_directory: None,
            builtin_agent_binary: None,
        }
    }

    #[test]
    fn handshake_vectors_match_the_native_and_web_protocol() {
        let secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let context = "hosted:cap_golden";
        let client_nonce = "00112233445566778899aabbccddeeff";
        let server_nonce = "ffeeddccbbaa99887766554433221100";
        assert_eq!(
            client_proof(secret, context, client_nonce),
            "2a0958501e684eb33817ddca6c2346e3a5f0d683b2c821666c0b045a5afe801b"
        );
        assert_eq!(
            server_proof(secret, context, client_nonce, server_nonce),
            "6e7af7a542b0ed092aa7017984d91e81d80c904663fa669945ef36fe042c3094"
        );
        assert_eq!(
            derive_key(secret, context, client_nonce, server_nonce)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            "ff8270f2ec546267347aaccd0178af62830df51be490248c916969f6ac43a550"
        );
    }

    #[test]
    fn legacy_device_timestamp_shape_round_trips() {
        let persisted: Persisted = serde_json::from_value(serde_json::json!({
            "devices": [{
                "id": "d_one",
                "name": "phone",
                "secret": "secret",
                "pairedAt": "2026-08-15T08:09:10Z",
                "lastSeenAt": null
            }]
        }))
        .unwrap();
        assert_eq!(persisted.devices.len(), 1);
        let value = serde_json::to_value(persisted).unwrap();
        assert_eq!(value["devices"][0]["pairedAt"], "2026-08-15T08:09:10.000Z");
    }

    #[test]
    fn invitation_auth_claim_presence_restart_and_revoke_are_one_guest_owned_flow() {
        let mut capabilities = FakeCapabilities {
            now: 1_776_240_000_000,
            ..FakeCapabilities::default()
        };
        let mut next = 1;
        let mut devices = Devices::default();
        let invite = devices
            .invite(
                &RemoteAccess {
                    relay_url: Some("https://relay.example".into()),
                    rendezvous_url: Some("wss://relay.example/route".into()),
                    online: true,
                },
                &mut capabilities,
                &mut next,
            )
            .unwrap();
        let (invite_id, secret) = invite.code.split_once('.').unwrap();
        let client_nonce = "00112233445566778899aabbccddeeff";
        let server_nonce = "ffeeddccbbaa99887766554433221100";
        let context = format!("invite:{invite_id}");
        let auth = InviteAuth {
            invite_id: invite_id.to_string(),
            nonce: client_nonce.to_string(),
            proof: client_proof(secret, &context, client_nonce),
        };
        assert!(matches!(
            devices
                .authenticate_invite(
                    &auth,
                    server_nonce,
                    &mut capabilities,
                    &mut next,
                )
                .unwrap(),
            PlatformReply::Authenticated { ref subject_id, .. } if subject_id == invite_id
        ));
        assert!(devices
            .authenticate_invite(&auth, server_nonce, &mut capabilities, &mut next)
            .is_err());

        let credential = match devices
            .claim_authenticated(invite_id, "phone", &boot(), &mut capabilities, &mut next)
            .unwrap()
        {
            PlatformReply::Claimed(credential) => credential,
            other => panic!("wrong claim reply: {other:?}"),
        };
        let device_nonce = "102132435465768798a9bacbdcedfe0f";
        let device_context = device_context(&credential.device_id);
        assert!(matches!(
            devices
                .authenticate_device(
                    &DeviceAuth {
                        device_id: credential.device_id.clone(),
                        nonce: device_nonce.into(),
                        proof: client_proof(&credential.secret, &device_context, device_nonce,),
                    },
                    server_nonce,
                    &mut capabilities,
                    &mut next,
                )
                .unwrap(),
            PlatformReply::Authenticated { .. }
        ));
        devices
            .connection(&credential.device_id, true, &mut capabilities, &mut next)
            .unwrap();
        assert!(devices
            .list(&mut capabilities, &mut next)
            .unwrap()
            .iter()
            .any(|device| device.id == credential.device_id && device.connected));

        // Durable records reload from the same secure capability, while live
        // connection presence remains intentionally process-local.
        let mut reloaded = Devices::default();
        let listed = reloaded.list(&mut capabilities, &mut next).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].connected);
        assert!(matches!(
            reloaded
                .revoke(&credential.device_id, &mut capabilities, &mut next)
                .unwrap()
                .as_slice(),
            [Publication::DeviceRevoked { device_id }] if device_id == &credential.device_id
        ));
        assert!(reloaded
            .list(&mut capabilities, &mut next)
            .unwrap()
            .is_empty());
    }
}
