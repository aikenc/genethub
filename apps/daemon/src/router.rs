//! Request dispatch: one `Request` in, one `Reply` or `ProtocolError` out.
//!
//! Kept free of transport concerns so the same routing serves loopback and
//! forwarded connections without duplication. Legacy LAN is rejected at bind.

use std::path::Path;
use std::sync::Arc;

use genehub_proto::{
    ErrorCode, HelloResult, ProtocolError, Reply, Request, TransportKind, WEB_PROTOCOL_VERSION,
};
use tokio::sync::broadcast;

use crate::state::Shared;
use crate::{files, git};

/// What a handled request may ask the connection to do beyond replying.
pub enum SideEffect {
    None,
    Subscribe {
        session_id: String,
        receiver: broadcast::Receiver<genehub_proto::SequencedEvent>,
    },
    Unsubscribe {
        session_id: String,
    },
}

pub struct Handled {
    pub reply: Result<Reply, ProtocolError>,
    pub effect: SideEffect,
}

impl Handled {
    fn ok(reply: Reply) -> Self {
        Handled {
            reply: Ok(reply),
            effect: SideEffect::None,
        }
    }

    fn err(code: ErrorCode, message: impl Into<String>) -> Self {
        Handled {
            reply: Err(ProtocolError {
                code,
                message: message.into(),
            }),
            effect: SideEffect::None,
        }
    }
}

/// Maps an internal failure onto a client-visible error.
///
/// Everything that reaches a user goes through here, so the wording is worth
/// keeping honest: `docs/testing.md` §4.4 requires every failure to say
/// something actionable rather than render blank.
fn failed(error: anyhow::Error) -> Handled {
    let message = format!("{error:#}");
    // Typed errors classify by type so a user-facing message (any language)
    // can change without breaking the wire code; string matching below is the
    // fallback for errors that cross module boundaries as plain anyhow text.
    let code = if error
        .downcast_ref::<crate::session::manager::SessionMissing>()
        .is_some()
    {
        ErrorCode::NotFound
    } else if message.contains("invalid session artifact")
        || message.contains("session artifact chunk")
        || message.contains("session artifact metadata")
        || message.contains("session artifact exceeds")
        || message.contains("artifact upload incomplete")
    {
        ErrorCode::BadRequest
    } else if message.contains("artifact upload conflict") {
        ErrorCode::Conflict
    } else if message.contains("no such artifact upload") {
        ErrorCode::NotFound
    } else if message.contains("artifact upload does not belong") {
        ErrorCode::Forbidden
    } else if message.contains("Asset Preview base URL") {
        ErrorCode::BadRequest
    } else if message.contains("escapes the workspace")
        || message.contains("not a member of this workspace")
        || message.contains("workspace path is not canonical")
        || message.contains("must name its root handle")
    {
        ErrorCode::Forbidden
    } else if message.contains("already running") {
        ErrorCode::Conflict
    } else if message.contains("no such") || message.contains("does not exist") {
        ErrorCode::NotFound
    } else if message.contains("workspace file")
        || message.contains("workspace folder")
        || message.contains(".code-workspace")
        || message.contains("not a directory")
        || message.contains("是内置的")
        || message.contains("只能清空")
        || message.contains("this agent offers")
        || message.contains("Claude Code offers")
        || message.contains("unknown thinking level")
    {
        ErrorCode::BadRequest
    } else if message.contains("does not") || message.contains("not supported") {
        ErrorCode::Unsupported
    } else {
        ErrorCode::Internal
    };
    // Default filter is info; warn keeps the sentence the client already saw in
    // daemon.log so a feedback pull of log.tail can explain the same failure.
    tracing::warn!(?code, error = %message, "rpc failed");
    Handled {
        reply: Err(ProtocolError { code, message }),
        effect: SideEffect::None,
    }
}

/// Handles one request on behalf of `caller`.
///
/// The caller is passed in rather than re-derived here because the gate above
/// has already resolved it, and two answers to "who is this" is one too many.
/// Most requests only need to have passed that gate; the ones that start a
/// process need to know *which* caller, because what the operating system is
/// asked to enforce on it depends on the answer.
pub async fn handle(
    state: &Shared,
    transport: TransportKind,
    caller: &crate::authz::Principal,
    request: Request,
) -> Handled {
    let operation = diagnostic_operation(&request);
    let handled = dispatch(state, transport, caller, request).await;
    if let Some(operation) = operation {
        let (outcome, code) = match &handled.reply {
            Ok(_) => ("ok", None),
            Err(error) => ("error", Some(error_code_name(error.code))),
        };
        state.diagnostics.record("rpc", operation, outcome, code);
    }
    handled
}

async fn dispatch(
    state: &Shared,
    transport: TransportKind,
    caller: &crate::authz::Principal,
    request: Request,
) -> Handled {
    match request {
        Request::ConnectionIdentity => Handled::ok(Reply::Hello(HelloResult {
            daemon_version: state.version.clone(),
            web_protocol: WEB_PROTOCOL_VERSION,
            machine_id: state.machine.machine_id.clone(),
            fingerprint: state.machine.fingerprint(),
            transport,
            machine_name: crate::link::default_display_name(),
            rtc_supported: crate::dataplane::rtc::SUPPORTED,
            features: Some(vec![
                genehub_proto::SPEECH_FEATURE_TRANSCRIBE.to_string(),
                genehub_proto::SPEECH_FEATURE_PARTIAL.to_string(),
                genehub_proto::SPEECH_FEATURE_CONTEXT_PREVIEW.to_string(),
                genehub_proto::SPEECH_FEATURE_FEEDBACK.to_string(),
            ]),
            isolation: Some(crate::isolation::report()),
        })),

        Request::Subscribe {
            session_id,
            since_seq,
            expand_last_round,
        } => match state
            .sessions
            .subscribe(&session_id, since_seq, expand_last_round)
            .await
        {
            Ok((snapshot, replayed, reset, receiver)) => Handled {
                reply: Ok(Reply::Subscribed {
                    snapshot,
                    replayed,
                    reset,
                }),
                effect: SideEffect::Subscribe {
                    session_id,
                    receiver,
                },
            },
            Err(error) => failed(error),
        },

        Request::Unsubscribe { session_id } => Handled {
            reply: Ok(Reply::Ack),
            effect: SideEffect::Unsubscribe { session_id },
        },

        Request::AgentList => {
            let providers = state.providers().await;
            Handled::ok(Reply::Agents(state.registry.list(&providers).await))
        }

        Request::AgentRefresh => {
            let providers = state.providers().await;
            Handled::ok(Reply::Agents(state.registry.refresh(&providers).await))
        }

        Request::SessionCreate {
            workspace_id,
            agent_id,
            model_id,
            mode_id,
            runtime_values,
            title,
            cwd,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            let start_in = match cwd {
                // Any of the workspace's folders, not only the first: a
                // multi-folder workspace is one project, and a task started in
                // its second folder is not a different workspace.
                Some(cwd) => {
                    let candidate = std::path::Path::new(&cwd);
                    match workspace
                        .folders
                        .iter()
                        .find_map(|folder| {
                            crate::session::store::ensure_within(&folder.root, candidate).ok()
                        })
                        .or_else(|| {
                            crate::session::store::ensure_within(&workspace.root, candidate).ok()
                        }) {
                        Some(resolved) => resolved,
                        // Refusing beats clamping to the root: a task quietly
                        // run in the wrong directory looks like it worked.
                        None => return failed(anyhow::anyhow!("cwd {cwd} escapes the workspace")),
                    }
                }
                None => workspace.root,
            };
            match state
                .sessions
                .create(
                    &workspace_id,
                    start_in,
                    &agent_id,
                    model_id,
                    mode_id,
                    runtime_values.unwrap_or_default(),
                    title,
                )
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }

        Request::SessionList {
            workspace_id,
            include_archived,
        } => match state
            .sessions
            .list(workspace_id.as_deref(), include_archived)
            .await
        {
            Ok(sessions) => Handled::ok(Reply::Sessions(sessions)),
            Err(error) => failed(error),
        },

        Request::SessionGet { session_id } => match state.sessions.snapshot(&session_id).await {
            Ok(snapshot) => Handled::ok(Reply::Snapshot(snapshot)),
            Err(error) => failed(error),
        },

        Request::SessionInspect {
            session_id,
            through_round_id,
        } => match state
            .sessions
            .inspect(&session_id, through_round_id.as_deref())
            .await
        {
            Ok(inspection) => Handled::ok(Reply::SessionInspection(inspection)),
            Err(error) => failed(error),
        },

        Request::SessionNarrative {
            session_id,
            through_round_id,
            item_id,
            cursor,
            limit,
        } => match state
            .sessions
            .narrative_page(
                &session_id,
                through_round_id.as_deref(),
                item_id.as_deref(),
                cursor.as_deref(),
                limit,
            )
            .await
        {
            Ok(page) => Handled::ok(Reply::SessionNarrative(page)),
            Err(error) => failed(error),
        },

        Request::SessionRounds {
            session_id,
            through_round_id,
            cursor,
            limit,
        } => match state
            .sessions
            .round_page(
                &session_id,
                through_round_id.as_deref(),
                cursor.as_deref(),
                limit,
            )
            .await
        {
            Ok(page) => Handled::ok(Reply::SessionRounds(page)),
            Err(error) => failed(error),
        },

        Request::SessionContext {
            session_id,
            through_round_id,
            token_budget,
        } => match state
            .sessions
            .session_context(&session_id, through_round_id.as_deref(), token_budget)
            .await
        {
            Ok(context) => Handled::ok(Reply::SessionContext(context)),
            Err(error) => failed(error),
        },

        Request::RoundTrunkList {
            session_id,
            round_id,
            cursor,
            limit,
        } => match state
            .sessions
            .round_layer(&session_id, &round_id, cursor.as_deref(), limit)
            .await
        {
            Ok(layer) => Handled::ok(Reply::RoundLayer(layer)),
            Err(error) => failed(error),
        },

        Request::RoundTrunkGet {
            session_id,
            round_id,
            trunk_index,
        } => match state
            .sessions
            .round_trunk(&session_id, &round_id, trunk_index)
            .await
        {
            Ok(trunk) => Handled::ok(Reply::RoundTrunk(trunk)),
            Err(error) => failed(error),
        },

        Request::BlobGet { session_id, blob } => {
            match state.sessions.blob(&session_id, &blob).await {
                Ok(blob) => Handled::ok(Reply::Blob(blob)),
                Err(error) => failed(error),
            }
        }

        Request::RoundTrunkBatchGet { session_id, refs } => {
            match state.sessions.round_trunks(&session_id, &refs).await {
                Ok(trunks) => Handled::ok(Reply::RoundTrunks(trunks)),
                Err(error) => failed(error),
            }
        }

        Request::BlobBatchGet { session_id, blobs } => {
            match state.sessions.blobs(&session_id, &blobs).await {
                Ok(blobs) => Handled::ok(Reply::Blobs(blobs)),
                Err(error) => failed(error),
            }
        }

        Request::SessionSend {
            session_id,
            text,
            attachments,
            artifact_preview_base_url,
            continues_round,
        } => {
            if text.trim().is_empty() && attachments.is_empty() {
                return Handled::err(ErrorCode::BadRequest, "there is nothing to send");
            }
            let providers = state.providers().await;
            match state
                .sessions
                .send(
                    &session_id,
                    text,
                    attachments,
                    &providers,
                    artifact_preview_base_url,
                    continues_round,
                )
                .await
            {
                Ok(_) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionArtifactBegin {
            session_id,
            files,
            metadata,
        } => match state
            .sessions
            .begin_artifact(&session_id, files, metadata)
            .await
        {
            Ok(upload) => Handled::ok(Reply::SessionArtifactUpload(upload)),
            Err(error) => failed(error),
        },

        Request::SessionArtifactChunk {
            session_id,
            upload_id,
            file_index,
            offset,
            data_base64,
        } => match state
            .sessions
            .write_artifact_chunk(&session_id, &upload_id, file_index, offset, &data_base64)
            .await
        {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },

        Request::SessionArtifactFinish {
            session_id,
            upload_id,
        } => match state
            .sessions
            .finish_artifact(&session_id, &upload_id)
            .await
        {
            Ok(bundle) => Handled::ok(Reply::SessionArtifact(bundle)),
            Err(error) => failed(error),
        },

        Request::SessionArtifactAbort {
            session_id,
            upload_id,
        } => match state.sessions.abort_artifact(&session_id, &upload_id).await {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },

        Request::SessionFork {
            session_id,
            turn_id,
            target,
        } => {
            let providers = state.providers().await;
            if let Some(target) = target
                .as_ref()
                .filter(|target| target.workspace_id.is_some())
            {
                let workspace_id = target.workspace_id.as_deref().expect("filtered above");
                let workspace = match state.workspaces.get(workspace_id).await {
                    Ok(workspace) => workspace,
                    Err(error) => return failed(error),
                };
                let transfer = match state.sessions.fork_export(&session_id, &turn_id).await {
                    Ok(transfer) => transfer,
                    Err(error) => return failed(error),
                };
                return match state
                    .sessions
                    .fork_import(
                        workspace_id,
                        workspace.root,
                        transfer,
                        target.clone(),
                        &providers,
                        true,
                    )
                    .await
                {
                    Ok(summary) => Handled::ok(Reply::Session(summary)),
                    Err(error) => failed(error),
                };
            }
            match state
                .sessions
                .fork(&session_id, &turn_id, target, &providers)
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }

        Request::SessionForkExport {
            session_id,
            turn_id,
        } => match state.sessions.fork_export(&session_id, &turn_id).await {
            Ok(transfer) => Handled::ok(Reply::ForkTransfer(transfer)),
            Err(error) => failed(error),
        },

        Request::SessionForkImport { transfer, target } => {
            let Some(workspace_id) = target.workspace_id.clone() else {
                return Handled::err(ErrorCode::BadRequest, "directed fork requires workspaceId");
            };
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            let providers = state.providers().await;
            match state
                .sessions
                .fork_import(
                    &workspace_id,
                    workspace.root,
                    transfer,
                    target,
                    &providers,
                    false,
                )
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }

        Request::SessionImportList {
            workspace_id,
            limit,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match state
                .sessions
                .list_imports(&workspace_id, workspace.root, limit)
                .await
            {
                Ok(listing) => Handled::ok(Reply::SessionImports(listing)),
                Err(error) => failed(error),
            }
        }

        Request::SessionImport {
            workspace_id,
            candidate_id,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match state
                .sessions
                .import(&workspace_id, workspace.root, &candidate_id)
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }

        Request::SessionInterrupt { session_id } => {
            match state.sessions.interrupt(&session_id).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionClose { session_id } => match state.sessions.close(&session_id).await {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },

        Request::SessionArchive {
            session_id,
            archived,
        } => match state.sessions.archive(&session_id, archived).await {
            Ok(summary) => Handled::ok(Reply::Session(summary)),
            Err(error) => failed(error),
        },

        Request::SessionRename { session_id, title } => {
            match state.sessions.rename(&session_id, &title).await {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }

        Request::SessionDelete { session_id } => match state.sessions.delete(&session_id).await {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },

        Request::SessionSetModel {
            session_id,
            model_id,
        } => {
            let providers = state.providers().await;
            match state
                .sessions
                .set_model(&session_id, &model_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionSetMode {
            session_id,
            mode_id,
        } => {
            let providers = state.providers().await;
            match state
                .sessions
                .set_mode(&session_id, &mode_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionSetEffort {
            session_id,
            effort_id,
        } => {
            let providers = state.providers().await;
            match state
                .sessions
                .set_effort(&session_id, &effort_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionSetRuntimeAxis {
            session_id,
            axis_id,
            value_id,
        } => {
            let providers = state.providers().await;
            match state
                .sessions
                .set_runtime_axis(&session_id, &axis_id, &value_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SessionRespondPermission {
            session_id,
            request_id,
            outcome,
        } => {
            let providers = state.providers().await;
            match state
                .sessions
                .respond_permission(&session_id, &request_id, outcome, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::SettingsGet => Handled::ok(Reply::Settings(state.settings().await)),

        Request::SpeechCapabilities => {
            Handled::ok(Reply::SpeechCapabilities(state.speech_capabilities().await))
        }

        Request::SpeechSettingsSetQwen3 {
            stub_enabled,
            context_enabled,
            pinned_terms,
            language_hints,
            collect_corrections,
            workspace_id,
        } => match state
            .set_qwen3_speech(
                stub_enabled,
                context_enabled,
                pinned_terms,
                language_hints,
                collect_corrections,
                workspace_id,
            )
            .await
        {
            Ok(settings) => Handled::ok(Reply::Settings(settings)),
            Err(error) => failed(error),
        },

        Request::SpeechRuntimeProbe => Handled::ok(Reply::SpeechRuntimeStatus(
            state.probe_speech_runtime().await,
        )),

        Request::SpeechRuntimeConfigure { command, args } => {
            if transport != TransportKind::Loopback {
                Handled::err(
                    ErrorCode::Forbidden,
                    "语音 runtime 只能由这台电脑上的本地用户注册或移除",
                )
            } else {
                match state.configure_speech_runtime(command, args).await {
                    Ok(capabilities) => Handled::ok(Reply::SpeechCapabilities(capabilities)),
                    Err(error) => failed(error),
                }
            }
        }

        Request::SpeechContextPreview {
            workspace_id,
            session_id,
            draft,
        } => match crate::speech::compile_context_for_state(
            state,
            &workspace_id,
            session_id.as_deref(),
            draft.as_deref(),
        )
        .await
        {
            Ok(context) => Handled::ok(Reply::SpeechContext(context)),
            Err(error) => failed(error),
        },

        Request::SpeechFeedbackRecord {
            workspace_id,
            request_id,
            context_snapshot_id: _,
            candidates: _,
            selected_candidate_id,
            rejected_candidate_id,
            scope,
            score_kind: _,
        } => match crate::speech::record_feedback_for_state(
            state,
            crate::speech::FeedbackSubmission {
                workspace_id,
                request_id,
                selected_candidate_id,
                rejected_candidate_id,
                scope,
            },
        )
        .await
        {
            Ok(receipt) => Handled::ok(Reply::SpeechFeedbackReceipt(receipt)),
            Err(error) => failed(error),
        },

        Request::SettingsSetProvider {
            provider_id,
            api_key,
            base_url,
            label,
            dialect,
            models,
        } => match state
            .set_provider(&provider_id, api_key, base_url, label, dialect, models)
            .await
        {
            Ok(settings) => Handled::ok(Reply::Settings(settings)),
            Err(error) => failed(error),
        },

        Request::LogTail { name } => {
            let dir = state.paths.logs_dir();
            // The daemon's own log by default: nearly every error someone opens
            // this for is the daemon's or an agent's, and both land there.
            let name = name.unwrap_or_else(|| "daemon.log".to_string());
            match crate::logs::tail(&dir, &name, crate::logs::DEFAULT_TAIL_BYTES) {
                Ok(text) => Handled::ok(Reply::Log(genehub_proto::LogTail {
                    path: dir.join(&name).display().to_string(),
                    name,
                    text,
                    files: crate::logs::list(&dir)
                        .into_iter()
                        .map(|(name, bytes)| genehub_proto::LogEntry { name, bytes })
                        .collect(),
                })),
                Err(error) => failed(error),
            }
        }

        Request::DiagnosticsSnapshot => {
            let hub = match state.link.get() {
                Some(link) => link.status().await,
                None => genehub_proto::HubStatus::Unpaired,
            };
            let remote = remote_status(state).await;
            Handled::ok(Reply::Diagnostics(state.diagnostics.snapshot(
                &state.version,
                &hub,
                &remote,
            )))
        }

        Request::UpdateCheck => match crate::host_update::check() {
            Ok(status) => Handled::ok(Reply::Update(status)),
            Err(message) => Handled::err(ErrorCode::Unsupported, message),
        },

        Request::UpdateAppCheck => {
            let manifest_url = state.config.read().await.update_manifest_url.clone();
            // The App check compares the App's own build version, not the
            // component's: a Live release moves the component past the App
            // line, and the question here is whether the machine's
            // binaries need replacing.
            let app_version = crate::version::app_version();
            Handled::ok(Reply::Update(
                crate::updates::check(&manifest_url, &app_version).await,
            ))
        }

        Request::UpdateDownload => match crate::host_update::apply("web") {
            Ok(()) => {
                state.reload.notify_waiters();
                Handled::ok(Reply::UpdateDownload(state.updates.state()))
            }
            Err(message) => Handled::err(ErrorCode::Unsupported, message),
        },

        Request::UpdateDownloadState => Handled::ok(Reply::UpdateDownload(state.updates.state())),

        Request::UpdateDismiss => Handled::ok(Reply::UpdateDownload(state.updates.dismiss(state))),

        Request::SettingsForgetProvider { provider_id } => {
            match state.forget_provider(&provider_id).await {
                Ok(settings) => Handled::ok(Reply::Settings(settings)),
                Err(error) => failed(error),
            }
        }

        Request::HubStatus => match state.link.get() {
            Some(link) => Handled::ok(Reply::HubStatus(link.status().await)),
            None => Handled::ok(Reply::HubStatus(genehub_proto::HubStatus::Unpaired)),
        },

        Request::HubPair {
            hub_url,
            display_name,
        } => {
            let Some(link) = state.link.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match link.pair(&hub_url, display_name).await {
                Ok(status) => Handled::ok(Reply::HubStatus(status)),
                Err(error) => {
                    // Being already paired is the user's situation to fix, not
                    // a fault, so it comes back as a conflict rather than a 500.
                    let message = format!("{error:#}");
                    let code = if message.contains("already paired") {
                        ErrorCode::Conflict
                    } else {
                        ErrorCode::Internal
                    };
                    Handled::err(code, message)
                }
            }
        }

        Request::HubTrial {
            hub_url,
            display_name,
        } => {
            let Some(link) = state.link.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match link.trial(&hub_url, display_name).await {
                Ok((status, trial)) => Handled::ok(Reply::HubClaim {
                    status,
                    claim: trial,
                }),
                Err(error) => {
                    let message = format!("{error:#}");
                    let code = if message.contains("already paired") {
                        ErrorCode::Conflict
                    } else {
                        ErrorCode::Internal
                    };
                    Handled::err(code, message)
                }
            }
        }

        Request::HubClaimLink => {
            let Some(link) = state.link.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match link.claim_link().await {
                Ok(trial) => Handled::ok(Reply::HubClaim {
                    status: link.status().await,
                    claim: trial,
                }),
                Err(error) => failed(error),
            }
        }

        Request::HubMachines => match state.link.get() {
            Some(link) => match link.machines().await {
                Ok(machines) => Handled::ok(Reply::HubMachines(machines)),
                Err(error) => failed(error),
            },
            // Still starting up is not "you have no machines", but a switcher
            // showing an error for the second it takes would be worse than one
            // that fills in a moment later.
            None => Handled::ok(Reply::HubMachines(Vec::new())),
        },

        Request::HubConnect { machine_id } => {
            let Some(link) = state.link.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match link.connect(&machine_id).await {
                Ok(ticket) => Handled::ok(Reply::HubTicket(ticket)),
                Err(error) => failed(error),
            }
        }

        Request::HubUnpair => match state.link.get() {
            Some(link) => match link.unpair().await {
                Ok(()) => Handled::ok(Reply::HubStatus(genehub_proto::HubStatus::Unpaired)),
                Err(error) => failed(error),
            },
            None => Handled::ok(Reply::HubStatus(genehub_proto::HubStatus::Unpaired)),
        },

        Request::DeviceList => Handled::ok(Reply::Devices {
            devices: state.devices.list(),
            remote: remote_status(state).await,
        }),

        Request::DeviceInvite(scope) => {
            let grants = match scope {
                None => crate::authz::GrantSet::full(),
                Some(scope) => {
                    let mut named = Vec::with_capacity(scope.grants.len());
                    for raw in &scope.grants {
                        match crate::authz::Capability::parse(raw) {
                            Some(capability) => named.push(capability),
                            // Refused rather than dropped: an invitation minted
                            // from a misspelled grant would silently be worth
                            // less than whoever sent it believes.
                            None => {
                                return Handled::err(
                                    ErrorCode::BadRequest,
                                    format!("unknown grant `{raw}`"),
                                )
                            }
                        }
                    }
                    crate::authz::GrantSet::of(named)
                }
            };
            let mut invite = state.devices.invite_with(grants);
            invite.rendezvous_url = remote_status(state).await.rendezvous_url;
            Handled::ok(Reply::Invite(invite))
        }

        // The protocol-v3 peer handshake authenticates an invitation before
        // this RPC exists. `handle_rpc` consumes the invitation on that narrow
        // bootstrap endpoint; an ordinary authenticated peer cannot claim one.
        Request::DeviceClaim { .. } => Handled::err(
            ErrorCode::Unauthorized,
            "配对邀请只能在对应的加密引导连接中兑换",
        ),

        Request::DeviceRevoke { device_id } => match state.devices.revoke(&device_id) {
            Ok(_) => Handled::ok(Reply::Devices {
                devices: state.devices.list(),
                remote: remote_status(state).await,
            }),
            Err(error) => failed(error),
        },

        Request::DeviceRemoteAttach {
            relay_url,
            join_token,
        } => {
            let Some(remote) = state.remote.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match remote.set(&relay_url, join_token).await {
                Ok(status) => Handled::ok(Reply::RemoteAccess(status)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }

        Request::DeviceRemoteDetach => match state.remote.get() {
            Some(remote) => match remote.clear().await {
                Ok(status) => Handled::ok(Reply::RemoteAccess(status)),
                Err(error) => failed(error),
            },
            None => Handled::ok(Reply::RemoteAccess(genehub_proto::RemoteAccess {
                relay_url: None,
                rendezvous_url: None,
                online: false,
            })),
        },

        Request::WorkspaceList => Handled::ok(Reply::Workspaces(state.workspaces.list().await)),

        Request::WorkspaceOpen { root } => {
            match state.workspaces.open(Path::new(&root), None).await {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => failed(error),
            }
        }

        Request::WorkspaceCreate { root, name } => {
            let path = crate::guest_paths::guest_path(Path::new(&root));
            if let Err(error) = std::fs::create_dir_all(&path) {
                return Handled::err(
                    ErrorCode::BadRequest,
                    format!("could not create {root}: {error}"),
                );
            }
            match state.workspaces.open(&path, Some(name)).await {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => failed(error),
            }
        }

        Request::WorkspaceRename { workspace_id, name } => {
            match state.workspaces.rename(&workspace_id, &name).await {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }

        Request::WorkspaceRemove { workspace_id } => {
            let sessions = match state.sessions.list(Some(&workspace_id), true).await {
                Ok(sessions) => sessions,
                Err(error) => return failed(error),
            };
            if sessions.iter().any(|session| {
                matches!(
                    session.status,
                    genehub_proto::SessionStatus::Running | genehub_proto::SessionStatus::Waiting
                )
            }) {
                return Handled::err(
                    ErrorCode::Conflict,
                    "stop the workspace's running or waiting sessions before removing it",
                );
            }
            match state.workspaces.remove(&workspace_id).await {
                Ok(workspaces) => Handled::ok(Reply::Workspaces(workspaces)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }

        Request::DirectoryList { path } => {
            match crate::workspace::list_directory(path.as_deref().map(Path::new)) {
                Ok(listing) => Handled::ok(Reply::Directory(listing)),
                Err(error) => failed(error),
            }
        }

        Request::DirectoryMkdir { parent, name } => {
            match crate::workspace::mkdir_directory(Path::new(&parent), &name) {
                Ok(listing) => {
                    tracing::info!(%parent, %name, "directory.mkdir");
                    Handled::ok(Reply::Directory(listing))
                }
                Err(error) => failed(error),
            }
        }

        Request::FileTree {
            workspace_id,
            path,
            depth,
        } => {
            match state
                .workspaces
                .tree(&workspace_id, path.as_deref(), depth.unwrap_or(2).min(8))
                .await
            {
                Ok(tree) => Handled::ok(Reply::FileTree(tree)),
                Err(error) => failed(error),
            }
        }

        Request::FileWrite {
            workspace_id,
            path,
            content,
        } => {
            let target = match state.workspaces.resolve(&workspace_id, &path).await {
                Ok(target) => target,
                Err(error) => return failed(error),
            };
            match files::write(&target.root, &target.absolute, &content) {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::FileMkdir { workspace_id, path } => {
            let target = match state.workspaces.resolve(&workspace_id, &path).await {
                Ok(target) => target,
                Err(error) => return failed(error),
            };
            match files::mkdir(&target.root, &target.absolute) {
                Ok(()) => {
                    tracing::info!(%workspace_id, %path, "file.mkdir");
                    Handled::ok(Reply::Ack)
                }
                Err(error) => failed(error),
            }
        }

        Request::FileCopy {
            workspace_id,
            from,
            to,
        } => {
            let source = match state.workspaces.resolve(&workspace_id, &from).await {
                Ok(source) => source,
                Err(error) => return failed(error),
            };
            let destination = match state.workspaces.resolve(&workspace_id, &to).await {
                Ok(destination) => destination,
                Err(error) => return failed(error),
            };
            if source.root_handle != destination.root_handle {
                tracing::warn!(
                    %workspace_id,
                    %from,
                    %to,
                    "file.copy refused: must stay inside the same workspace root"
                );
                return Handled::err(
                    ErrorCode::BadRequest,
                    "copy must stay inside the same workspace root",
                );
            }
            match files::copy_path(&source.root, &source.absolute, &destination.absolute) {
                Ok(()) => {
                    tracing::info!(%workspace_id, %from, %to, "file.copy");
                    Handled::ok(Reply::Ack)
                }
                Err(error) => failed(error),
            }
        }

        Request::FileMove {
            workspace_id,
            from,
            to,
        } => {
            let source = match state.workspaces.resolve(&workspace_id, &from).await {
                Ok(source) => source,
                Err(error) => return failed(error),
            };
            let destination = match state.workspaces.resolve(&workspace_id, &to).await {
                Ok(destination) => destination,
                Err(error) => return failed(error),
            };
            if source.root_handle != destination.root_handle {
                tracing::warn!(
                    %workspace_id,
                    %from,
                    %to,
                    "file.move refused: must stay inside the same workspace root"
                );
                return Handled::err(
                    ErrorCode::BadRequest,
                    "move must stay inside the same workspace root",
                );
            }
            match files::move_path(&source.root, &source.absolute, &destination.absolute) {
                Ok(()) => {
                    tracing::info!(%workspace_id, %from, %to, "file.move");
                    Handled::ok(Reply::Ack)
                }
                Err(error) => failed(error),
            }
        }

        Request::FileDelete {
            workspace_id,
            paths,
        } => {
            for path in &paths {
                let target = match state.workspaces.resolve(&workspace_id, path).await {
                    Ok(target) => target,
                    Err(error) => return failed(error),
                };
                if let Err(error) = files::delete_path(&target.root, &target.absolute) {
                    return failed(error);
                }
            }
            tracing::info!(%workspace_id, count = paths.len(), "file.delete");
            Handled::ok(Reply::Ack)
        }

        Request::GitStatus { workspace_id } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match git::status(&workspace.root).await {
                Ok(status) => Handled::ok(Reply::GitStatus(status)),
                Err(error) => failed(error),
            }
        }

        Request::GitDiff { workspace_id, path } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match git::diff(&workspace.root, path.as_deref()).await {
                Ok(diff) => Handled::ok(Reply::GitDiff { diff }),
                Err(error) => failed(error),
            }
        }

        Request::GitCommit {
            workspace_id,
            message,
            paths,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match git::commit(&workspace.root, &message, &paths).await {
                Ok(commit) => Handled::ok(Reply::GitCommit { commit }),
                Err(error) => failed(error),
            }
        }

        Request::PtyOpen {
            workspace_id,
            cols,
            rows,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            let confinement = match crate::isolation::required_for(caller, &workspace) {
                Ok(confinement) => confinement,
                Err(refusal) => return Handled::err(ErrorCode::IsolationUnavailable, refusal),
            };
            match state
                .terminals
                .open(
                    &workspace.root,
                    cols.unwrap_or(80),
                    rows.unwrap_or(24),
                    confinement,
                )
                .await
            {
                Ok(pty_id) => Handled::ok(Reply::Pty { pty_id }),
                Err(error) => failed(error),
            }
        }

        Request::PtyWrite { pty_id, data } => match state.terminals.write(&pty_id, &data).await {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },

        Request::PtyResize { pty_id, cols, rows } => {
            match state.terminals.resize(&pty_id, cols, rows).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

        Request::PtyClose { pty_id } => match state.terminals.close(&pty_id).await {
            Ok(()) => Handled::ok(Reply::Ack),
            Err(error) => failed(error),
        },

        Request::ProcessList => Handled::ok(Reply::Processes(state.processes.list().await)),
        Request::ProcessKill { session_id, pid } => {
            match state.processes.stop(&session_id, pid).await {
                crate::processes::Stopped::Yes => Handled::ok(Reply::Ack),
                // One answer for "no such session" and for "not that
                // session's", so that a caller who guessed a pid learns only
                // that the guess was refused.
                crate::processes::Stopped::NotThisSession => Handled::err(
                    ErrorCode::NotFound,
                    format!("no process {pid} belongs to {session_id}"),
                ),
                crate::processes::Stopped::Unknown => Handled::err(
                    ErrorCode::Internal,
                    "this machine could not be asked what is running",
                ),
            }
        }
        Request::ProcessKillAll { session_id } => {
            state.processes.stop_all(&session_id).await;
            Handled::ok(Reply::Ack)
        }
    }
}

/// Only operations useful during support triage enter the automatic record.
/// Payload values are deliberately ignored; names are compile-time constants.
fn diagnostic_operation(request: &Request) -> Option<&'static str> {
    match request {
        Request::AgentRefresh => Some("agent.refresh"),
        Request::SessionCreate { .. } => Some("session.create"),
        Request::SessionSend { .. } => Some("session.send"),
        Request::SessionArtifactBegin { .. } => Some("session.artifact.begin"),
        Request::SessionArtifactChunk { .. } => Some("session.artifact.chunk"),
        Request::SessionArtifactFinish { .. } => Some("session.artifact.finish"),
        Request::SessionArtifactAbort { .. } => Some("session.artifact.abort"),
        Request::SessionFork { .. } => Some("session.fork"),
        Request::SessionForkExport { .. } => Some("session.forkExport"),
        Request::SessionForkImport { .. } => Some("session.forkImport"),
        Request::SessionImport { .. } => Some("session.import"),
        Request::SessionInterrupt { .. } => Some("session.interrupt"),
        Request::SessionDelete { .. } => Some("session.delete"),
        Request::SessionRespondPermission { .. } => Some("session.respondPermission"),
        Request::SettingsSetProvider { .. } => Some("settings.setProvider"),
        Request::SettingsForgetProvider { .. } => Some("settings.forgetProvider"),
        Request::HubPair { .. } => Some("hub.pair"),
        Request::HubTrial { .. } => Some("hub.trial"),
        Request::HubClaimLink => Some("hub.claimLink"),
        Request::HubConnect { .. } => Some("hub.connect"),
        Request::HubUnpair => Some("hub.unpair"),
        Request::DeviceInvite(..) => Some("device.invite"),
        Request::DeviceClaim { .. } => Some("device.claim"),
        Request::DeviceRevoke { .. } => Some("device.revoke"),
        Request::DeviceRemoteAttach { .. } => Some("device.remoteAttach"),
        Request::DeviceRemoteDetach => Some("device.remoteDetach"),
        Request::WorkspaceOpen { .. } => Some("workspace.open"),
        Request::WorkspaceCreate { .. } => Some("workspace.create"),
        Request::WorkspaceRename { .. } => Some("workspace.rename"),
        Request::WorkspaceRemove { .. } => Some("workspace.remove"),
        Request::DirectoryList { .. } => Some("directory.list"),
        Request::DirectoryMkdir { .. } => Some("directory.mkdir"),
        Request::FileTree { .. } => Some("file.tree"),
        Request::FileWrite { .. } => Some("file.write"),
        Request::FileMkdir { .. } => Some("file.mkdir"),
        Request::FileCopy { .. } => Some("file.copy"),
        Request::FileMove { .. } => Some("file.move"),
        Request::FileDelete { .. } => Some("file.delete"),
        Request::GitStatus { .. } => Some("git.status"),
        Request::GitDiff { .. } => Some("git.diff"),
        Request::GitCommit { .. } => Some("git.commit"),
        Request::PtyOpen { .. } => Some("pty.open"),
        Request::PtyResize { .. } => Some("pty.resize"),
        Request::PtyClose { .. } => Some("pty.close"),
        _ => None,
    }
}

fn error_code_name(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::BadRequest => "badRequest",
        ErrorCode::Unauthorized => "unauthorized",
        ErrorCode::NotFound => "notFound",
        ErrorCode::Conflict => "conflict",
        ErrorCode::Unsupported => "unsupported",
        ErrorCode::Forbidden => "forbidden",
        ErrorCode::Internal => "internal",
        ErrorCode::WebProtocol => "webProtocol",
        ErrorCode::IsolationUnavailable => "isolationUnavailable",
    }
}

async fn remote_status(state: &Shared) -> genehub_proto::RemoteAccess {
    match state.remote.get() {
        Some(remote) => remote.status().await,
        None => genehub_proto::RemoteAccess {
            relay_url: None,
            rendezvous_url: None,
            online: false,
        },
    }
}

pub fn transport_for(remote: Option<std::net::IpAddr>) -> TransportKind {
    match remote {
        Some(ip) if ip.is_loopback() => TransportKind::Loopback,
        Some(_) => TransportKind::Lan,
        None => TransportKind::Forwarded,
    }
}

pub type SharedState = Arc<crate::state::AppState>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn loopback_and_lan_addresses_are_distinguished() {
        assert_eq!(
            transport_for(Some(IpAddr::V4(Ipv4Addr::LOCALHOST))),
            TransportKind::Loopback
        );
        assert_eq!(
            transport_for(Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)))),
            TransportKind::Lan
        );
        assert_eq!(transport_for(None), TransportKind::Forwarded);
    }

    #[test]
    fn workspace_escapes_are_reported_as_forbidden_not_internal() {
        for message in [
            "path escapes the workspace",
            "root handle is not a member of this workspace",
            "a workspace resource path must name its root handle",
        ] {
            let handled = failed(anyhow::anyhow!(message));
            match handled.reply {
                Err(error) => assert_eq!(error.code, ErrorCode::Forbidden),
                Ok(_) => panic!("expected an error"),
            }
        }
    }

    #[test]
    fn a_missing_entity_is_reported_as_not_found() {
        let handled = failed(anyhow::anyhow!("no such session: s1"));
        match handled.reply {
            Err(error) => assert_eq!(error.code, ErrorCode::NotFound),
            Ok(_) => panic!("expected an error"),
        }
    }

    #[test]
    fn a_missing_session_classifies_by_type_not_by_wording() {
        let handled = failed(crate::session::manager::SessionMissing("s1".to_string()).into());
        match handled.reply {
            Err(error) => {
                assert_eq!(error.code, ErrorCode::NotFound);
                assert_eq!(error.message, "会话不存在：s1");
            }
            Ok(_) => panic!("expected an error"),
        }
    }

    #[test]
    fn artifact_input_failures_keep_their_client_visible_class() {
        for (message, expected) in [
            ("invalid session artifact file name", ErrorCode::BadRequest),
            (
                "artifact upload conflict: wrong offset",
                ErrorCode::Conflict,
            ),
            ("no such artifact upload: u_1", ErrorCode::NotFound),
            (
                "artifact upload does not belong to this session",
                ErrorCode::Forbidden,
            ),
            (
                "'not-a-model-this-cli-has' is not a model this Claude Code offers (default, opus, sonnet, haiku)",
                ErrorCode::BadRequest,
            ),
        ] {
            let handled = failed(anyhow::anyhow!(message));
            match handled.reply {
                Err(error) => assert_eq!(error.code, expected, "{message}"),
                Ok(_) => panic!("expected an error for {message}"),
            }
        }
    }

    #[test]
    fn native_update_entry_points_fail_closed() {
        let check = crate::host_update::check().expect_err("native check must refuse");
        assert!(check.contains("手动下载"), "{check}");
        assert!(check.contains("SHA256SUMS"), "{check}");
        let apply = crate::host_update::apply("web").expect_err("native apply must refuse");
        assert!(apply.contains("手动下载"), "{apply}");
    }
}
