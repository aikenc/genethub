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
    } else if message.contains("artifact upload conflict")
        || message.contains("revision 冲突")
        || message.contains("已由 Workflow Run")
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
    } else if message.contains("no such")
        || message.contains("does not exist")
        || message.contains("Workflow 不存在")
        || message.contains("Workflow Run 不存在")
        || message.contains("项目尚未初始化 Workflow")
    {
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

async fn start_workflow_sessions(
    state: &Shared,
    workspace_id: &str,
    run_id: &str,
    sessions: Vec<(genehub_proto::SessionSummary, String)>,
) -> anyhow::Result<()> {
    for (session, message) in sessions {
        if let Err(error) =
            crate::workflow::start_assigned(state, workspace_id, run_id, &session, message).await
        {
            let launch = anyhow::anyhow!("启动 Workflow 子会话 {}：{error:#}", session.id);
            return match crate::workflow::abort_launch(state, workspace_id, run_id).await {
                Ok(()) => Err(launch),
                Err(cleanup) => Err(anyhow::anyhow!(
                    "{launch:#}；终止 Workflow Run 时又失败：{cleanup:#}"
                )),
            };
        }
    }
    Ok(())
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
    let needed = crate::authz::required(&request);
    let recovery_configuration = if !caller.allows(needed) {
        match (&request, caller.session_controller_id()) {
            (Request::AgentSpaceConfigure { workspace_id, .. }, Some(session_id)) => {
                match state.workspaces.project_root(workspace_id).await {
                    Ok(project) => crate::workflow::exception_authority(state, &project, session_id).await.unwrap_or(false),
                    Err(_) => false,
                }
            }
            _ => false,
        }
    } else { false };
    if !caller.allows(needed) && !recovery_configuration {
        return Handled::err(
            ErrorCode::Unauthorized,
            format!("caller lacks the {} capability", needed.as_str()),
        );
    }
    if let Err(message) = authorize_session_request(state, caller, &request).await {
        return Handled::err(ErrorCode::Forbidden, message);
    }
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

/// Keeps a Workflow-managed child human-read-only without inventing a second
/// Session runtime. Fork remains a human operation and deliberately does not
/// appear here: the fork is an ordinary Session with no managed binding.
async fn authorize_session_request(
    state: &Shared,
    caller: &crate::authz::Principal,
    request: &Request,
) -> Result<(), String> {
    if caller.session_controller_id().is_some()
        && matches!(
            request,
            Request::SessionCreate { .. }
                | Request::SessionForkImport { .. }
                | Request::SessionImport { .. }
        )
    {
        return Err(
            "受会话绑定的 Agent 不能创建普通会话；请通过项目 Workflow 委托受管子会话".into(),
        );
    }

    let target = match request {
        Request::SessionSend { session_id, .. }
        | Request::SessionArtifactBegin { session_id, .. }
        | Request::SessionArtifactChunk { session_id, .. }
        | Request::SessionArtifactFinish { session_id, .. }
        | Request::SessionArtifactAbort { session_id, .. }
        | Request::SessionInterrupt { session_id }
        | Request::SessionClose { session_id }
        | Request::SessionArchive { session_id, .. }
        | Request::SessionRename { session_id, .. }
        | Request::SessionDelete { session_id }
        | Request::SessionSetModel { session_id, .. }
        | Request::SessionSetMode { session_id, .. }
        | Request::SessionSetEffort { session_id, .. }
        | Request::SessionSetRuntimeAxis { session_id, .. }
        | Request::SessionRespondPermission { session_id, .. }
        | Request::ProcessKill { session_id, .. }
        | Request::ProcessKillAll { session_id } => Some(session_id.as_str()),
        _ => None,
    };
    let Some(target) = target else {
        return Ok(());
    };
    let summary = match state.sessions.summary(target).await {
        Ok(summary) => summary,
        // Process ownership is checked by the process registry itself. Let an
        // ordinary caller reach that check when the Session record is already
        // gone: killing one process then remains `notFound`, while `kill all`
        // remains an idempotent desired-state cleanup. Session-bound Agents
        // still take the normal path so a made-up id cannot bypass their child
        // boundary.
        Err(error) => {
            if caller.session_controller_id().is_none()
                && matches!(
                    request,
                    Request::ProcessKill { .. } | Request::ProcessKillAll { .. }
                )
                && error.is::<crate::session::manager::SessionMissing>()
            {
                return Ok(());
            }
            return Err(format!("{error:#}"));
        }
    };
    match (caller.session_controller_id(), summary.managed) {
        (Some(controller), Some(managed)) if managed.parent_session_id == controller => Ok(()),
        (Some(controller), Some(_)) if !matches!(request, Request::SessionRespondPermission { .. }) => {
            let project = state.workspaces.project_root(&summary.workspace_id).await
                .map_err(|error| format!("无法确认项目边界：{error:#}"))?;
            if crate::workflow::exception_authority(state, &project, controller).await.unwrap_or(false) {
                Ok(())
            } else {
                Err("受会话绑定的 Agent 只能控制由自己委托的受管子会话".into())
            }
        }
        (Some(_), _) => Err("受会话绑定的 Agent 只能控制由自己委托的受管子会话".into()),
        (None, Some(managed))
            if managed.user_interaction == genehub_proto::SessionUserInteraction::ReadOnly =>
        {
            Err("这是 Workflow 管理的只读子会话；可查看或 fork，但不能直接改写".into())
        }
        (None, _) => Ok(()),
    }
}

async fn authorize_project_workflow_mutation(
    state: &Shared,
    caller: &crate::authz::Principal,
    workspace_id: &str,
) -> Result<(), String> {
    match caller {
        crate::authz::Principal::LocalUser => Ok(()),
        crate::authz::Principal::SessionController { session_id } => {
            if state.sessions.consulting(session_id).await {
                return Err(
                    "PM 正在咨询未决 Human 请求；不能以项目管理权替代该请求的正式决定".into(),
                );
            }
            let summary = state
                .sessions
                .summary(session_id)
                .await
                .map_err(|error| format!("无法确认入口会话：{error:#}"))?;
            if summary.managed.is_some() {
                return Err("受管子会话不能初始化或激活项目 DCG；请回到项目主会话操作".into());
            }
            if summary.workspace_id != workspace_id {
                return Err("入口会话不属于请求的项目 Workspace".into());
            }
            let space = state
                .workspaces
                .agent_space(workspace_id)
                .await
                .map_err(|error| format!("无法确认项目管理授权：{error:#}"))?;
            if agent_space_requires_project_control(&space)
                && !state.project_control.is_bound(workspace_id, session_id)
                && !crate::workflow::exception_authority(state, workspace_id, session_id).await.unwrap_or(false)
            {
                return Err(
                    "当前 Session 没有这个项目的 ProjectControlBinding；请先完成 PM 接管".into(),
                );
            }
            Ok(())
        }
        _ => Err("只有本机用户或项目普通主会话可以修改 DCG 生命周期".into()),
    }
}

fn agent_space_requires_project_control(space: &crate::config::AgentSpaceEntry) -> bool {
    crate::agent_space::has_enabled_component(space, crate::agent_space::COMPONENT_PM)
        || space.bootstrap_pack.is_some()
}

async fn authorize_agent_space_change(
    state: &Shared,
    caller: &crate::authz::Principal,
    workspace_id: &str,
) -> Result<(), String> {
    match caller {
        crate::authz::Principal::LocalUser => Ok(()),
        crate::authz::Principal::SessionController { session_id } => {
            if state.sessions.consulting(session_id).await {
                return Err(
                    "PM 正在咨询未决 Human 请求；不能以项目管理权替代该请求的正式决定".into(),
                );
            }
            let summary = state
                .sessions
                .summary(session_id)
                .await
                .map_err(|error| format!("无法确认入口会话：{error:#}"))?;
            if summary.managed.is_some() {
                return Err("受管 Worker Session 不能改组 AgentSpace 树".into());
            }
            let project_id = state
                .workspaces
                .project_root(workspace_id)
                .await
                .map_err(|error| format!("无法确认项目边界：{error:#}"))?;
            if summary.workspace_id == workspace_id
                || state.project_control.is_bound(&project_id, session_id)
                || crate::workflow::exception_authority(state, &project_id, session_id).await.unwrap_or(false)
            {
                Ok(())
            } else {
                Err("当前 Session 既不属于目标 Space，也没有该项目的控制绑定".into())
            }
        }
        _ => Err("只有认证用户或获得项目控制绑定的普通 Session 可以改组 AgentSpace".into()),
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
    let digest = crate::project_control::agent_space_plan_digest(
        workspace_id,
        &canonical_root,
        expected_revision,
        &current.builder_lock_digest,
        operation,
    )?;
    Ok((current, canonical_root, digest))
}

/// Refuses to move an AgentSpace while a Run still depends on it.
///
/// A Run pins its execution carrier when it starts, so a reparent in flight
/// would leave that Run bound to a Space in another project's scope. The
/// check lives here rather than in `workspace` because it is the one place
/// that holds both the registry and the Workflow runtime root; the registry
/// itself deliberately knows nothing about Runs.
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

    let sessions = state.sessions.list(Some(workspace_id), true).await?;
    let active_sessions = sessions
        .into_iter()
        .filter(|session| {
            matches!(
                session.status,
                genehub_proto::SessionStatus::Running | genehub_proto::SessionStatus::Waiting
            )
        })
        .map(|session| session.id)
        .collect::<Vec<_>>();
    if !active_sessions.is_empty() {
        anyhow::bail!(
            "activeSessionConflict: stop these running or waiting Sessions before changing AgentSpace {workspace_id}: {}",
            active_sessions.join(", ")
        );
    }

    let project = state.workspaces.project_root(workspace_id).await?;
    let active_runs = match state.workspaces.get(&project).await {
        Ok(project_entry) => crate::workflow::project_active_run_ids(
            &state.paths.root,
            &project,
            &project_entry.root,
        )?,
        Err(error) => anyhow::bail!(
            "activeRunUnknown: 无法确认 AgentSpace 是否仍被 Workflow 使用；先恢复项目 {project}：{error:#}"
        ),
    };
    if !active_runs.is_empty() {
        anyhow::bail!(
            "activeRunConflict: finish or cancel these Workflow Runs before changing the team: {}",
            active_runs.join(", ")
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

async fn dispatch(
    state: &Shared,
    transport: TransportKind,
    caller: &crate::authz::Principal,
    request: Request,
) -> Handled {
    match request {
        Request::ClientDebug(request) => match state.client_debug.handle(request).await {
            Ok(reply) => Handled::ok(Reply::ClientDebug(reply)),
            Err(error) => Handled {
                reply: Err(error),
                effect: SideEffect::None,
            },
        },
        Request::ConnectionIdentity => Handled::ok(Reply::Hello(HelloResult {
            daemon_version: state.version.clone(),
            web_protocol: WEB_PROTOCOL_VERSION,
            machine_id: state.machine.machine_id.clone(),
            fingerprint: state.machine.fingerprint(),
            transport,
            machine_name: crate::link::default_display_name(),
            rtc_supported: crate::dataplane::rtc::SUPPORTED,
            features: Some(vec![
                "service.preview.v1".to_string(),
                "process.services.v1".to_string(),
                "workflow.control.v1".to_string(),
                "session.input.v1".to_string(),
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
            recent_rounds,
        } => match state
            .sessions
            .subscribe_window(&session_id, since_seq, expand_last_round, recent_rounds)
            .await
        {
            Ok((mut snapshot, replayed, reset, receiver)) => {
                crate::workflow::summarize_sessions(
                    state,
                    std::slice::from_mut(&mut snapshot.summary),
                )
                .await;
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

        Request::WorkflowInspect { workspace_id } => {
            let workspace = match state.workspaces.project_entry(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => {
                    return Handled::err(ErrorCode::Forbidden, format!("{error:#}"));
                }
            };
            let runtime = match crate::workflow::RuntimeStore::new(
                &state.paths.root,
                &workspace_id,
                &workspace.root,
            ) {
                Ok(runtime) => runtime,
                Err(error) => return failed(error),
            };
            match crate::workflow::inspect(&workspace.root, &runtime) {
                Ok(status) => Handled::ok(Reply::WorkflowProject(status)),
                Err(error) => failed(error),
            }
        }

        Request::WorkflowInitialize {
            workspace_id,
            agent_id,
            model_id,
        } => {
            if let Err(message) =
                authorize_project_workflow_mutation(state, caller, &workspace_id).await
            {
                return Handled::err(ErrorCode::Forbidden, message);
            }
            let workspace = match state.workspaces.project_entry(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => {
                    return Handled::err(ErrorCode::Forbidden, format!("{error:#}"));
                }
            };
            let runtime = match crate::workflow::RuntimeStore::new(
                &state.paths.root,
                &workspace_id,
                &workspace.root,
            ) {
                Ok(runtime) => runtime,
                Err(error) => return failed(error),
            };
            match crate::workflow::initialize_and_activate(
                &workspace.root,
                &runtime,
                &agent_id,
                model_id.as_deref(),
            ) {
                Ok(status) => Handled::ok(Reply::WorkflowProject(status)),
                Err(error) => failed(error),
            }
        }

        Request::WorkflowActivate {
            workspace_id,
            candidate_digest,
            expected_revision,
        } => {
            if let Err(message) =
                authorize_project_workflow_mutation(state, caller, &workspace_id).await
            {
                return Handled::err(ErrorCode::Forbidden, message);
            }
            let workspace = match state.workspaces.project_entry(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => {
                    return Handled::err(ErrorCode::Forbidden, format!("{error:#}"));
                }
            };
            let runtime = match crate::workflow::RuntimeStore::new(
                &state.paths.root,
                &workspace_id,
                &workspace.root,
            ) {
                Ok(runtime) => runtime,
                Err(error) => return failed(error),
            };
            match crate::workflow::activate_bound_project(
                state,
                &workspace_id,
                &workspace.root,
                &runtime,
                candidate_digest.as_deref(),
                expected_revision,
            )
            .await
            {
                Ok(status) => Handled::ok(Reply::WorkflowProject(status)),
                Err(error) => failed(error),
            }
        }

        Request::WorkflowDispatch {
            retry_of,
            resume_cancelled,
            candidate_digest,
            workspace_id,
            workflow_id,
            task_id,
            prompt,
        } => {
            let Some(parent_session_id) = caller.session_controller_id() else {
                return Handled::err(
                    ErrorCode::Unauthorized,
                    "workflow.dispatch 只能由当前根会话中的 Agent 发起",
                );
            };
            let project_space = match state.workspaces.agent_space(&workspace_id).await {
                Ok(space) => space,
                Err(error) => return failed(error),
            };
            // Delegation belongs to the authorized project, not to one chat tab.
            // dispatch below still requires an ordinary root Session in this project;
            // configuration changes retain their controller/exception checks.
            if agent_space_requires_project_control(&project_space)
                && !state.project_control.has_binding(&workspace_id)
                && !crate::workflow::exception_authority(state, &workspace_id, parent_session_id).await.unwrap_or(false)
            {
                return Handled::err(
                    ErrorCode::Forbidden,
                    "项目尚未接管；请先完成 PM 接管后再委托任务",
                );
            }
            let transition = match crate::workflow::dispatch(
                state,
                &workspace_id,
                parent_session_id,
                &workflow_id,
                &task_id,
                &prompt,
                candidate_digest.as_deref(),
                retry_of.as_deref(),
                resume_cancelled.unwrap_or(false),
            )
            .await
            {
                Ok(transition) => transition,
                Err(error) => return failed(error),
            };
            if let Err(error) = start_workflow_sessions(
                state,
                &workspace_id,
                &transition.status.id,
                transition.sessions,
            )
            .await
            {
                return failed(error);
            }
            Handled::ok(Reply::WorkflowRun(transition.status))
        }

        Request::WorkflowCheck {
            workspace_id,
            run_id,
        } => match crate::workflow::check(state, &workspace_id, run_id.as_deref()).await {
            Ok(report) => Handled::ok(Reply::WorkflowCheck(report)),
            Err(error) => failed(error),
        },

        Request::WorkflowGet {
            workspace_id,
            run_id,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            let runtime = match crate::workflow::RuntimeStore::new(
                &state.paths.root,
                &workspace_id,
                &workspace.root,
            ) {
                Ok(runtime) => runtime,
                Err(error) => return failed(error),
            };
            match crate::workflow::get(&runtime, &run_id) {
                Ok(status) => Handled::ok(Reply::WorkflowRun(status)),
                Err(error) => failed(error),
            }
        }

        Request::WorkflowHistory {
            workspace_id,
            limit,
        } => {
            let workspace = match state.workspaces.get(&workspace_id).await {
                Ok(workspace) => workspace,
                Err(error) => return failed(error),
            };
            let runtime = match crate::workflow::RuntimeStore::new(
                &state.paths.root,
                &workspace_id,
                &workspace.root,
            ) {
                Ok(runtime) => runtime,
                Err(error) => return failed(error),
            };
            match crate::workflow::history(&runtime, limit.unwrap_or(50)) {
                Ok(runs) => Handled::ok(Reply::WorkflowRuns(runs)),
                Err(error) => failed(error),
            }
        }

        Request::WorkflowComplete {
            workspace_id,
            run_id,
            node_id,
            expected_revision,
            evidence,
            outcome,
            reason,
        } => {
            let Some(caller_session_id) = caller.session_controller_id() else {
                return Handled::err(
                    ErrorCode::Unauthorized,
                    "workflow.complete 只能由该节点的受管子会话发起",
                );
            };
            let transition = match crate::workflow::complete(
                state,
                &workspace_id,
                caller_session_id,
                &run_id,
                &node_id,
                expected_revision,
                evidence,
                outcome.unwrap_or_default(),
                reason,
            )
            .await
            {
                Ok(transition) => transition,
                Err(error) => return failed(error),
            };
            if let Err(error) = start_workflow_sessions(
                state,
                &workspace_id,
                &transition.status.id,
                transition.sessions,
            )
            .await
            {
                return failed(error);
            }
            Handled::ok(Reply::WorkflowRun(transition.status))
        }

        Request::WorkflowCancel {
            workspace_id,
            run_id,
            expected_revision,
        } => {
            // Device/channel Session grants were checked by the common entry.
            // Agent-bound callers additionally prove project ownership.
            if caller.session_controller_id().is_some() {
                if let Err(error) =
                    authorize_project_workflow_mutation(state, caller, &workspace_id).await
                {
                    return Handled::err(ErrorCode::Forbidden, error);
                }
            }
            match crate::workflow::cancel(state, &workspace_id, &run_id, expected_revision).await {
                Ok(run) => Handled::ok(Reply::WorkflowRun(run)),
                Err(error) => failed(error),
            }
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
                Ok(summary) => {
                    if let Ok(space) = state.workspaces.agent_space(&workspace_id).await {
                        if crate::agent_space::has_enabled_component(
                            &space,
                            crate::agent_space::COMPONENT_PM,
                        ) {
                            if let Some(pack) = space.bootstrap_pack.as_ref() {
                                if let Err(error) = state.project_control.bind(
                                    &workspace_id,
                                    &summary.id,
                                    &pack.id,
                                    &pack.digest,
                                ) {
                                    return failed(error);
                                }
                            }
                        }
                    }
                    Handled::ok(Reply::Session(summary))
                }
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
            Ok(mut sessions) => {
                crate::workflow::summarize_sessions(state, &mut sessions).await;
                Handled::ok(Reply::Sessions(sessions))
            }
            Err(error) => failed(error),
        },

        Request::SessionGet {
            session_id,
            recent_rounds,
            before_item_id,
        } => match match recent_rounds {
            Some(limit) => {
                state
                    .sessions
                    .history_snapshot(&session_id, limit, before_item_id.as_deref())
                    .await
            }
            None => state.sessions.snapshot(&session_id).await,
        } {
            Ok(mut snapshot) => {
                crate::workflow::summarize_sessions(
                    state,
                    std::slice::from_mut(&mut snapshot.summary),
                )
                .await;
                Handled::ok(Reply::Snapshot(snapshot))
            }
            Err(error) => failed(error),
        },

        Request::SessionComponents { session_id } => {
            match session_components(state, &session_id).await {
                Ok(instances) => Handled::ok(Reply::SessionComponents(instances)),
                Err(error) => failed(error),
            }
        }

        Request::SessionFlow { session_id } => {
            match crate::workflow::executor_flow(state, &session_id).await {
                Ok(flow) => Handled::ok(Reply::SessionFlow(flow)),
                Err(error) => failed(error),
            }
        }

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
            message_id,
            task_run_id,
            session_id,
            text,
            attachments,
            artifact_preview_base_url,
            continues_round,
        } => {
            if text.trim().is_empty() && attachments.is_empty() {
                return Handled::err(ErrorCode::BadRequest, "there is nothing to send");
            }
            if let Some(message_id) = message_id {
                if let Some(run_id) = task_run_id.as_deref() {
                    if let Err(error) =
                        crate::workflow::validate_input_target(state, &session_id, run_id).await
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
                        "user",
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

        Request::SessionClose { session_id } => {
            if let Err(error) = state.project_control.revoke_session(&session_id).await {
                return failed(error);
            }
            match state.sessions.close(&session_id).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => failed(error),
            }
        }

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

        Request::SessionDelete { session_id } => {
            if let Err(error) = state.project_control.revoke_session(&session_id).await {
                return failed(error);
            }
            let summary = match state.sessions.summary(&session_id).await {
                Ok(summary) => summary,
                Err(error) => return failed(error),
            };
            let binding_snapshot = match state
                .project_control
                .remove_binding_for_session(&summary.workspace_id, &session_id)
            {
                Ok(snapshot) => snapshot,
                Err(error) => return failed(error),
            };
            match state.sessions.delete(&session_id).await {
                Ok(()) => Handled::ok(Reply::Ack),
                Err(error) => {
                    if let Some(snapshot) = binding_snapshot.as_deref() {
                        if let Err(restore) = state
                            .project_control
                            .restore_binding_snapshot(&summary.workspace_id, Some(snapshot))
                        {
                            return Handled::err(
                                ErrorCode::Internal,
                                format!(
                                    "sessionDeleteRollbackIncomplete: {error:#}; restoring project control binding failed: {restore:#}"
                                ),
                            );
                        }
                    }
                    failed(error)
                }
            }
        }

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
            let kind = match state
                .sessions
                .pending_permission_kind(&session_id, &request_id)
                .await
            {
                Ok(kind) => kind,
                Err(error) => return failed(error),
            };
            if kind == Some(genehub_proto::PermissionRequestKind::PlanApproval)
                && matches!(caller, crate::authz::Principal::SessionController { .. })
            {
                return Handled::err(ErrorCode::Forbidden, "Agent/CLI 不能替用户响应计划确认");
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

        Request::WorkspaceAddRoot { workspace_id, root } => {
            match state
                .workspaces
                .add_root(&workspace_id, Path::new(&root))
                .await
            {
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

        Request::AgentSpaceChangePlan {
            workspace_id,
            expected_revision,
            operation,
        } => {
            if let Err(message) = authorize_agent_space_change(state, caller, &workspace_id).await {
                return Handled::err(ErrorCode::Forbidden, message);
            }
            if let genehub_proto::AgentSpaceOperation::SetParent { parent_workspace_id: Some(parent) } = &operation {
                if let Err(message) = authorize_agent_space_change(state, caller, parent).await {
                    return Handled::err(ErrorCode::Forbidden, message);
                }
            }
            let (current, canonical_root, plan_digest) =
                match agent_space_change_facts(state, &workspace_id, expected_revision, &operation)
                    .await
                {
                    Ok(facts) => facts,
                    Err(error) => {
                        return Handled::err(ErrorCode::Conflict, format!("{error:#}"));
                    }
                };
            let approval = if let Some(session_id) = caller.session_controller_id() {
                let detail = serde_json::to_string_pretty(&operation)
                    .unwrap_or_else(|_| format!("{operation:?}"));
                let project_id = match state.workspaces.project_root(&workspace_id).await {
                    Ok(id) => id,
                    Err(error) => return failed(error),
                };
                match state.project_control.issue_management(crate::project_control::ChallengeSpec {
                            controller_session_id: session_id.into(),
                            workspace_id: workspace_id.clone(),
                            canonical_root,
                            action: "agentSpace.configure".into(),
                            pack_id: "agent-space-control".into(),
                            pack_digest: plan_digest.clone(),
                            plan_digest: plan_digest.clone(),
                            expected_revision,
                            git_head: None,
                            status_digest: current.builder_lock_digest,
                            title: "应用这次 AgentSpace 变更？".into(),
                            detail: format!(
                                "只对 Workspace {workspace_id} 执行一次 revision {expected_revision} CAS：\n{detail}\nplan: {plan_digest}"
                            ),
                        }, &project_id, crate::workflow::exception_authority(state, &project_id, session_id).await.unwrap_or(false))
                        .await { Ok(challenge) => challenge, Err(error) => return failed(error) }
            } else {
                None
            };
            Handled::ok(Reply::AgentSpaceChangePlan(
                genehub_proto::AgentSpaceChangePlan {
                    schema: "genehub.agent-space-change-plan.v1".into(),
                    workspace_id,
                    plan_digest,
                    expected_revision,
                    operation,
                    approval,
                },
            ))
        }

        Request::AgentSpaceConfigure {
            workspace_id,
            expected_revision,
            operation,
            plan_digest,
            action_id,
        } => {
            if let Err(message) = authorize_agent_space_change(state, caller, &workspace_id).await {
                return Handled::err(ErrorCode::Forbidden, message);
            }
            if let genehub_proto::AgentSpaceOperation::SetParent { parent_workspace_id: Some(parent) } = &operation {
                if let Err(message) = authorize_agent_space_change(state, caller, parent).await {
                    return Handled::err(ErrorCode::Forbidden, message);
                }
            }
            if let (Some(session_id), Some(plan_digest), Some(action_id)) = (
                caller.session_controller_id(),
                plan_digest.as_deref(),
                action_id.as_deref(),
            ) {
                match state
                    .project_control
                    .completed_action::<genehub_proto::WorkspaceInfo>(
                        &workspace_id,
                        session_id,
                        "agentSpace.configure",
                        plan_digest,
                        action_id,
                    ) {
                    Ok(Some(workspace)) => return Handled::ok(Reply::Workspace(workspace)),
                    Ok(None) => {}
                    Err(error) => {
                        return Handled::err(ErrorCode::Conflict, format!("{error:#}"));
                    }
                }
            }
            let mut reserved = None;
            let _mutation = if let Some(session_id) = caller.session_controller_id() {
                let mutation = state.project_control.mutation_lock().await;
                let (current, canonical_root, current_plan) = match agent_space_change_facts(
                    state,
                    &workspace_id,
                    expected_revision,
                    &operation,
                )
                .await
                {
                    Ok(facts) => facts,
                    Err(error) => {
                        return Handled::err(ErrorCode::Conflict, format!("{error:#}"));
                    }
                };
                let Some(plan_digest) = plan_digest.as_deref() else {
                    return Handled::err(
                        ErrorCode::Forbidden,
                        "approvalRequired: Agent 修改 Component 或 Parent 前必须先使用 --plan 并由用户确认",
                    );
                };
                let Some(action_id) = action_id.as_deref() else {
                    return Handled::err(ErrorCode::BadRequest, "apply requires --action-id");
                };
                if current_plan != plan_digest {
                    return Handled::err(
                        ErrorCode::Conflict,
                        "approvalStale: AgentSpace facts changed; create and approve a new plan",
                    );
                }
                let challenge = match state
                    .project_control
                    .reserve(
                        session_id,
                        &workspace_id,
                        &canonical_root,
                        "agentSpace.configure",
                        "agent-space-control",
                        plan_digest,
                        plan_digest,
                        expected_revision,
                        None,
                        &current.builder_lock_digest,
                        action_id,
                        crate::workflow::exception_authority(state, &state.workspaces.project_root(&workspace_id).await.unwrap_or_else(|_| workspace_id.clone()), session_id).await.unwrap_or(false),
                    )
                    .await
                {
                    Ok(challenge) => challenge,
                    Err(error) => {
                        return Handled::err(ErrorCode::Forbidden, format!("{error:#}"));
                    }
                };
                reserved = Some((challenge, action_id.to_string()));
                Some(mutation)
            } else {
                None
            };
            if let Err(error) = guard_agent_space_mutation(state, &workspace_id, &operation).await {
                if let Some((challenge, action_id)) = &reserved {
                    if let Err(error) = state
                        .project_control
                        .release_failed(challenge, action_id)
                        .await
                    {
                        return failed(error);
                    }
                }
                return Handled::err(ErrorCode::Conflict, format!("{error:#}"));
            }
            let config_snapshot = reserved
                .as_ref()
                .map(|_| state.workspaces.config_snapshot());
            let config_snapshot = match config_snapshot {
                Some(snapshot) => Some(snapshot.await),
                None => None,
            };
            match state
                .workspaces
                .configure_agent_space(&workspace_id, expected_revision, &operation)
                .await
            {
                Ok(workspace) => {
                    if let Some((challenge, action_id)) = &reserved {
                        let session_id = caller
                            .session_controller_id()
                            .expect("reserved changes have a Session controller");
                        let plan_digest = plan_digest
                            .as_deref()
                            .expect("reserved changes have a plan digest");
                        if let Err(error) = state.project_control.record_completed_action(
                            &workspace_id,
                            session_id,
                            "agentSpace.configure",
                            plan_digest,
                            action_id,
                            &workspace,
                        ) {
                            let rollback = match config_snapshot {
                                Some(snapshot) => state
                                    .workspaces
                                    .restore_config_snapshot(snapshot)
                                    .await
                                    .map_err(|rollback| format!("; rollback failed: {rollback:#}")),
                                None => Ok(()),
                            };
                            if let Err(error) = state
                                .project_control
                                .release_failed(challenge, action_id)
                                .await
                            {
                                return failed(error);
                            }
                            return Handled::err(
                                ErrorCode::Internal,
                                format!(
                                    "mutationReceiptFailed: {error:#}{}",
                                    rollback.err().unwrap_or_default()
                                ),
                            );
                        }
                        if let Err(error) =
                            state.project_control.complete(challenge, action_id).await
                        {
                            return failed(error);
                        }
                    }
                    Handled::ok(Reply::Workspace(workspace))
                }
                Err(error) => {
                    if let Some((challenge, action_id)) = &reserved {
                        if let Err(error) = state
                            .project_control
                            .release_failed(challenge, action_id)
                            .await
                        {
                            return failed(error);
                        }
                    }
                    Handled::err(ErrorCode::BadRequest, format!("{error:#}"))
                }
            }
        }

        Request::AgentSpaceBuilder {
            workspace_id,
            target_workspace_id,
            space_name,
            operation,
        } => {
            if let Some(session_id) = caller.session_controller_id() {
                if !crate::workflow::exception_authority(state, &workspace_id, session_id).await.unwrap_or(false) {
                    return Handled::err(
                        ErrorCode::Forbidden,
                        "AgentSpaceBuilder 写操作由 Bootstrap transaction、用户界面或异常处置中的项目 PM 调用",
                    );
                }
            }
            if let Err(message) =
                authorize_project_workflow_mutation(state, caller, &workspace_id).await
            {
                return Handled::err(ErrorCode::Forbidden, message);
            }
            if !crate::agent_space_builder::valid_space_name(&space_name) {
                return Handled::err(
                    ErrorCode::BadRequest,
                    "AgentSpace name must be lowercase kebab-case",
                );
            }
            // Builder repairs source/projection drift. Verify project ownership
            // here, not the old projection that this operation must rebuild.
            // Workflow execution/activation still requires project_entry().
            match state.workspaces.project_root(&workspace_id).await {
                Ok(project_id) if project_id == workspace_id => {}
                Ok(_) => {
                    return Handled::err(
                        ErrorCode::Forbidden,
                        "Builder must be called from the project root",
                    )
                }
                Err(error) => return failed(error),
            }
            let project = match state.workspaces.get(&workspace_id).await {
                Ok(project) => project,
                Err(error) => return failed(error),
            };
            let space_root = match target_workspace_id {
                Some(target_workspace_id) => {
                    let target = match state.workspaces.get(&target_workspace_id).await {
                        Ok(target) => target,
                        Err(error) => return failed(error),
                    };
                    if target.root != project.root
                        && !target.root.starts_with(project.root.join("spaces"))
                    {
                        return Handled::err(
                            ErrorCode::Forbidden,
                            "AgentSpaceBuilder target is outside the project boundary",
                        );
                    }
                    target.root
                }
                None => project.root.join("spaces").join(&space_name),
            };
            let (command, require_no_post_commands) = match operation {
                genehub_proto::AgentSpaceBuilderOperation::Init => {
                    (crate::agent_space_builder::Command::Init, true)
                }
                genehub_proto::AgentSpaceBuilderOperation::Check => {
                    (crate::agent_space_builder::Command::Check, true)
                }
                genehub_proto::AgentSpaceBuilderOperation::Explain => {
                    (crate::agent_space_builder::Command::Explain, true)
                }
                genehub_proto::AgentSpaceBuilderOperation::Build {
                    dry_run,
                    require_no_post_commands,
                } => (
                    crate::agent_space_builder::Command::Build { dry_run },
                    require_no_post_commands,
                ),
                genehub_proto::AgentSpaceBuilderOperation::Verify => {
                    (crate::agent_space_builder::Command::Verify, true)
                }
                genehub_proto::AgentSpaceBuilderOperation::Clean => {
                    (crate::agent_space_builder::Command::Clean, true)
                }
            };
            match crate::agent_space_builder::run(
                &project.root,
                &space_root,
                command,
                require_no_post_commands,
            ) {
                Ok(report) => Handled::ok(Reply::AgentSpaceBuilder(report.into())),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error}")),
            }
        }

        Request::ProjectBootstrap {
            workspace_id,
            pack_id,
            apply,
            agent_id,
            model_id,
            plan_digest,
            action_id,
            expected_revision,
        } => {
            if let Err(message) =
                authorize_project_workflow_mutation(state, caller, &workspace_id).await
            {
                return Handled::err(ErrorCode::Forbidden, message);
            }
            let caller_session = match caller.session_controller_id() {
                Some(session_id) => state.sessions.summary(session_id).await.ok(),
                None => None,
            };
            let agent_id = agent_id
                .or_else(|| {
                    caller_session
                        .as_ref()
                        .map(|session| session.agent_id.clone())
                })
                .unwrap_or_else(|| "opencode".into());
            let model_id = model_id.or_else(|| {
                caller_session
                    .as_ref()
                    .and_then(|session| session.model_id.clone())
            });
            if apply {
                if let (Some(session_id), Some(plan_digest), Some(action_id)) = (
                    caller.session_controller_id(),
                    plan_digest.as_deref(),
                    action_id.as_deref(),
                ) {
                    match state
                        .project_control
                        .completed_action::<genehub_proto::BootstrapPackReport>(
                            &workspace_id,
                            session_id,
                            "project.bootstrap.apply",
                            plan_digest,
                            action_id,
                        ) {
                        Ok(Some(report)) => {
                            return Handled::ok(Reply::BootstrapPack(report));
                        }
                        Ok(None) => {}
                        Err(error) => {
                            return Handled::err(ErrorCode::Conflict, format!("{error:#}"));
                        }
                    }
                }
            }
            if !apply {
                match crate::bootstrap_pack::prepare(
                    state,
                    &workspace_id,
                    &pack_id,
                    &agent_id,
                    model_id.as_deref(),
                )
                .await
                {
                    Ok(prepared) => {
                        let mut report = prepared.report();
                        if !report.current {
                            if let Some(session_id) = caller.session_controller_id() {
                                if report.conflict_runs.is_empty() {
                                    report.approval = match state
                                        .project_control
                                        .issue_management(
                                            prepared.challenge_spec(session_id),
                                            &workspace_id,
                                            crate::workflow::exception_authority(state, &workspace_id, session_id).await.unwrap_or(false),
                                        )
                                        .await
                                    {
                                        Ok(approval) => approval,
                                        Err(error) => return failed(error),
                                    };
                                }
                            }
                        }
                        Handled::ok(Reply::BootstrapPack(report))
                    }
                    Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
                }
            } else {
                let _mutation = state.project_control.mutation_lock().await;
                let prepared = match crate::bootstrap_pack::prepare(
                    state,
                    &workspace_id,
                    &pack_id,
                    &agent_id,
                    model_id.as_deref(),
                )
                .await
                {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        return Handled::err(ErrorCode::Conflict, format!("{error:#}"));
                    }
                };
                if prepared.report().current {
                    let session_id = caller.session_controller_id().unwrap_or_default();
                    return match crate::bootstrap_pack::apply(state, prepared, session_id).await {
                        Ok(report) => Handled::ok(Reply::BootstrapPack(report)),
                        Err(error) => failed(error),
                    };
                }
                if !prepared.report().conflict_runs.is_empty() {
                    return Handled::err(ErrorCode::Conflict, format!(
                        "activeRunConflict: cancel or finish these executions before shared Pack changes: {}",
                        prepared.report().conflict_runs.join(", ")));
                }
                let Some(session_id) = caller.session_controller_id() else {
                    return Handled::err(
                        ErrorCode::Forbidden,
                        "approvalRequired: 请在 Agent Session 中生成 plan 并由用户确认",
                    );
                };
                let Some(plan_digest) = plan_digest.as_deref() else {
                    return Handled::err(ErrorCode::BadRequest, "apply requires --plan-digest");
                };
                let Some(action_id) = action_id.as_deref() else {
                    return Handled::err(ErrorCode::BadRequest, "apply requires --action-id");
                };
                let Some(expected_revision) = expected_revision else {
                    return Handled::err(
                        ErrorCode::BadRequest,
                        "apply requires --expected-revision",
                    );
                };
                let current = prepared.report();
                let canonical_root = prepared.canonical_root();
                if current.plan_digest != plan_digest
                    || current.expected_revision != expected_revision
                {
                    return Handled::err(
                        ErrorCode::Conflict,
                        "approvalStale: project facts changed; create and approve a new plan",
                    );
                }
                let challenge = match state
                    .project_control
                    .reserve(
                        session_id,
                        &workspace_id,
                        &canonical_root,
                        "project.bootstrap.apply",
                        &pack_id,
                        &current.pack_digest,
                        plan_digest,
                        expected_revision,
                        current.git.head.as_deref(),
                        &current.git.status_digest,
                        action_id,
                        crate::workflow::exception_authority(state, &state.workspaces.project_root(&workspace_id).await.unwrap_or_else(|_| workspace_id.clone()), session_id).await.unwrap_or(false),
                    )
                    .await
                {
                    Ok(challenge) => challenge,
                    Err(error) => {
                        return Handled::err(ErrorCode::Forbidden, format!("{error:#}"));
                    }
                };
                match crate::bootstrap_pack::apply(state, prepared, session_id).await {
                    Ok(report) => {
                        if let Err(error) = state.project_control.record_completed_action(
                            &workspace_id,
                            session_id,
                            "project.bootstrap.apply",
                            plan_digest,
                            action_id,
                            &report,
                        ) {
                            // The project transaction itself is already
                            // durably complete. Do not lie that it failed;
                            // the durable Pack receipt and exact team facts
                            // still make a repeated apply a no-op. Surface the
                            // degraded action-replay receipt in diagnostics.
                            tracing::error!(
                                workspace = %workspace_id,
                                action_id,
                                %error,
                                "could not persist the completed Bootstrap action receipt"
                            );
                        }
                        if let Err(error) =
                            state.project_control.complete(&challenge, action_id).await
                        {
                            return failed(error);
                        }
                        Handled::ok(Reply::BootstrapPack(report))
                    }
                    Err(error) => {
                        if let Err(error) = state
                            .project_control
                            .release_failed(&challenge, action_id)
                            .await
                        {
                            return failed(error);
                        }
                        Handled::err(ErrorCode::BadRequest, format!("{error:#}"))
                    }
                }
            }
        }

        Request::BootstrapPackList => match crate::bootstrap_pack::list() {
            Ok(packs) => Handled::ok(Reply::BootstrapPacks(packs)),
            Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
        },

        Request::ProjectApprovalRequest { challenge_id } => {
            let Some(session_id) = caller.session_controller_id() else {
                return Handled::err(
                    ErrorCode::Forbidden,
                    "只有生成该计划的 Agent Session 可以请求用户确认",
                );
            };
            let (request, expires_at_ms) = match state
                .project_control
                .request_permission(session_id, &challenge_id)
                .await
            {
                Ok(interaction) => interaction,
                Err(error) => {
                    return Handled::err(ErrorCode::Conflict, format!("{error:#}"));
                }
            };
            match state
                .sessions
                .request_project_approval(session_id, request, expires_at_ms)
                .await
            {
                Ok(()) => Handled::ok(Reply::Ack),
                // Presentation may already be durable even if closing the
                // old Agent failed. Keep its identity for recovery/retry;
                // presenting a challenge never grants authority.
                Err(error) => Handled::err(ErrorCode::Conflict, format!("{error:#}")),
            }
        }

        Request::AgentSpaceChildren { workspace_id } => {
            match state.workspaces.schedulable_children(&workspace_id).await {
                Ok(children) => Handled::ok(Reply::Workspaces(children)),
                Err(error) => Handled::err(ErrorCode::BadRequest, format!("{error:#}")),
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
            let binding_snapshot = match state.project_control.binding_snapshot(&workspace_id) {
                Ok(snapshot) => snapshot,
                Err(error) => return failed(error),
            };
            if let Err(error) = state.project_control.remove_binding(&workspace_id) {
                return failed(error);
            }
            if let Err(error) = state.project_control.revoke_workspace(&workspace_id).await {
                return failed(error);
            }
            match state.workspaces.remove(&workspace_id).await {
                Ok(workspaces) => Handled::ok(Reply::Workspaces(workspaces)),
                Err(error) => {
                    if let Err(restore) = state
                        .project_control
                        .restore_binding_snapshot(&workspace_id, binding_snapshot.as_deref())
                    {
                        return Handled::err(
                            ErrorCode::Internal,
                            format!(
                                "workspaceRemoveRollbackIncomplete: {error:#}; restoring project control binding failed: {restore:#}"
                            ),
                        );
                    }
                    Handled::err(ErrorCode::BadRequest, format!("{error:#}"))
                }
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

        Request::ProcessList => {
            match crate::dataplane::service_preview::process_snapshot(state, caller, None).await {
                Ok(rows) => Handled::ok(Reply::Processes(rows)),
                Err(e) => failed(e),
            }
        }
        Request::ProcessWorkspaceList { workspace_id } => {
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
        }
        Request::ProcessServiceStop {
            workspace_id,
            entry_path,
            run_id,
        } => {
            if !caller.allows(crate::authz::Capability::Services) {
                return Handled::err(ErrorCode::Forbidden, "需要 services 授权");
            }
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
        }
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
        Request::WorkflowInitialize { .. } => Some("workflow.initialize"),
        Request::WorkflowActivate { .. } => Some("workflow.activate"),
        Request::WorkflowDispatch { .. } => Some("workflow.dispatch"),
        Request::WorkflowComplete { .. } => Some("workflow.complete"),
        Request::WorkflowCancel { .. } => Some("workflow.cancel"),
        Request::AgentSpaceBuilder { .. } => Some("agentSpace.builder"),
        Request::AgentSpaceChangePlan { .. } => Some("agentSpace.changePlan"),
        Request::ProjectBootstrap { .. } => Some("project.bootstrap"),
        Request::ProjectApprovalRequest { .. } => Some("project.approval.request"),
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

    fn unregistered_space() -> crate::config::AgentSpaceEntry {
        crate::config::AgentSpaceEntry {
            workspace_id: "w_project".into(),
            parent_workspace_id: None,
            revision: 0,
            lifecycle: "persistent".into(),
            builder_lock_digest: String::new(),
            components: Vec::new(),
            guidance: Vec::new(),
            bootstrap_pack: None,
        }
    }

    #[test]
    fn only_pm_managed_projects_require_a_project_control_binding() {
        let legacy = unregistered_space();
        assert!(!agent_space_requires_project_control(&legacy));

        let pm = crate::agent_space::apply(
            &legacy,
            &genehub_proto::AgentSpaceOperation::SetComponent {
                component_id: crate::agent_space::COMPONENT_PM.into(),
                enabled: true,
                role: None,
            },
        )
        .expect("mounting PM should be valid");
        assert!(agent_space_requires_project_control(&pm));

        let mut packed = legacy;
        packed.bootstrap_pack = Some(crate::config::AgentSpacePackEntry {
            id: "game-delivery-v1".into(),
            version: 1,
            digest: "sha256:pack".into(),
        });
        assert!(agent_space_requires_project_control(&packed));
    }


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
