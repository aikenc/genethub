//! Privacy-safe support diagnostics kept in memory by the daemon.
//!
//! The ordinary on-machine log remains useful to a person inspecting their own
//! computer, but it can contain paths, subprocess output and provider errors.
//! It must never be silently attached to hosted feedback. This record has the
//! opposite contract: callers can only add compile-time categories, so there is
//! nowhere for user or Agent content to enter it.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Instant;

use genehub_proto::{HubStatus, RemoteAccess, SupportDiagnosticEvent, SupportDiagnostics};

const MAX_EVENTS: usize = 256;

struct Record {
    events: VecDeque<SupportDiagnosticEvent>,
    dropped: u64,
}

pub struct Diagnostics {
    started: Instant,
    record: Mutex<Record>,
}

impl Default for Diagnostics {
    fn default() -> Self {
        Self::new()
    }
}

impl Diagnostics {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            record: Mutex::new(Record {
                events: VecDeque::with_capacity(MAX_EVENTS),
                dropped: 0,
            }),
        }
    }

    /// Adds one allowlisted fact. `&'static str` is the privacy boundary: a
    /// prompt, path, URL, token or arbitrary error message cannot be passed.
    pub fn record(
        &self,
        component: &'static str,
        operation: &'static str,
        outcome: &'static str,
        code: Option<&'static str>,
    ) {
        let mut record = self
            .record
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = record.events.back_mut() {
            if previous.component == component
                && previous.operation == operation
                && previous.outcome == outcome
                && previous.code.as_deref() == code
            {
                previous.at = now();
                previous.count = previous.count.saturating_add(1);
                return;
            }
        }
        if record.events.len() == MAX_EVENTS {
            record.events.pop_front();
            record.dropped = record.dropped.saturating_add(1);
        }
        record.events.push_back(SupportDiagnosticEvent {
            at: now(),
            component: component.to_string(),
            operation: operation.to_string(),
            outcome: outcome.to_string(),
            code: code.map(str::to_string),
            count: 1,
        });
    }

    pub fn snapshot(
        &self,
        daemon_version: &str,
        hub: &HubStatus,
        remote: &RemoteAccess,
    ) -> SupportDiagnostics {
        let record = self
            .record
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        SupportDiagnostics {
            version: 1,
            captured_at: now(),
            daemon_version: daemon_version.to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            uptime_seconds: self.started.elapsed().as_secs(),
            hub_state: hub_state(hub).to_string(),
            remote_state: remote_state(remote).to_string(),
            events: record.events.iter().cloned().collect(),
            dropped_events: record.dropped,
        }
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn hub_state(status: &HubStatus) -> &'static str {
    match status {
        HubStatus::Unpaired => "unpaired",
        HubStatus::Pairing { .. } => "pairing",
        HubStatus::Paired { online: true, .. } => "online",
        HubStatus::Paired { online: false, .. } => "offline",
        HubStatus::Failed { .. } => "failed",
    }
}

fn remote_state(status: &RemoteAccess) -> &'static str {
    if status.relay_url.is_none() {
        "disabled"
    } else if status.online {
        "online"
    } else {
        "offline"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote() -> RemoteAccess {
        RemoteAccess {
            relay_url: None,
            rendezvous_url: None,
            online: false,
        }
    }

    #[test]
    fn coalesces_repeated_categories_without_accepting_runtime_text() {
        let diagnostics = Diagnostics::new();
        diagnostics.record("rpc", "file.write", "error", Some("forbidden"));
        diagnostics.record("rpc", "file.write", "error", Some("forbidden"));

        let snapshot = diagnostics.snapshot("0.1.0", &HubStatus::Unpaired, &remote());
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.events[0].count, 2);
        assert_eq!(snapshot.events[0].operation, "file.write");
        assert_eq!(snapshot.hub_state, "unpaired");
        assert_eq!(snapshot.remote_state, "disabled");
    }

    #[test]
    fn bounds_the_ring_and_reports_eviction() {
        let diagnostics = Diagnostics::new();
        for index in 0..=MAX_EVENTS {
            let outcome = if index % 2 == 0 { "ok" } else { "error" };
            diagnostics.record("rpc", "workspace.open", outcome, None);
        }
        let snapshot = diagnostics.snapshot("0.1.0", &HubStatus::Unpaired, &remote());
        assert_eq!(snapshot.events.len(), MAX_EVENTS);
        assert_eq!(snapshot.dropped_events, 1);
    }
}
