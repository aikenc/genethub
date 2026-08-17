//! Portable daemon business state.
//!
//! Platform crates must not depend on this crate. The Wasm entry crate links it
//! normally, preserving Rust ownership, visibility and memory safety.

mod agents;
mod authz;
mod capability;
mod config;
mod devices;
mod files;
mod git;
mod session;
mod speech;
mod terminal;
mod workspace;

use std::collections::{BTreeMap, HashMap, VecDeque};

use genehub_proto::{
    ErrorCode, HelloResult, ProtocolError, RemoteAccess, Reply, Request, TransportKind,
    PROTOCOL_VERSION,
};
use genet_daemon_logic_api::{
    CallerContext, CapabilityBatch, CapabilityCall, CapabilityRequest, CapabilityResults,
    CapabilityValue, ConnectivityRequest, FileLocator, FileRequest, FileRoot, LogicBoot,
    LogicInput, LogicOutcome, LogicOutput, LogicRequest, PlatformCall, PlatformCompletion,
    PlatformReply, PlatformRequest, SpeechCompletionEvidence,
};

#[derive(Clone, Debug)]
pub struct LogicApp {
    boot: LogicBoot,
    next_capability_id: u64,
    config: Option<config::Config>,
    discoveries: BTreeMap<String, config::Discovery>,
    agent_cache: Option<Vec<genehub_proto::AgentInfo>>,
    sessions: session::Sessions,
    terminals: HashMap<String, u64>,
    devices: devices::Devices,
    remote_access: RemoteAccess,
    workspace_roots_ready: bool,
    /// Short-lived, authoritative speech results. These intentionally do not
    /// enter durable process state: losing an unsubmitted correction on a
    /// restart is safer than persisting dictated text beyond its TTL.
    speech_results: VecDeque<SpeechCompletionEvidence>,
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
            next_capability_id: 1,
            config: None,
            discoveries: BTreeMap::new(),
            agent_cache: None,
            sessions: session::Sessions::default(),
            terminals: HashMap::new(),
            devices: devices::Devices::default(),
            remote_access: offline_remote(),
            workspace_roots_ready: false,
            speech_results: VecDeque::new(),
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
            LogicInput::Request(request) => self.handle_request(request, capabilities),
            LogicInput::Platform(call) => self.handle_platform(call, capabilities),
            // Capability batches emitted by resource-event handling are
            // currently fire-and-forget; their native completion only drains
            // the bounded carrier and cannot complete an unrelated RPC.
            LogicInput::CapabilityResults(_) => LogicOutput::default(),
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
        if let Some(scope) = input.route.workspace_id.as_deref() {
            if request_workspace(&input.request).is_some_and(|requested| requested != scope) {
                return LogicOutput::completed(
                    call_id,
                    LogicOutcome::Error(ProtocolError {
                        code: ErrorCode::Forbidden,
                        message: "the routed capability does not cover this workspace".to_string(),
                    }),
                );
            }
        }
        if let Some(invite_id) = input.route.bootstrap_invite.as_deref() {
            match &input.request {
                Request::DeviceClaim { code, .. } if code == invite_id => {}
                Request::DeviceClaim { .. } => {
                    return LogicOutput::completed(
                        call_id,
                        LogicOutcome::Error(ProtocolError {
                            code: ErrorCode::Unauthorized,
                            message: "pairing invitation does not match this peer session"
                                .to_string(),
                        }),
                    )
                }
                _ => {
                    return LogicOutput::completed(
                        call_id,
                        LogicOutcome::Error(ProtocolError {
                            code: ErrorCode::Unauthorized,
                            message: "pairing sessions may only redeem their invitation"
                                .to_string(),
                        }),
                    )
                }
            }
        }
        if let Err(error) = authz::authorize_request(&input.caller, &input.request, &self.devices) {
            return LogicOutput::completed(call_id, LogicOutcome::Error(error));
        }
        let caller = input.caller;
        let bootstrap_invite = input.route.bootstrap_invite;
        let outcome = match input.request {
            Request::ConnectionIdentity => {
                LogicOutcome::Reply(Box::new(Reply::Hello(HelloResult {
                    daemon_version: self.boot.daemon_version.clone(),
                    protocol_version: self.boot.protocol_version,
                    machine_id: self.boot.machine_id.clone(),
                    fingerprint: self.boot.fingerprint.clone(),
                    transport,
                    machine_name: self.boot.machine_name.clone(),
                    rtc_supported: self.boot.rtc_supported,
                    features: Some(self.boot.features.clone()),
                    isolation: self.boot.isolation.clone(),
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
            | Request::SessionInspect { .. }
            | Request::SessionNarrative { .. }
            | Request::SessionRounds { .. }
            | Request::SessionContext { .. }
            | Request::RoundTrunkList { .. }
            | Request::RoundTrunkGet { .. }
            | Request::BlobGet { .. }
            | Request::SessionSend { .. }
            | Request::SessionArtifactBegin { .. }
            | Request::SessionArtifactChunk { .. }
            | Request::SessionArtifactFinish { .. }
            | Request::SessionArtifactAbort { .. }
            | Request::SessionFork { .. }
            | Request::SessionForkExport { .. }
            | Request::SessionForkImport { .. }
            | Request::SessionImportList { .. }
            | Request::SessionImport { .. }
            | Request::SessionInterrupt { .. }
            | Request::SessionClose { .. }
            | Request::SessionArchive { .. }
            | Request::SessionRename { .. }
            | Request::SessionDelete { .. }
            | Request::SessionSetModel { .. }
            | Request::SessionSetMode { .. }
            | Request::SessionSetEffort { .. }
            | Request::SessionRespondPermission { .. }
            | Request::ProcessList
            | Request::ProcessKill { .. }
            | Request::ProcessKillAll { .. }) => {
                return self.request_session(call_id, request, capabilities)
            }
            Request::AgentList => self.agent_list(false, capabilities),
            Request::AgentRefresh => self.agent_list(true, capabilities),
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
            Request::DeviceInvite(scope) => match self.refresh_remote(capabilities).and_then(|()| {
                let grants = match scope {
                    None => authz::GrantSet::full(),
                    Some(scope) => {
                        let mut parsed = Vec::with_capacity(scope.grants.len());
                        for name in scope.grants {
                            let Some(capability) = authz::Capability::parse(&name) else {
                                return Err(ProtocolError {
                                    code: ErrorCode::BadRequest,
                                    message: format!("unknown device grant `{name}`"),
                                });
                            };
                            parsed.push(capability);
                        }
                        authz::GrantSet::of(parsed)
                    }
                };
                self.devices.invite(
                    grants,
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
            Request::DeviceClaim { device_name, .. } => match bootstrap_invite {
                Some(invite_id) => match self.devices.claim_authenticated(
                    &invite_id,
                    &device_name,
                    &self.boot,
                    capabilities,
                    &mut self.next_capability_id,
                ) {
                    Ok(PlatformReply::Claimed(credential)) => {
                        LogicOutcome::Reply(Box::new(Reply::Claimed(credential)))
                    }
                    Ok(_) => LogicOutcome::Error(ProtocolError {
                        code: ErrorCode::Internal,
                        message: "pairing claim returned the wrong value".to_string(),
                    }),
                    Err(error) => LogicOutcome::Error(error),
                },
                None => LogicOutcome::Error(ProtocolError {
                    code: ErrorCode::Unauthorized,
                    message: "配对邀请只能在对应的加密引导连接中兑换".to_string(),
                }),
            },
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
            Request::SpeechCapabilities => self.speech_capabilities(capabilities),
            Request::SpeechSettingsSetQwen3 {
                stub_enabled,
                context_enabled,
                pinned_terms,
                language_hints,
                collect_corrections,
                workspace_id,
            } => self.set_speech_settings(
                stub_enabled,
                context_enabled,
                pinned_terms,
                language_hints,
                collect_corrections,
                workspace_id,
                capabilities,
            ),
            Request::SpeechRuntimeProbe => self.probe_speech(capabilities),
            Request::SpeechRuntimeConfigure { command, args } => {
                if transport != TransportKind::Loopback {
                    LogicOutcome::Error(ProtocolError {
                        code: ErrorCode::Forbidden,
                        message: "语音 runtime 只能由这台电脑上的本地用户注册或移除".to_string(),
                    })
                } else {
                    self.configure_speech(command, args, capabilities)
                }
            }
            Request::SpeechContextPreview {
                workspace_id,
                session_id,
                draft,
            } => self.speech_context(workspace_id, session_id, draft, capabilities),
            Request::SpeechFeedbackRecord {
                workspace_id,
                request_id,
                context_snapshot_id: _,
                candidates: _,
                selected_candidate_id,
                rejected_candidate_id,
                scope,
                score_kind: _,
            } => self.record_speech_feedback(
                workspace_id,
                request_id,
                selected_candidate_id,
                rejected_candidate_id,
                scope,
                capabilities,
            ),
            Request::DiagnosticsSnapshot => self.diagnostics(capabilities),
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
            Request::DirectoryMkdir { parent, name } => match workspace::mkdir_directory(
                parent,
                name,
                self.boot.home_directory.as_deref(),
                capabilities,
                &mut self.next_capability_id,
            ) {
                Ok(directory) => LogicOutcome::Reply(Box::new(Reply::Directory(directory))),
                Err(error) => LogicOutcome::Error(error),
            },
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
            Request::FileMkdir { workspace_id, path } => {
                self.file_mutation(workspace_id, capabilities, |workspace, executor, next| {
                    files::mkdir(workspace, &path, executor, next)
                })
            }
            Request::FileCopy {
                workspace_id,
                from,
                to,
            } => self.file_mutation(workspace_id, capabilities, |workspace, executor, next| {
                files::copy(workspace, &from, &to, executor, next)
            }),
            Request::FileMove {
                workspace_id,
                from,
                to,
            } => self.file_mutation(workspace_id, capabilities, |workspace, executor, next| {
                files::move_path(workspace, &from, &to, executor, next)
            }),
            Request::FileDelete {
                workspace_id,
                paths,
            } => self.file_mutation(workspace_id, capabilities, |workspace, executor, next| {
                files::delete(workspace, &paths, executor, next)
            }),
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
                &caller,
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
        if session_request_needs_agent_catalog(&request) {
            if let Err(error) = self.ensure_agent_cache(false, capabilities) {
                return LogicOutput::completed(call_id, LogicOutcome::Error(error));
            }
        }
        let config = config::with_discoveries(
            self.config.as_ref().expect("config loaded"),
            &self.discoveries,
        );
        session::request(
            &mut self.sessions,
            call_id,
            request,
            &self.boot,
            &config,
            self.agent_cache.as_deref().unwrap_or_default(),
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
            PlatformRequest::AuthorizeStream { caller, stream } => {
                Ok(PlatformReply::StreamAuthorization(authz::authorize_stream(
                    &caller,
                    stream,
                    &self.devices,
                )))
            }
            PlatformRequest::WorkspaceCatalog => self.platform_workspace_catalog(capabilities),
            PlatformRequest::ResolveWorkspaceFile { workspace_id, path } => {
                self.platform_workspace_file(&workspace_id, &path, capabilities)
            }
            PlatformRequest::ResolveWorkspaceExecution { workspace_id, cwd } => {
                self.platform_workspace_execution(&workspace_id, cwd, capabilities)
            }
            PlatformRequest::PrepareSpeech {
                route_workspace_id,
                start,
            } => self.platform_prepare_speech(route_workspace_id.as_deref(), &start, capabilities),
            PlatformRequest::PrepareUpdate {
                terminate_activities,
            } => {
                let active_sessions = self.sessions.update_activity_count();
                let terminals = self.terminals.len().min(u32::MAX as usize) as u32;
                let was_busy = active_sessions > 0 || terminals > 0;
                if !was_busy || terminate_activities {
                    self.sessions
                        .shutdown(capabilities, &mut self.next_capability_id);
                    let terminal_ids = self.terminals.keys().cloned().collect::<Vec<_>>();
                    for terminal_id in terminal_ids {
                        let _ = terminal::close(
                            &self.terminals,
                            &terminal_id,
                            capabilities,
                            &mut self.next_capability_id,
                        );
                    }
                    self.terminals.clear();
                }
                let remaining_sessions = self.sessions.update_activity_count();
                let remaining_terminals = self.terminals.len().min(u32::MAX as usize) as u32;
                Ok(PlatformReply::UpdateReadiness(
                    genet_daemon_logic_api::UpdateReadiness {
                        busy: remaining_sessions > 0 || remaining_terminals > 0,
                        active_sessions: if !was_busy || terminate_activities {
                            remaining_sessions
                        } else {
                            active_sessions
                        },
                        terminals: if !was_busy || terminate_activities {
                            remaining_terminals
                        } else {
                            terminals
                        },
                    },
                ))
            }
            PlatformRequest::RememberSpeechCompletion { evidence } => {
                self.remember_speech_completion(evidence);
                Ok(PlatformReply::Ack)
            }
            PlatformRequest::Shutdown => {
                self.sessions
                    .shutdown(capabilities, &mut self.next_capability_id);
                Ok(PlatformReply::Ack)
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

    fn platform_prepare_speech(
        &mut self,
        route_workspace_id: Option<&str>,
        start: &genehub_proto::SpeechStart,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<PlatformReply, ProtocolError> {
        if route_workspace_id.is_some_and(|scope| scope != start.workspace_id) {
            return Err(ProtocolError {
                code: ErrorCode::Forbidden,
                message: "the routed capability does not cover this workspace".to_string(),
            });
        }
        self.ensure_workspaces(capabilities)?;
        let config = self.config.as_ref().expect("config loaded").clone();
        workspace::workspace(&config, &start.workspace_id)?;
        if let Some(session_id) = start.session_id.as_deref() {
            self.sessions.validate_membership(
                session_id,
                &start.workspace_id,
                &config,
                capabilities,
                &mut self.next_capability_id,
            )?;
        }
        Ok(PlatformReply::SpeechPrepared(config.speech))
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

    fn platform_workspace_execution(
        &mut self,
        workspace_id: &str,
        cwd: Option<String>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<PlatformReply, ProtocolError> {
        self.ensure_workspaces(capabilities)?;
        let workspace =
            workspace::workspace(self.config.as_ref().expect("config loaded"), workspace_id)?;
        let first = workspace.folders.first().ok_or_else(|| ProtocolError {
            code: ErrorCode::BadRequest,
            message: "workspace has no folders".to_string(),
        })?;
        let roots = workspace
            .folders
            .iter()
            .map(|folder| genet_daemon_logic_api::WorkspaceRootPath {
                handle: folder.root_handle.clone(),
                native_path: folder.root.clone(),
            })
            .collect::<Vec<_>>();
        let mut client = capability::Client::new(capabilities, &mut self.next_capability_id);
        let cwd = match client.call(CapabilityRequest::File(FileRequest::ResolveWorkspacePath {
            roots,
            default_handle: first.root_handle.clone(),
            path: cwd,
        }))? {
            CapabilityValue::FileLocator(locator) => locator,
            _ => {
                return Err(ProtocolError {
                    code: ErrorCode::Internal,
                    message: "workspace cwd resolver returned the wrong value".to_string(),
                })
            }
        };
        Ok(PlatformReply::WorkspaceExecution(
            genet_daemon_logic_api::WorkspaceExecution {
                cwd,
                roots: workspace
                    .folders
                    .iter()
                    .map(|folder| FileLocator {
                        root: FileRoot::Workspace {
                            handle: folder.root_handle.clone(),
                        },
                        path: String::new(),
                    })
                    .collect(),
            },
        ))
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

    fn diagnostics(&mut self, capabilities: &mut impl CapabilityExecutor) -> LogicOutcome {
        let mut client = capability::Client::new(capabilities, &mut self.next_capability_id);
        match client.call(CapabilityRequest::Diagnostics) {
            Ok(CapabilityValue::Diagnostics(snapshot)) => {
                LogicOutcome::Reply(Box::new(Reply::Diagnostics(snapshot)))
            }
            Ok(_) => LogicOutcome::Error(ProtocolError {
                code: ErrorCode::Internal,
                message: "diagnostics capability returned the wrong value".to_string(),
            }),
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

    fn speech_capabilities(&mut self, capabilities: &mut impl CapabilityExecutor) -> LogicOutcome {
        if let Err(error) = self.ensure_config(capabilities) {
            return LogicOutcome::Error(error);
        }
        match speech::capabilities(
            &self.config.as_ref().expect("config loaded").speech,
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(value) => LogicOutcome::Reply(Box::new(Reply::SpeechCapabilities(value))),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn set_speech_settings(
        &mut self,
        stub_enabled: Option<bool>,
        context_enabled: bool,
        pinned_terms: Vec<String>,
        language_hints: Vec<String>,
        collect_corrections: bool,
        workspace_id: Option<String>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutcome::Error(error);
        }
        let mut next = self.config.as_ref().expect("config loaded").clone();
        let workspace = workspace_id
            .as_deref()
            .and_then(|id| workspace::workspace(&next, id).ok());
        if let Err(error) = speech::update_settings(
            &mut next,
            stub_enabled,
            context_enabled,
            pinned_terms,
            language_hints,
            collect_corrections,
            workspace_id,
            workspace.as_ref(),
        )
        .and_then(|()| config::save(&next, capabilities, &mut self.next_capability_id))
        {
            return LogicOutcome::Error(error);
        }
        self.config = Some(next);
        self.settings(capabilities)
    }

    fn probe_speech(&mut self, capabilities: &mut impl CapabilityExecutor) -> LogicOutcome {
        if let Err(error) = self.ensure_config(capabilities) {
            return LogicOutcome::Error(error);
        }
        match speech::probe(
            &self.config.as_ref().expect("config loaded").speech,
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(value) => LogicOutcome::Reply(Box::new(Reply::SpeechRuntimeStatus(value))),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn configure_speech(
        &mut self,
        command: Option<String>,
        args: Vec<String>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_config(capabilities) {
            return LogicOutcome::Error(error);
        }
        let runtime = match command {
            Some(command) => match speech::validate_registration(
                command,
                args,
                capabilities,
                &mut self.next_capability_id,
            ) {
                Ok(runtime) => Some(runtime),
                Err(error) => return LogicOutcome::Error(error),
            },
            None if args.is_empty() => None,
            None => {
                return LogicOutcome::Error(ProtocolError {
                    code: ErrorCode::BadRequest,
                    message: "移除 runtime 时不能提供参数".to_string(),
                })
            }
        };
        let mut next = self.config.as_ref().expect("config loaded").clone();
        if runtime.is_some() {
            next.speech.stub_enabled = false;
        }
        next.speech.runtime = runtime;
        if let Err(error) = config::save(&next, capabilities, &mut self.next_capability_id) {
            return LogicOutcome::Error(error);
        }
        self.config = Some(next);
        self.speech_capabilities(capabilities)
    }

    fn speech_context(
        &mut self,
        workspace_id: String,
        session_id: Option<String>,
        draft: Option<String>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutcome::Error(error);
        }
        let config = self.config.as_ref().expect("config loaded").clone();
        let workspace = match workspace::workspace(&config, &workspace_id) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        let items = match session_id.as_deref() {
            Some(session_id) => match self.sessions.context_items(
                session_id,
                &workspace_id,
                &config,
                capabilities,
                &mut self.next_capability_id,
            ) {
                Ok(items) => items,
                Err(error) => return LogicOutcome::Error(error),
            },
            None => Vec::new(),
        };
        match speech::compile_context(
            &config.speech,
            &workspace,
            &items,
            draft.as_deref(),
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(context) => LogicOutcome::Reply(Box::new(Reply::SpeechContext(context))),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn remember_speech_completion(&mut self, evidence: SpeechCompletionEvidence) {
        const MAX_RESULTS: usize = 64;
        self.speech_results.retain(|stored| {
            stored.workspace_id != evidence.workspace_id || stored.request_id != evidence.request_id
        });
        while self.speech_results.len() >= MAX_RESULTS {
            self.speech_results.pop_front();
        }
        self.speech_results.push_back(evidence);
    }

    #[allow(clippy::too_many_arguments)]
    fn record_speech_feedback(
        &mut self,
        workspace_id: String,
        request_id: String,
        selected_candidate_id: String,
        rejected_candidate_id: Option<String>,
        scope: Option<genehub_proto::SpeechFeedbackScope>,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_workspaces(capabilities) {
            return LogicOutcome::Error(error);
        }
        let config = self.config.as_ref().expect("config loaded").clone();
        let workspace = match workspace::workspace(&config, &workspace_id) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        let now = match speech::clock(capabilities, &mut self.next_capability_id) {
            Ok(now) => now,
            Err(error) => return LogicOutcome::Error(error),
        };
        const TTL_MILLIS: i64 = 30 * 60 * 1_000;
        self.speech_results.retain(|stored| {
            now.saturating_sub(stored.recorded_at_millis) <= TTL_MILLIS
                && stored.recorded_at_millis <= now.saturating_add(60_000)
        });
        let evidence = match self
            .speech_results
            .iter()
            .find(|stored| {
                stored.workspace_id == workspace_id && stored.request_id == request_id
            })
            .cloned()
        {
            Some(evidence) => evidence,
            None => {
                return LogicOutcome::Error(ProtocolError {
                    code: ErrorCode::BadRequest,
                    message: "本次语音候选已经过期或不属于当前项目；为避免伪造训练数据，请重新录音后再选择候选".to_string(),
                })
            }
        };
        match speech::record_feedback(
            &config.speech,
            &workspace,
            evidence,
            selected_candidate_id,
            rejected_candidate_id,
            scope,
            now,
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(receipt) => LogicOutcome::Reply(Box::new(Reply::SpeechFeedbackReceipt(receipt))),
            Err(error) => LogicOutcome::Error(error),
        }
    }

    fn agent_list(
        &mut self,
        refresh: bool,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        if let Err(error) = self.ensure_agent_cache(refresh, capabilities) {
            return LogicOutcome::Error(error);
        }
        LogicOutcome::Reply(Box::new(Reply::Agents(
            self.agent_cache.clone().unwrap_or_default(),
        )))
    }

    fn ensure_agent_cache(
        &mut self,
        refresh: bool,
        capabilities: &mut impl CapabilityExecutor,
    ) -> Result<(), ProtocolError> {
        self.ensure_config(capabilities)?;
        if refresh || self.agent_cache.is_none() {
            // Provider discovery is cached in the guest, not persisted as
            // user-authored configuration. Resolve one shared runtime view so
            // Settings and the Agent picker cannot disagree about models.
            let _ = config::settings(
                self.config.as_ref().expect("config loaded"),
                &mut self.discoveries,
                capabilities,
                &mut self.next_capability_id,
            );
            let runtime_config = config::with_discoveries(
                self.config.as_ref().expect("config loaded"),
                &self.discoveries,
            );
            let agents = agents::list(
                &self.boot,
                &runtime_config,
                capabilities,
                &mut self.next_capability_id,
            )?;
            self.agent_cache = Some(agents);
        }
        Ok(())
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
        if let Err(error) = self.sessions.ensure_workspace_removable(
            &workspace_id,
            self.config.as_ref().expect("config loaded"),
            capabilities,
            &mut self.next_capability_id,
        ) {
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

    fn file_mutation<E, F>(
        &mut self,
        workspace_id: String,
        capabilities: &mut E,
        operation: F,
    ) -> LogicOutcome
    where
        E: CapabilityExecutor,
        F: FnOnce(&config::WorkspaceEntry, &mut E, &mut u64) -> Result<(), ProtocolError>,
    {
        let workspace = match self.workspace_for_operation(&workspace_id, capabilities) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        match operation(&workspace, capabilities, &mut self.next_capability_id) {
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
        caller: &CallerContext,
        capabilities: &mut impl CapabilityExecutor,
    ) -> LogicOutcome {
        let workspace = match self.workspace_for_operation(&workspace_id, capabilities) {
            Ok(workspace) => workspace,
            Err(error) => return LogicOutcome::Error(error),
        };
        let confinement_required = authz::authorize_stream(
            caller,
            genet_daemon_logic_api::StreamMethod::ShellRun,
            &self.devices,
        )
        .confinement_required;
        if confinement_required
            && !self
                .boot
                .isolation
                .as_ref()
                .is_some_and(|report| report.enforced)
        {
            return LogicOutcome::Error(ProtocolError {
                code: ErrorCode::IsolationUnavailable,
                message: self
                    .boot
                    .isolation
                    .as_ref()
                    .map(|report| {
                        format!(
                            "this has to run confined to the workspace and this machine cannot do that: {}",
                            report.detail
                        )
                    })
                    .unwrap_or_else(|| {
                        "this machine did not report a process-confinement backend".to_string()
                    }),
            });
        }
        match terminal::open(
            &mut self.terminals,
            &workspace,
            cols,
            rows,
            confinement_required,
            capabilities,
            &mut self.next_capability_id,
        ) {
            Ok(pty_id) => LogicOutcome::Reply(Box::new(Reply::Pty { pty_id })),
            Err(error) => LogicOutcome::Error(error),
        }
    }
}

fn session_request_needs_agent_catalog(request: &Request) -> bool {
    matches!(
        request,
        Request::SessionSend { .. }
            | Request::SessionFork { .. }
            | Request::SessionForkImport { .. }
            | Request::SessionSetModel { .. }
            | Request::SessionSetMode { .. }
            | Request::SessionSetEffort { .. }
            | Request::SessionRespondPermission { .. }
    )
}

fn request_workspace(request: &Request) -> Option<&str> {
    match request {
        Request::SessionFork {
            target: Some(target),
            ..
        }
        | Request::SessionForkImport { target, .. } => target.workspace_id.as_deref(),
        Request::SessionCreate { workspace_id, .. }
        | Request::SessionImportList { workspace_id, .. }
        | Request::SessionImport { workspace_id, .. }
        | Request::FileTree { workspace_id, .. }
        | Request::FileWrite { workspace_id, .. }
        | Request::FileMkdir { workspace_id, .. }
        | Request::FileCopy { workspace_id, .. }
        | Request::FileMove { workspace_id, .. }
        | Request::FileDelete { workspace_id, .. }
        | Request::GitStatus { workspace_id }
        | Request::GitDiff { workspace_id, .. }
        | Request::GitCommit { workspace_id, .. }
        | Request::PtyOpen { workspace_id, .. }
        | Request::SpeechContextPreview { workspace_id, .. }
        | Request::SpeechFeedbackRecord { workspace_id, .. }
        | Request::WorkspaceRename { workspace_id, .. }
        | Request::WorkspaceRemove { workspace_id } => Some(workspace_id),
        _ => None,
    }
}

fn offline_remote() -> RemoteAccess {
    RemoteAccess {
        relay_url: None,
        rendezvous_url: None,
        online: false,
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
    use genehub_proto::{
        AgentInfo, Capabilities, Catalog, LogTail, ModeInfo, PermissionOutcome, ProbeState,
        SequencedEvent, SessionArtifactFile, SessionEvent, SessionStatus, TimelineItem,
        TransportKind,
    };
    use genet_daemon_logic_api::{FileKind, Publication};

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
            features: Vec::new(),
            isolation: None,
            log_directory: ".".to_string(),
            log_display_directory: "/host/logs".to_string(),
            default_workspace: None,
            home_directory: None,
            builtin_agent_binary: None,
            builtin_agent_home_env: None,
        }
    }

    fn call(
        app: &mut LogicApp,
        capabilities: &mut impl CapabilityExecutor,
        call_id: u64,
        request: Request,
    ) -> Result<Reply, ProtocolError> {
        let output = app.handle_with(
            LogicInput::Request(LogicRequest {
                call_id,
                transport: TransportKind::Loopback,
                caller: CallerContext::LocalUser,
                route: Default::default(),
                request,
            }),
            capabilities,
        );
        let completion = output
            .completions
            .into_iter()
            .find(|completion| completion.call_id == call_id)
            .expect("a synchronous guest request completes exactly once");
        match completion.outcome {
            LogicOutcome::Reply(reply) => Ok(*reply),
            LogicOutcome::Error(error) => Err(error),
        }
    }

    #[cfg(unix)]
    fn open_workspace(
        app: &mut LogicApp,
        capabilities: &mut RealCapabilities,
        call_id: u64,
        root: &std::path::Path,
    ) -> genehub_proto::WorkspaceInfo {
        match call(
            app,
            capabilities,
            call_id,
            Request::WorkspaceOpen {
                root: root.display().to_string(),
            },
        )
        .unwrap()
        {
            Reply::Workspace(workspace) => workspace,
            other => panic!("wrong workspace reply: {other:?}"),
        }
    }

    #[cfg(unix)]
    fn create_session(
        app: &mut LogicApp,
        capabilities: &mut RealCapabilities,
        call_id: u64,
        workspace_id: String,
        cwd: Option<String>,
    ) -> genehub_proto::SessionSummary {
        match call(
            app,
            capabilities,
            call_id,
            Request::SessionCreate {
                workspace_id,
                agent_id: "genet".to_string(),
                model_id: None,
                mode_id: None,
                title: None,
                cwd,
            },
        )
        .unwrap()
        {
            Reply::Session(session) => session,
            other => panic!("wrong session reply: {other:?}"),
        }
    }

    #[cfg(unix)]
    struct WaitingInteraction {
        _directory: tempfile::TempDir,
        app: LogicApp,
        capabilities: RealCapabilities,
        session_id: String,
        private: std::path::PathBuf,
        logs: std::path::PathBuf,
        transcript: std::path::PathBuf,
        spawns: std::path::PathBuf,
    }

    #[cfg(unix)]
    fn wait_for_spawn_count(path: &std::path::Path, expected: usize) -> usize {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let count = std::fs::read_to_string(path)
                .map(|contents| contents.lines().count())
                .unwrap_or(0);
            if count >= expected || std::time::Instant::now() >= deadline {
                return count;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn waiting_interaction() -> WaitingInteraction {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private");
        let logs = directory.path().join("logs");
        let workspace = directory.path().join("workspace");
        let marker = directory.path().join("asked");
        let transcript = directory.path().join("transcript.jsonl");
        let spawns = directory.path().join("spawns");
        std::fs::create_dir_all(&workspace).unwrap();
        let agent = directory.path().join("fake-acp-agent");
        std::fs::write(
            &agent,
            r#"#!/bin/sh
marker=$1
transcript=$2
spawns=$3
printf 'spawn\n' >> "$spawns"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$transcript"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"remote-1"}}'
      ;;
    *'"method":"session/resume"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"remote-1"}}'
      ;;
    *'"method":"session/set_mode"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}'
      ;;
    *'"method":"session/prompt"'*)
      if [ ! -f "$marker" ]; then
        : > "$marker"
        printf '%s\n' '{"jsonrpc":"2.0","id":41,"method":"session/request_permission","params":{"toolCall":{"toolCallId":"tool-1","title":"Write a file"},"options":[{"optionId":"yes","name":"Allow once","kind":"allow_once"},{"optionId":"no","name":"Reject","kind":"reject_once"}]}}'
      else
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"resumed safely"}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}'
      fi
      ;;
  esac
done
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&agent).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&agent, permissions).unwrap();

        let mut app = LogicApp::new(boot()).unwrap();
        let mut config = config::Config::default();
        config.agents.custom.insert(
            "fixture".to_string(),
            config::CustomAgent {
                extends: "acp".to_string(),
                command: vec![
                    agent.display().to_string(),
                    marker.display().to_string(),
                    transcript.display().to_string(),
                    spawns.display().to_string(),
                ],
                label: Some("Fixture ACP".to_string()),
            },
        );
        app.config = Some(config);
        app.agent_cache = Some(vec![AgentInfo {
            id: "acp:fixture".to_string(),
            label: "Fixture ACP".to_string(),
            probe: ProbeState::Ready,
            capabilities: Capabilities {
                interrupt: true,
                set_mode: true,
                permissions: true,
                resume: true,
                ..Capabilities::default()
            },
            catalog: Catalog {
                modes: vec![
                    ModeInfo {
                        id: "ask".to_string(),
                        label: "Ask".to_string(),
                        description: None,
                    },
                    ModeInfo {
                        id: "agent".to_string(),
                        label: "Agent".to_string(),
                        description: None,
                    },
                ],
                default_mode: Some("agent".to_string()),
                ..Catalog::default()
            },
            builtin: false,
        }]);
        let mut capabilities = RealCapabilities::new(&private, &logs);
        let workspace = open_workspace(&mut app, &mut capabilities, 1, &workspace);
        let session = match call(
            &mut app,
            &mut capabilities,
            2,
            Request::SessionCreate {
                workspace_id: workspace.id,
                agent_id: "acp:fixture".to_string(),
                model_id: None,
                mode_id: Some("ask".to_string()),
                title: None,
                cwd: None,
            },
        )
        .unwrap()
        {
            Reply::Session(session) => session,
            other => panic!("wrong session reply: {other:?}"),
        };
        assert!(matches!(
            call(
                &mut app,
                &mut capabilities,
                3,
                Request::SessionSend {
                    session_id: session.id.clone(),
                    text: "please write it".to_string(),
                    attachments: Vec::new(),
                    artifact_preview_base_url: None,
                    continues_round: None,
                },
            )
            .unwrap(),
            Reply::Ack
        ));

        let mut waiting = false;
        for _ in 0..16 {
            let event = capabilities.event();
            let output = app.handle_with(LogicInput::CapabilityEvent(event), &mut capabilities);
            waiting |= output.publications.iter().any(|publication| {
                matches!(
                    publication,
                    Publication::Session(SequencedEvent {
                        event: SessionEvent::PermissionRequested { .. },
                        ..
                    })
                )
            });
            if waiting {
                break;
            }
        }
        assert!(waiting, "the fake ACP agent never requested permission");
        let state = serde_json::to_value(&app.sessions).unwrap();
        assert!(state["loaded"][&session.id]["process"].is_null());
        assert!(state["loaded"][&session.id]["activeTurn"].is_null());

        WaitingInteraction {
            _directory: directory,
            app,
            capabilities,
            session_id: session.id,
            private,
            logs,
            transcript,
            spawns,
        }
    }

    #[test]
    fn portable_router_owns_identity_and_pure_validation() {
        let mut app = LogicApp::new(boot()).unwrap();
        assert!(matches!(
            app.handle(LogicInput::Request(LogicRequest {
                call_id: 1,
                transport: TransportKind::Loopback,
                caller: CallerContext::LocalUser,
                route: Default::default(),
                request: Request::ConnectionIdentity,
            })),
            LogicOutput { completions, .. }
                if matches!(completions.as_slice(), [genet_daemon_logic_api::LogicCompletion {
                    outcome: LogicOutcome::Reply(reply),
                    ..
                }] if matches!(**reply, Reply::Hello(_)))
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
                caller: CallerContext::LocalUser,
                route: Default::default(),
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
                caller: CallerContext::LocalUser,
                route: Default::default(),
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
    fn portable_session_owns_persistence_process_protocol_and_live_state() {
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
        let restart_boot = boot.clone();
        let mut app = LogicApp::new(boot).unwrap();
        let mut capabilities = RealCapabilities::new(&private, &logs);
        let call = |app: &mut LogicApp, capabilities: &mut RealCapabilities, call_id, request| {
            app.handle_with(
                LogicInput::Request(LogicRequest {
                    call_id,
                    transport: TransportKind::Loopback,
                    caller: CallerContext::LocalUser,
                    route: Default::default(),
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
                cwd: None,
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

        drop(app);
        app = LogicApp::new(restart_boot).unwrap();
        let snapshot = call(
            &mut app,
            &mut capabilities,
            4,
            Request::SessionGet {
                session_id: session_id.clone(),
            },
        );
        let snapshot = match &snapshot.completions[0].outcome {
            LogicOutcome::Reply(reply) => match &**reply {
                Reply::Snapshot(snapshot) => snapshot,
                other => panic!("wrong snapshot reply: {other:?}"),
            },
            other => panic!("session get failed: {other:?}"),
        };
        assert!(snapshot.items.iter().any(|item| matches!(
            item,
            genehub_proto::TimelineItem::AssistantMessage { text, .. }
                if text == "portable reply"
        )));
        let completed_turn = snapshot
            .items
            .iter()
            .find_map(|item| match item {
                genehub_proto::TimelineItem::TurnSummary { stats, .. } => {
                    Some(stats.turn_id.clone())
                }
                _ => None,
            })
            .expect("the completed source turn is durable");

        let forked = call(
            &mut app,
            &mut capabilities,
            5,
            Request::SessionFork {
                session_id,
                turn_id: completed_turn,
                target: Some(genehub_proto::ForkTarget {
                    agent_id: "genet".to_string(),
                    workspace_id: None,
                    model_id: None,
                    mode_id: None,
                    effort_id: None,
                }),
            },
        );
        let forked = match &forked.completions[0].outcome {
            LogicOutcome::Reply(reply) => match &**reply {
                Reply::Session(session) => session,
                other => panic!("wrong fork reply: {other:?}"),
            },
            other => panic!("portable fork failed: {other:?}"),
        };
        assert_eq!(
            forked.lineage.as_ref().map(|lineage| lineage.method),
            Some(genehub_proto::ForkMethod::ReconstructedContext)
        );
        let fork_snapshot = call(
            &mut app,
            &mut capabilities,
            6,
            Request::SessionGet {
                session_id: forked.id.clone(),
            },
        );
        assert!(matches!(
            &fork_snapshot.completions[0].outcome,
            LogicOutcome::Reply(reply)
                if matches!(&**reply, Reply::Snapshot(snapshot)
                    if snapshot.items.iter().any(|item| matches!(
                        item,
                        genehub_proto::TimelineItem::AssistantMessage { text, .. }
                            if text == "portable reply"
                    )))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejecting_a_portable_interaction_cancels_without_restarting_the_agent() {
        let mut fixture = waiting_interaction();
        assert!(matches!(
            call(
                &mut fixture.app,
                &mut fixture.capabilities,
                20,
                Request::SessionRespondPermission {
                    session_id: fixture.session_id.clone(),
                    request_id: "41".to_string(),
                    outcome: PermissionOutcome::Selected {
                        option_id: "no".to_string(),
                    },
                },
            )
            .unwrap(),
            Reply::Ack
        ));
        assert_eq!(
            std::fs::read_to_string(&fixture.spawns)
                .unwrap()
                .lines()
                .count(),
            1,
            "rejection must not restart the stopped Agent"
        );
        let snapshot = match call(
            &mut fixture.app,
            &mut fixture.capabilities,
            21,
            Request::SessionGet {
                session_id: fixture.session_id.clone(),
            },
        )
        .unwrap()
        {
            Reply::Snapshot(snapshot) => snapshot,
            other => panic!("wrong snapshot reply: {other:?}"),
        };
        assert_eq!(snapshot.summary.status, SessionStatus::Idle);
        assert!(snapshot.pending_permissions.is_empty());
        let state = serde_json::to_value(&fixture.app.sessions).unwrap();
        let round = &state["loaded"][&fixture.session_id]["rounds"][0];
        assert_eq!(round["adapterTurnIds"].as_array().unwrap().len(), 1);
        assert_eq!(round["outcome"], "canceled");
    }

    #[cfg(unix)]
    #[test]
    fn portable_interaction_survives_a_cold_daemon_restart() {
        let WaitingInteraction {
            _directory,
            app,
            capabilities,
            session_id,
            private,
            logs,
            transcript,
            spawns,
        } = waiting_interaction();

        // A process restart does not carry the guest snapshot or native
        // resource table. Drop both sides, then reconstruct them exclusively
        // from the portable files written before the Agent was stopped.
        drop(app);
        drop(capabilities);
        let mut app = LogicApp::new(boot()).unwrap();
        let mut capabilities = RealCapabilities::new(&private, &logs);

        let waiting = match call(
            &mut app,
            &mut capabilities,
            30,
            Request::SessionGet {
                session_id: session_id.clone(),
            },
        )
        .unwrap()
        {
            Reply::Snapshot(snapshot) => snapshot,
            other => panic!("wrong cold-restart snapshot reply: {other:?}"),
        };
        assert_eq!(waiting.summary.status, SessionStatus::Waiting);
        assert_eq!(waiting.pending_permissions.len(), 1);
        assert_eq!(waiting.pending_permissions[0].id, "41");

        assert!(matches!(
            call(
                &mut app,
                &mut capabilities,
                31,
                Request::SessionRespondPermission {
                    session_id: session_id.clone(),
                    request_id: "41".to_string(),
                    outcome: PermissionOutcome::Selected {
                        option_id: "yes".to_string(),
                    },
                },
            )
            .unwrap(),
            Reply::Ack
        ));
        assert_eq!(
            wait_for_spawn_count(&spawns, 3),
            3,
            "cold recovery performs one catalog handshake and one session resume"
        );
        let mut completed = false;
        for _ in 0..20 {
            let event = capabilities.event();
            let output = app.handle_with(LogicInput::CapabilityEvent(event), &mut capabilities);
            completed |= output.publications.iter().any(|publication| {
                matches!(
                    publication,
                    Publication::Session(SequencedEvent {
                        event: SessionEvent::TurnCompleted { .. },
                        ..
                    })
                )
            });
            if completed {
                break;
            }
        }
        assert!(completed, "the cold-restarted interaction never completed");
        let resumed_transcript = std::fs::read_to_string(transcript).unwrap();
        assert_eq!(
            resumed_transcript
                .lines()
                .filter(|line| {
                    serde_json::from_str::<serde_json::Value>(line)
                        .ok()
                        .is_some_and(|value| {
                            value.get("method").and_then(serde_json::Value::as_str)
                                == Some("session/resume")
                        })
                })
                .count(),
            1,
            "the durable session itself must be resumed exactly once; transcript:\n{resumed_transcript}"
        );
        assert!(resumed_transcript.contains("The user approved the interrupted permission request"));

        let finished = match call(
            &mut app,
            &mut capabilities,
            32,
            Request::SessionGet { session_id },
        )
        .unwrap()
        {
            Reply::Snapshot(snapshot) => snapshot,
            other => panic!("wrong completed snapshot reply: {other:?}"),
        };
        assert_eq!(finished.summary.status, SessionStatus::Idle);
        assert!(finished.pending_permissions.is_empty());
        assert!(finished.items.iter().any(|item| {
            matches!(item, TimelineItem::AssistantMessage { text, .. } if text == "resumed safely")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn portable_artifact_upload_is_bounded_hashed_and_idempotent() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        use sha2::{Digest, Sha256};

        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private");
        let logs = directory.path().join("logs");
        let workspace = directory.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();

        let mut app = LogicApp::new(boot()).unwrap();
        let mut capabilities = RealCapabilities::new(&private, &logs);
        let workspace_info = open_workspace(&mut app, &mut capabilities, 1, &workspace);
        let session = create_session(&mut app, &mut capabilities, 2, workspace_info.id, None);

        let invalid = call(
            &mut app,
            &mut capabilities,
            3,
            Request::SessionArtifactBegin {
                session_id: session.id.clone(),
                files: vec![SessionArtifactFile {
                    name: "../escape.txt".to_string(),
                    mime: "text/plain".to_string(),
                    bytes: 1,
                }],
                metadata: serde_json::json!({}),
            },
        )
        .unwrap_err();
        assert_eq!(invalid.code, ErrorCode::BadRequest);

        let payload = b"portable artifact bytes";
        let upload = match call(
            &mut app,
            &mut capabilities,
            4,
            Request::SessionArtifactBegin {
                session_id: session.id.clone(),
                files: vec![SessionArtifactFile {
                    name: "capture.txt".to_string(),
                    mime: "text/plain".to_string(),
                    bytes: payload.len() as u64,
                }],
                metadata: serde_json::json!({"source": "integration-test"}),
            },
        )
        .unwrap()
        {
            Reply::SessionArtifactUpload(upload) => upload,
            other => panic!("wrong artifact begin reply: {other:?}"),
        };

        let wrong_offset = call(
            &mut app,
            &mut capabilities,
            5,
            Request::SessionArtifactChunk {
                session_id: session.id.clone(),
                upload_id: upload.upload_id.clone(),
                file_index: 0,
                offset: 1,
                data_base64: STANDARD.encode(payload),
            },
        )
        .unwrap_err();
        assert_eq!(wrong_offset.code, ErrorCode::BadRequest);

        assert!(matches!(
            call(
                &mut app,
                &mut capabilities,
                6,
                Request::SessionArtifactChunk {
                    session_id: session.id.clone(),
                    upload_id: upload.upload_id.clone(),
                    file_index: 0,
                    offset: 0,
                    data_base64: STANDARD.encode(payload),
                },
            )
            .unwrap(),
            Reply::Ack
        ));

        let finish = |app: &mut LogicApp, capabilities: &mut RealCapabilities, call_id| match call(
            app,
            capabilities,
            call_id,
            Request::SessionArtifactFinish {
                session_id: session.id.clone(),
                upload_id: upload.upload_id.clone(),
            },
        )
        .unwrap()
        {
            Reply::SessionArtifact(bundle) => bundle,
            other => panic!("wrong artifact finish reply: {other:?}"),
        };
        let bundle = finish(&mut app, &mut capabilities, 7);
        assert_eq!(bundle.total_bytes, payload.len() as u64);
        assert_eq!(bundle.files.len(), 1);
        assert_eq!(
            bundle.files[0].sha256,
            format!("{:x}", Sha256::digest(payload))
        );
        assert_eq!(
            std::fs::read(workspace.join(&bundle.workspace_path).join("capture.txt")).unwrap(),
            payload
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(workspace.join(&bundle.manifest_path)).unwrap())
                .unwrap();
        assert_eq!(manifest["schema"], "genehub.session-artifact.v1");
        assert_eq!(manifest["capture"]["source"], "integration-test");

        assert_eq!(
            finish(&mut app, &mut capabilities, 8),
            bundle,
            "retrying finish must return the same immutable receipt"
        );
    }

    #[cfg(unix)]
    #[test]
    fn portable_catalog_preserves_multi_root_future_format_and_deletion_contracts() {
        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private");
        let logs = directory.path().join("logs");
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let workspace_file = directory.path().join("project.code-workspace");
        std::fs::write(
            &workspace_file,
            serde_json::to_vec_pretty(&serde_json::json!({
                "folders": [
                    {"path": first},
                    {"path": second}
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let (workspace_id, second_session_id, future_session_id) = {
            let mut app = LogicApp::new(boot()).unwrap();
            let mut capabilities = RealCapabilities::new(&private, &logs);
            let workspace = open_workspace(&mut app, &mut capabilities, 1, &workspace_file);
            let second_session = create_session(
                &mut app,
                &mut capabilities,
                2,
                workspace.id.clone(),
                Some(second.display().to_string()),
            );
            let future_session = create_session(
                &mut app,
                &mut capabilities,
                3,
                workspace.id.clone(),
                Some(first.display().to_string()),
            );
            (workspace.id, second_session.id, future_session.id)
        };

        assert!(
            second
                .join(".genethub/sessions")
                .join(&second_session_id)
                .join("meta.json")
                .is_file(),
            "the session with a second-root cwd must be stored under that root"
        );
        let second_meta = second
            .join(".genethub/sessions")
            .join(&second_session_id)
            .join("meta.json");
        let mut old_meta: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&second_meta).unwrap()).unwrap();
        old_meta["format"] = serde_json::json!(4);
        std::fs::write(&second_meta, serde_json::to_vec_pretty(&old_meta).unwrap()).unwrap();
        let future_meta = first
            .join(".genethub/sessions")
            .join(&future_session_id)
            .join("meta.json");
        let written = session::SESSION_FORMAT + 1;
        std::fs::write(
            &future_meta,
            serde_json::to_vec_pretty(&serde_json::json!({
                "format": written,
                "title": "来自未来",
                "whatIsThis": [1, 2]
            }))
            .unwrap(),
        )
        .unwrap();

        let mut app = LogicApp::new(boot()).unwrap();
        let mut capabilities = RealCapabilities::new(&private, &logs);
        let listed = match call(
            &mut app,
            &mut capabilities,
            10,
            Request::SessionList {
                workspace_id: Some(workspace_id.clone()),
                include_archived: false,
            },
        )
        .unwrap()
        {
            Reply::Sessions(sessions) => sessions,
            other => panic!("wrong session list reply: {other:?}"),
        };
        assert!(listed.iter().any(|session| session.id == second_session_id));
        let future = listed
            .iter()
            .find(|session| session.id == future_session_id)
            .expect("a newer session in the user's project must remain visible");
        assert_eq!(future.title.as_deref(), Some("来自未来"));
        assert_eq!(future.unsupported.as_ref().unwrap().written, written);
        assert_eq!(
            call(
                &mut app,
                &mut capabilities,
                11,
                Request::SessionGet {
                    session_id: future_session_id.clone(),
                },
            )
            .unwrap_err()
            .code,
            ErrorCode::Unsupported
        );

        let renamed = match call(
            &mut app,
            &mut capabilities,
            12,
            Request::SessionRename {
                session_id: second_session_id.clone(),
                title: "A durable name".to_string(),
            },
        )
        .unwrap()
        {
            Reply::Session(session) => session,
            other => panic!("wrong rename reply: {other:?}"),
        };
        assert_eq!(renamed.title.as_deref(), Some("A durable name"));
        let rewritten: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&second_meta).unwrap()).unwrap();
        assert_eq!(
            rewritten["format"],
            serde_json::json!(session::SESSION_FORMAT),
            "the first write by a newer build must stamp its session format"
        );
        assert_eq!(
            call(
                &mut app,
                &mut capabilities,
                13,
                Request::SessionRename {
                    session_id: second_session_id.clone(),
                    title: "   ".to_string(),
                },
            )
            .unwrap_err()
            .code,
            ErrorCode::BadRequest
        );

        let removed = match call(
            &mut app,
            &mut capabilities,
            14,
            Request::WorkspaceRemove {
                workspace_id: workspace_id.clone(),
            },
        )
        .unwrap()
        {
            Reply::Workspaces(workspaces) => workspaces,
            other => panic!("wrong workspace remove reply: {other:?}"),
        };
        assert!(removed.iter().all(|workspace| workspace.id != workspace_id));
        let hidden = match call(
            &mut app,
            &mut capabilities,
            15,
            Request::SessionList {
                workspace_id: Some(workspace_id.clone()),
                include_archived: true,
            },
        )
        .unwrap()
        {
            Reply::Sessions(sessions) => sessions,
            other => panic!("wrong removed-workspace session reply: {other:?}"),
        };
        assert!(hidden.is_empty(), "removed workspace sessions stay hidden");
        let reopened = open_workspace(&mut app, &mut capabilities, 16, &workspace_file);
        assert_eq!(reopened.id, workspace_id);
        let restored = match call(
            &mut app,
            &mut capabilities,
            17,
            Request::SessionList {
                workspace_id: Some(workspace_id.clone()),
                include_archived: true,
            },
        )
        .unwrap()
        {
            Reply::Sessions(sessions) => sessions,
            other => panic!("wrong reopened-workspace session reply: {other:?}"),
        };
        assert!(restored
            .iter()
            .any(|session| session.id == second_session_id));

        for (call_id, session_id) in [
            (20, second_session_id.clone()),
            (21, second_session_id.clone()),
            (22, future_session_id.clone()),
            (23, future_session_id.clone()),
        ] {
            assert!(matches!(
                call(
                    &mut app,
                    &mut capabilities,
                    call_id,
                    Request::SessionDelete { session_id },
                )
                .unwrap(),
                Reply::Ack
            ));
        }
        let listed = match call(
            &mut app,
            &mut capabilities,
            24,
            Request::SessionList {
                workspace_id: None,
                include_archived: true,
            },
        )
        .unwrap()
        {
            Reply::Sessions(sessions) => sessions,
            other => panic!("wrong session list reply: {other:?}"),
        };
        assert!(listed.is_empty(), "tombstoned sessions must not reappear");
    }

    #[cfg(unix)]
    #[test]
    fn portable_session_honors_and_retries_the_legacy_workspace_owner_lock() {
        use fs2::FileExt as _;

        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private");
        let logs = directory.path().join("logs");
        let workspace = directory.path().join("workspace");
        let home = workspace.join(".genethub");
        std::fs::create_dir_all(&home).unwrap();

        let mut app = LogicApp::new(boot()).unwrap();
        let mut capabilities = RealCapabilities::new(&private, &logs);
        let workspace_info = open_workspace(&mut app, &mut capabilities, 1, &workspace);

        std::fs::write(home.join("owner"), "GeneHub Legacy\n").unwrap();
        let legacy = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(home.join("owner.lock"))
            .unwrap();
        legacy.try_lock_exclusive().unwrap();
        let refused = call(
            &mut app,
            &mut capabilities,
            2,
            Request::SessionCreate {
                workspace_id: workspace_info.id.clone(),
                agent_id: "genet".to_string(),
                model_id: None,
                mode_id: None,
                title: None,
                cwd: None,
            },
        )
        .unwrap_err();
        assert_eq!(refused.code, ErrorCode::Conflict);

        legacy.unlock().unwrap();
        drop(legacy);
        let created = create_session(&mut app, &mut capabilities, 3, workspace_info.id, None);
        assert!(
            workspace
                .join(".genethub/sessions")
                .join(created.id)
                .join("meta.json")
                .is_file(),
            "the current build must retry the compatibility lock without restarting"
        );
    }

    #[cfg(unix)]
    #[test]
    fn portable_acp_import_is_two_stage_durable_and_non_replayable() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private");
        let logs = directory.path().join("logs");
        let workspace = directory.path().join("workspace");
        std::fs::create_dir_all(&private).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();

        let agent = directory.path().join("fixture-acp");
        std::fs::write(
            &agent,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{"sessionCapabilities":{"list":{},"load":{}}}}}'
      ;;
    *'"method":"session/list"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessions":[{"sessionId":"source-session","title":"Imported fixture","updatedAt":123}]}}'
      ;;
    *'"method":"session/load"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello from source"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"portable imported answer"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
      ;;
  esac
done
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&agent).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&agent, permissions).unwrap();

        let mut config = config::Config::default();
        config.agents.custom.insert(
            "fixture".to_string(),
            config::CustomAgent {
                extends: "acp".to_string(),
                command: vec![agent.display().to_string()],
                label: Some("Fixture ACP".to_string()),
            },
        );
        std::fs::write(
            private.join("config.json"),
            serde_json::to_vec_pretty(&config).unwrap(),
        )
        .unwrap();

        let mut app = LogicApp::new(boot()).unwrap();
        let mut capabilities = RealCapabilities::new(&private, &logs);
        let workspace = open_workspace(&mut app, &mut capabilities, 1, &workspace);
        let listed = match call(
            &mut app,
            &mut capabilities,
            2,
            Request::SessionImportList {
                workspace_id: workspace.id.clone(),
                limit: Some(10),
            },
        )
        .unwrap()
        {
            Reply::SessionImports(listing) => listing,
            other => panic!("wrong import list reply: {other:?}"),
        };
        let candidate = listed
            .sources
            .iter()
            .find(|source| source.agent_id == "acp:fixture")
            .and_then(|source| source.candidates.first())
            .expect("the custom ACP source must return an opaque candidate")
            .clone();
        assert!(candidate.candidate_id.starts_with("ic_"));
        assert!(!candidate.candidate_id.contains("source-session"));

        let imported = match call(
            &mut app,
            &mut capabilities,
            3,
            Request::SessionImport {
                workspace_id: workspace.id.clone(),
                candidate_id: candidate.candidate_id.clone(),
            },
        )
        .unwrap()
        {
            Reply::Session(session) => session,
            other => panic!("wrong import reply: {other:?}"),
        };
        assert_eq!(imported.imported.as_ref().unwrap().agent_id, "acp:fixture");

        let snapshot = match call(
            &mut app,
            &mut capabilities,
            4,
            Request::SessionGet {
                session_id: imported.id,
            },
        )
        .unwrap()
        {
            Reply::Snapshot(snapshot) => snapshot,
            other => panic!("wrong imported snapshot reply: {other:?}"),
        };
        assert!(snapshot.items.iter().any(|item| matches!(
            item,
            genehub_proto::TimelineItem::UserMessage { text, .. }
                if text == "hello from source"
        )));
        assert!(snapshot.items.iter().any(|item| matches!(
            item,
            genehub_proto::TimelineItem::AssistantMessage { text, .. }
                if text == "portable imported answer"
        )));

        assert_eq!(
            call(
                &mut app,
                &mut capabilities,
                5,
                Request::SessionImport {
                    workspace_id: workspace.id.clone(),
                    candidate_id: candidate.candidate_id,
                },
            )
            .unwrap_err()
            .code,
            ErrorCode::BadRequest,
            "an opaque candidate is a one-use selection token"
        );
        let listed_again = match call(
            &mut app,
            &mut capabilities,
            6,
            Request::SessionImportList {
                workspace_id: workspace.id,
                limit: Some(10),
            },
        )
        .unwrap()
        {
            Reply::SessionImports(listing) => listing,
            other => panic!("wrong second import list reply: {other:?}"),
        };
        assert!(listed_again.filtered_duplicates >= 1);
        assert!(listed_again
            .sources
            .iter()
            .find(|source| source.agent_id == "acp:fixture")
            .is_some_and(|source| source.candidates.is_empty()));
    }
}
