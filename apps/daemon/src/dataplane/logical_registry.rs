//! Daemon-local admission and lifetime of resumable peers. No credentials leave
//! this registry except the initial encrypted CREATE response. Physical channel
//! tasks hold handles, never ownership of a logical peer's business task.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use tokio::sync::OwnedSemaphorePermit;

use super::endpoint::{CarrierKind, PeerAccess};
use crate::channel_auth::{self, SessionKey};

pub(crate) const RESUME_TTL: Duration = Duration::from_secs(60);
const MAX_CONNECTIONS: usize = 32;
const GLOBAL_BYTES: usize = 160 * 1024 * 1024;
// Reserve conservatively for both journals, receive custody, physical crypto
// queues and stream command queues before creating any of those owners.
pub(crate) const CONNECTION_BYTES: usize = 20 * 1024 * 1024;
// 4 MiB each for receive custody, replay log, queued writes and the bounded
// 256 producer frames awaiting admission; progress buckets + the three
// 16-record carrier queues fit in the remaining 4 MiB. Endpoint/actor queues
// transfer the same frame, and the endpoint's permit survives until custody.
// This is a transmission-byte reservation, not a claim about allocator/RSS.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Policy {
    RelayAllowed,
    DirectOnly,
}

#[derive(Clone, PartialEq, Eq)]
struct Admission {
    principal: String,
    device_id: Option<String>,
    workspace_id: Option<String>,
    workspace_handle: Option<String>,
}
impl Admission {
    fn new(_key: &SessionKey, access: &PeerAccess, _carrier: CarrierKind) -> Result<Self> {
        if access.bootstrap_invite.is_some() {
            bail!("bootstrap peers cannot resume");
        }
        Ok(Self {
            principal: access.principal.clone(),
            device_id: access.device_id.clone(),
            workspace_id: access.workspace_id.clone(),
            workspace_handle: access.workspace_handle.clone(),
        })
    }
}

/// A registry entry owns a cancellation guard. Dropping it is terminal even
/// when a caller still has an attachment handle.
struct Entry {
    admission: Admission,
    policy: Policy,
    secret: String,
    resumable: bool,
    authorization_expires_at: Option<Instant>,
    access: PeerAccess,
    suspended_at: Option<Instant>,
    epoch: u64,
    last_attempt: Option<String>,
    task: Option<tokio::task::AbortHandle>,
    handle: Option<super::logical_connection::Handle>,
    _bytes: OwnedSemaphorePermit,
}
impl Drop for Entry {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

pub(crate) struct Registry {
    incarnation: String,
    entries: Mutex<HashMap<String, Entry>>,
    bytes: Arc<tokio::sync::Semaphore>,
}

/// Does not implement Debug: the recovery secret must never appear in logs.
pub(crate) struct Created {
    pub id: String,
    pub incarnation: String,
    pub secret: String,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            incarnation: crate::devices::random_token(),
            entries: Mutex::new(HashMap::new()),
            bytes: Arc::new(tokio::sync::Semaphore::new(GLOBAL_BYTES)),
        }
    }
}

impl Registry {
    pub fn create(
        &self,
        key: &SessionKey,
        access: &PeerAccess,
        carrier: CarrierKind,
        policy: Policy,
        resumable: bool,
        now: Instant,
    ) -> Result<Created> {
        let admission = Admission::new(key, access, carrier)?;
        if policy == Policy::DirectOnly && !direct_path(carrier, access.transport) {
            bail!("PolicyDenied");
        }
        let mut entries = self.entries.lock().unwrap();
        Self::expire(&mut entries, now);
        if entries.len() >= MAX_CONNECTIONS {
            bail!("logical connection admission exhausted");
        }
        let reservation = self
            .bytes
            .clone()
            .try_acquire_many_owned(CONNECTION_BYTES as u32)
            .map_err(|_| anyhow!("logical connection byte admission exhausted"))?;
        let id = crate::devices::random_token();
        let secret = crate::devices::random_token();
        entries.insert(
            id.clone(),
            Entry {
                admission,
                policy,
                secret: secret.clone(),
                resumable,
                authorization_expires_at: access.authorization_expires_at,
                access: access.clone(),
                suspended_at: Some(now),
                epoch: 0,
                last_attempt: None,
                task: None,
                handle: None,
                _bytes: reservation,
            },
        );
        Ok(Created {
            id,
            incarnation: self.incarnation.clone(),
            secret,
        })
    }

    pub fn own_task(
        &self,
        id: &str,
        task: tokio::task::AbortHandle,
        handle: super::logical_connection::Handle,
    ) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        let Some(entry) = entries.get_mut(id) else {
            task.abort();
            bail!("SessionLost");
        };
        if entry.task.is_some() {
            task.abort();
            bail!("logical peer task already owned");
        }
        entry.task = Some(task);
        entry.handle = Some(handle);
        Ok(())
    }

    /// Rechecks fresh carrier authentication and scope, then proves recovery
    /// possession bound to that channel's two-nonce key derivation. This method
    /// cannot advance epochs or displace the currently active channel.
    #[allow(clippy::too_many_arguments)]
    pub fn attach(
        &self,
        id: &str,
        incarnation: &str,
        key: &SessionKey,
        access: &PeerAccess,
        carrier: CarrierKind,
        attempt: &str,
        proof: &str,
        now: Instant,
    ) -> Result<(u64, String)> {
        if incarnation != self.incarnation {
            bail!("SessionLost");
        }
        if attempt.len() != 32 || !attempt.bytes().all(|c| c.is_ascii_hexdigit()) {
            bail!("invalid activation attempt");
        }
        let admission = Admission::new(key, access, carrier)?;
        let mut entries = self.entries.lock().unwrap();
        Self::expire(&mut entries, now);
        let entry = entries.get_mut(id).ok_or_else(|| anyhow!("SessionLost"))?;
        if entry.admission != admission
            || (entry.policy == Policy::DirectOnly && !direct_path(carrier, access.transport))
        {
            bail!("PolicyDenied");
        }
        if access.authorization_expires_at.is_some_and(|at| at <= now)
            || (entry.authorization_expires_at.is_some()
                && access.authorization_expires_at.is_none())
        {
            bail!("PolicyDenied");
        }
        channel_auth::verify_proof(
            &key.resume_proof(&entry.secret, id, incarnation, attempt),
            proof,
        )?;
        entry.authorization_expires_at = access.authorization_expires_at;
        entry.access = access.clone();
        Ok((
            entry.epoch,
            key.resume_server_proof(&entry.secret, id, incarnation, attempt, entry.epoch),
        ))
    }

    /// Called only by the connection actor after a successful ATTACH on this
    /// exact channel and validation of both SYNC watermarks. Serialized commit;
    /// losing ACTIVATED never permits reactivation of the old epoch.
    pub fn activate(&self, id: &str, attempt: &str, expected: u64, now: Instant) -> Result<u64> {
        let mut entries = self.entries.lock().unwrap();
        Self::expire(&mut entries, now);
        let entry = entries.get_mut(id).ok_or_else(|| anyhow!("SessionLost"))?;
        if entry.last_attempt.as_deref() == Some(attempt) {
            if expected.checked_add(1) != Some(entry.epoch) {
                bail!("activation attempt mismatch");
            }
            return Ok(entry.epoch);
        }
        if entry.epoch != expected {
            bail!("activation epoch conflict");
        }
        entry.epoch = expected
            .checked_add(1)
            .ok_or_else(|| anyhow!("activation epoch exhausted"))?;
        entry.last_attempt = Some(attempt.to_owned());
        entry.suspended_at.get_or_insert(now);
        // Retain the original deadline until SYNC completes; repeated failed
        // attachments may not keep a disconnected peer alive indefinitely.
        Ok(entry.epoch)
    }

    pub fn synced(&self, id: &str, epoch: u64) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.get_mut(id).ok_or_else(|| anyhow!("SessionLost"))?;
        if entry.epoch != epoch {
            bail!("stale logical channel");
        }
        entry.suspended_at = None;
        Ok(())
    }
    pub fn suspend(&self, id: &str, epoch: u64, now: Instant) {
        let mut entries = self.entries.lock().unwrap();
        if entries
            .get(id)
            .is_some_and(|entry| entry.epoch == epoch && !entry.resumable)
        {
            entries.remove(id);
        } else if let Some(entry) = entries.get_mut(id) {
            if entry.epoch == epoch {
                entry.suspended_at.get_or_insert(now);
            }
        }
    }
    pub fn handle(&self, id: &str) -> Result<super::logical_connection::Handle> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .and_then(|e| e.handle.clone())
            .ok_or_else(|| anyhow!("SessionLost"))
    }
    pub fn access(&self, id: &str) -> Result<PeerAccess> {
        let entries = self.entries.lock().unwrap();
        let entry = entries.get(id).ok_or_else(|| anyhow!("SessionLost"))?;
        if entry
            .authorization_expires_at
            .is_some_and(|at| at <= Instant::now())
            || entry
                .access
                .hosted_authority
                .as_ref()
                .is_some_and(|a| !a.load(std::sync::atomic::Ordering::Acquire))
        {
            bail!("PolicyDenied");
        }
        let mut access = entry.access.clone();
        access.logical_id = Some(id.to_owned());
        Ok(access)
    }
    pub fn remove(&self, id: &str) {
        self.entries.lock().unwrap().remove(id);
    }
    pub fn revoke_device(&self, device_id: &str) {
        self.entries
            .lock()
            .unwrap()
            .retain(|_, entry| entry.admission.device_id.as_deref() != Some(device_id));
    }
    pub fn reap(&self, now: Instant) {
        Self::expire(&mut self.entries.lock().unwrap(), now);
    }
    fn expire(entries: &mut HashMap<String, Entry>, now: Instant) {
        entries.retain(|_, entry| {
            entry
                .access
                .hosted_authority
                .as_ref()
                .is_none_or(|a| a.load(std::sync::atomic::Ordering::Acquire))
                && entry.authorization_expires_at.is_none_or(|at| now < at)
                && entry
                    .suspended_at
                    .is_none_or(|at| now.saturating_duration_since(at) < RESUME_TTL)
        });
    }
}

fn direct_path(carrier: CarrierKind, transport: genehub_proto::TransportKind) -> bool {
    matches!(carrier, CarrierKind::Rtc)
        || (matches!(carrier, CarrierKind::WebSocket)
            && transport == genehub_proto::TransportKind::Loopback)
}
