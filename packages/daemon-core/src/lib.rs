//! Portable daemon business state.
//!
//! Platform crates must not depend on this crate. The Wasm entry crate links it
//! normally, preserving Rust ownership, visibility and memory safety.

mod agents;
mod capability;
mod config;
mod devices;
mod files;
mod git;
mod session;
mod terminal;
mod workspace;

use std::collections::{BTreeMap, HashMap};

use genehub_proto::{
    ErrorCode, HelloResult, LogicModuleStatus, ProtocolError, RemoteAccess, Reply, Request,
    TransportKind, UpdateDownload, PROTOCOL_VERSION,
};
use genet_daemon_common::{decode_json, encode_json};
use genet_daemon_logic_api::{
    CapabilityBatch, CapabilityCall, CapabilityFailureKind, CapabilityRequest, CapabilityResults,
    CapabilityValue, ConnectivityRequest, FileLocator, FileRequest, FileRoot, LogicArtifactRequest,
    LogicBoot, LogicInput, LogicOutcome, LogicOutput, LogicRequest, PlatformCall,
    PlatformCompletion, PlatformReply, PlatformRequest, SNAPSHOT_FORMAT_VERSION,
};
use serde::{Deserialize, Serialize};

const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const AUTOMATIC_UPDATE_REFUSAL: &str =
    "自动更新尚未启用：请从官方发布页手动下载，并核对 SHA256SUMS";

#[derive(Clone, Debug)]
pub struct LogicApp {
    boot: LogicBoot,
    handled_requests: u64,
    next_capability_id: u64,
    pending: std::collections::BTreeMap<u64, Pending>,
    config: Option<config::Config>,
    discoveries: BTreeMap<String, config::Discovery>,
    agent_cache: Option<Vec<genehub_proto::AgentInfo>>,
    sessions: session::Sessions,
    terminals: HashMap<String, u64>,
    devices: devices::Devices,
    remote_access: RemoteAccess,
    update_download: UpdateDownload,
    workspace_roots_ready: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    format_version: u32,
    boot: LogicBoot,
    handled_requests: u64,
    next_capability_id: u64,
    pending: BTreeMap<u64, Pending>,
    config: Option<config::Config>,
    discoveries: BTreeMap<String, config::Discovery>,
    agent_cache: Option<Vec<genehub_proto::AgentInfo>>,
    sessions: session::Sessions,
    terminals: HashMap<String, u64>,
    #[serde(default)]
    devices: devices::Devices,
    #[serde(default = "offline_remote")]
    remote_access: RemoteAccess,
    #[serde(default = "idle_download")]
    update_download: UpdateDownload,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    call_id: u64,
}

/// Typed guest-side access to the one opaque byte-batch platform import.
/// Native tests provide a deterministic fake; the Wasm entry provides the
/// actual import. Product code never calls a string-shaped host function.
pub trait CapabilityExecutor {
    fn execute(&mut self, batch: CapabilityBatch) -> Result<CapabilityResults, String>;
}

struct NoCapabilities;

impl CapabilityExecutor for NoCapabilities {
    fn execute(&mut self, _batch: CapabilityBatch) -> Result<CapabilityResults, String> {
        Err("synchronous system capabilities are unavailable".to_string())
    }
}

impl LogicApp {
    pub fn new(boot: LogicBoot) -> Result<Self, String> {
        validate_boot(&boot)?;
        Ok(Self {
            boot,
            handled_requests: 0,
            next_capability_id: 1,
            pending: BTreeMap::new(),
            config: None,
            discoveries: BTreeMap::new(),
            agent_cache: None,
            sessions: session::Sessions::default(),
            terminals: HashMap::new(),
            devices: devices::Devices::default(),
            remote_access: offline_remote(),
            update_download: UpdateDownload::Idle,
            workspace_roots_ready: false,
        })
    }

    pub fn handle(&mut self, input: LogicInput) -> LogicOutput {
        self.handle_with(input, &mut NoCapabilities)
    }

    pub fn handle_with(
        &mut self,
        input: LogicInput,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutput {
        match input {
            LogicInput::Request(request) => {
                self.handled_requests = self.handled_requests.saturating_add(1);
                self.handle_request(request, capabilities)
            }
            LogicInput::Platform(call) => self.handle_platform(call, capabilities),
            LogicInput::CapabilityResults(results) => self.handle_capability_results(results),
            // Unknown or stale resource events are intentionally harmless so a
            // late OS close from a replaced instance cannot trap its successor.
            LogicInput::CapabilityEvent(event) => {
                let mut output = terminal::event(&mut self.terminals, event.clone());
                let mut session = session::event(
                    &mut self.sessions,
                    event,
                    capabilities,
                    &mut self.next_capability_id,
                );
                output.publications.append(&mut session.publications);
                output
                    .capability_batches
                    .append(&mut session.capability_batches);
                output
            }
        }
    }

    fn handle_request(
        &mut self,
        input: LogicRequest,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutput {
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
            request @ (Request::Subscribe { .. }
            | Request::Unsubscribe { .. }
            | Request::SessionCreate { .. }
            | Request::SessionList { .. }
            | Request::SessionGet { .. }
            | Request::RoundTrunkList { .. }
            | Request::RoundTrunkGet { .. }
            | Request::BlobGet { .. }
            | Request::SessionSend { .. }
            | Request::SessionFork { .. }
            | Request::SessionInterrupt { .. }
            | Request::SessionClose { .. }
            | Request::SessionArchive { .. }
            | Request::SessionRename { .. }
            | Request::SessionDelete { .. }
            | Request::SessionSetModel { .. }
            | Request::SessionSetMode { .. }
            | Request::SessionSetEffort { .. }
            | Request::SessionRespondPermission { .. }) => {
                return self.request_session(call_id, request, capabilities)
            }
            Request::AgentList => self.agent_list(false, capabilities),
            Request::AgentRefresh => self.agent_list(true, capabilities),
            Request::UpdateCheck | Request::UpdateDownload => LogicOutcome::Error(ProtocolError {
                code: ErrorCode::Unsupported,
                message: AUTOMATIC_UPDATE_REFUSAL.to_string(),
            }),
            Request::UpdateDownloadState => LogicOutcome::Reply(Box::new(Reply::UpdateDownload(
                self.update_download.clone(),
            ))),
            Request::UpdateDismiss => {
                if !matches!(self.update_download, UpdateDownload::Fetching { .. }) {
                    self.update_download = UpdateDownload::Idle;
                }
                LogicOutcome::Reply(Box::new(Reply::UpdateDownload(
                    self.update_download.clone(),
                )))
            }
            Request::DeviceList => match self.refresh_remote(capabilities).and_then(|()| {
                self.devices
                    .list(capabilities, &mut self.next_capability_id)
            }) {
                Ok(devices) => LogicOutcome::Reply(Box::new(Reply::Devices {
                    devices,
                    remote: self.remote_access.clone(),
                })),
                Err(error) => LogicOutcome::Error(error),
            },
            Request::DeviceInvite => match self.refresh_remote(capabilities).and_then(|()| {
                self.devices.invite(
                    &self.remote_access,
                    capabilities,
                    &mut self.next_capability_id,
                )
            }) {
                Ok(invite) => LogicOutcome::Reply(Box::new(Reply::Invite(invite))),
                Err(error) => LogicOutcome::Error(error),
            },
            Request::DeviceRevoke { device_id } => {
                match self
                    .devices
                    .revoke(&device_id, capabilities, &mut self.next_capability_id)
                {
                    Ok(publications) => {
                        let devices = match self
                            .devices
                            .list(capabilities, &mut self.next_capability_id)
                        {
                            Ok(devices) => devices,
                            Err(error) => {
                                return LogicOutput::completed(call_id, LogicOutcome::Error(error))
                            }
                        };
                        return LogicOutput {
                            completions: vec![genet_daemon_logic_api::LogicCompletion {
                                call_id,
                                outcome: LogicOutcome::Reply(Box::new(Reply::Devices {
                                    devices,
                                    remote: self.remote_access.clone(),
                                })),
                                connection: genet_daemon_logic_api::ConnectionDirective::None,
                            }],
                            publications,
                            ..LogicOutput::default()
                        };
                    }
                    Err(error) => LogicOutcome::Error(error),
                }
            }
            Request::DeviceClaim { .. } => LogicOutcome::Error(ProtocolError {
                code: ErrorCode::Unauthorized,
                message: "配对邀请只能在对应的加密引导连接中兑换".to_string(),
            }),
            Request::DeviceRemoteAttach {
                relay_url,
                join_token,
            } => self.remote_change(
                ConnectivityRequest::RemoteAttach {
                    relay_url,
                    join_token,
                },
                capabilities,
            ),
            Request::DeviceRemoteDetach => {
                self.remote_change(ConnectivityRequest::RemoteDetach, capabilities)
            }
            Request::HubStatus => self.hub_change(ConnectivityRequest::HubStatus, capabilities),
            Request::HubPair {
                hub_url,
                display_name,
            } => self.hub_change(
                ConnectivityRequest::HubPair {
                    hub_url,
                    display_name,
                },
                capabilities,
            ),
            Request::HubTrial {
                hub_url,
                display_name,
            } => self.hub_change(
                ConnectivityRequest::HubTrial {
                    hub_url,
                    display_name,
                },
                capabilities,
            ),
            Request::HubClaimLink => {
                self.hub_change(ConnectivityRequest::HubClaimLink, capabilities)
            }
            Request::HubMachines => self.hub_change(ConnectivityRequest::HubMachines, capabilities),
            Request::HubConnect { machine_id } => {
                self.hub_change(ConnectivityRequest::HubConnect { machine_id }, capabilities)
            }
            Request::HubUnpair => self.hub_change(ConnectivityRequest::HubUnpair, capabilities),
            Request::LogTail { name } => self.read_log(name, capabilities),
            Request::SettingsGet => self.settings(capabilities),
            Request::SettingsSetProvider {
                provider_id,
                api_key,
                base_url,
                label,
                dialect,
                models,
            } => self.set_provider(
                provider_id,
                api_key,
                base_url,
                label,
                dialect,
                models,
                capabilities,
            ),
            Request::SettingsForgetProvider { provider_id } => {
                self.forget_provider(provider_id, capabilities)
            }
            Request::WorkspaceList => self.workspace_list(capabilities),
            Request::WorkspaceOpen { root } => self.workspace_open(root, None, false, capabilities),
            Request::WorkspaceCreate { root, name } => {
                self.workspace_open(root, Some(name), true, capabilities)
            }
            Request::WorkspaceRename { workspace_id, name } => {
                self.workspace_rename(workspace_id, name, capabilities)
            }
            Request::WorkspaceRemove { workspace_id } => {
                self.workspace_remove(workspace_id, capabilities)
            }
            Request::DirectoryList { path } => {
                match workspace::directory(
                    path,
                    self.boot.home_directory.as_deref(),
                    capabilities,
                    &mut self.next_capability_id,
                ) {
                    Ok(directory) => LogicOutcome::Reply(Box::new(Reply::Directory(directory))),
                    Err(error) => LogicOutcome::Error(error),
                }
            }
            Request::FileTree {
                workspace_id,
                path,
                depth,
            } => self.file_tree(workspace_id, path, depth, capabilities),
            Request::FileWrite {
                workspace_id,
                path,
                content,
            } => self.file_write(workspace_id, path, content, capabilities),
            Request::GitStatus { workspace_id } => self.git_status(workspace_id, capabilities),
            Request::GitDiff { workspace_id, path } => {
                self.git_diff(workspace_id, path, capabilities)
            }
            Request::GitCommit {
                workspace_id,
                message,
                paths,
            } => self.git_commit(workspace_id, message, paths, capabilities),
            Request::PtyOpen {
                workspace_id,
                cols,
                rows,
            } => self.pty_open(
                workspace_id,
                cols.unwrap_or(80),
                rows.unwrap_or(24),
                capabilities,
            ),
            Request::PtyWrite { pty_id, data } => terminal::reply(terminal::write(
                &self.terminals,
                &pty_id,
                data,
                capabilities,
                &mut self.next_capability_id,
            )),
            Request::PtyResize { pty_id, cols, rows } => terminal::reply(terminal::resize(
                &self.terminals,
                &pty_id,
                cols,
                rows,
                capabilities,
                &mut self.next_capability_id,
            )),
            Request::PtyClose { pty_id } => terminal::reply(terminal::close(
                &self.terminals,
                &pty_id,
                capabilities,
                &mut self.next_capability_id,
            )),
        };
        LogicOutput::completed(call_id, outcome)
    }

    fn request_session(
        &mut self,
        call_id: u64,
        request: Request,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutput {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutput::completed(call_id, LogicOutcome::Error(error));
        }
        let config = self.config.as_ref().expect("config loaded").clone();
        session::request(
            &mut self.sessions,
            call_id,
            request,
            &self.boot,
            &config,
            capabilities,
            &mut self.next_capability_id,
        )
    }

    fn handle_platform(
        &mut self,
        call: PlatformCall,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutput {
        let result = match call.request {
            PlatformRequest::AuthenticateDevice { auth, server_nonce } => {
                self.devices.authenticate_device(
                    &auth,
                    &server_nonce,
                    capabilities,
                    &mut self.next_capability_id,
                )
            }
            PlatformRequest::AuthenticateInvite { auth, server_nonce } => {
                self.devices.authenticate_invite(
                    &auth,
                    &server_nonce,
                    capabilities,
                    &mut self.next_capability_id,
                )
            }
            PlatformRequest::ClaimAuthenticatedInvite {
                invite_id,
                device_name,
            } => self.devices.claim_authenticated(
                &invite_id,
                &device_name,
                &self.boot,
                capabilities,
                &mut self.next_capability_id,
            ),
            PlatformRequest::DeviceConnection {
                device_id,
                connected,
            } => self.devices.connection(
                &device_id,
                connected,
                capabilities,
                &mut self.next_capability_id,
            ),
            PlatformRequest::WorkspaceCatalog => self.platform_workspace_catalog(capabilities),
            PlatformRequest::ResolveWorkspaceFile { workspace_id, path } => {
                self.platform_workspace_file(&workspace_id, &path, capabilities)
            }
        };
        LogicOutput {
            platform_completions: vec![PlatformCompletion {
                call_id: call.call_id,
                result,
            }],
            ..LogicOutput::default()
        }
    }

    fn platform_workspace_catalog(
        &mut self,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<PlatformReply, ProtocolError> {
        self.ensure_workspaces(capabilities)?;
        let config = self.config.as_ref().expect("config loaded");
        let mut workspaces = config
            .workspaces
            .iter()
            .filter(|workspace| !workspace.removed)
            .map(|workspace| genet_daemon_logic_api::CatalogWorkspace {
                local_workspace_id: workspace.id.clone(),
                reported_name: workspace.name.clone(),
                is_git_repo: workspace.is_git_repo,
            })
            .collect::<Vec<_>>();
        workspaces.sort_by(|left, right| {
            left.reported_name
                .cmp(&right.reported_name)
                .then(left.local_workspace_id.cmp(&right.local_workspace_id))
        });
        Ok(PlatformReply::WorkspaceCatalog(
            genet_daemon_logic_api::WorkspaceCatalog {
                generation: config.workspace_catalog_generation.clone(),
                revision: config.workspace_catalog_revision,
                workspaces,
            },
        ))
    }

    fn platform_workspace_file(
        &mut self,
        workspace_id: &str,
        path: &str,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<PlatformReply, ProtocolError> {
        self.ensure_workspaces(capabilities)?;
        let workspace =
            workspace::workspace(self.config.as_ref().expect("config loaded"), workspace_id)?;
        Ok(PlatformReply::WorkspaceFile(files::resolve_locator(
            &workspace, path,
        )?))
    }

    fn connectivity(
        &mut self,
        request: ConnectivityRequest,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<CapabilityValue, ProtocolError> {
        let mut client = capability::Client::new(capabilities, &mut self.next_capability_id);
        client.call(CapabilityRequest::Connectivity(request))
    }

    fn refresh_remote(
        &mut self,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<(), ProtocolError> {
        match self.connectivity(ConnectivityRequest::RemoteStatus, capabilities)? {
            CapabilityValue::RemoteAccess(remote) => {
                self.remote_access = remote;
                Ok(())
            }
            _ => Err(ProtocolError {
                code: ErrorCode::Internal,
                message: "remote connectivity returned the wrong value".to_string(),
            }),
        }
    }

    fn remote_change(
        &mut self,
        request: ConnectivityRequest,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        match self.connectivity(request, capabilities) {
            Ok(CapabilityValue::RemoteAccess(remote)) => {
                self.remote_access = remote.clone();
                LogicOutcome::Reply(Box::new(Reply::RemoteAccess(remote)))
            }
            Ok(_) => LogicOutcome::Error(ProtocolError {
                code: ErrorCode::Internal,
                message: "remote connectivity returned the wrong value".to_string(),
            }),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn hub_change(
        &mut self,
        request: ConnectivityRequest,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        match self.connectivity(request, capabilities) {
            Ok(CapabilityValue::HubStatus(status)) => {
                LogicOutcome::Reply(Box::new(Reply::HubStatus(status)))
            }
            Ok(CapabilityValue::HubClaim { status, claim }) => {
                LogicOutcome::Reply(Box::new(Reply::HubClaim { status, claim }))
            }
            Ok(CapabilityValue::HubMachines(machines)) => {
                LogicOutcome::Reply(Box::new(Reply::HubMachines(machines)))
            }
            Ok(CapabilityValue::HubTicket(ticket)) => {
                LogicOutcome::Reply(Box::new(Reply::HubTicket(ticket)))
            }
            Ok(_) => LogicOutcome::Error(ProtocolError {
                code: ErrorCode::Internal,
                message: "Hub connectivity returned the wrong value".to_string(),
            }),
            Err(error) => LogicOutcome::Error(error),
        }
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

    fn read_log(
        &mut self,
        name: Option<String>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        let name = name.unwrap_or_else(|| "daemon.log".to_string());
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || matches!(name.as_str(), "." | "..")
        {
            return LogicOutcome::Error(ProtocolError {
                code: ErrorCode::BadRequest,
                message: format!("{name} 不是一个日志文件名"),
            });
        }
        let list_id = self.take_capability_id();
        let metadata_id = self.take_capability_id();
        let tail_id = self.take_capability_id();
        let batch_id = self.take_capability_id();
        let locator = FileLocator {
            root: FileRoot::Logs,
            path: name.clone(),
        };
        let results = match capabilities.execute(CapabilityBatch {
            batch_id,
            calls: vec![
                CapabilityCall {
                    call_id: list_id,
                    request: CapabilityRequest::File(FileRequest::List {
                        locator: FileLocator {
                            root: FileRoot::Logs,
                            path: String::new(),
                        },
                    }),
                },
                CapabilityCall {
                    call_id: metadata_id,
                    request: CapabilityRequest::File(FileRequest::Metadata {
                        locator: locator.clone(),
                    }),
                },
                CapabilityCall {
                    call_id: tail_id,
                    request: CapabilityRequest::File(FileRequest::ReadTail {
                        locator,
                        max_bytes: portable_logs::DEFAULT_TAIL_BYTES as u32,
                    }),
                },
            ],
        }) {
            Ok(results) => results,
            Err(message) => {
                return LogicOutcome::Error(ProtocolError {
                    code: ErrorCode::Internal,
                    message,
                })
            }
        };
        match portable_logs::from_capabilities(
            &name,
            &self.boot.log_display_directory,
            results,
            list_id,
            metadata_id,
            tail_id,
        ) {
            Ok(log) => LogicOutcome::Reply(Box::new(Reply::Log(log))),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn take_capability_id(&mut self) -> u64 {
        let id = self.next_capability_id;
        self.next_capability_id = self.next_capability_id.saturating_add(1);
        id
    }

    fn ensure_config(
        &mut self,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<(), ProtocolError> {
        if self.config.is_none() {
            self.config = Some(config::load(capabilities, &mut self.next_capability_id)?);
        }
        Ok(())
    }

    fn settings(&mut self, capabilities: &mut impl CapabilityExecutor) -> LogicOutcome {
        if let Err(error) = self.ensure_config(capabilities) {
            return LogicOutcome::Error(error);
        }
        LogicOutcome::Reply(Box::new(Reply::Settings(config::settings(
            self.config.as_ref().expect("config loaded"),
            &mut self.discoveries,
            capabilities,
            &mut self.next_capability_id,
        ))))
    }

    fn agent_list(
        &mut self,
        refresh: bool,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_config(capabilities) {
            return LogicOutcome::Error(error);
        }
        if refresh || self.agent_cache.is_none() {
            match agents::list(
                &self.boot,
                self.config.as_ref().expect("config loaded"),
                capabilities,
                &mut self.next_capability_id,
            ) {
                Ok(agents) => self.agent_cache = Some(agents),
                Err(error) => return LogicOutcome::Error(error),
            }
        }
        LogicOutcome::Reply(Box::new(Reply::Agents(
            self.agent_cache.clone().unwrap_or_default(),
        )))
    }

    #[allow(clippy::too_many_arguments)]
    fn set_provider(
        &mut self,
        provider_id: String,
        api_key: Option<String>,
        base_url: Option<String>,
        label: Option<String>,
        dialect: Option<String>,
        models: Option<Vec<String>>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_config(capabilities) {
            return LogicOutcome::Error(error);
        }
        let mut next = self.config.as_ref().expect("config loaded").clone();
        if let Err(error) = config::set_provider(
            &mut next,
            provider_id.clone(),
            api_key,
            base_url,
            label,
            dialect,
            models,
        )
        .and_then(|()| config::save(&next, capabilities, &mut self.next_capability_id))
        {
            return LogicOutcome::Error(error);
        }
        self.config = Some(next);
        self.discoveries.remove(&provider_id);
        self.agent_cache = None;
        self.settings(capabilities)
    }

    fn forget_provider(
        &mut self,
        provider_id: String,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_config(capabilities) {
            return LogicOutcome::Error(error);
        }
        let mut next = self.config.as_ref().expect("config loaded").clone();
        if let Err(error) = config::forget_provider(&mut next, &provider_id)
            .and_then(|()| config::save(&next, capabilities, &mut self.next_capability_id))
        {
            return LogicOutcome::Error(error);
        }
        self.config = Some(next);
        self.discoveries.remove(&provider_id);
        self.agent_cache = None;
        self.settings(capabilities)
    }

    fn ensure_workspaces(
        &mut self,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<(), ProtocolError> {
        self.ensure_config(capabilities)?;
        if self.workspace_roots_ready {
            return Ok(());
        }
        let mut next = self.config.as_ref().expect("config loaded").clone();
        let changed = workspace::prepare(
            &mut next,
            self.boot.default_workspace.as_deref(),
            capabilities,
            &mut self.next_capability_id,
        )?;
        if changed {
            config::save(&next, capabilities, &mut self.next_capability_id)?;
        }
        self.config = Some(next);
        self.workspace_roots_ready = true;
        Ok(())
    }

    fn workspace_list(&mut self, capabilities: &mut impl CapabilityExecutor) -> LogicOutcome {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutcome::Error(error);
        }
        LogicOutcome::Reply(Box::new(Reply::Workspaces(workspace::list(
            self.config.as_ref().expect("config loaded"),
        ))))
    }

    fn workspace_open(
        &mut self,
        root: String,
        name: Option<String>,
        create: bool,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutcome::Error(error);
        }
        let mut next = self.config.as_ref().expect("config loaded").clone();
        let workspace = match workspace::open(
            &mut next,
            root,
            name,
            create,
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        if let Err(error) = config::save(&next, capabilities, &mut self.next_capability_id) {
            return LogicOutcome::Error(error);
        }
        self.config = Some(next);
        LogicOutcome::Reply(Box::new(Reply::Workspace(workspace)))
    }

    fn workspace_rename(
        &mut self,
        workspace_id: String,
        name: String,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutcome::Error(error);
        }
        let mut next = self.config.as_ref().expect("config loaded").clone();
        let workspace = match workspace::rename(&mut next, &workspace_id, &name) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        if let Err(error) = config::save(&next, capabilities, &mut self.next_capability_id) {
            return LogicOutcome::Error(error);
        }
        self.config = Some(next);
        LogicOutcome::Reply(Box::new(Reply::Workspace(workspace)))
    }

    fn workspace_remove(
        &mut self,
        workspace_id: String,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutcome::Error(error);
        }
        let mut next = self.config.as_ref().expect("config loaded").clone();
        let workspaces = match workspace::remove(&mut next, &workspace_id) {
            Ok(workspaces) => workspaces,
            Err(error) => return LogicOutcome::Error(error),
        };
        if let Err(error) = config::save(&next, capabilities, &mut self.next_capability_id) {
            return LogicOutcome::Error(error);
        }
        self.config = Some(next);
        LogicOutcome::Reply(Box::new(Reply::Workspaces(workspaces)))
    }

    fn file_tree(
        &mut self,
        workspace_id: String,
        path: Option<String>,
        depth: Option<u32>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutcome::Error(error);
        }
        let workspace =
            match workspace::workspace(self.config.as_ref().expect("config loaded"), &workspace_id)
            {
                Ok(workspace) => workspace,
                Err(error) => return LogicOutcome::Error(error),
            };
        match files::tree(
            &workspace,
            path.as_deref(),
            depth.unwrap_or(2).min(8),
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(tree) => LogicOutcome::Reply(Box::new(Reply::FileTree(tree))),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn file_write(
        &mut self,
        workspace_id: String,
        path: String,
        content: String,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutcome::Error(error);
        }
        let workspace =
            match workspace::workspace(self.config.as_ref().expect("config loaded"), &workspace_id)
            {
                Ok(workspace) => workspace,
                Err(error) => return LogicOutcome::Error(error),
            };
        match files::write(
            &workspace,
            &path,
            content,
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(()) => LogicOutcome::Reply(Box::new(Reply::Ack)),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn workspace_for_operation(
        &mut self,
        workspace_id: &str,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<config::WorkspaceEntry, ProtocolError> {
        self.ensure_workspaces(capabilities)?;
        workspace::workspace(self.config.as_ref().expect("config loaded"), workspace_id)
    }

    fn git_status(
        &mut self,
        workspace_id: String,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        let workspace = match self.workspace_for_operation(&workspace_id, capabilities) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        match git::status(&workspace, capabilities, &mut self.next_capability_id) {
            Ok(status) => LogicOutcome::Reply(Box::new(Reply::GitStatus(status))),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn git_diff(
        &mut self,
        workspace_id: String,
        path: Option<String>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        let workspace = match self.workspace_for_operation(&workspace_id, capabilities) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        match git::diff(
            &workspace,
            path.as_deref(),
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(diff) => LogicOutcome::Reply(Box::new(Reply::GitDiff { diff })),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn git_commit(
        &mut self,
        workspace_id: String,
        message: String,
        paths: Vec<String>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        let workspace = match self.workspace_for_operation(&workspace_id, capabilities) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        match git::commit(
            &workspace,
            &message,
            &paths,
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(commit) => LogicOutcome::Reply(Box::new(Reply::GitCommit { commit })),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn pty_open(
        &mut self,
        workspace_id: String,
        cols: u16,
        rows: u16,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        let workspace = match self.workspace_for_operation(&workspace_id, capabilities) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        match terminal::open(
            &mut self.terminals,
            &workspace,
            cols,
            rows,
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(pty_id) => LogicOutcome::Reply(Box::new(Reply::Pty { pty_id })),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        encode_json(
            "logic snapshot",
            &Snapshot {
                format_version: SNAPSHOT_FORMAT_VERSION,
                boot: self.boot.clone(),
                handled_requests: self.handled_requests,
                next_capability_id: self.next_capability_id,
                pending: self.pending.clone(),
                config: self.config.clone(),
                discoveries: self.discoveries.clone(),
                agent_cache: self.agent_cache.clone(),
                sessions: self.sessions.clone(),
                terminals: self.terminals.clone(),
                devices: self.devices.clone(),
                remote_access: self.remote_access.clone(),
                update_download: self.update_download.clone(),
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
            next_capability_id: snapshot.next_capability_id,
            pending: snapshot.pending,
            config: snapshot.config,
            discoveries: snapshot.discoveries,
            agent_cache: snapshot.agent_cache,
            sessions: snapshot.sessions,
            terminals: snapshot.terminals,
            devices: snapshot.devices,
            remote_access: snapshot.remote_access,
            update_download: snapshot.update_download,
            workspace_roots_ready: false,
        })
    }

    pub fn handled_requests(&self) -> u64 {
        self.handled_requests
    }
}

fn offline_remote() -> RemoteAccess {
    RemoteAccess {
        relay_url: None,
        rendezvous_url: None,
        online: false,
    }
}

fn idle_download() -> UpdateDownload {
    UpdateDownload::Idle
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
    use genehub_proto::{ErrorCode, LogEntry, LogTail, ProtocolError};
    use genet_daemon_logic_api::{
        CapabilityFailure, CapabilityFailureKind, CapabilityResults, CapabilityValue, FileKind,
    };

    pub const DEFAULT_TAIL_BYTES: usize = 64 * 1024;

    pub fn from_capabilities(
        name: &str,
        display_directory: &str,
        results: CapabilityResults,
        list_id: u64,
        metadata_id: u64,
        tail_id: u64,
    ) -> Result<LogTail, ProtocolError> {
        let find = |id| {
            results
                .results
                .iter()
                .find(|result| result.call_id == id)
                .ok_or_else(|| ProtocolError {
                    code: ErrorCode::Internal,
                    message: format!("log capability omitted call {id}"),
                })
        };
        let entries = match &find(list_id)?.result {
            Ok(CapabilityValue::FileEntries(entries)) => entries,
            Ok(_) => return Err(wrong_type("listing log files")),
            Err(error) => return Err(map_failure(error)),
        };
        let metadata = match &find(metadata_id)?.result {
            Ok(CapabilityValue::FileMetadata(metadata)) if metadata.kind == FileKind::File => {
                metadata
            }
            Ok(CapabilityValue::FileMetadata(_)) => {
                return Err(ProtocolError {
                    code: ErrorCode::BadRequest,
                    message: format!("打不开 {name}：not a regular log file"),
                })
            }
            Ok(_) => return Err(wrong_type("reading log metadata")),
            Err(error) => return Err(map_failure(error)),
        };
        let raw = match &find(tail_id)?.result {
            Ok(CapabilityValue::Bytes(bytes)) => bytes,
            Ok(_) => return Err(wrong_type("reading log bytes")),
            Err(error) => return Err(map_failure(error)),
        };
        let mut text = String::from_utf8_lossy(raw).to_string();
        if metadata.bytes > DEFAULT_TAIL_BYTES as u64 {
            text = match text.find('\n') {
                Some(at) => text[at + 1..].to_string(),
                None => String::new(),
            };
        }
        let mut files = entries
            .iter()
            .filter(|entry| entry.kind == FileKind::File)
            .map(|entry| {
                (
                    entry.modified_at_millis.unwrap_or(i64::MIN),
                    LogEntry {
                        name: entry.name.clone(),
                        bytes: entry.bytes,
                    },
                )
            })
            .collect::<Vec<_>>();
        files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
        Ok(LogTail {
            path: format!(
                "{}/{}",
                display_directory.trim_end_matches(['/', '\\']),
                name
            ),
            name: name.to_string(),
            text,
            files: files.into_iter().map(|(_, entry)| entry).collect(),
        })
    }

    fn wrong_type(operation: &str) -> ProtocolError {
        ProtocolError {
            code: ErrorCode::Internal,
            message: format!("system capability returned the wrong value while {operation}"),
        }
    }

    fn map_failure(error: &CapabilityFailure) -> ProtocolError {
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
            message: error.message.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{LogTail, TransportKind};
    use genet_daemon_logic_api::FileKind;

    struct TestLogs(std::path::PathBuf);

    #[cfg(unix)]
    struct RealCapabilities {
        runtime: tokio::runtime::Runtime,
        host: std::sync::Arc<genet_daemon_system::SystemHost>,
        events: tokio::sync::mpsc::Receiver<genet_daemon_logic_api::CapabilityEvent>,
    }

    #[cfg(unix)]
    impl RealCapabilities {
        fn new(private: &std::path::Path, logs: &std::path::Path) -> Self {
            let host =
                std::sync::Arc::new(genet_daemon_system::SystemHost::new(private, logs).unwrap());
            let events = host.take_events().unwrap();
            Self {
                runtime: tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap(),
                host,
                events,
            }
        }

        fn event(&mut self) -> genet_daemon_logic_api::CapabilityEvent {
            self.runtime
                .block_on(async {
                    tokio::time::timeout(std::time::Duration::from_secs(5), self.events.recv())
                        .await
                })
                .expect("capability event before timeout")
                .expect("capability event stream remains open")
        }
    }

    #[cfg(unix)]
    impl CapabilityExecutor for RealCapabilities {
        fn execute(&mut self, batch: CapabilityBatch) -> Result<CapabilityResults, String> {
            Ok(self.runtime.block_on(self.host.execute(batch)))
        }
    }

    impl CapabilityExecutor for TestLogs {
        fn execute(&mut self, batch: CapabilityBatch) -> Result<CapabilityResults, String> {
            let results = batch
                .calls
                .into_iter()
                .map(|call| {
                    let result = match call.request {
                        CapabilityRequest::File(FileRequest::List { .. }) => {
                            let entries = std::fs::read_dir(&self.0)
                                .unwrap()
                                .map(|entry| {
                                    let entry = entry.unwrap();
                                    let metadata = entry.metadata().unwrap();
                                    genet_daemon_logic_api::FileEntry {
                                        name: entry.file_name().to_string_lossy().to_string(),
                                        kind: if metadata.is_file() {
                                            FileKind::File
                                        } else {
                                            FileKind::Directory
                                        },
                                        bytes: metadata.len(),
                                        modified_at_millis: None,
                                        native_path: None,
                                    }
                                })
                                .collect();
                            Ok(CapabilityValue::FileEntries(entries))
                        }
                        CapabilityRequest::File(FileRequest::Metadata { locator }) => {
                            let metadata = std::fs::metadata(self.0.join(&locator.path)).unwrap();
                            Ok(CapabilityValue::FileMetadata(
                                genet_daemon_logic_api::FileMetadata {
                                    kind: FileKind::File,
                                    bytes: metadata.len(),
                                    modified_at_millis: None,
                                    canonical_path: None,
                                    parent_path: None,
                                    file_name: Some(locator.path),
                                    extension: None,
                                },
                            ))
                        }
                        CapabilityRequest::File(FileRequest::ReadTail { locator, max_bytes }) => {
                            let bytes = std::fs::read(self.0.join(locator.path)).unwrap();
                            let from = bytes.len().saturating_sub(max_bytes as usize);
                            Ok(CapabilityValue::Bytes(bytes[from..].to_vec()))
                        }
                        other => panic!("unexpected capability {other:?}"),
                    };
                    genet_daemon_logic_api::CapabilityResult {
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
            daemon_version: "1.2.3".to_string(),
            protocol_version: PROTOCOL_VERSION,
            machine_id: "machine".to_string(),
            fingerprint: "fingerprint".to_string(),
            machine_name: "workstation".to_string(),
            rtc_supported: true,
            log_directory: ".".to_string(),
            log_display_directory: "/host/logs".to_string(),
            default_workspace: None,
            home_directory: None,
            builtin_agent_binary: None,
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

        let output = app.handle_with(
            LogicInput::Request(LogicRequest {
                call_id: 1,
                transport: TransportKind::Loopback,
                request: Request::LogTail { name: None },
            }),
            &mut TestLogs(directory.path().to_path_buf()),
        );
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

    #[cfg(unix)]
    #[test]
    fn portable_session_owns_persistence_process_protocol_and_hot_state() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private");
        let logs = directory.path().join("logs");
        let workspace = directory.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let agent = directory.path().join("fake-genet-agent");
        std::fs::write(
            &agent,
            r#"#!/bin/sh
while IFS= read -r line; do
  turn=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  [ -n "$turn" ] || continue
  printf '%s\n' '{"type":"agent_start"}'
  printf '%s\n' '{"type":"text_start"}'
  printf '%s\n' '{"type":"text_delta","delta":"portable "}'
  printf '%s\n' '{"type":"text_end","content":"portable reply"}'
  printf '%s\n' '{"type":"agent_end"}'
done
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&agent).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&agent, permissions).unwrap();

        let mut boot = boot();
        boot.builtin_agent_binary = Some(agent.display().to_string());
        let mut app = LogicApp::new(boot).unwrap();
        let mut capabilities = RealCapabilities::new(&private, &logs);
        let call = |app: &mut LogicApp, capabilities: &mut RealCapabilities, call_id, request| {
            app.handle_with(
                LogicInput::Request(LogicRequest {
                    call_id,
                    transport: TransportKind::Loopback,
                    request,
                }),
                capabilities,
            )
        };
        let opened = call(
            &mut app,
            &mut capabilities,
            1,
            Request::WorkspaceOpen {
                root: workspace.display().to_string(),
            },
        );
        let workspace_id = match &opened.completions[0].outcome {
            LogicOutcome::Reply(reply) => match &**reply {
                Reply::Workspace(workspace) => workspace.id.clone(),
                other => panic!("wrong workspace reply: {other:?}"),
            },
            other => panic!("workspace open failed: {other:?}"),
        };
        let created = call(
            &mut app,
            &mut capabilities,
            2,
            Request::SessionCreate {
                workspace_id,
                agent_id: "genet".to_string(),
                model_id: None,
                mode_id: None,
                title: None,
            },
        );
        let session_id = match &created.completions[0].outcome {
            LogicOutcome::Reply(reply) => match &**reply {
                Reply::Session(session) => session.id.clone(),
                other => panic!("wrong session reply: {other:?}"),
            },
            other => panic!("session create failed: {other:?}"),
        };
        let sent = call(
            &mut app,
            &mut capabilities,
            3,
            Request::SessionSend {
                session_id: session_id.clone(),
                text: "hello portable world".to_string(),
                attachments: Vec::new(),
                artifact_preview_base_url: None,
                continues_round: None,
            },
        );
        assert!(matches!(
            sent.completions[0].outcome,
            LogicOutcome::Reply(ref reply) if matches!(**reply, Reply::Ack)
        ));

        let mut completed = false;
        for _ in 0..8 {
            let event = capabilities.event();
            let output = app.handle_with(LogicInput::CapabilityEvent(event), &mut capabilities);
            completed |= output.publications.iter().any(|publication| {
                matches!(
                    publication,
                    genet_daemon_logic_api::Publication::Session(genehub_proto::SequencedEvent {
                        event: genehub_proto::SessionEvent::TurnCompleted { .. },
                        ..
                    })
                )
            });
            if completed {
                break;
            }
        }
        assert!(completed, "the portable Agent turn never completed");

        let restored = LogicApp::restore(&app.snapshot().unwrap()).unwrap();
        app = restored;
        let snapshot = call(
            &mut app,
            &mut capabilities,
            4,
            Request::SessionGet { session_id },
        );
        assert!(matches!(
            &snapshot.completions[0].outcome,
            LogicOutcome::Reply(reply)
                if matches!(&**reply, Reply::Snapshot(snapshot)
                    if snapshot.items.iter().any(|item| matches!(
                        item,
                        genehub_proto::TimelineItem::AssistantMessage { text, .. }
                            if text == "portable reply"
                    )))
        ));
    }
}
