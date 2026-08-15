//! Portable daemon business state.
//!
//! Platform crates must not depend on this crate. The Wasm entry crate links it
//! normally, preserving Rust ownership, visibility and memory safety.

use genehub_proto::{ErrorCode, HelloResult, ProtocolError, Reply, Request, PROTOCOL_VERSION};
use genet_daemon_common::{decode_json, encode_json};
use genet_daemon_logic_api::{LogicBoot, LogicOutcome, LogicRequest, SNAPSHOT_FORMAT_VERSION};
use serde::{Deserialize, Serialize};

const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const AUTOMATIC_UPDATE_REFUSAL: &str =
    "自动更新尚未启用：请从官方发布页手动下载，并核对 SHA256SUMS";

#[derive(Clone, Debug)]
pub struct LogicApp {
    boot: LogicBoot,
    handled_requests: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    format_version: u32,
    boot: LogicBoot,
    handled_requests: u64,
}

impl LogicApp {
    pub fn new(boot: LogicBoot) -> Result<Self, String> {
        validate_boot(&boot)?;
        Ok(Self {
            boot,
            handled_requests: 0,
        })
    }

    pub fn handle(&mut self, input: LogicRequest) -> LogicOutcome {
        self.handled_requests = self.handled_requests.saturating_add(1);
        match input.request {
            Request::ConnectionIdentity => {
                LogicOutcome::Reply(Box::new(Reply::Hello(HelloResult {
                    daemon_version: self.boot.daemon_version.clone(),
                    protocol_version: self.boot.protocol_version,
                    machine_id: self.boot.machine_id.clone(),
                    fingerprint: self.boot.fingerprint.clone(),
                    transport: input.transport,
                    machine_name: self.boot.machine_name.clone(),
                    rtc_supported: self.boot.rtc_supported,
                })))
            }
            Request::UpdateCheck | Request::UpdateDownload => LogicOutcome::Error(ProtocolError {
                code: ErrorCode::Unsupported,
                message: AUTOMATIC_UPDATE_REFUSAL.to_string(),
            }),
            Request::SessionSend {
                ref text,
                ref attachments,
                ..
            } if text.trim().is_empty() && attachments.is_empty() => {
                LogicOutcome::Error(ProtocolError {
                    code: ErrorCode::BadRequest,
                    message: "there is nothing to send".to_string(),
                })
            }
            _ => LogicOutcome::ContinueNative,
        }
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        encode_json(
            "logic snapshot",
            &Snapshot {
                format_version: SNAPSHOT_FORMAT_VERSION,
                boot: self.boot.clone(),
                handled_requests: self.handled_requests,
            },
        )
    }

    pub fn restore(bytes: &[u8]) -> Result<Self, String> {
        let snapshot: Snapshot = decode_json("logic snapshot", bytes, MAX_SNAPSHOT_BYTES)?;
        if snapshot.format_version != SNAPSHOT_FORMAT_VERSION {
            return Err(format!(
                "unsupported logic snapshot format {}",
                snapshot.format_version
            ));
        }
        validate_boot(&snapshot.boot)?;
        Ok(Self {
            boot: snapshot.boot,
            handled_requests: snapshot.handled_requests,
        })
    }

    pub fn handled_requests(&self) -> u64 {
        self.handled_requests
    }
}

fn validate_boot(boot: &LogicBoot) -> Result<(), String> {
    if boot.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "logic protocol {} does not match schema {}",
            boot.protocol_version, PROTOCOL_VERSION
        ));
    }
    for (label, value) in [
        ("daemon version", boot.daemon_version.as_str()),
        ("machine id", boot.machine_id.as_str()),
        ("fingerprint", boot.fingerprint.as_str()),
        ("machine name", boot.machine_name.as_str()),
    ] {
        if value.is_empty() {
            return Err(format!("{label} must not be empty"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::TransportKind;

    fn boot() -> LogicBoot {
        LogicBoot {
            daemon_version: "1.2.3".to_string(),
            protocol_version: PROTOCOL_VERSION,
            machine_id: "machine".to_string(),
            fingerprint: "fingerprint".to_string(),
            machine_name: "workstation".to_string(),
            rtc_supported: true,
        }
    }

    #[test]
    fn portable_router_owns_identity_update_policy_and_pure_validation() {
        let mut app = LogicApp::new(boot()).unwrap();
        assert!(matches!(
            app.handle(LogicRequest {
                transport: TransportKind::Loopback,
                request: Request::ConnectionIdentity,
            }),
            LogicOutcome::Reply(reply) if matches!(*reply, Reply::Hello(_))
        ));
        assert!(matches!(
            app.handle(LogicRequest {
                transport: TransportKind::Forwarded,
                request: Request::UpdateDownload,
            }),
            LogicOutcome::Error(ProtocolError {
                code: ErrorCode::Unsupported,
                ..
            })
        ));
        assert_eq!(app.handled_requests(), 2);
    }

    #[test]
    fn snapshot_restores_state_without_platform_interpreting_it() {
        let mut app = LogicApp::new(boot()).unwrap();
        let _ = app.handle(LogicRequest {
            transport: TransportKind::Loopback,
            request: Request::AgentList,
        });
        let restored = LogicApp::restore(&app.snapshot().unwrap()).unwrap();
        assert_eq!(restored.handled_requests(), 1);
    }
}
