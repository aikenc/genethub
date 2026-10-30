//! Request dispatch: one `Request` in, one `Reply` or `ProtocolError` out.
//!
//! Kept free of transport concerns so the same routing serves loopback and
//! forwarded connections without duplication. Legacy LAN is rejected at bind.

use std::path::Path;
use std::sync::Arc;

use genehub_proto::{
    ErrorCode, HelloResult, ProtocolError, Reply, Request, SessionAgentTarget, TransportKind,
    WEB_PROTOCOL_VERSION,
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
        || message.contains("invalid session label")
    {
        ErrorCode::BadRequest
    } else if message.contains("artifact upload conflict")
        || message.contains("revision 冲突")
        || message.contains("正在被另一个请求修改")
    {
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
    handle_in_workspace(state, transport, caller, None, request).await
}

pub(crate) async fn handle_in_workspace(
    state: &Shared,
    transport: TransportKind,
    caller: &crate::authz::Principal,
    workspace_scope: Option<&str>,
    request: Request,
) -> Handled {
    if !caller.permits(&request) {
        return Handled::err(
            ErrorCode::Forbidden,
            "this connection does not permit this operation",
        );
    }
    if let Err(message) = authorize_session_request(state, caller, &request).await {
        return Handled::err(ErrorCode::Forbidden, message);
    }
    let operation = diagnostic_operation(&request);
    let handled = dispatch(state, transport, caller, workspace_scope, request).await;
    if let Some(operation) = operation {
        let (outcome, code) = match &handled.reply {
            Ok(_) => ("ok", None),
            Err(error) => {
                tracing::warn!(operation, code = ?error.code, "RPC operation failed");
                ("error", Some(error_code_name(error.code)))
            }
        };
        state.diagnostics.record("rpc", operation, outcome, code);
    }
    handled
}

async fn authorize_session_request(
    _state: &Shared,
    caller: &crate::authz::Principal,
    request: &Request,
) -> Result<(), String> {
    // OS-account capability parity does not turn an Agent into the Human
    // answering a credential card. Keep this semantic gate independent of
    // the coarse Settings grant.
    if caller.session_controller_id().is_some()
        && matches!(
            request,
            Request::SettingsSetProvider { .. }
                | Request::SettingsForgetProvider { .. }
                | Request::ProviderOperation {
                    operation: genehub_proto::ProviderOperationCommand::Submit { .. },
                    ..
                }
        )
    {
        return Err("provider 配置须由 Human 确认；请用 provider configure 创建配置卡片".into());
    }
    if let (Some(controller), Request::ProviderOperation { session_id, .. }) =
        (caller.session_controller_id(), request)
    {
        if controller != session_id {
            return Err("provider operation belongs to another Session".into());
        }
    }
    Ok(())
}

async fn mark_if_started_by_a_session(
    state: &Shared,
    caller: &crate::authz::Principal,
    summary: genehub_proto::SessionSummary,
) -> genehub_proto::SessionSummary {
    if caller.session_controller_id().is_none() {
        return summary;
    }
    let label = crate::session::store::SESSION_STARTED_LABEL.to_string();
    match state.sessions.label(&summary.id, &[label], &[]).await {
        Ok(labelled) => labelled,
        Err(error) => {
            tracing::warn!(session = %summary.id, %error, "labelling a session started by a session failed");
            summary
        }
    }
}

async fn agent_space_change_facts(
    state: &Shared,
    workspace_id: &str,
    expected_revision: u64,
    operation: &genehub_proto::AgentSpaceOperation,
) -> anyhow::Result<(crate::config::AgentSpaceEntry, String, String)> {
    let workspace = state.workspaces.get(workspace_id).await?;
    let current = state.workspaces.agent_space(workspace_id).await?;
    if current.revision != expected_revision {
        anyhow::bail!(
            "revisionConflict: AgentSpace {workspace_id} is at revision {}, not {expected_revision}",
            current.revision
        );
    }
    let canonical_root = workspace.root.canonicalize()?.display().to_string();
    let digest =
        agent_space_plan_digest(workspace_id, &canonical_root, expected_revision, operation)?;
    Ok((current, canonical_root, digest))
}

fn agent_space_plan_digest(
    workspace_id: &str,
    canonical_root: &str,
    expected_revision: u64,
    operation: &genehub_proto::AgentSpaceOperation,
) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(workspace_id.as_bytes());
    hash.update([0]);
    hash.update(canonical_root.as_bytes());
    hash.update([0]);
    hash.update(expected_revision.to_le_bytes());
    hash.update([0]);
    hash.update(serde_json::to_vec(operation)?);
    Ok(format!("sha256:{:x}", hash.finalize()))
}

/// The responsibilities live in one Session.
///
/// Read from the Space's current composition rather than from anything stored
/// on the Session: a Session *is* the instance of its AgentSpace, so mounting
/// a component reaches the conversations already open on it. Nothing here can
/// change composition — that stays an operation on the Space.
async fn session_components(
    state: &Shared,
    session_id: &str,
) -> anyhow::Result<Vec<genehub_proto::ComponentInstanceInfo>> {
    let (workspace_id, space_home, session_dir) =
        state.sessions.component_scope(session_id).await?;
    let space = state.workspaces.agent_space(&workspace_id).await?;
    let instances =
        crate::session::components::resolve(&space_home, &session_dir, &space.components)?;
    Ok(instances
        .into_iter()
        .map(|instance| genehub_proto::ComponentInstanceInfo {
            component_id: instance.component_id,
            role: instance.role,
            space_dir: instance.space_dir.display().to_string(),
            session_dir: instance.session_dir.display().to_string(),
        })
        .collect())
}

async fn guard_agent_space_mutation(
    state: &Shared,
    workspace_id: &str,
    operation: &genehub_proto::AgentSpaceOperation,
) -> anyhow::Result<()> {
    let current = state.workspaces.agent_space(workspace_id).await?;
    let proposed = crate::agent_space::apply(&current, operation)?;
    if proposed == current {
        return Ok(());
    }

    let destructive = match operation {
        genehub_proto::AgentSpaceOperation::SetComponent {
            component_id,
            enabled,
            role,
        } => current
            .components
            .iter()
            .find(|component| component.component_id == *component_id)
            .is_some_and(|component| {
                (component.enabled && !enabled) || component.role.as_deref() != role.as_deref()
            }),
        genehub_proto::AgentSpaceOperation::RemoveComponent { .. }
        | genehub_proto::AgentSpaceOperation::SetParent { .. }
        | genehub_proto::AgentSpaceOperation::SetLifecycle { .. } => true,
    };
    if !destructive {
        return Ok(());
    }

    // Only a Session that is mid-turn can be writing. A `Waiting` Session is
    // blocked on a person's answer and holds nothing — and it is precisely
    // the state someone is in when they realize the team needs changing, so
    // treating it as a conflict refused the change exactly when it was
    // wanted.
    let sessions = state.sessions.list(Some(workspace_id), true).await?;
    let active_sessions = sessions
        .into_iter()
        .filter(|session| matches!(session.status, genehub_proto::SessionStatus::Running))
        .map(|session| session.id)
        .collect::<Vec<_>>();
    if !active_sessions.is_empty() {
        anyhow::bail!(
            "activeSessionConflict: stop these running Sessions before changing AgentSpace {workspace_id}: {}",
            active_sessions.join(", ")
        );
    }

    let removes_executor = match operation {
        genehub_proto::AgentSpaceOperation::RemoveComponent { component_id } => {
            component_id == crate::agent_space::COMPONENT_EXECUTOR
        }
        genehub_proto::AgentSpaceOperation::SetComponent {
            component_id,
            enabled,
            ..
        } => component_id == crate::agent_space::COMPONENT_EXECUTOR && !enabled,
        _ => false,
    };
    let moves_subtree = matches!(
        operation,
        genehub_proto::AgentSpaceOperation::SetParent { .. }
    );
    if removes_executor || moves_subtree {
        let children = state
            .workspaces
            .list()
            .await
            .into_iter()
            .filter(|workspace| {
                workspace
                    .agent_space
                    .as_ref()
                    .and_then(|space| space.parent_workspace_id.as_deref())
                    == Some(workspace_id)
            })
            .map(|workspace| workspace.id)
            .collect::<Vec<_>>();
        if !children.is_empty() {
            anyhow::bail!(
                "childSpaceConflict: detach or reparent these direct child AgentSpaces first: {}",
                children.join(", ")
            );
        }
    }
    Ok(())
}

/// An id the registry has never heard of is `notFound`, so a caller can tell
/// a typo from an Agent that refused or failed.
fn agent_failure(state: &Shared, agent_id: &str, error: anyhow::Error) -> Handled {
    if state.registry.get(agent_id).is_none() && state.registry.host(agent_id).is_none() {
        return Handled::err(ErrorCode::NotFound, format!("没有名为 {agent_id} 的 Agent"));
    }
    Handled::err(ErrorCode::BadRequest, format!("{error:#}"))
}

/// Every Agent with its routes. Routes depend on the Human-edited tag/cost
/// configuration, so they are attached per call and never cached.
pub(crate) async fn agent_infos(state: &Shared, refresh: bool) -> Vec<genehub_proto::AgentInfo> {
    let providers = state.providers().await;
    let mut agents = if refresh {
        state.registry.refresh(&providers).await
    } else {
        state.registry.list(&providers).await
    };
    let preferences = state
        .config
        .read()
        .await
        .agent_preferences
        .clone()
        .unwrap_or_default();
    for agent in &mut agents {
        if matches!(agent.probe, genehub_proto::ProbeState::Ready) {
            agent.routes = Some(crate::agent_routing::route_infos(
                &preferences,
                agent,
                &state.registry,
            ));
        }
    }
    agents
}

async fn dispatch(
    state: &Shared,
    transport: TransportKind,
    caller: &crate::authz::Principal,
    workspace_scope: Option<&str>,
    request: Request,
) -> Handled {
    if matches!(caller, crate::authz::Principal::PreviewShare { .. })
        && !matches!(
            &request,
            Request::ConnectionIdentity | Request::PreviewFeedback(_)
        )
    {
        return Handled::err(
            ErrorCode::Forbidden,
            "preview share permits only its file preview and feedback",
        );
    }
    match request {
        Request::PreviewFeedback(request) => Box::pin(async move {
            match crate::preview_feedback::handle(state, caller, workspace_scope, request).await {
                Ok(reply) => Handled::ok(Reply::PreviewFeedback(reply)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }).await,
        Request::ClientDebug(request) => Box::pin(async move {
            match state.client_debug.handle(request).await {
                Ok(reply) => Handled::ok(Reply::ClientDebug(reply)),
                Err(error) => Handled {
                    reply: Err(error),
                    effect: SideEffect::None,
                },
            }
        }).await,
        Request::ConnectionIdentity => Box::pin(async move {
            Handled::ok(Reply::Hello(HelloResult {
                data_channel_url: match state.remote.get() {
                    Some(remote) => remote.status().await.channels
                        .and_then(|lanes| lanes.into_iter().find(|lane| lane.id == 1))
                        .map(|lane| lane.url),
                    None => None,
                },
                daemon_version: state.version.clone(),
                web_protocol: WEB_PROTOCOL_VERSION,
                machine_id: state.machine.machine_id.clone(),
                fingerprint: state.machine.fingerprint(),
                transport,
                machine_name: crate::link::default_display_name(),
                rtc_supported: crate::dataplane::rtc::SUPPORTED,
                features: Some(vec![
                    "fabric.channels.v1".to_string(),
                    "asset.preview.image.v1".to_string(),
                    "service.preview.v1".to_string(),
                    "process.services.v1".to_string(),
                    "session.input.v1".to_string(),
                    "session.file-upload.v1".to_string(),
                    "provider.configuration.v1".to_string(),
                    "session.previewAnnotations.v1".to_string(),
                    "preview.feedback.v1".to_string(),
                    "session.switch-agent.v1".to_string(),
                    "agent-tag-routing.v1".to_string(),
                    genehub_proto::SPEECH_FEATURE_TRANSCRIBE.to_string(),
                    genehub_proto::SPEECH_FEATURE_PARTIAL.to_string(),
                    genehub_proto::SPEECH_FEATURE_CONTEXT_PREVIEW.to_string(),
                    genehub_proto::SPEECH_FEATURE_FEEDBACK.to_string(),
                ].into_iter().chain(crate::file_access::machine_files_supported().then(|| "asset.preview.machine-file.v1".to_string())).collect()),
                isolation: Some(crate::isolation::report()),
            }))
        }).await,        Request::Subscribe {
            session_id,
            since_seq,
            expand_last_round,
            recent_rounds,
        } => Box::pin(async move {
            match state
                .sessions
                .subscribe_window(&session_id, since_seq, expand_last_round, recent_rounds)
                .await
            {
                Ok((snapshot, replayed, reset, receiver)) => {
                    Handled {
                        reply: Ok(Reply::Subscribed {
                            snapshot,
                            replayed,
                            reset,
                        }),
                        effect: SideEffect::Subscribe {
                            session_id,
                            receiver,
                        },
                    }
                }
                Err(error) => failed(error),
            }
        }).await,

        Request::Unsubscribe { session_id } => Box::pin(async move {
            Handled {
                reply: Ok(Reply::Ack),
                effect: SideEffect::Unsubscribe { session_id },
            }
        }).await,

        Request::AgentList => Box::pin(async move {
            Handled::ok(Reply::Agents(agent_infos(state, false).await))
        }).await,

        Request::AgentRefresh => Box::pin(async move {
            Handled::ok(Reply::Agents(agent_infos(state, true).await))
        }).await,

        Request::AgentAction { agent_id, action_id } => Box::pin(async move {
            match state.registry.run_action(&agent_id, &action_id).await {
                Ok(_) => Handled::ok(Reply::Agents(agent_infos(state, false).await)),
                Err(error) => agent_failure(state, &agent_id, error),
            }
        }).await,

        Request::AgentReload { agent_id } => Box::pin(async move {
            // Detached: a restart outlives a caller whose own deadline
            // (30 s for a CLI call) is shorter than a restart can take.
            let registry = state.registry.clone();
            let id = agent_id.clone();
            match tokio::spawn(async move { registry.reload(&id).await }).await {
                Ok(Ok(())) => Handled::ok(Reply::Agents(agent_infos(state, false).await)),
                Ok(Err(error)) => agent_failure(state, &agent_id, error),
                Err(error) => Handled::err(ErrorCode::Internal, format!("{error}")),
            }
        }).await,

        Request::AgentReset { agent_id } => Box::pin(async move {
            // Detached: a restart outlives a caller whose own deadline
            // (30 s for a CLI call) is shorter than a restart can take.
            let registry = state.registry.clone();
            let id = agent_id.clone();
            match tokio::spawn(async move { registry.reset(&id).await }).await {
                Ok(Ok(())) => Handled::ok(Reply::Agents(agent_infos(state, false).await)),
                Ok(Err(error)) => agent_failure(state, &agent_id, error),
                Err(error) => Handled::err(ErrorCode::Internal, format!("{error}")),
            }
        }).await,

        Request::AgentTest { agent_id, live } => Box::pin(async move {
            match state.registry.test(&agent_id, live).await {
                Ok((passed, output)) => Handled::ok(Reply::AgentTestResult { passed, output }),
                Err(error) => agent_failure(state, &agent_id, error),
            }
        }).await,

        Request::AgentLogs { agent_id, lines } => Box::pin(async move {
            let lines = lines.unwrap_or(200).clamp(1, 500) as usize;
            match state.registry.logs(&agent_id, lines) {
                Ok(lines) => Handled::ok(Reply::AgentLogs { lines }),
                Err(error) => agent_failure(state, &agent_id, error),
            }
        }).await,

        // Only a person answers these, so neither verb is offered to a
        // session-bound CLI caller. Their contents never leave this reply
        // path and the `agentRequest` push.
        Request::AgentRequests => Box::pin(async move {
            if matches!(caller, crate::authz::Principal::SessionController { .. }) {
                return Handled::err(ErrorCode::Forbidden, "Agent 级请求只给人看，不给会话里的 Agent");
            }
            Handled::ok(Reply::AgentRequests(state.registry.requests()))
        }).await,

        Request::AgentRequestAnswer {
            agent_id,
            request_id,
            outcome,
        } => Box::pin(async move {
            if matches!(caller, crate::authz::Principal::SessionController { .. }) {
                return Handled::err(ErrorCode::Forbidden, "Agent 级请求只能由人回答");
            }
            match state.registry.answer(&agent_id, &request_id, outcome).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => agent_failure(state, &agent_id, error),
            }
        }).await,

        Request::SessionCreate {
            workspace_id,
            agent_id,
            model_id,
            effort_id,
            fast,
            mode_id,
            runtime_values,
            title,
            cwd,
        } => Box::pin(async move {
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
                None => state.workspaces.default_cwd(&workspace),
            };
            let model_id = match crate::agent_routing::ensure_concrete_route_allowed(
                state,
                &agent_id,
                model_id,
            )
            .await
            {
                Ok(model_id) => model_id,
                Err(error) => return failed(error),
            };
            match state
                .sessions
                .create(
                    &workspace_id,
                    start_in,
                    &agent_id,
                    model_id,
                    effort_id,
                    fast,
                    mode_id,
                    runtime_values.unwrap_or_default(),
                    title,
                )
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(
                    mark_if_started_by_a_session(state, caller, summary).await,
                )),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionCreateRouted {
            workspace_id,
            tags,
            media_tags,
            title,
            cwd,
        } => Box::pin(async move {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            let start_in = match cwd {
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
                        None => return failed(anyhow::anyhow!("cwd {cwd} escapes the workspace")),
                    }
                }
                None => state.workspaces.default_cwd(&workspace),
            };
            let routing_tags = match crate::agent_routing::validate_selected_tags(tags) {
                Ok(tags) => tags,
                Err(error) => return failed(error),
            };
            let media_tags = match crate::agent_routing::validate_media_tags(media_tags) {
                Ok(tags) => tags,
                Err(error) => return failed(error),
            };
            let required = crate::agent_routing::normalize_tags(
                routing_tags.iter().chain(media_tags.iter()).cloned(),
            );
            let (route, _) =
                match crate::agent_routing::resolve_live_route(state, &required).await {
                    Ok(route) => route,
                    Err(error) => return failed(error),
                };
            match state
                .sessions
                .create_routed(
                    &workspace_id,
                    start_in,
                    &route.agent_id,
                    route.model_id,
                    route.effort_id,
                    route.fast,
                    route.mode_id,
                    route.runtime_values,
                    title,
                    routing_tags,
                    media_tags,
                )
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(
                    mark_if_started_by_a_session(state, caller, summary).await,
                )),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionList {
            workspace_id,
            include_archived,
            lean,
        } => Box::pin(async move {
            match state
                .sessions
                .list_with_projection(workspace_id.as_deref(), include_archived, lean)
                .await
            {
                Ok(sessions) => {
                    Handled::ok(Reply::Sessions(sessions))
                }
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionGet {
            session_id,
            recent_rounds,
            before_item_id,
        } => Box::pin(async move {
            match match recent_rounds {
                Some(limit) => {
                    state
                        .sessions
                        .history_snapshot(&session_id, limit, before_item_id.as_deref())
                        .await
                }
                None => state.sessions.snapshot(&session_id).await,
            } {
                Ok(snapshot) => {
                    Handled::ok(Reply::Snapshot(snapshot))
                }
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionDrafts { session_id } => Box::pin(async move {
            match state.sessions.drafts(&session_id).await {
                Ok(drafts) => Handled::ok(Reply::SessionDrafts(drafts)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionDraftsReplace { session_id, drafts } => Box::pin(async move {
            match state.sessions.replace_drafts(&session_id, drafts).await {
                Ok(drafts) => Handled::ok(Reply::SessionDrafts(drafts)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionPreviewAnnotationsGet { session_id } => Box::pin(async move {
            match state.sessions.preview_annotations(&session_id).await {
                Ok(draft) => Handled::ok(Reply::PreviewAnnotations(draft)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionPreviewAnnotationUpsert {
            session_id,
            annotation,
            expected_revision,
        } => Box::pin(async move {
            match state
                .sessions
                .upsert_preview_annotation(
                    Some(&state.workspaces),
                    &session_id,
                    annotation,
                    expected_revision,
                )
                .await
            {
                Ok(draft) => Handled::ok(Reply::PreviewAnnotations(draft)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionPreviewAnnotationRemove {
            session_id,
            ids,
            expected_revision,
        } => Box::pin(async move {
            match state
                .sessions
                .remove_preview_annotations(&session_id, ids, expected_revision)
                .await
            {
                Ok(draft) => Handled::ok(Reply::PreviewAnnotations(draft)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionComponents { session_id } => Box::pin(async move {
            match session_components(state, &session_id).await {
                Ok(instances) => Handled::ok(Reply::SessionComponents(instances)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionInspect {
            session_id,
            through_round_id,
        } => Box::pin(async move {
            match state
                .sessions
                .inspect(&session_id, through_round_id.as_deref())
                .await
            {
                Ok(inspection) => Handled::ok(Reply::SessionInspection(inspection)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionNarrative {
            session_id,
            through_round_id,
            item_id,
            cursor,
            limit,
        } => Box::pin(async move {
            match state
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
            }
        }).await,

        Request::SessionRounds {
            session_id,
            through_round_id,
            cursor,
            limit,
        } => Box::pin(async move {
            match state
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
            }
        }).await,

        Request::SessionContext {
            session_id,
            through_round_id,
            token_budget,
        } => Box::pin(async move {
            match state
                .sessions
                .session_context(&session_id, through_round_id.as_deref(), token_budget)
                .await
            {
                Ok(context) => Handled::ok(Reply::SessionContext(context)),
                Err(error) => failed(error),
            }
        }).await,

        Request::RoundTrunkList {
            session_id,
            round_id,
            cursor,
            limit,
        } => Box::pin(async move {
            match state
                .sessions
                .round_layer(&session_id, &round_id, cursor.as_deref(), limit)
                .await
            {
                Ok(layer) => Handled::ok(Reply::RoundLayer(layer)),
                Err(error) => failed(error),
            }
        }).await,

        Request::RoundTrunkGet {
            session_id,
            round_id,
            trunk_index,
        } => Box::pin(async move {
            match state
                .sessions
                .round_trunk(&session_id, &round_id, trunk_index)
                .await
            {
                Ok(trunk) => Handled::ok(Reply::RoundTrunk(trunk)),
                Err(error) => failed(error),
            }
        }).await,

        Request::BlobGet { session_id, blob } => Box::pin(async move {
            match state.sessions.blob(&session_id, &blob).await {
                Ok(blob) => Handled::ok(Reply::Blob(blob)),
                Err(error) => failed(error),
            }
        }).await,

        Request::RoundTrunkBatchGet { session_id, refs } => Box::pin(async move {
            match state.sessions.round_trunks(&session_id, &refs).await {
                Ok(trunks) => Handled::ok(Reply::RoundTrunks(trunks)),
                Err(error) => failed(error),
            }
        }).await,

        Request::BlobBatchGet { session_id, blobs } => Box::pin(async move {
            match state.sessions.blobs(&session_id, &blobs).await {
                Ok(blobs) => Handled::ok(Reply::Blobs(blobs)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionSend {
            message_id,
            task_run_id,
            session_id,
            text,
            mut attachments,
            artifact_preview_base_url,
            continues_round,
            origin,
        } => Box::pin(async move {
            if text.trim().is_empty() && attachments.is_empty() {
                return Handled::err(ErrorCode::BadRequest, "there is nothing to send");
            }
            if matches!(state.sessions.summary(&session_id).await, Ok(summary) if summary.history_only == Some(true)) {
                return Handled::err(ErrorCode::BadRequest, "this is retired execution history; fork to continue");
            }
            // A stored file may only name this session's own upload. This also
            // fills `bytes` from the filesystem before the message is logged.
            if let Err(error) = state
                .sessions
                .validate_user_attachments(&session_id, &mut attachments)
                .await
            {
                return failed(error);
            }
            let system = origin
                .as_ref()
                .is_some_and(|o| o.session_id == "system");
            // A system notice is durable or it is nothing: the sender retries
            // it, and only a stable messageId makes a retry safe. It is not a
            // Run's notice either, so it carries no task.
            if system && message_id.is_none() {
                return Handled::err(
                    ErrorCode::BadRequest,
                    "a system notice requires a stable messageId",
                );
            }
            if system && task_run_id.is_some() {
                return Handled::err(
                    ErrorCode::BadRequest,
                    "a system notice cannot carry a taskRunId",
                );
            }
            // A local Agent caller is attributed by its verified identity, not
            // by what it declares. Any other caller already acts as the owner,
            // so a declared origin can only mark its text as Agent-written.
            let origin = if system {
                Some(genehub_proto::InputOrigin {
                    machine_id: state.machine.machine_id.clone(),
                    machine_name: Some(crate::link::default_display_name()),
                    session_id: "system".to_string(),
                })
            } else {
                match caller.session_controller_id() {
                    Some(session_id) => Some(genehub_proto::InputOrigin {
                        machine_id: state.machine.machine_id.clone(),
                        machine_name: Some(crate::link::default_display_name()),
                        session_id: session_id.to_string(),
                    }),
                    None => origin,
                }
            };
            if let Some(message_id) = message_id {
                {
                    let media_tags = crate::agent_routing::media_tags_for_mimes(
                        attachments
                            .iter()
                            .map(|attachment| attachment.mime.as_str()),
                    );
                    if let Err(error) =
                        crate::agent_routing::route_session(state, &session_id, None, media_tags)
                            .await
                    {
                        return failed(error);
                    }
                }
                return match state
                    .sessions
                    .accept_input(
                        &session_id,
                        message_id,
                        text,
                        attachments,
                        task_run_id,
                        // `system` is a statement about the text, not about the
                        // caller: a script's notice keeps its origin when it has
                        // one, but is never read as the Agent's own request.
                        if system {
                            "system"
                        } else if origin.is_some() {
                            "agent"
                        } else {
                            "user"
                        },
                        origin,
                    )
                    .await
                {
                    Ok(()) => Handled::ok(Reply::Ack),
                    Err(error) => failed(error),
                };
            }
            if task_run_id.is_some() {
                return Handled::err(
                    ErrorCode::BadRequest,
                    "taskRunId requires a stable messageId",
                );
            }
            let media_tags = crate::agent_routing::media_tags_for_mimes(
                attachments
                    .iter()
                    .map(|attachment| attachment.mime.as_str()),
            );
            if let Err(error) =
                crate::agent_routing::route_session(state, &session_id, None, media_tags).await
            {
                return failed(error);
            }
            let providers = state.providers().await;
            match state
                .sessions
                .send_attributed(
                    &session_id,
                    text,
                    attachments,
                    &providers,
                    artifact_preview_base_url,
                    continues_round,
                    origin,
                )
                .await
            {
                Ok(_) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionArtifactBegin {
            session_id,
            files,
            metadata,
        } => Box::pin(async move {
            match state
                .sessions
                .begin_artifact(&session_id, files, metadata)
                .await
            {
                Ok(upload) => Handled::ok(Reply::SessionArtifactUpload(upload)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionArtifactChunk {
            session_id,
            upload_id,
            file_index,
            offset,
            data_base64,
        } => Box::pin(async move {
            match state
                .sessions
                .write_artifact_chunk(&session_id, &upload_id, file_index, offset, &data_base64)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionArtifactFinish {
            session_id,
            upload_id,
        } => Box::pin(async move {
            match state
                .sessions
                .finish_artifact(&session_id, &upload_id)
                .await
            {
                Ok(bundle) => Handled::ok(Reply::SessionArtifact(bundle)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionArtifactAbort {
            session_id,
            upload_id,
        } => Box::pin(async move {
            match state.sessions.abort_artifact(&session_id, &upload_id).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionFork {
            session_id,
            turn_id,
            target,
        } => Box::pin(async move {
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
        }).await,

        Request::SessionForkRouted {
            session_id,
            turn_id,
            workspace_id,
            tags,
        } => Box::pin(async move {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            let source = match state.sessions.summary(&session_id).await {
                Ok(source) => source,
                Err(error) => return failed(error),
            };
            let transfer = match state.sessions.fork_export(&session_id, &turn_id).await {
                Ok(transfer) => transfer,
                Err(error) => return failed(error),
            };
            let routing_tags = match crate::agent_routing::validate_selected_tags(tags) {
                Ok(tags) => tags,
                Err(error) => return failed(error),
            };
            let media_tags = crate::agent_routing::media_tags_for_timeline(&transfer.items);
            let required = crate::agent_routing::normalize_tags(
                routing_tags.iter().chain(media_tags.iter()).cloned(),
            );
            let (route, providers) =
                match crate::agent_routing::resolve_live_route(state, &required).await {
                    Ok(route) => route,
                    Err(error) => return failed(error),
                };
            let same_workspace = source.workspace_id == workspace_id;
            let target = genehub_proto::ForkTarget {
                agent_id: route.agent_id,
                workspace_id: (!same_workspace).then_some(workspace_id.clone()),
                model_id: route.model_id,
                mode_id: route.mode_id,
                effort_id: route.effort_id,
                fast: route.fast,
                runtime_values: route.runtime_values,
            };
            let result = if same_workspace {
                state
                    .sessions
                    .fork_routed(
                        &session_id,
                        &turn_id,
                        target,
                        &providers,
                        routing_tags,
                        media_tags,
                    )
                    .await
            } else {
                state
                    .sessions
                    .fork_import_routed(
                        &workspace_id,
                        workspace.root,
                        transfer,
                        target,
                        &providers,
                        true,
                        routing_tags,
                        media_tags,
                    )
                    .await
            };
            match result {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionForkExport {
            session_id,
            turn_id,
        } => Box::pin(async move {
            match state.sessions.fork_export(&session_id, &turn_id).await {
                Ok(transfer) => Handled::ok(Reply::ForkTransfer(transfer)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionForkImport { transfer, target } => Box::pin(async move {
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
        }).await,

        Request::SessionForkImportRouted {
            transfer,
            workspace_id,
            tags,
        } => Box::pin(async move {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            let routing_tags = match crate::agent_routing::validate_selected_tags(tags) {
                Ok(tags) => tags,
                Err(error) => return failed(error),
            };
            let media_tags = crate::agent_routing::media_tags_for_timeline(&transfer.items);
            let required = crate::agent_routing::normalize_tags(
                routing_tags.iter().chain(media_tags.iter()).cloned(),
            );
            let (route, providers) =
                match crate::agent_routing::resolve_live_route(state, &required).await {
                    Ok(route) => route,
                    Err(error) => return failed(error),
                };
            let target = genehub_proto::ForkTarget {
                agent_id: route.agent_id,
                workspace_id: Some(workspace_id.clone()),
                model_id: route.model_id,
                mode_id: route.mode_id,
                effort_id: route.effort_id,
                fast: route.fast,
                runtime_values: route.runtime_values,
            };
            match state
                .sessions
                .fork_import_routed(
                    &workspace_id,
                    workspace.root,
                    transfer,
                    target,
                    &providers,
                    false,
                    routing_tags,
                    media_tags,
                )
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionImportList {
            workspace_id,
            limit,
        } => Box::pin(async move {
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
        }).await,

        Request::SessionImport {
            workspace_id,
            candidate_id,
        } => Box::pin(async move {
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
        }).await,

        Request::SessionInterrupt { session_id } => Box::pin(async move {
            match state.sessions.interrupt(&session_id).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionClose { session_id } => Box::pin(async move {
            match state.sessions.close(&session_id).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionArchive {
            session_id,
            archived,
        } => Box::pin(async move {
            match state.sessions.archive(&session_id, archived).await {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionRename { session_id, title } => Box::pin(async move {
            match state.sessions.rename(&session_id, &title).await {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionLabel { session_id, add, remove } => Box::pin(async move {
            match state.sessions.label(&session_id, &add, &remove).await {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionDescribe { session_id, text } => Box::pin(async move {
            match state.sessions.describe(&session_id, &text).await {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionDelete { session_id } => Box::pin(async move {
            match state.sessions.delete(&session_id).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionSetModel {
            session_id,
            model_id,
        } => Box::pin(async move {
            let summary = match state.sessions.summary(&session_id).await {
                Ok(summary) => summary,
                Err(error) => return failed(error),
            };
            // Naming a model the session's own Agent does not ship is a request
            // to move the session to whoever does, not a reason to refuse.
            if let Some(owner) = crate::agent_routing::agent_offering_model(state, &model_id, &summary.agent_id).await
            {
                if owner != summary.agent_id {
                    let mut target = SessionAgentTarget {
                        agent_id: owner,
                        model_id: Some(model_id.clone()),
                        mode_id: None,
                        effort_id: None,
                        fast: None,
                        runtime_values: std::collections::BTreeMap::new(),
                    };
                    target.model_id = match crate::agent_routing::ensure_concrete_route_allowed(
                        state,
                        &target.agent_id,
                        target.model_id,
                    )
                    .await
                    {
                        Ok(model_id) => model_id,
                        Err(error) => return failed(error),
                    };
                    let providers = state.providers().await;
                    return match state.sessions.switch_agent(&session_id, target, &providers).await
                    {
                        Ok(summary) => Handled::ok(Reply::Session(summary)),
                        Err(error) => failed(error),
                    };
                }
            }
            if let Err(error) = crate::agent_routing::ensure_concrete_route_allowed(
                state,
                &summary.agent_id,
                Some(model_id.clone()),
            )
            .await
            {
                return failed(error);
            }
            let providers = state.providers().await;
            match state
                .sessions
                .set_model(&session_id, &model_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionSwitchAgent { session_id, mut target } => Box::pin(async move {
            target.model_id = match crate::agent_routing::ensure_concrete_route_allowed(
                state,
                &target.agent_id,
                target.model_id,
            )
            .await
            {
                Ok(model_id) => model_id,
                Err(error) => return failed(error),
            };
            let providers = state.providers().await;
            match state
                .sessions
                .switch_agent(&session_id, target, &providers)
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionRoute {
            session_id,
            tags,
            media_tags,
        } => Box::pin(async move {
            let tags = match crate::agent_routing::validate_selected_tags(tags) {
                Ok(tags) => tags,
                Err(error) => return failed(error),
            };
            let media_tags = match crate::agent_routing::validate_media_tags(media_tags) {
                Ok(tags) => tags,
                Err(error) => return failed(error),
            };
            match crate::agent_routing::route_session(state, &session_id, Some(tags), media_tags)
                .await
            {
                Ok(summary) => Handled::ok(Reply::Session(summary)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionSetMode {
            session_id,
            mode_id,
        } => Box::pin(async move {
            let providers = state.providers().await;
            match state
                .sessions
                .set_mode(&session_id, &mode_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionSetEffort {
            session_id,
            effort_id,
        } => Box::pin(async move {
            let providers = state.providers().await;
            match state
                .sessions
                .set_effort(&session_id, &effort_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionSetFast { session_id, fast } => Box::pin(async move {
            let providers = state.providers().await;
            match state.sessions.set_fast(&session_id, fast, &providers).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionSetRuntimeAxis {
            session_id,
            axis_id,
            value_id,
        } => Box::pin(async move {
            let providers = state.providers().await;
            match state
                .sessions
                .set_runtime_axis(&session_id, &axis_id, &value_id, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::SessionAsk { session_id, request_id, title, questions } => Box::pin(async move {
            if caller.session_controller_id().is_some_and(|id| id != session_id) {
                return Handled::err(ErrorCode::Forbidden, "会话里的 Agent 只能为自己的会话提问");
            }
            let request = genehub_proto::PermissionRequest {
                id: request_id, title, kind: genehub_proto::PermissionRequestKind::Question,
                detail: None, tool_call_id: None, options: vec![], questions: Some(questions),
            };
            let owned = state.clone();
            // Stopping the caller's CLI may disconnect its RPC. The saved
            // obligation and cleanup must outlive that connection.
            match tokio::spawn(async move { owned.sessions.request_conversation_question(&session_id, request).await }).await {
                Ok(Ok(())) => Handled::ok(Reply::Ack),
                Ok(Err(error)) => failed(error),
                Err(_) => Handled::err(ErrorCode::Internal, "提问操作意外中止"),
            }
        }).await,

        Request::SessionRespondPermission {
            session_id,
            request_id,
            outcome,
        } => Box::pin(async move {
            let kind = match state
                .sessions
                .pending_permission_kind(&session_id, &request_id)
                .await
            {
                Ok(kind) => kind,
                Err(error) => return failed(error),
            };
            if kind == Some(genehub_proto::PermissionRequestKind::ProviderConfiguration)
                && (caller.session_controller_id().is_some()
                    || !matches!(outcome, genehub_proto::PermissionOutcome::Canceled))
            {
                return Handled::err(ErrorCode::Forbidden, "provider 配置须由 Human 通过专用提交入口确认；普通会话答案不能保存密钥或授予配置权限");
            }
            // A tool permission is addressed to the Human. A Session
            // Controller (the Agent's own CLI or another Agent) must not be
            // able to approve the request it caused.
            if kind == Some(genehub_proto::PermissionRequestKind::Permission)
                && caller.session_controller_id().is_some()
            {
                return Handled::err(
                    ErrorCode::Forbidden,
                    "Agent/CLI 不能替用户批准工具权限",
                );
            }
            // A question in the caller's own Session is addressed to its
            // Human. Answering another Session's question (a PM deciding a
            // reviewer's recovery choice) stays an Agent-to-Agent path.
            if (kind == Some(genehub_proto::PermissionRequestKind::PlanApproval)
                || (kind == Some(genehub_proto::PermissionRequestKind::Question)
                    && (caller.session_controller_id() == Some(session_id.as_str()))))
                && matches!(caller, crate::authz::Principal::SessionController { .. })
            {
                return Handled::err(
                    ErrorCode::Forbidden,
                    "Agent/CLI 不能替用户回答问题或确认计划",
                );
            }
            let providers = state.providers().await;
            match state
                .sessions
                .respond_permission(&session_id, &request_id, outcome, &providers)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::CallerAuthority => Handled::ok(Reply::CallerAuthority(caller.authority())),
        Request::ProviderList => {
            let config = state.config.read().await;
            let providers = config.agents.providers.iter().map(|(id, provider)| {
                let resolved = crate::provider::resolve(id, provider);
                genehub_proto::ProviderInfo {
                    id: id.clone(), has_api_key: provider.api_key.as_deref().is_some_and(|key| !key.is_empty()),
                    base_url: resolved.base_url, label: resolved.label, dialect: resolved.dialect.as_str().into(),
                    custom: resolved.custom, models: provider.models.clone(),
                    model_inputs: Some(provider.model_capabilities.iter().filter_map(|(model, caps)| Some((model.clone(), caps.inputs.clone()?))).collect()),
                    model_capabilities: Some(provider.models.iter().chain(provider.model_capabilities.keys())
                        .map(|model| (model.clone(), crate::capabilities::info(id, provider, model))).collect()),
                    problem: None,
                }
            }).collect();
            Handled::ok(Reply::Providers(providers))
        },
        Request::ProviderOperation { session_id, operation } => Box::pin(async move {
            // Preparation stops its calling execution; do not tie it to the old CLI future.
            let state = state.clone();
            match tokio::spawn(async move { crate::provider_control::execute(&state, &session_id, operation).await }).await {
                Ok(Ok(receipt)) => Handled::ok(Reply::ProviderOperation(receipt)),
                Ok(Err(error)) => {
                    if error.is::<crate::session::manager::SessionMissing>() { failed(error) }
                    else if error.root_cause().is::<std::io::Error>() || error.root_cause().is::<serde_json::Error>() {
                        Handled::err(ErrorCode::Internal, "配置操作存储不可用；请检查原操作回执后重试，不会盲目重复保存")
                    } else { Handled::err(ErrorCode::BadRequest, error.to_string()) }
                },
                Err(_) => Handled::err(ErrorCode::Internal, "配置请求处理意外中止；请读取原操作回执"),
            }
        }).await,

        Request::SettingsGet => Box::pin(async move {
            Handled::ok(Reply::Settings(state.settings().await))
        }).await,

        Request::SettingsSetAgentPreferences { preferences } => Box::pin(async move {
            match state.set_agent_preferences(preferences).await {
                Ok(settings) => Handled::ok(Reply::Settings(settings)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SpeechCapabilities => Box::pin(async move {
            Handled::ok(Reply::SpeechCapabilities(state.speech_capabilities().await))
        }).await,

        Request::SpeechSettingsSetQwen3 {
            stub_enabled,
            context_enabled,
            pinned_terms,
            language_hints,
            collect_corrections,
            workspace_id,
        } => Box::pin(async move {
            match state
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
            }
        }).await,

        Request::SpeechRuntimeProbe => Box::pin(async move {
            Handled::ok(Reply::SpeechRuntimeStatus(
                state.probe_speech_runtime().await,
            ))
        }).await,

        Request::SpeechRuntimeConfigure { command, args } => Box::pin(async move {
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
        }).await,

        Request::SpeechContextPreview {
            workspace_id,
            session_id,
            draft,
        } => Box::pin(async move {
            match crate::speech::compile_context_for_state(
                state,
                &workspace_id,
                session_id.as_deref(),
                draft.as_deref(),
            )
            .await
            {
                Ok(context) => Handled::ok(Reply::SpeechContext(context)),
                Err(error) => failed(error),
            }
        }).await,

        Request::SpeechFeedbackRecord {
            workspace_id,
            request_id,
            context_snapshot_id: _,
            candidates: _,
            selected_candidate_id,
            rejected_candidate_id,
            scope,
            score_kind: _,
        } => Box::pin(async move {
            match crate::speech::record_feedback_for_state(
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
            }
        }).await,

        Request::SettingsSetProvider {
            provider_id,
            api_key,
            base_url,
            label,
            dialect,
            models,
            model_inputs,
            model_capabilities,
        } => Box::pin(async move {
            match state
                .set_provider(
                    &provider_id,
                    api_key,
                    base_url,
                    label,
                    dialect,
                    models,
                    model_inputs,
                    model_capabilities,
                )
                .await
            {
                Ok(settings) => Handled::ok(Reply::Settings(settings)),
                Err(error) => failed(error),
            }
        }).await,

        Request::LogTail { name } => Box::pin(async move {
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
        }).await,

        Request::DiagnosticsSnapshot => Box::pin(async move {
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
        }).await,

        Request::UpdateCheck => Box::pin(async move {
            match crate::host_update::check() {
                Ok(status) => Handled::ok(Reply::Update(status)),
                Err(message) => Handled::err(ErrorCode::Unsupported, message),
            }
        }).await,

        Request::UpdateAppCheck => Box::pin(async move {
            let manifest_url = state.config.read().await.update_manifest_url.clone();
            // The App check compares the App's own build version, not the
            // component's: a Live release moves the component past the App
            // line, and the question here is whether the machine's
            // binaries need replacing.
            let app_version = crate::version::app_version();
            Handled::ok(Reply::Update(
                crate::updates::check(&manifest_url, &app_version).await,
            ))
        }).await,

        Request::UpdateDownload => Box::pin(async move {
            match crate::host_update::apply("web") {
                Ok(()) => {
                    state.reload.notify_waiters();
                    Handled::ok(Reply::UpdateDownload(state.updates.state()))
                }
                Err(message) => Handled::err(ErrorCode::Unsupported, message),
            }
        }).await,

        Request::UpdateDownloadState => Box::pin(async move {
            Handled::ok(Reply::UpdateDownload(state.updates.state()))
        }).await,

        Request::UpdateDismiss => Box::pin(async move {
            Handled::ok(Reply::UpdateDownload(state.updates.dismiss(state)))
        }).await,

        Request::SettingsForgetProvider { provider_id } => Box::pin(async move {
            match state.forget_provider(&provider_id).await {
                Ok(settings) => Handled::ok(Reply::Settings(settings)),
                Err(error) => failed(error),
            }
        }).await,

        Request::HubStatus => Box::pin(async move {
            match state.link.get() {
                Some(link) => Handled::ok(Reply::HubStatus(link.status().await)),
                None => Handled::ok(Reply::HubStatus(genehub_proto::HubStatus::Unpaired)),
            }
        }).await,

        Request::HubPair {
            hub_url,
            display_name,
        } => Box::pin(async move {
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
        }).await,

        Request::HubTrial {
            hub_url,
            display_name,
        } => Box::pin(async move {
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
        }).await,

        Request::HubClaimLink => Box::pin(async move {
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
        }).await,

        Request::HubMachines => Box::pin(async move {
            match state.link.get() {
                Some(link) => match link.machines().await {
                    Ok(machines) => Handled::ok(Reply::HubMachines(machines)),
                    Err(error) => failed(error),
                },
                // Still starting up is not "you have no machines", but a switcher
                // showing an error for the second it takes would be worse than one
                // that fills in a moment later.
                None => Handled::ok(Reply::HubMachines(Vec::new())),
            }
        }).await,

        Request::HubConnect { machine_id } => Box::pin(async move {
            let Some(link) = state.link.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match link.connect(&machine_id).await {
                Ok(ticket) => Handled::ok(Reply::HubTicket(ticket)),
                Err(error) => failed(error),
            }
        }).await,

        Request::HubUnpair => Box::pin(async move {
            match state.link.get() {
                Some(link) => match link.unpair().await {
                    Ok(()) => Handled::ok(Reply::HubStatus(genehub_proto::HubStatus::Unpaired)),
                    Err(error) => failed(error),
                },
                None => Handled::ok(Reply::HubStatus(genehub_proto::HubStatus::Unpaired)),
            }
        }).await,

        Request::DeviceList => Box::pin(async move {
            Handled::ok(Reply::Devices {
                devices: state.devices.list(),
                remote: remote_status(state).await,
            })
        }).await,

        Request::DeviceInvite(scope) => Box::pin(async move {
            if scope.is_some() {
                return Handled::err(ErrorCode::BadRequest, "restricted invitations are no longer supported; pair for full machine access or use a preview share");
            }
            let mut invite = state.devices.invite();
            invite.rendezvous_url = remote_status(state).await.rendezvous_url;
            Handled::ok(Reply::Invite(invite))
        }).await,

        // The protocol-v3 peer handshake authenticates an invitation before
        // this RPC exists. `handle_rpc` consumes the invitation on that narrow
        // bootstrap endpoint; an ordinary authenticated peer cannot claim one.
        Request::DeviceClaim { .. } => Box::pin(async move {
            Handled::err(
                ErrorCode::Unauthorized,
                "配对邀请只能在对应的加密引导连接中兑换",
            )
        }).await,

        Request::DeviceRevoke { device_id } => Box::pin(async move {
            match state.devices.revoke(&device_id) {
                Ok(_) => Handled::ok(Reply::Devices {
                    devices: state.devices.list(),
                    remote: remote_status(state).await,
                }),
                Err(error) => failed(error),
            }
        }).await,

        Request::DeviceRemoteAttach {
            relay_url,
            join_token,
            channel_count,
        } => Box::pin(async move {
            let Some(remote) = state.remote.get() else {
                return Handled::err(ErrorCode::Internal, "the daemon is still starting up");
            };
            match remote.set_channels(&relay_url, join_token, channel_count.unwrap_or(1)).await {
                Ok(status) => Handled::ok(Reply::RemoteAccess(status)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }).await,

        Request::DeviceRemoteDetach => Box::pin(async move {
            match state.remote.get() {
                Some(remote) => match remote.clear().await {
                    Ok(status) => Handled::ok(Reply::RemoteAccess(status)),
                    Err(error) => failed(error),
                },
                None => Handled::ok(Reply::RemoteAccess(genehub_proto::RemoteAccess {
                    relay_url: None,
                    rendezvous_url: None,
                    channels: None,
                    online: false,
                })),
            }
        }).await,

        Request::FileAccessList => Box::pin(async move {
            Handled::ok(Reply::FileAccess(crate::file_access::info(&*state.config.read().await)))
        }).await,
        Request::FileAccessConfigure { expected_revision, additional_directories } => Box::pin(async move {
            match crate::file_access::configure(state, &expected_revision, additional_directories).await {
                Ok(info) => Handled::ok(Reply::FileAccess(info)),
                Err(error) if error.to_string().contains("revision conflict") => Handled::err(ErrorCode::Conflict, error.to_string()),
                Err(error) => Handled::err(ErrorCode::BadRequest, error.to_string()),
            }
        }).await,
        Request::WorkspaceList => Box::pin(async move {
            // Spaces written into <data>/spaces/ become projects the next time
            // anyone looks; throttled, and a no-op when there is nothing there.
            state
                .workspaces
                .scan_spaces(&state.paths.root.join("spaces"), false)
                .await;
            Handled::ok(Reply::Workspaces(state.workspaces.list().await))
        }).await,

        Request::WorkspaceOpen { root } => Box::pin(async move {
            match state.workspaces.open_with_children(Path::new(&root)).await {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => failed(error),
            }
        }).await,

        Request::WorkspaceAddRoot { workspace_id, root } => Box::pin(async move {
            match state
                .workspaces
                .add_root(&workspace_id, Path::new(&root))
                .await
            {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => failed(error),
            }
        }).await,

        Request::WorkspaceCreate { root, name } => Box::pin(async move {
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
        }).await,

        Request::AgentSpaceChangePlan {
            workspace_id,
            expected_revision,
            operation,
        } => Box::pin(async move {
            let (_current, _canonical_root, plan_digest) =
                match agent_space_change_facts(state, &workspace_id, expected_revision, &operation).await {
                    Ok(facts) => facts,
                    Err(error) => return Handled::err(ErrorCode::Conflict, format!("{error:#}")),
                };
            Handled::ok(Reply::AgentSpaceChangePlan(
                genehub_proto::AgentSpaceChangePlan {
                    schema: "genehub.agent-space-change-plan.v1".into(),
                    workspace_id,
                    plan_digest,
                    expected_revision,
                    operation,
                },
            ))
        }).await,

        Request::AgentSpaceConfigure {
            workspace_id,
            expected_revision,
            operation,
            plan_digest: _,
            action_id: _,
        } => Box::pin(async move {
            if let Err(error) = guard_agent_space_mutation(state, &workspace_id, &operation).await {
                return Handled::err(ErrorCode::Conflict, format!("{error:#}"));
            }
            match state
                .workspaces
                .configure_agent_space(&workspace_id, expected_revision, &operation)
                .await
            {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }).await,

        Request::AgentSpaceChildren { workspace_id } => Box::pin(async move {
            match state.workspaces.schedulable_children(&workspace_id).await {
                Ok(children) => Handled::ok(Reply::Workspaces(children)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }).await,

        Request::WorkspaceRename { workspace_id, name } => Box::pin(async move {
            match state.workspaces.rename(&workspace_id, &name).await {
                Ok(workspace) => Handled::ok(Reply::Workspace(workspace)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
            }
        }).await,

        Request::WorkspaceRemove { workspace_id } => Box::pin(async move {
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
        }).await,

        Request::DirectoryList { path } => Box::pin(async move {
            match crate::workspace::list_directory(path.as_deref().map(Path::new)) {
                Ok(listing) => Handled::ok(Reply::Directory(listing)),
                Err(error) => failed(error),
            }
        }).await,

        Request::DirectoryMkdir { parent, name } => Box::pin(async move {
            match crate::workspace::mkdir_directory(Path::new(&parent), &name) {
                Ok(listing) => {
                    tracing::info!(%parent, %name, "directory.mkdir");
                    Handled::ok(Reply::Directory(listing))
                }
                Err(error) => failed(error),
            }
        }).await,

        Request::FileTree {
            workspace_id,
            path,
            depth,
        } => Box::pin(async move {
            match state
                .workspaces
                .tree(&workspace_id, path.as_deref(), depth.unwrap_or(2).min(8))
                .await
            {
                Ok(tree) => Handled::ok(Reply::FileTree(tree)),
                Err(error) => failed(error),
            }
        }).await,

        Request::FileWrite {
            workspace_id,
            path,
            content,
        } => Box::pin(async move {
            let target = match state.workspaces.resolve(&workspace_id, &path).await {
                Ok(target) => target,
                Err(error) => return failed(error),
            };
            match files::write(&target.root, &target.absolute, &content) {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::FileMkdir { workspace_id, path } => Box::pin(async move {
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
        }).await,

        Request::FileCopy {
            workspace_id,
            from,
            to,
        } => Box::pin(async move {
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
        }).await,

        Request::FileMove {
            workspace_id,
            from,
            to,
        } => Box::pin(async move {
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
        }).await,

        Request::FileDelete {
            workspace_id,
            paths,
        } => Box::pin(async move {
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
        }).await,

        Request::GitStatus { workspace_id } => Box::pin(async move {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match git::status(&workspace.root).await {
                Ok(status) => Handled::ok(Reply::GitStatus(status)),
                Err(error) => failed(error),
            }
        }).await,

        Request::GitDiff { workspace_id, path } => Box::pin(async move {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match git::diff(&workspace.root, path.as_deref()).await {
                Ok(diff) => Handled::ok(Reply::GitDiff { diff }),
                Err(error) => failed(error),
            }
        }).await,

        Request::GitCommit {
            workspace_id,
            message,
            paths,
        } => Box::pin(async move {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match git::commit(&workspace.root, &message, &paths).await {
                Ok(commit) => Handled::ok(Reply::GitCommit { commit }),
                Err(error) => failed(error),
            }
        }).await,

        Request::PtyOpen {
            workspace_id,
            cols,
            rows,
        } => Box::pin(async move {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            match state
                .terminals
                .open(
                    &workspace.root,
                    cols.unwrap_or(80),
                    rows.unwrap_or(24),
                )
                .await
            {
                Ok(pty_id) => Handled::ok(Reply::Pty { pty_id }),
                Err(error) => failed(error),
            }
        }).await,

        Request::PtyWrite { pty_id, data } => Box::pin(async move {
            match state.terminals.write(&pty_id, &data).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::PtyResize { pty_id, cols, rows } => Box::pin(async move {
            match state.terminals.resize(&pty_id, cols, rows).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::PtyClose { pty_id } => Box::pin(async move {
            match state.terminals.close(&pty_id).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }).await,

        Request::ProcessList => Box::pin(async move {
            match crate::dataplane::service_preview::process_snapshot(state, caller, None).await {
                Ok(rows) => Handled::ok(Reply::Processes(rows)),
                Err(e) => failed(e),
            }
        }).await,
        Request::ProcessWorkspaceList { workspace_id } => Box::pin(async move {
            match crate::dataplane::service_preview::process_snapshot(
                state,
                caller,
                Some(&workspace_id),
            )
            .await
            {
                Ok(rows) => Handled::ok(Reply::Processes(rows)),
                Err(e) => failed(e),
            }
        }).await,
        Request::ProcessServiceStop {
            workspace_id,
            entry_path,
            run_id,
        } => Box::pin(async move {
            match crate::dataplane::service_preview::stop_registered(
                state,
                &workspace_id,
                &entry_path,
                &run_id,
            )
            .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(e) => failed(e),
            }
        }).await,
        Request::ProcessKill { session_id, pid } => Box::pin(async move {
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
        }).await,
        Request::ProcessKillAll { session_id } => Box::pin(async move {
            state.processes.stop_all(&session_id).await;
            Handled::ok(Reply::Ack)
        }).await,

    }
}

/// Only operations useful during support triage enter the automatic record.
/// Payload values are deliberately ignored; names are compile-time constants.
fn diagnostic_operation(request: &Request) -> Option<&'static str> {
    match request {
        Request::AgentRefresh => Some("agent.refresh"),
        Request::AgentAction { .. } => Some("agent.action"),
        Request::AgentReload { .. } => Some("agent.reload"),
        Request::AgentReset { .. } => Some("agent.reset"),
        Request::AgentTest { .. } => Some("agent.test"),
        Request::AgentRequestAnswer { .. } => Some("agent.requestAnswer"),
        Request::SessionCreate { .. } | Request::SessionCreateRouted { .. } => {
            Some("session.create")
        }
        Request::AgentSpaceChangePlan { .. } => Some("agentSpace.changePlan"),
        Request::AgentSpaceChildren { .. } => Some("agentSpace.children"),
        Request::SessionSend { .. } => Some("session.send"),
        Request::SessionDraftsReplace { .. } => Some("session.drafts.replace"),
        Request::SessionPreviewAnnotationUpsert { .. } => Some("session.previewAnnotations.upsert"),
        Request::SessionPreviewAnnotationRemove { .. } => Some("session.previewAnnotations.remove"),
        Request::SessionArtifactBegin { .. } => Some("session.artifact.begin"),
        Request::SessionArtifactChunk { .. } => Some("session.artifact.chunk"),
        Request::SessionArtifactFinish { .. } => Some("session.artifact.finish"),
        Request::SessionArtifactAbort { .. } => Some("session.artifact.abort"),
        Request::SessionFork { .. } => Some("session.fork"),
        Request::SessionForkRouted { .. } => Some("session.forkRouted"),
        Request::SessionForkExport { .. } => Some("session.forkExport"),
        Request::SessionForkImport { .. } => Some("session.forkImport"),
        Request::SessionForkImportRouted { .. } => Some("session.forkImportRouted"),
        Request::SessionImport { .. } => Some("session.import"),
        Request::SessionInterrupt { .. } => Some("session.interrupt"),
        Request::SessionDelete { .. } => Some("session.delete"),
        Request::SessionSwitchAgent { .. } => Some("session.switchAgent"),
        Request::SessionRoute { .. } => Some("session.route"),
        Request::SessionRespondPermission { .. } => Some("session.respondPermission"),
        Request::SessionAsk { .. } => Some("session.ask"),
        Request::SettingsSetProvider { .. } => Some("settings.setProvider"),
        Request::ProviderOperation { .. } => Some("provider.operation"),
        Request::SettingsSetAgentPreferences { .. } => Some("settings.setAgentPreferences"),
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
        Request::WorkspaceAddRoot { .. } => Some("workspace.addRoot"),
        Request::WorkspaceCreate { .. } => Some("workspace.create"),
        Request::AgentSpaceConfigure { .. } => Some("agentSpace.configure"),
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
    }
}

async fn remote_status(state: &Shared) -> genehub_proto::RemoteAccess {
    match state.remote.get() {
        Some(remote) => remote.status().await,
        None => genehub_proto::RemoteAccess {
            relay_url: None,
            rendezvous_url: None,
            channels: None,
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
                "'not-a-model-this-cli-has' is not a model this agent offers (default, opus, sonnet, haiku)",
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
