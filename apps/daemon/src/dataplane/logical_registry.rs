//! Admission accounting and authenticated access for live connections only.
use super::endpoint::{CarrierKind, PeerAccess};
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const MAX_CONNECTIONS: usize = 32;
pub(crate) struct Registry {
    entries: Mutex<HashMap<String, PeerAccess>>,
}
pub(crate) struct Connection {
    pub id: String,
    registry: Arc<Registry>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.registry.entries.lock().unwrap().remove(&self.id);
    }
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}
impl Registry {
    pub fn create(
        self: &Arc<Self>,
        access: &PeerAccess,
        carrier: CarrierKind,
        direct_only: bool,
    ) -> Result<Connection> {
        if access.bootstrap_invite.is_some() {
            bail!("bootstrap cannot create ordinary connections");
        }
        if direct_only
            && !matches!(carrier, CarrierKind::Rtc)
            && access.transport != genehub_proto::TransportKind::Loopback
        {
            bail!("PolicyDenied");
        }
        validate_access(access)?;
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= MAX_CONNECTIONS {
            bail!("connection admission exhausted");
        }
        let id = crate::devices::random_token();
        let mut admitted = access.clone();
        admitted.logical_id = Some(id.clone());
        admitted.direct_only = matches!(carrier, CarrierKind::Rtc)
            || access.transport == genehub_proto::TransportKind::Loopback;
        entries.insert(id.clone(), admitted);
        Ok(Connection {
            id,
            registry: self.clone(),
        })
    }
    pub fn access(&self, id: &str) -> Result<PeerAccess> {
        let entries = self.entries.lock().unwrap();
        let entry = entries
            .get(id)
            .ok_or_else(|| anyhow!("connection closed"))?;
        validate_access(entry)?;
        Ok(entry.clone())
    }
}
pub(crate) fn validate_access(access: &PeerAccess) -> Result<()> {
    if access
        .authorization_expires_at
        .is_some_and(|at| at <= Instant::now())
        || access
            .hosted_authority
            .as_ref()
            .is_some_and(|a| !a.load(std::sync::atomic::Ordering::Acquire))
    {
        bail!("connection authorization expired or revoked");
    }
    Ok(())
}
