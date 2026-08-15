//! Portable daemon business state.
//!
//! Platform crates must not depend on this crate. The Wasm entry crate links it
//! normally, preserving Rust ownership, visibility and memory safety.

use genehub_proto::{
    ErrorCode, HelloResult, LogEntry, LogTail, LogicModuleStatus, ProtocolError, Reply, Request,
    TransportKind, PROTOCOL_VERSION,
};
use genet_daemon_common::{decode_json, encode_json};
use genet_daemon_logic_api::{
    CapabilityBatch, CapabilityCall, CapabilityFailureKind, CapabilityRequest, CapabilityResults,
    CapabilityValue, LogicArtifactRequest, LogicBoot, LogicInput, LogicOutcome, LogicOutput,
    LogicRequest, SNAPSHOT_FORMAT_VERSION,
};
use serde::{Deserialize, Serialize};

const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const AUTOMATIC_UPDATE_REFUSAL: &str =
    "自动更新尚未启用：请从官方发布页手动下载，并核对 SHA256SUMS";

#[derive(Clone, Debug)]
pub struct LogicApp {
    boot: LogicBoot,
    handled_requests: u64,
    pending: std::collections::BTreeMap<u64, Pending>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    format_version: u32,
    boot: LogicBoot,
    handled_requests: u64,
    pending: std::collections::BTreeMap<u64, Pending>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    call_id: u64,
}

impl LogicApp {
    pub fn new(boot: LogicBoot) -> Result<Self, String> {
        validate_boot(&boot)?;
        Ok(Self {
            boot,
            handled_requests: 0,
            pending: std::collections::BTreeMap::new(),
        })
    }

    pub fn handle(&mut self, input: LogicInput) -> LogicOutput {
        match input {
            LogicInput::Request(request) => {
                self.handled_requests = self.handled_requests.saturating_add(1);
                self.handle_request(request)
            }
            // Capability routing lands before the first migrated asynchronous
            // domain. Unknown resource events are intentionally harmless so a
            // late OS close from a replaced instance cannot trap its successor.
            LogicInput::CapabilityResults(results) => self.handle_capability_results(results),
            LogicInput::CapabilityEvent(_) => LogicOutput::default(),
        }
    }

    fn handle_request(&mut self, input: LogicRequest) -> LogicOutput {
        let call_id = input.call_id;
        let transport = input.transport;
        let outcome = match input.request {
            Request::DaemonLogicStatus => {
                return self.request_artifact(call_id, LogicArtifactRequest::Status)
            }
            Request::DaemonLogicInstall { path } => {
                if transport != TransportKind::Loopback {
                    LogicOutcome::Error(ProtocolError {
                        code: ErrorCode::Forbidden,
                        message: "daemon logic may only be installed over loopback".to_string(),
                    })
                } else {
                    return self.request_artifact(
                        call_id,
                        LogicArtifactRequest::Install { native_path: path },
                    );
                }
            }
            Request::DaemonLogicRollback => {
                if transport != TransportKind::Loopback {
                    LogicOutcome::Error(ProtocolError {
                        code: ErrorCode::Forbidden,
                        message: "daemon logic may only be rolled back over loopback".to_string(),
                    })
                } else {
                    return self.request_artifact(call_id, LogicArtifactRequest::Rollback);
                }
            }
            Request::ConnectionIdentity => {
                LogicOutcome::Reply(Box::new(Reply::Hello(HelloResult {
                    daemon_version: self.boot.daemon_version.clone(),
                    protocol_version: self.boot.protocol_version,
                    machine_id: self.boot.machine_id.clone(),
                    fingerprint: self.boot.fingerprint.clone(),
                    transport,
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
            Request::LogTail { name } => self.read_log(name),
            _ => LogicOutcome::ContinueNative,
        };
        LogicOutput::completed(call_id, outcome)
    }

    fn request_artifact(&mut self, call_id: u64, request: LogicArtifactRequest) -> LogicOutput {
        self.pending.insert(call_id, Pending { call_id });
        LogicOutput {
            capability_batches: vec![CapabilityBatch {
                batch_id: call_id,
                calls: vec![CapabilityCall {
                    call_id,
                    request: CapabilityRequest::LogicArtifact(request),
                }],
            }],
            ..LogicOutput::default()
        }
    }

    fn handle_capability_results(&mut self, results: CapabilityResults) -> LogicOutput {
        let Some(pending) = self.pending.remove(&results.batch_id) else {
            return LogicOutput::default();
        };
        let outcome = match results.results.as_slice() {
            [result] if result.call_id == pending.call_id => match &result.result {
                Ok(CapabilityValue::LogicArtifact(state)) => {
                    LogicOutcome::Reply(Box::new(Reply::LogicModule(LogicModuleStatus {
                        loaded: true,
                        version: Some(state.version.clone()),
                        digest: Some(state.digest.clone()),
                        origin: Some(state.origin.clone()),
                        generation: state.generation,
                    })))
                }
                Ok(_) => LogicOutcome::Error(ProtocolError {
                    code: ErrorCode::Internal,
                    message: "logic artifact capability returned the wrong value".to_string(),
                }),
                Err(error) => LogicOutcome::Error(ProtocolError {
                    code: match error.kind {
                        CapabilityFailureKind::Invalid => ErrorCode::BadRequest,
                        CapabilityFailureKind::Denied => ErrorCode::Forbidden,
                        CapabilityFailureKind::NotFound => ErrorCode::NotFound,
                        CapabilityFailureKind::Conflict => ErrorCode::Conflict,
                        CapabilityFailureKind::Unavailable
                        | CapabilityFailureKind::TooLarge
                        | CapabilityFailureKind::Internal => ErrorCode::Internal,
                    },
                    message: error.message.clone(),
                }),
            },
            _ => LogicOutcome::Error(ProtocolError {
                code: ErrorCode::Internal,
                message: "logic artifact capability returned a malformed batch".to_string(),
            }),
        };
        LogicOutput::completed(pending.call_id, outcome)
    }

    fn read_log(&self, name: Option<String>) -> LogicOutcome {
        let name = name.unwrap_or_else(|| "daemon.log".to_string());
        let directory = std::path::Path::new(&self.boot.log_directory);
        match portable_logs::tail(directory, &name, portable_logs::DEFAULT_TAIL_BYTES) {
            Ok(text) => LogicOutcome::Reply(Box::new(Reply::Log(LogTail {
                path: std::path::Path::new(&self.boot.log_display_directory)
                    .join(&name)
                    .display()
                    .to_string(),
                name,
                text,
                files: portable_logs::list(directory)
                    .into_iter()
                    .map(|(name, bytes)| LogEntry { name, bytes })
                    .collect(),
            }))),
            Err(message) => LogicOutcome::Error(ProtocolError {
                code: if message.contains("不是一个日志文件名") {
                    ErrorCode::BadRequest
                } else if message.contains("does not exist")
                    || message.contains("No such file")
                    || message.contains("找不到")
                {
                    ErrorCode::NotFound
                } else {
                    ErrorCode::Internal
                },
                message,
            }),
        }
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        encode_json(
            "logic snapshot",
            &Snapshot {
                format_version: SNAPSHOT_FORMAT_VERSION,
                boot: self.boot.clone(),
                handled_requests: self.handled_requests,
                pending: self.pending.clone(),
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
            pending: snapshot.pending,
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
        ("log directory", boot.log_directory.as_str()),
        ("log display directory", boot.log_display_directory.as_str()),
    ] {
        if value.is_empty() {
            return Err(format!("{label} must not be empty"));
        }
    }
    Ok(())
}

mod portable_logs {
    use std::io::{Read, Seek, SeekFrom};
    use std::path::Path;

    pub const DEFAULT_TAIL_BYTES: usize = 64 * 1024;

    pub fn list(directory: &Path) -> Vec<(String, u64)> {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return Vec::new();
        };
        let mut found = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let metadata = entry.path().symlink_metadata().ok()?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return None;
                }
                Some((
                    entry.file_name().to_string_lossy().to_string(),
                    metadata.len(),
                    metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                ))
            })
            .collect::<Vec<_>>();
        found.sort_by_key(|(_, _, modified)| std::cmp::Reverse(*modified));
        found
            .into_iter()
            .map(|(name, bytes, _)| (name, bytes))
            .collect()
    }

    pub fn tail(directory: &Path, name: &str, bytes: usize) -> Result<String, String> {
        if name.is_empty() || Path::new(name).components().count() != 1 {
            return Err(format!("{name} 不是一个日志文件名"));
        }
        let path = directory.join(name);
        let metadata = path
            .symlink_metadata()
            .map_err(|error| format!("打不开 {name}：{error}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!("打不开 {name}：not a regular log file"));
        }
        let mut file =
            std::fs::File::open(&path).map_err(|error| format!("打不开 {name}：{error}"))?;
        let from = metadata.len().saturating_sub(bytes as u64);
        file.seek(SeekFrom::Start(from))
            .map_err(|error| format!("读取 {name}：{error}"))?;
        let mut raw = Vec::new();
        file.take(bytes as u64)
            .read_to_end(&mut raw)
            .map_err(|error| format!("读取 {name}：{error}"))?;
        let text = String::from_utf8_lossy(&raw).to_string();
        if from == 0 {
            return Ok(text);
        }
        Ok(match text.find('\n') {
            Some(at) => text[at + 1..].to_string(),
            None => text,
        })
    }
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
            log_directory: ".".to_string(),
            log_display_directory: "/host/logs".to_string(),
        }
    }

    #[test]
    fn portable_router_owns_identity_update_policy_and_pure_validation() {
        let mut app = LogicApp::new(boot()).unwrap();
        assert!(matches!(
            app.handle(LogicInput::Request(LogicRequest {
                call_id: 1,
                transport: TransportKind::Loopback,
                request: Request::ConnectionIdentity,
            })),
            LogicOutput { completions, .. }
                if matches!(completions.as_slice(), [genet_daemon_logic_api::LogicCompletion {
                    outcome: LogicOutcome::Reply(reply),
                    ..
                }] if matches!(**reply, Reply::Hello(_)))
        ));
        assert!(matches!(
            app.handle(LogicInput::Request(LogicRequest {
                call_id: 2,
                transport: TransportKind::Forwarded,
                request: Request::UpdateDownload,
            })),
            LogicOutput { completions, .. }
                if matches!(completions.as_slice(), [genet_daemon_logic_api::LogicCompletion {
                    outcome: LogicOutcome::Error(ProtocolError {
                        code: ErrorCode::Unsupported,
                        ..
                    }),
                    ..
                }])
        ));
        assert_eq!(app.handled_requests(), 2);
    }

    #[test]
    fn snapshot_restores_state_without_platform_interpreting_it() {
        let mut app = LogicApp::new(boot()).unwrap();
        let _ = app.handle(LogicInput::Request(LogicRequest {
            call_id: 1,
            transport: TransportKind::Loopback,
            request: Request::AgentList,
        }));
        let restored = LogicApp::restore(&app.snapshot().unwrap()).unwrap();
        assert_eq!(restored.handled_requests(), 1);
    }

    #[test]
    fn artifact_control_survives_hot_state_transfer_mid_capability() {
        let mut app = LogicApp::new(boot()).unwrap();
        let output = app.handle(LogicInput::Request(LogicRequest {
            call_id: 41,
            transport: TransportKind::Loopback,
            request: Request::DaemonLogicStatus,
        }));
        assert!(output.completions.is_empty());
        assert!(matches!(
            output.capability_batches.as_slice(),
            [CapabilityBatch { batch_id: 41, calls }]
                if matches!(calls.as_slice(), [CapabilityCall {
                    request: CapabilityRequest::LogicArtifact(LogicArtifactRequest::Status),
                    ..
                }])
        ));

        let mut restored = LogicApp::restore(&app.snapshot().unwrap()).unwrap();
        let output = restored.handle(LogicInput::CapabilityResults(CapabilityResults {
            batch_id: 41,
            results: vec![genet_daemon_logic_api::CapabilityResult {
                call_id: 41,
                result: Ok(CapabilityValue::LogicArtifact(
                    genet_daemon_logic_api::LogicArtifactState {
                        version: "next".into(),
                        digest: "abc".into(),
                        origin: "installed".into(),
                        generation: 7,
                    },
                )),
            }],
        }));
        assert!(matches!(
            output.completions.as_slice(),
            [genet_daemon_logic_api::LogicCompletion {
                call_id: 41,
                outcome: LogicOutcome::Reply(reply),
                ..
            }] if matches!(**reply, Reply::LogicModule(LogicModuleStatus { generation: 7, .. }))
        ));
    }

    #[test]
    fn log_reading_is_portable_business_logic_and_rejects_path_escape() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("daemon.log"),
            "first\nsecond\nthird\n",
        )
        .unwrap();
        let mut config = boot();
        config.log_directory = directory.path().display().to_string();
        let mut app = LogicApp::new(config).unwrap();

        let output = app.handle(LogicInput::Request(LogicRequest {
            call_id: 1,
            transport: TransportKind::Loopback,
            request: Request::LogTail { name: None },
        }));
        assert!(matches!(
            output.completions.as_slice(),
            [genet_daemon_logic_api::LogicCompletion {
                outcome: LogicOutcome::Reply(reply),
                ..
            }] if matches!(**reply, Reply::Log(LogTail { ref text, .. }) if text.ends_with("third\n"))
        ));

        assert!(matches!(
            app.handle(LogicInput::Request(LogicRequest {
                call_id: 2,
                transport: TransportKind::Forwarded,
                request: Request::LogTail {
                    name: Some("../config.json".to_string()),
                },
            })),
            LogicOutput { completions, .. }
                if matches!(completions.as_slice(), [genet_daemon_logic_api::LogicCompletion {
                    outcome: LogicOutcome::Error(ProtocolError {
                        code: ErrorCode::BadRequest,
                        ..
                    }),
                    ..
                }])
        ));
    }
}
