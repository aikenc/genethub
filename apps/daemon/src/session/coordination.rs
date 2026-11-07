//! Bounded, read-only projections published by timer-driven coordinators.
//! The coordinator owns durable obligations. This file is a replaceable view,
//! never an execution lock or a second task state machine.
use genehub_proto::SessionCoordinationSummary;
use serde::Deserialize;
use std::io::Read;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    version: u32,
    updated_at_ms: i64,
    #[serde(default)]
    received_at_ms: Option<i64>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    revision: Option<u64>,
    sessions: HashMap<String, SessionCoordinationSummary>,
}
struct Entry {
    checked: Instant,
    snapshot: Option<Snapshot>,
    unavailable: bool,
}
#[derive(Default, Clone)]
pub(super) struct Cache(Arc<Mutex<HashMap<PathBuf, Entry>>>);
impl Cache {
    pub(super) fn read(&self, home: &Path, session: &str) -> Option<SessionCoordinationSummary> {
        let path = home.join("session-coordination.json");
        let mut cache = self.0.lock().ok()?;
        let now = Instant::now();
        let entry = cache.entry(path.clone()).or_insert_with(|| Entry {
            checked: now - Duration::from_secs(3),
            snapshot: None,
            unavailable: false,
        });
        if now.duration_since(entry.checked) >= Duration::from_secs(2) {
            entry.checked = now;
            let read = || -> anyhow::Result<Option<Snapshot>> {
                let meta = match std::fs::symlink_metadata(&path) {
                    Ok(meta) => meta,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(error) => return Err(error.into()),
                };
                anyhow::ensure!(
                    meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 524288,
                    "invalid coordination projection"
                );
                let mut bytes = Vec::new();
                std::fs::File::open(&path)?
                    .take(524289)
                    .read_to_end(&mut bytes)?;
                anyhow::ensure!(bytes.len() <= 524288, "oversized coordination projection");
                let value: Snapshot = serde_json::from_slice(&bytes)?;
                anyhow::ensure!(
                    value.version == 1 && value.sessions.len() <= 4096 && value.updated_at_ms > 0,
                    "unsupported coordination projection"
                );
                anyhow::ensure!(
                    value.sessions.values().all(|s| s.source.len() <= 200
                        && s.task_id.as_ref().is_none_or(|id| id.len() <= 200)),
                    "oversized coordination identity"
                );
                Ok(Some(value))
            };
            match read() {
                Ok(Some(snapshot)) => {
                    let ordered = entry.snapshot.as_ref().is_none_or(|old| {
                        match (old.revision, snapshot.revision) {
                            (Some(before), Some(after)) => {
                                old.source == snapshot.source && after >= before
                            }
                            (Some(_), None) => false,
                            _ => true,
                        }
                    });
                    if ordered {
                        entry.snapshot = Some(snapshot);
                    }
                    entry.unavailable = !ordered;
                }
                Ok(None)
                    if entry.snapshot.is_none()
                        && !home.join("coordination-source.json").exists() =>
                {
                    entry.unavailable = false
                }
                Ok(None) | Err(_) => entry.unavailable = true,
            }
        }
        let mut summary = entry
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.sessions.get(session))
            .cloned();
        if let Some(value) = summary.as_mut() {
            value.updated_at_ms = entry
                .snapshot
                .as_ref()
                .map(|s| s.updated_at_ms)
                .unwrap_or(0);
            value.stale = entry.unavailable
                || super::store::now_ms().saturating_sub(
                    entry
                        .snapshot
                        .as_ref()
                        .and_then(|s| s.received_at_ms)
                        .unwrap_or(value.updated_at_ms),
                ) > 120_000;
        } else if entry.unavailable {
            summary = Some(SessionCoordinationSummary {
                source: "unavailable".into(),
                active: true,
                unknown: 1,
                stale: true,
                ..Default::default()
            });
        }
        summary
    }
}
