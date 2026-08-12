//! Bounded, feedback-safe daemon diagnostics.
//!
//! This is intentionally separate from `daemon.log`. The ordinary log contains
//! agent stderr and may contain source or credentials; this ring accepts only a
//! small allowlisted schema and is the only daemon evidence feedback may attach
//! automatically.

use std::collections::VecDeque;
use std::sync::Mutex;

use genehub_proto::{DaemonDiagnosticEvent, DaemonDiagnosticSnapshot};

const MAX_EVENTS: usize = 512;
const MAX_BYTES: usize = 192 * 1024;
const MAX_EVENT_BYTES: usize = 4 * 1024;

#[derive(Default)]
pub struct Diagnostics {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    events: VecDeque<StoredEvent>,
    bytes: usize,
    dropped: u64,
}

struct StoredEvent {
    event: DaemonDiagnosticEvent,
    bytes: usize,
    workspace_scope: Option<String>,
}

impl Diagnostics {
    pub fn record(&self, mut event: DaemonDiagnosticEvent, workspace_scope: Option<&str>) {
        event.at_ms = chrono::Utc::now().timestamp_millis();
        event.kind = bounded_label(&event.kind, 40);
        event.operation = if allowlisted_operation(&event.operation) {
            event.operation
        } else {
            "unknown".to_string()
        };
        event.request_id = event.request_id.filter(|value| valid_request_id(value));
        event.transport = event.transport.and_then(|value| match value.as_str() {
            "websocket" | "fabric" | "rtc" => Some(value),
            _ => None,
        });
        event.outcome = match event.outcome.as_str() {
            "ok" | "error" | "cancelled" | "connected" | "disconnected" => event.outcome,
            _ => "error".to_string(),
        };
        event.path = event.path.filter(|value| safe_relative_path(value));

        let Ok(encoded) = serde_json::to_vec(&event) else {
            self.inner.lock().unwrap().dropped += 1;
            return;
        };
        if encoded.len() > MAX_EVENT_BYTES {
            self.inner.lock().unwrap().dropped += 1;
            return;
        }

        let mut inner = self.inner.lock().unwrap();
        inner.bytes += encoded.len();
        inner.events.push_back(StoredEvent {
            event,
            bytes: encoded.len(),
            workspace_scope: workspace_scope.map(str::to_string),
        });
        while inner.events.len() > MAX_EVENTS || inner.bytes > MAX_BYTES {
            let Some(removed) = inner.events.pop_front() else {
                break;
            };
            inner.bytes = inner.bytes.saturating_sub(removed.bytes);
            inner.dropped += 1;
        }
    }

    /// A machine-level peer sees the full ring; a resource-routed peer sees
    /// only events from its authorized workspace and no global activity count.
    pub fn snapshot(
        &self,
        daemon_version: &str,
        workspace_scope: Option<&str>,
    ) -> DaemonDiagnosticSnapshot {
        let inner = self.inner.lock().unwrap();
        DaemonDiagnosticSnapshot {
            version: 1,
            daemon_version: daemon_version.to_string(),
            captured_at_ms: chrono::Utc::now().timestamp_millis(),
            events: inner
                .events
                .iter()
                .filter(|stored| {
                    workspace_scope.is_none()
                        || stored.workspace_scope.as_deref() == workspace_scope
                })
                .map(|stored| stored.event.clone())
                .collect(),
            dropped_events: if workspace_scope.is_none() {
                inner.dropped
            } else {
                0
            },
        }
    }
}

fn bounded_label(value: &str, maximum: usize) -> String {
    let value: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "._:-".contains(*character))
        .take(maximum)
        .collect();
    if value.is_empty() {
        "unknown".to_string()
    } else {
        value
    }
}

fn valid_request_id(value: &str) -> bool {
    value.len() <= 96
        && ["op_", "preview_", "rtc_", "internal_"]
            .iter()
            .any(|prefix| value.starts_with(prefix) && value.len() >= prefix.len() + 8)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn allowlisted_operation(value: &str) -> bool {
    matches!(
        value,
        "rpc"
            | "data.endpoint"
            | "asset.preview"
            | "rtc.negotiate"
            | "connection.identity"
            | "subscribe"
            | "unsubscribe"
            | "agent.list"
            | "agent.refresh"
            | "session.create"
            | "session.list"
            | "session.get"
            | "round.trunk.list"
            | "round.trunk.get"
            | "blob.get"
            | "session.send"
            | "session.fork"
            | "session.interrupt"
            | "session.close"
            | "session.archive"
            | "session.rename"
            | "session.delete"
            | "session.setModel"
            | "session.setMode"
            | "session.setEffort"
            | "session.respondPermission"
            | "settings.get"
            | "settings.setProvider"
            | "settings.forgetProvider"
            | "log.tail"
            | "diagnostics.snapshot"
            | "update.check"
            | "update.download"
            | "update.downloadState"
            | "update.dismiss"
            | "hub.status"
            | "hub.pair"
            | "hub.trial"
            | "hub.claimLink"
            | "hub.machines"
            | "hub.connect"
            | "hub.unpair"
            | "device.list"
            | "device.invite"
            | "device.claim"
            | "device.revoke"
            | "device.remoteAttach"
            | "device.remoteDetach"
            | "workspace.list"
            | "workspace.open"
            | "workspace.create"
            | "workspace.rename"
            | "workspace.remove"
            | "directory.list"
            | "file.tree"
            | "file.write"
            | "git.status"
            | "git.diff"
            | "git.commit"
            | "pty.open"
            | "pty.write"
            | "pty.resize"
            | "pty.close"
    )
}

fn safe_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1_000
        && !value.contains(['?', '#'])
        && crate::files::validate_preview_path(value).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(index: usize) -> DaemonDiagnosticEvent {
        DaemonDiagnosticEvent {
            at_ms: 0,
            kind: "operation".into(),
            operation: "file.tree".into(),
            request_id: Some(format!("op_{index:08}")),
            transport: Some("fabric".into()),
            outcome: "ok".into(),
            status: Some(200),
            duration_ms: Some(2),
            request_bytes: Some(10),
            response_bytes: Some(20),
            path: Some("r_root/docs/readme.md".into()),
        }
    }

    #[test]
    fn snapshot_is_bounded_and_keeps_the_newest_events() {
        let diagnostics = Diagnostics::default();
        for index in 0..1_000 {
            diagnostics.record(event(index), None);
        }
        let snapshot = diagnostics.snapshot("test", None);
        assert!(snapshot.events.len() <= MAX_EVENTS);
        assert!(snapshot.dropped_events > 0);
        assert_eq!(
            snapshot.events.last().unwrap().request_id.as_deref(),
            Some("op_00000999")
        );
        assert!(serde_json::to_vec(&snapshot).unwrap().len() < 256 * 1024);
    }

    #[test]
    fn unsafe_identifiers_and_physical_paths_are_never_retained() {
        let diagnostics = Diagnostics::default();
        let mut unsafe_event = event(1);
        unsafe_event.operation = "sk-proj-abcdefghijklmnopqrstuvwxyz".into();
        unsafe_event.request_id = Some("ghp_abcdefghijklmnopqrstuvwxyz".into());
        unsafe_event.transport = Some("unknown".into());
        unsafe_event.path = Some("C:/Users/person/private.txt".into());
        diagnostics.record(unsafe_event, None);

        let stored = diagnostics.snapshot("test", None).events.pop().unwrap();
        assert_eq!(stored.operation, "unknown");
        assert_eq!(stored.request_id, None);
        assert_eq!(stored.transport, None);
        assert_eq!(stored.path, None);
    }

    #[test]
    fn resource_scoped_snapshots_do_not_cross_workspace_boundaries() {
        let diagnostics = Diagnostics::default();
        diagnostics.record(event(1), Some("workspace-one"));
        diagnostics.record(event(2), Some("workspace-two"));

        let scoped = diagnostics.snapshot("test", Some("workspace-one"));
        assert_eq!(scoped.events.len(), 1);
        assert_eq!(scoped.events[0].request_id.as_deref(), Some("op_00000001"));
        assert_eq!(diagnostics.snapshot("test", None).events.len(), 2);
    }
}
