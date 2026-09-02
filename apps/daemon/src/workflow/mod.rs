//! Project-owned Workflow source and the deliberately small execution kernel.
//!
//! Business stages do not exist here. A project graph names generic capability
//! providers (`agent.session`, `result.publish`), their inputs, evidence gates
//! and outgoing events. Adding a review, approval, branch or PM therefore
//! requires a project node; the daemon never inserts one by convention.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use genehub_proto::{
    ManagedSessionInfo, SessionSummary, SessionUserInteraction, WorkflowCatalogEntryStatus,
    WorkflowNodeRunStatus, WorkflowProjectStatus, WorkflowRunStatus,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::state::Shared;

const SOURCE_DIR: &str = ".genethub/workflow";
const PROJECT_FILE: &str = "project.yaml";
const CATALOG_FILE: &str = "workflows/catalog.yaml";
const MAX_SOURCE_BYTES: u64 = 256 * 1024;
const MAX_NODES: usize = 64;
const DEFAULT_LEASE_SECONDS: u64 = 60 * 60;
const MAX_LEASE_SECONDS: u64 = 24 * 60 * 60;

const PROJECT_SCHEMA: &str = "genehub.workflow.project.v1";
const CATALOG_SCHEMA: &str = "genehub.workflow.catalog.v1";
const DEFINITION_SCHEMA: &str = "genehub.workflow.definition.v1";
const ROLE_SCHEMA: &str = "genehub.workflow.role.v1";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectDefinition {
    schema: String,
    default_workflow: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogDefinition {
    schema: String,
    workflows: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogEntry {
    id: String,
    path: String,
    #[serde(default, rename = "match")]
    matching: Option<WorkflowMatch>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowMatch {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    complexity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDefinition {
    schema: String,
    id: String,
    version: u32,
    entry: String,
    nodes: Vec<NodeDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeDefinition {
    id: String,
    uses: String,
    #[serde(default, rename = "with")]
    inputs: NodeInputs,
    #[serde(default)]
    completion: CompletionDefinition,
    #[serde(default)]
    on: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeInputs {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    write_lease: Option<WriteLeaseDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteLeaseDefinition {
    target_ref: String,
    #[serde(default = "default_lease_seconds")]
    ttl_seconds: u64,
}

fn default_lease_seconds() -> u64 {
    DEFAULT_LEASE_SECONDS
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletionDefinition {
    #[serde(default)]
    all: Vec<EvidenceRequirement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidenceRequirement {
    key: String,
    verify: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoleSnapshot {
    schema: String,
    id: String,
    agent_id: String,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    mode_id: Option<String>,
    #[serde(default)]
    runtime_values: BTreeMap<String, String>,
    #[serde(default)]
    user_interaction: SessionUserInteraction,
    prompt: String,
    #[serde(default)]
    prompt_text: String,
}

#[derive(Debug, Clone)]
struct Bundle {
    digest: String,
    definition: WorkflowDefinition,
    roles: BTreeMap<String, RoleSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRecord {
    id: String,
    workspace_id: String,
    parent_session_id: String,
    workflow_id: String,
    bundle_digest: String,
    task_id: String,
    task_prompt: String,
    status: String,
    revision: u64,
    definition: WorkflowDefinition,
    roles: BTreeMap<String, RoleSnapshot>,
    nodes: BTreeMap<String, NodeRecord>,
    leases: BTreeMap<String, LeaseRecord>,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeRecord {
    uses: String,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default)]
    evidence: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRecord {
    run_id: String,
    node_id: String,
    repository: String,
    target_ref: String,
    base_commit: String,
    expires_at_ms: i64,
}

pub struct Transition {
    pub status: WorkflowRunStatus,
    pub sessions: Vec<(SessionSummary, String)>,
}

/// Chinese root-controller contract for any ordinary Agent. It is a thin
/// capability guide, not a PM personality and not a new Session kind.
pub fn root_session_guidance(cwd: &Path) -> Option<String> {
    let source = find_source_root(cwd);
    let location = source
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| format!("{SOURCE_DIR}/（尚未初始化）"));
    Some(format!(
        "<genehub_workflow_controller>\n\
你仍是当前目录的普通对话 Agent，不是独立的 PM 产品入口。先理解用户目标，再按两个互不替代的维度判断：\
业务问题或工作流改进；简单任务或复杂任务。项目流程源位于 `{location}`。\n\
需要查看项目可用流程时，使用环境变量 `GENEHUB_CLI` 指向的绝对命令运行 `workflow inspect`；\
只有用户明确要建立项目方法且目录尚未初始化时才运行 `workflow init`。简单任务优先选择项目的直达流程；\
派发时用 `--kind` 和 `--complexity` 明确给出两个维度，让项目 catalog 选择流程；\
不得自行补上项目图中没有声明的 PM、评审、分支、合并或用户批准节点。\n\
通过 `workflow dispatch` 创建的子会话仍是普通 Workspace/Session，只是带父子关系与用户只读策略。\n\
</genehub_workflow_controller>"
    ))
}

pub fn initialize_project(root: &Path, agent_id: &str, model_id: Option<&str>) -> Result<PathBuf> {
    let root = root
        .canonicalize()
        .with_context(|| format!("目录不存在：{}", root.display()))?;
    if !root.is_dir() {
        bail!("{} 不是目录", root.display());
    }
    let home = root.join(".genethub");
    let source = home.join("workflow");
    ensure_directory_tree(&root, Path::new(".genethub/workflow/workflows"))?;
    ensure_directory_tree(&root, Path::new(".genethub/workflow/roles"))?;
    ensure_directory_tree(&root, Path::new(".genethub/workflow/prompts"))?;
    ensure_source_visible(&home)?;

    write_new_or_same(
        &source.join(PROJECT_FILE),
        format!("schema: {PROJECT_SCHEMA}\ndefaultWorkflow: direct-change\n").as_bytes(),
    )?;
    write_new_or_same(
        &source.join(CATALOG_FILE),
        format!(
            "schema: {CATALOG_SCHEMA}\nworkflows:\n  - id: direct-change\n    path: direct-change.yaml\n    match:\n      kind: business\n      complexity: simple\n"
        )
        .as_bytes(),
    )?;
    write_new_or_same(
        &source.join("workflows/direct-change.yaml"),
        format!(
            "schema: {DEFINITION_SCHEMA}\nid: direct-change\nversion: 1\nentry: implement\nnodes:\n  - id: implement\n    uses: agent.session\n    with:\n      role: worker\n      workspace: .\n      writeLease:\n        targetRef: current\n        ttlSeconds: 3600\n    completion:\n      all:\n        - key: commit\n          verify: git.commitOnTarget\n        - key: checks\n          verify: value.nonEmpty\n    on:\n      completed: [publish]\n  - id: publish\n    uses: result.publish\n"
        )
        .as_bytes(),
    )?;
    let model = model_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("modelId: {value}\n"))
        .unwrap_or_default();
    write_new_or_same(
        &source.join("roles/worker.yaml"),
        format!(
            "schema: {ROLE_SCHEMA}\nid: worker\nagentId: {agent_id}\n{model}userInteraction: readOnly\nprompt: prompts/direct-worker.md\n"
        )
        .as_bytes(),
    )?;
    write_new_or_same(
        &source.join("prompts/direct-worker.md"),
        "你是当前项目直达流程中的实现 Worker。只处理根会话交付的精确目标，不扩大范围，不替用户改变流程。\n\
先核对仓库与目标 ref，再完成实现和项目要求的检查。只有真实提交已经位于租约目标 ref、检查已经实际执行后，\
才可按系统合同上报证据；不得编造 commit、测试或检查结果。\n"
            .as_bytes(),
    )?;
    Ok(source)
}

pub fn inspect(root: &Path) -> Result<WorkflowProjectStatus> {
    let source = source_root(root)?;
    let (project, catalog, _) = load_project_files(&source)?;
    if !catalog
        .workflows
        .iter()
        .any(|entry| entry.id == project.default_workflow)
    {
        bail!(
            "defaultWorkflow {} 不在 catalog 中",
            project.default_workflow
        );
    }
    let mut workflows = Vec::new();
    for entry in &catalog.workflows {
        let bundle = load_bundle_from(&source, entry)?;
        workflows.push(WorkflowCatalogEntryStatus {
            id: entry.id.clone(),
            path: entry.path.clone(),
            digest: bundle.digest,
            match_kind: entry.matching.as_ref().and_then(|value| value.kind.clone()),
            match_complexity: entry
                .matching
                .as_ref()
                .and_then(|value| value.complexity.clone()),
        });
    }
    Ok(WorkflowProjectStatus {
        schema: project.schema,
        root: source.display().to_string(),
        default_workflow: project.default_workflow,
        workflows,
    })
}

pub async fn dispatch(
    state: &Shared,
    root_workspace_id: &str,
    parent_session_id: &str,
    workflow_id: &str,
    task_id: &str,
    task_prompt: &str,
) -> Result<Transition> {
    validate_id(task_id, "taskId")?;
    let parent = state.sessions.summary(parent_session_id).await?;
    if parent.workspace_id != root_workspace_id {
        bail!("根会话不属于请求的 Workspace");
    }
    if parent.managed.is_some() {
        bail!("受管子会话不能派发新的 Workflow；请回到根普通会话操作");
    }
    let workspace = state.workspaces.get(root_workspace_id).await?;
    let source = source_root(&workspace.root)?;
    let (_, catalog, _) = load_project_files(&source)?;
    let entry = catalog
        .workflows
        .iter()
        .find(|entry| entry.id == workflow_id)
        .ok_or_else(|| anyhow!("Workflow 不存在：{workflow_id}"))?;
    let bundle = load_bundle_from(&source, entry)?;
    let now = now_ms();
    let run_id = format!("wr_{}", uuid::Uuid::new_v4().simple());
    let mut run = RunRecord {
        id: run_id.clone(),
        workspace_id: root_workspace_id.to_string(),
        parent_session_id: parent_session_id.to_string(),
        workflow_id: workflow_id.to_string(),
        bundle_digest: bundle.digest,
        task_id: task_id.to_string(),
        task_prompt: task_prompt.to_string(),
        status: "running".into(),
        revision: 0,
        definition: bundle.definition,
        roles: bundle.roles,
        nodes: BTreeMap::new(),
        leases: BTreeMap::new(),
        created_at_ms: now,
        updated_at_ms: now,
    };
    for node in &run.definition.nodes {
        run.nodes.insert(
            node.id.clone(),
            NodeRecord {
                uses: node.uses.clone(),
                status: "pending".into(),
                session_id: None,
                evidence: BTreeMap::new(),
            },
        );
    }
    let entry = run.definition.entry.clone();
    let sessions = activate(state, &workspace.root, &mut run, vec![entry]).await?;
    settle_if_terminal(&mut run);
    run.revision = 1;
    run.updated_at_ms = now_ms();
    save_run(&workspace.root, &run)?;
    if run.status == "completed" {
        release_leases(&workspace.root, &run)?;
    }
    Ok(Transition {
        status: run_status(&run),
        sessions,
    })
}

/// Fails a Run whose freshly-created managed Sessions could not be started.
/// The Run is durable before its first prompt is sent so a very fast Worker
/// can report evidence safely; this is the compensating transition for the
/// narrow window between those two operations.
pub async fn abort_launch(state: &Shared, root_workspace_id: &str, run_id: &str) -> Result<()> {
    let workspace = state.workspaces.get(root_workspace_id).await?;
    let _lock = lock_run(&workspace.root, run_id)?;
    let mut run = load_run(&workspace.root, run_id)?;
    if run.workspace_id != root_workspace_id {
        bail!("Workflow Run 不属于请求的 Workspace");
    }
    if run.status != "running" {
        return Ok(());
    }
    let session_ids = run
        .nodes
        .values()
        .filter_map(|node| node.session_id.clone())
        .collect::<Vec<_>>();
    for node in run.nodes.values_mut() {
        match node.status.as_str() {
            "running" => node.status = "failed".into(),
            "pending" => node.status = "unreached".into(),
            _ => {}
        }
    }
    run.status = "failed".into();
    run.revision = run.revision.saturating_add(1);
    run.updated_at_ms = now_ms();
    save_run(&workspace.root, &run)?;

    let mut cleanup_errors = Vec::new();
    if let Err(error) = release_leases(&workspace.root, &run) {
        cleanup_errors.push(format!("释放 Workflow Run 租约：{error:#}"));
    }
    for session_id in session_ids {
        if let Err(error) = state.sessions.delete(&session_id).await {
            cleanup_errors.push(format!("删除受管 Session {session_id}：{error:#}"));
        }
    }
    if !cleanup_errors.is_empty() {
        bail!(cleanup_errors.join("；"));
    }
    Ok(())
}

pub fn get(root: &Path, run_id: &str) -> Result<WorkflowRunStatus> {
    validate_id(run_id, "runId")?;
    Ok(run_status(&load_run(root, run_id)?))
}

pub async fn complete(
    state: &Shared,
    root_workspace_id: &str,
    caller_session_id: &str,
    run_id: &str,
    node_id: &str,
    expected_revision: u64,
    evidence: BTreeMap<String, String>,
) -> Result<Transition> {
    validate_id(run_id, "runId")?;
    validate_id(node_id, "nodeId")?;
    let workspace = state.workspaces.get(root_workspace_id).await?;
    let _lock = lock_run(&workspace.root, run_id)?;
    let mut run = load_run(&workspace.root, run_id)?;
    if run.workspace_id != root_workspace_id {
        bail!("Workflow Run 不属于请求的 Workspace");
    }
    if run.revision != expected_revision {
        bail!(
            "Workflow revision 冲突：当前为 {}，请求为 {}；先重新读取 workflow get",
            run.revision,
            expected_revision
        );
    }
    if run.status != "running" {
        bail!("Workflow Run 当前为 {}，不能再次完成节点", run.status);
    }
    let node = run
        .definition
        .nodes
        .iter()
        .find(|node| node.id == node_id)
        .cloned()
        .ok_or_else(|| anyhow!("Workflow 节点不存在：{node_id}"))?;
    let record = run
        .nodes
        .get(node_id)
        .ok_or_else(|| anyhow!("Workflow 节点状态不存在：{node_id}"))?;
    if record.status != "running" || record.session_id.as_deref() != Some(caller_session_id) {
        bail!("当前 Session 不是节点 {node_id} 的执行者");
    }
    verify_evidence(&workspace.root, &run, &node, &evidence).await?;
    let record = run.nodes.get_mut(node_id).expect("validated node record");
    record.status = "completed".into();
    record.evidence = evidence;
    let targets = node.on.get("completed").cloned().unwrap_or_default();
    let sessions = activate(state, &workspace.root, &mut run, targets).await?;
    settle_if_terminal(&mut run);
    run.revision = run.revision.saturating_add(1);
    run.updated_at_ms = now_ms();
    save_run(&workspace.root, &run)?;
    if run.status == "completed" {
        release_leases(&workspace.root, &run)?;
    }
    Ok(Transition {
        status: run_status(&run),
        sessions,
    })
}

async fn activate(
    state: &Shared,
    project_root: &Path,
    run: &mut RunRecord,
    initial: Vec<String>,
) -> Result<Vec<(SessionSummary, String)>> {
    let nodes_before = run.nodes.clone();
    let leases_before = run.leases.clone();
    let mut queue: VecDeque<String> = initial.into();
    let mut sessions = Vec::new();
    let result: Result<()> = async {
        while let Some(node_id) = queue.pop_front() {
            let node = run
                .definition
                .nodes
                .iter()
                .find(|node| node.id == node_id)
                .cloned()
                .ok_or_else(|| anyhow!("Workflow 节点不存在：{node_id}"))?;
            let current = run
                .nodes
                .get(&node_id)
                .map(|node| node.status.as_str())
                .unwrap_or("missing");
            if current != "pending" {
                continue;
            }
            match node.uses.as_str() {
                "result.publish" => {
                    run.nodes.get_mut(&node_id).expect("validated node").status =
                        "completed".into();
                    queue.extend(node.on.get("completed").cloned().unwrap_or_default());
                }
                "agent.session" => {
                    let role_id = node
                        .inputs
                        .role
                        .as_deref()
                        .ok_or_else(|| anyhow!("节点 {} 缺少 with.role", node.id))?;
                    let role = run
                        .roles
                        .get(role_id)
                        .cloned()
                        .ok_or_else(|| anyhow!("角色不存在：{role_id}"))?;
                    let (workspace_id, cwd) = execution_workspace(
                        state,
                        &run.workspace_id,
                        project_root,
                        node.inputs.workspace.as_deref(),
                    )
                    .await?;
                    if let Some(policy) = &node.inputs.write_lease {
                        let lease =
                            acquire_lease(project_root, &cwd, &run.id, &node.id, policy).await?;
                        run.leases.insert(node.id.clone(), lease);
                    }
                    let managed = ManagedSessionInfo {
                        parent_session_id: run.parent_session_id.clone(),
                        workflow_run_id: run.id.clone(),
                        workflow_id: run.workflow_id.clone(),
                        node_id: node.id.clone(),
                        role: role.id.clone(),
                        user_interaction: role.user_interaction,
                    };
                    let system_prompt = managed_prompt(run, &node, &role);
                    let summary = state
                        .sessions
                        .create_managed(
                            &workspace_id,
                            cwd,
                            &role.agent_id,
                            role.model_id.clone(),
                            role.mode_id.clone(),
                            role.runtime_values.clone(),
                            Some(format!("{} · {}", run.task_id, role.id)),
                            managed,
                            system_prompt,
                        )
                        .await?;
                    let record = run.nodes.get_mut(&node.id).expect("validated node");
                    record.status = "running".into();
                    record.session_id = Some(summary.id.clone());
                    sessions.push((summary, task_message(run, &node)));
                }
                other => bail!("未注册的 Workflow capability：{other}"),
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let new_leases = run
            .leases
            .iter()
            .filter(|(node_id, _)| !leases_before.contains_key(*node_id))
            .map(|(_, lease)| lease.clone())
            .collect::<Vec<_>>();
        let mut cleanup_errors = Vec::new();
        for (session, _) in &sessions {
            if let Err(cleanup) = state.sessions.delete(&session.id).await {
                cleanup_errors.push(format!("删除受管 Session {}：{cleanup:#}", session.id));
            }
        }
        for lease in &new_leases {
            if let Err(cleanup) = release_lease(project_root, lease) {
                cleanup_errors.push(format!("释放目标 ref 租约：{cleanup:#}"));
            }
        }
        run.nodes = nodes_before;
        run.leases = leases_before;
        if cleanup_errors.is_empty() {
            return Err(error);
        }
        bail!("{error:#}；激活回滚失败：{}", cleanup_errors.join("；"));
    }
    Ok(sessions)
}

async fn execution_workspace(
    state: &Shared,
    root_workspace_id: &str,
    project_root: &Path,
    configured: Option<&str>,
) -> Result<(String, PathBuf)> {
    let configured = configured.unwrap_or(".").trim();
    if configured.is_empty() || configured == "." {
        return Ok((
            root_workspace_id.to_string(),
            project_root
                .canonicalize()
                .with_context(|| format!("读取项目根目录：{}", project_root.display()))?,
        ));
    }
    let path = existing_relative_within(project_root, configured, "角色 Workspace")?;
    if !path.is_dir() {
        bail!("角色 Workspace 不是目录：{}", path.display());
    }
    let workspace = state.workspaces.open(&path, None).await?;
    Ok((workspace.id, path))
}

fn managed_prompt(run: &RunRecord, node: &NodeDefinition, role: &RoleSnapshot) -> String {
    let evidence = node
        .completion
        .all
        .iter()
        .map(|requirement| format!("`{}`（{}）", requirement.key, requirement.verify))
        .collect::<Vec<_>>()
        .join("、");
    format!(
        "{}\n\n<genehub_managed_session>\n\
你正在普通 Session 中执行项目 Workflow `{}` 的节点 `{}`，角色标签为 `{}`。本会话由根会话委托，\
对用户界面只读；不要把技术执行转回根会话。节点完成标准来自项目配置，需要证据：{}。\n\
完成后先运行 `\"$GENEHUB_CLI\" workflow get` 读取本受管会话绑定的最新 revision，\
再运行 `\"$GENEHUB_CLI\" workflow complete --revision <revision> --evidence <key=value>`，为每个要求的 key 各传一次。\
只上报真实证据；缺少证据时继续执行或明确失败。\n\
</genehub_managed_session>",
        role.prompt_text,
        run.workflow_id,
        node.id,
        role.id,
        if evidence.is_empty() { "无额外证据" } else { &evidence },
    )
}

fn task_message(run: &RunRecord, node: &NodeDefinition) -> String {
    format!(
        "任务 ID：{}\nWorkflow：{}\n当前节点：{}\n\n用户目标：\n{}",
        run.task_id, run.workflow_id, node.id, run.task_prompt
    )
}

fn settle_if_terminal(run: &mut RunRecord) {
    if !run.nodes.values().any(|node| node.status == "running")
        && run
            .nodes
            .values()
            .all(|node| node.status == "completed" || node.status == "unreached")
    {
        run.status = "completed".into();
    }
}

async fn verify_evidence(
    project_root: &Path,
    run: &RunRecord,
    node: &NodeDefinition,
    evidence: &BTreeMap<String, String>,
) -> Result<()> {
    let expected: BTreeSet<&str> = node
        .completion
        .all
        .iter()
        .map(|requirement| requirement.key.as_str())
        .collect();
    let supplied: BTreeSet<&str> = evidence.keys().map(String::as_str).collect();
    if expected != supplied {
        bail!(
            "节点 {} 的证据键不匹配：需要 {:?}，收到 {:?}",
            node.id,
            expected,
            supplied
        );
    }
    for requirement in &node.completion.all {
        let value = evidence
            .get(&requirement.key)
            .expect("key sets were compared")
            .trim();
        match requirement.verify.as_str() {
            "value.nonEmpty" => {
                if value.is_empty() {
                    bail!("证据 {} 不能为空", requirement.key);
                }
            }
            "git.commitOnTarget" => {
                let lease = run
                    .leases
                    .get(&node.id)
                    .ok_or_else(|| anyhow!("节点 {} 没有目标 ref 租约", node.id))?;
                let repository = Path::new(&lease.repository);
                if !repository.starts_with(project_root) && repository != project_root {
                    bail!("租约仓库不属于当前项目");
                }
                let current = crate::git::resolve_ref(repository, &lease.target_ref).await?;
                if current != value {
                    bail!(
                        "commit 证据不是租约目标 {} 的当前提交：目标为 {}，收到 {}",
                        lease.target_ref,
                        current,
                        value
                    );
                }
                if current == lease.base_commit {
                    bail!("目标 ref 没有产生新提交");
                }
                if !crate::git::is_ancestor(repository, &lease.base_commit, &current).await? {
                    bail!("目标 ref 的新提交不是租约基线的后继");
                }
            }
            other => bail!("未注册的 evidence verifier：{other}"),
        }
    }
    Ok(())
}

async fn acquire_lease(
    project_root: &Path,
    repository: &Path,
    run_id: &str,
    node_id: &str,
    policy: &WriteLeaseDefinition,
) -> Result<LeaseRecord> {
    if policy.ttl_seconds == 0 || policy.ttl_seconds > MAX_LEASE_SECONDS {
        bail!("writeLease.ttlSeconds 必须在 1..={MAX_LEASE_SECONDS} 之间");
    }
    let status = crate::git::status(repository).await?;
    if !status.clean {
        bail!("目标 Workspace 工作区不干净，不能取得直接写入租约");
    }
    let target_ref = if policy.target_ref == "current" {
        crate::git::current_ref(repository).await?
    } else {
        policy.target_ref.clone()
    };
    if !target_ref.starts_with("refs/heads/") {
        bail!("直接写入租约只接受本地分支 ref：{target_ref}");
    }
    let base_commit = crate::git::resolve_ref(repository, &target_ref).await?;
    let key = hex_digest(format!("{}\0{target_ref}", repository.display()).as_bytes());
    let directory = runtime_root(project_root).join("ref-leases");
    fs::create_dir_all(&directory)?;
    let guard_path = directory.join(format!("{key}.guard"));
    let guard = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&guard_path)?;
    crate::fs_lock::try_lock_exclusive(&guard, &guard_path)
        .context("目标 ref 租约正在被另一个请求修改")?;
    let path = directory.join(format!("{key}.json"));
    if path.exists() {
        let existing: LeaseRecord = serde_json::from_slice(&fs::read(&path)?)?;
        if existing.expires_at_ms > now_ms() {
            bail!(
                "目标 ref {} 已由 Workflow Run {} 的节点 {} 独占",
                existing.target_ref,
                existing.run_id,
                existing.node_id
            );
        }
        fs::remove_file(&path)?;
    }
    let record = LeaseRecord {
        run_id: run_id.to_string(),
        node_id: node_id.to_string(),
        repository: repository.display().to_string(),
        target_ref,
        base_commit,
        expires_at_ms: now_ms().saturating_add(
            i64::try_from(policy.ttl_seconds.saturating_mul(1000)).unwrap_or(i64::MAX),
        ),
    };
    crate::config::save_private(&path, &serde_json::to_vec_pretty(&record)?)?;
    Ok(record)
}

fn release_leases(project_root: &Path, run: &RunRecord) -> Result<()> {
    for lease in run.leases.values() {
        release_lease(project_root, lease)?;
    }
    Ok(())
}

fn release_lease(project_root: &Path, lease: &LeaseRecord) -> Result<()> {
    let directory = runtime_root(project_root).join("ref-leases");
    let key = hex_digest(format!("{}\0{}", lease.repository, lease.target_ref).as_bytes());
    let path = directory.join(format!("{key}.json"));
    if !path.exists() {
        return Ok(());
    }
    let current: LeaseRecord = serde_json::from_slice(&fs::read(&path)?)?;
    if current.run_id == lease.run_id && current.node_id == lease.node_id {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn load_project_files(
    source: &Path,
) -> Result<(ProjectDefinition, CatalogDefinition, Vec<(String, Vec<u8>)>)> {
    let project_path = existing_relative_within(source, PROJECT_FILE, "项目 Workflow 配置")?;
    let catalog_path = existing_relative_within(source, CATALOG_FILE, "Workflow catalog")?;
    let project_bytes = read_source(&project_path)?;
    let catalog_bytes = read_source(&catalog_path)?;
    let project: ProjectDefinition =
        serde_yaml::from_slice(&project_bytes).context("解析 .genethub/workflow/project.yaml")?;
    let catalog: CatalogDefinition = serde_yaml::from_slice(&catalog_bytes)
        .context("解析 .genethub/workflow/workflows/catalog.yaml")?;
    if project.schema != PROJECT_SCHEMA {
        bail!("不支持的 project schema：{}", project.schema);
    }
    if catalog.schema != CATALOG_SCHEMA {
        bail!("不支持的 catalog schema：{}", catalog.schema);
    }
    validate_id(&project.default_workflow, "defaultWorkflow")?;
    let mut ids = BTreeSet::new();
    for entry in &catalog.workflows {
        validate_id(&entry.id, "workflow id")?;
        if !ids.insert(entry.id.clone()) {
            bail!("catalog 中存在重复 Workflow：{}", entry.id);
        }
    }
    Ok((
        project,
        catalog,
        vec![
            (PROJECT_FILE.into(), project_bytes),
            (CATALOG_FILE.into(), catalog_bytes),
        ],
    ))
}

fn load_bundle_from(source: &Path, entry: &CatalogEntry) -> Result<Bundle> {
    let (_, _, mut digest_files) = load_project_files(source)?;
    let workflow_relative = format!("workflows/{}", entry.path);
    let workflow_path = existing_relative_within(source, &workflow_relative, "Workflow 定义")?;
    let workflow_bytes = read_source(&workflow_path)?;
    let definition: WorkflowDefinition = serde_yaml::from_slice(&workflow_bytes)
        .with_context(|| format!("解析 Workflow {}", entry.id))?;
    if definition.schema != DEFINITION_SCHEMA {
        bail!("不支持的 Workflow schema：{}", definition.schema);
    }
    if definition.id != entry.id {
        bail!(
            "catalog Workflow {} 与定义 id {} 不一致",
            entry.id,
            definition.id
        );
    }
    validate_definition(&definition)?;
    digest_files.push((workflow_relative, workflow_bytes));

    let mut roles = BTreeMap::new();
    for role_id in definition
        .nodes
        .iter()
        .filter_map(|node| node.inputs.role.as_ref())
    {
        if roles.contains_key(role_id) {
            continue;
        }
        validate_id(role_id, "role id")?;
        let relative = format!("roles/{role_id}.yaml");
        let role_bytes = read_source(&existing_relative_within(source, &relative, "角色定义")?)?;
        let mut role: RoleSnapshot =
            serde_yaml::from_slice(&role_bytes).with_context(|| format!("解析角色 {role_id}"))?;
        if role.schema != ROLE_SCHEMA || role.id != *role_id {
            bail!("角色文件 {relative} 的 schema 或 id 不匹配");
        }
        let prompt_bytes = read_source(&existing_relative_within(
            source,
            &role.prompt,
            "角色 Prompt",
        )?)?;
        role.prompt_text = String::from_utf8(prompt_bytes.clone())
            .with_context(|| format!("角色 Prompt 不是 UTF-8：{}", role.prompt))?;
        digest_files.push((relative, role_bytes));
        digest_files.push((role.prompt.clone(), prompt_bytes));
        roles.insert(role_id.clone(), role);
    }
    digest_files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (path, bytes) in digest_files {
        digest.update((path.len() as u64).to_le_bytes());
        digest.update(path.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    Ok(Bundle {
        digest: format!("sha256:{:x}", digest.finalize()),
        definition,
        roles,
    })
}

fn validate_definition(definition: &WorkflowDefinition) -> Result<()> {
    validate_id(&definition.id, "workflow id")?;
    if definition.version == 0 {
        bail!("Workflow version 必须大于 0");
    }
    if definition.nodes.is_empty() || definition.nodes.len() > MAX_NODES {
        bail!("Workflow 节点数必须在 1..={MAX_NODES} 之间");
    }
    let mut ids = BTreeSet::new();
    let mut incoming = BTreeMap::<String, usize>::new();
    for node in &definition.nodes {
        validate_id(&node.id, "node id")?;
        if !ids.insert(node.id.clone()) {
            bail!("Workflow 存在重复节点：{}", node.id);
        }
        if !matches!(node.uses.as_str(), "agent.session" | "result.publish") {
            bail!("未注册的 Workflow capability：{}", node.uses);
        }
        if node.uses == "agent.session" && node.inputs.role.is_none() {
            bail!("agent.session 节点 {} 必须声明 with.role", node.id);
        }
        if node.uses == "result.publish"
            && (node.inputs.role.is_some()
                || node.inputs.workspace.is_some()
                || node.inputs.write_lease.is_some())
        {
            bail!("result.publish 节点 {} 不能声明 with 输入", node.id);
        }
        if node.uses == "result.publish" && !node.completion.all.is_empty() {
            bail!(
                "result.publish 节点 {} 会立即发布，不能声明 completion 证据",
                node.id
            );
        }
        let mut evidence = BTreeSet::new();
        for requirement in &node.completion.all {
            validate_id(&requirement.key, "evidence key")?;
            if !evidence.insert(requirement.key.clone()) {
                bail!(
                    "节点 {} 存在重复 evidence key：{}",
                    node.id,
                    requirement.key
                );
            }
            if !matches!(
                requirement.verify.as_str(),
                "value.nonEmpty" | "git.commitOnTarget"
            ) {
                bail!("未注册的 evidence verifier：{}", requirement.verify);
            }
            if requirement.verify == "git.commitOnTarget" && node.inputs.write_lease.is_none() {
                bail!(
                    "节点 {} 使用 git.commitOnTarget，但没有声明 with.writeLease",
                    node.id
                );
            }
        }
        for (event, targets) in &node.on {
            if event != "completed" {
                bail!("当前内核尚未注册节点事件：{event}");
            }
            for target in targets {
                *incoming.entry(target.clone()).or_default() += 1;
            }
        }
    }
    if !ids.contains(&definition.entry) {
        bail!("Workflow entry 不存在：{}", definition.entry);
    }
    for node in &definition.nodes {
        for targets in node.on.values() {
            for target in targets {
                if !ids.contains(target) {
                    bail!("节点 {} 指向不存在的节点 {target}", node.id);
                }
            }
        }
    }
    if let Some((node, _)) = incoming.iter().find(|(_, count)| **count > 1) {
        bail!("V1 暂不支持 join；节点 {node} 有多个入边");
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    visit(&definition.entry, definition, &mut visiting, &mut visited)?;
    if visited.len() != definition.nodes.len() {
        let unreachable = ids.difference(&visited).cloned().collect::<Vec<_>>();
        bail!("Workflow 存在从 entry 不可达的节点：{unreachable:?}");
    }
    Ok(())
}

fn visit(
    id: &str,
    definition: &WorkflowDefinition,
    visiting: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
) -> Result<()> {
    if visited.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id.to_string()) {
        bail!("Workflow 存在环：{id}");
    }
    let node = definition
        .nodes
        .iter()
        .find(|node| node.id == id)
        .expect("targets validated after ids");
    for target in node.on.values().flatten() {
        visit(target, definition, visiting, visited)?;
    }
    visiting.remove(id);
    visited.insert(id.to_string());
    Ok(())
}

fn source_root(root: &Path) -> Result<PathBuf> {
    let root = root
        .canonicalize()
        .with_context(|| format!("读取项目根目录：{}", root.display()))?;
    let candidate = root.join(SOURCE_DIR);
    if !candidate.join(PROJECT_FILE).is_file() {
        bail!(
            "项目尚未初始化 Workflow：缺少 {}",
            candidate.join(PROJECT_FILE).display()
        );
    }
    let source = candidate
        .canonicalize()
        .with_context(|| format!("读取 Workflow 源：{}", candidate.display()))?;
    if !source.starts_with(&root) {
        bail!("Workflow 源越出项目根目录：{}", source.display());
    }
    Ok(source)
}

fn find_source_root(cwd: &Path) -> Option<PathBuf> {
    let cwd = cwd.canonicalize().ok()?;
    cwd.ancestors()
        .map(|ancestor| ancestor.join(SOURCE_DIR))
        .find(|candidate| candidate.join(PROJECT_FILE).is_file())
}

fn safe_relative(base: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        bail!("Workflow 路径必须是项目内相对路径：{}", relative.display());
    }
    Ok(base.join(relative))
}

fn existing_relative_within(base: &Path, relative: &str, label: &str) -> Result<PathBuf> {
    let base = base
        .canonicalize()
        .with_context(|| format!("读取 {label} 根目录：{}", base.display()))?;
    let candidate = safe_relative(&base, relative)?;
    let resolved = candidate
        .canonicalize()
        .with_context(|| format!("{label} 不存在：{}", candidate.display()))?;
    if !resolved.starts_with(&base) {
        bail!("{label} 越出允许目录：{}", resolved.display());
    }
    Ok(resolved)
}

fn ensure_directory_tree(root: &Path, relative: &Path) -> Result<PathBuf> {
    let root = root
        .canonicalize()
        .with_context(|| format!("读取项目根目录：{}", root.display()))?;
    let mut current = root.clone();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            bail!("项目目录必须使用普通相对路径：{}", relative.display());
        };
        current.push(component);
        match crate::config::sensitive_metadata(&current) {
            Ok(metadata) => {
                crate::config::reject_link_or_reparse(&current, &metadata)?;
                if !metadata.is_dir() {
                    bail!("项目目录路径不是目录：{}", current.display());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .with_context(|| format!("创建项目目录：{}", current.display()))?;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("检查项目目录：{}", current.display()))
            }
        }
    }
    Ok(current)
}

fn read_source(path: &Path) -> Result<Vec<u8>> {
    let metadata =
        fs::metadata(path).with_context(|| format!("缺少 Workflow 源：{}", path.display()))?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
        bail!(
            "Workflow 源必须是小于 {MAX_SOURCE_BYTES} 字节的普通文件：{}",
            path.display()
        );
    }
    fs::read(path).with_context(|| format!("读取 Workflow 源：{}", path.display()))
}

fn ensure_source_visible(home: &Path) -> Result<()> {
    let path = home.join(".gitignore");
    match crate::config::sensitive_metadata(&path) {
        Ok(metadata) => {
            crate::config::reject_link_or_reparse(&path, &metadata)?;
            if !metadata.is_file() {
                bail!(".genethub/.gitignore 不是普通文件：{}", path.display());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("检查 .genethub/.gitignore"),
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut lines = existing.lines().map(str::to_string).collect::<Vec<_>>();
    for required in ["*", "!.gitignore", "!workflow/", "!workflow/**"] {
        if !lines.iter().any(|line| line.trim() == required) {
            lines.push(required.into());
        }
    }
    let mut body = lines.join("\n");
    body.push('\n');
    fs::write(path, body)?;
    Ok(())
}

fn write_new_or_same(path: &Path, body: &[u8]) -> Result<()> {
    match crate::config::sensitive_metadata(path) {
        Ok(metadata) => {
            crate::config::reject_link_or_reparse(path, &metadata)?;
            if !metadata.is_file() {
                bail!("项目 Workflow 源不是普通文件：{}", path.display());
            }
            let existing = fs::read(path)?;
            if existing == body {
                return Ok(());
            }
            bail!("拒绝覆盖已有项目 Workflow 源：{}", path.display());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("检查 Workflow 源：{}", path.display()))
        }
    }
    let parent = path.parent().expect("template file has a parent");
    fs::create_dir_all(parent)?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    let mut file = options.open(path)?;
    file.write_all(body)?;
    file.sync_all()?;
    Ok(())
}

fn validate_id(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("{label} 只能包含字母、数字、点、下划线和连字符，且不超过 96 字符");
    }
    Ok(())
}

fn runtime_root(project_root: &Path) -> PathBuf {
    project_root.join(".genethub/runtime/workflows")
}

fn run_path(project_root: &Path, run_id: &str) -> PathBuf {
    runtime_root(project_root)
        .join("runs")
        .join(format!("{run_id}.json"))
}

fn save_run(project_root: &Path, run: &RunRecord) -> Result<()> {
    let path = run_path(project_root, &run.id);
    crate::config::save_private(&path, &serde_json::to_vec_pretty(run)?)
}

fn load_run(project_root: &Path, run_id: &str) -> Result<RunRecord> {
    let path = run_path(project_root, run_id);
    serde_json::from_slice(
        &fs::read(&path).with_context(|| format!("Workflow Run 不存在：{run_id}"))?,
    )
    .with_context(|| format!("读取 Workflow Run：{}", path.display()))
}

fn lock_run(project_root: &Path, run_id: &str) -> Result<File> {
    let path = runtime_root(project_root)
        .join("locks")
        .join(format!("{run_id}.lock"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&path)?;
    crate::fs_lock::try_lock_exclusive(&file, &path).context("Workflow Run 正由另一个请求修改")?;
    Ok(file)
}

fn run_status(run: &RunRecord) -> WorkflowRunStatus {
    WorkflowRunStatus {
        id: run.id.clone(),
        workspace_id: run.workspace_id.clone(),
        parent_session_id: run.parent_session_id.clone(),
        workflow_id: run.workflow_id.clone(),
        bundle_digest: run.bundle_digest.clone(),
        task_id: run.task_id.clone(),
        status: run.status.clone(),
        revision: run.revision,
        active_nodes: run
            .nodes
            .iter()
            .filter(|(_, node)| node.status == "running")
            .map(|(id, _)| id.clone())
            .collect(),
        nodes: run
            .nodes
            .iter()
            .map(|(id, node)| WorkflowNodeRunStatus {
                id: id.clone(),
                uses: node.uses.clone(),
                status: node.status.clone(),
                session_id: node.session_id.clone(),
                evidence: node.evidence.clone(),
            })
            .collect(),
        created_at_ms: run.created_at_ms,
        updated_at_ms: run.updated_at_ms,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_initializer_uses_the_single_genethub_workflow_source() {
        let root = tempfile::tempdir().unwrap();
        let source = initialize_project(
            root.path(),
            "opencode",
            Some("bailian-token-plan-personal/qwen3.8-flash"),
        )
        .unwrap();
        assert_eq!(source, root.path().join(".genethub/workflow"));
        assert!(!root.path().join(".genehub").exists());
        let ignore = fs::read_to_string(root.path().join(".genethub/.gitignore")).unwrap();
        assert!(ignore.contains("!workflow/**"));
        let status = inspect(root.path()).unwrap();
        assert_eq!(status.default_workflow, "direct-change");
        assert_eq!(status.workflows.len(), 1);
        let role = fs::read_to_string(source.join("roles/worker.yaml")).unwrap();
        assert!(role.contains("agentId: opencode"));
        assert!(role.contains("modelId: bailian-token-plan-personal/qwen3.8-flash"));
        let prompt = fs::read_to_string(source.join("prompts/direct-worker.md")).unwrap();
        assert!(prompt.contains("实现 Worker"));

        initialize_project(
            root.path(),
            "opencode",
            Some("bailian-token-plan-personal/qwen3.8-flash"),
        )
        .unwrap();
    }

    #[test]
    fn project_prompt_is_versioned_by_the_bundle_digest() {
        let root = tempfile::tempdir().unwrap();
        let source = initialize_project(root.path(), "genet", Some("qwen3.8-flash")).unwrap();
        let before = inspect(root.path()).unwrap().workflows[0].digest.clone();
        fs::write(
            source.join("prompts/direct-worker.md"),
            "这是项目自己版本化的新提示词。\n",
        )
        .unwrap();
        let after = inspect(root.path()).unwrap().workflows[0].digest.clone();
        assert_ne!(before, after);
    }

    #[test]
    fn default_simple_flow_does_not_invent_review_branch_or_user_approval() {
        let root = tempfile::tempdir().unwrap();
        let source = initialize_project(root.path(), "genet", Some("qwen3.8-flash")).unwrap();
        let workflow = fs::read_to_string(source.join("workflows/direct-change.yaml")).unwrap();
        assert!(workflow.contains("uses: agent.session"));
        assert!(workflow.contains("uses: result.publish"));
        for hidden_stage in ["review", "approval", "branch", "merge", "pm"] {
            assert!(
                !workflow.contains(hidden_stage),
                "default workflow silently inserted {hidden_stage}"
            );
        }
    }

    #[test]
    fn graph_validation_uses_capabilities_and_edges_not_business_node_names() {
        let definition = WorkflowDefinition {
            schema: DEFINITION_SCHEMA.into(),
            id: "anything".into(),
            version: 1,
            entry: "first".into(),
            nodes: vec![
                NodeDefinition {
                    id: "first".into(),
                    uses: "agent.session".into(),
                    inputs: NodeInputs {
                        role: Some("domain-expert".into()),
                        ..Default::default()
                    },
                    completion: CompletionDefinition::default(),
                    on: BTreeMap::from([("completed".into(), vec!["done".into()])]),
                },
                NodeDefinition {
                    id: "done".into(),
                    uses: "result.publish".into(),
                    inputs: NodeInputs::default(),
                    completion: CompletionDefinition::default(),
                    on: BTreeMap::new(),
                },
            ],
        };
        validate_definition(&definition).unwrap();
    }

    #[test]
    fn graph_validation_rejects_hidden_or_unsafe_execution_capabilities() {
        let definition = WorkflowDefinition {
            schema: DEFINITION_SCHEMA.into(),
            id: "unsafe".into(),
            version: 1,
            entry: "run-review-because-the-name-says-so".into(),
            nodes: vec![NodeDefinition {
                id: "run-review-because-the-name-says-so".into(),
                uses: "shell.exec".into(),
                inputs: NodeInputs::default(),
                completion: CompletionDefinition::default(),
                on: BTreeMap::new(),
            }],
        };
        assert!(validate_definition(&definition)
            .unwrap_err()
            .to_string()
            .contains("未注册"));
    }

    #[test]
    fn graph_validation_accepts_project_owned_fanout_without_named_business_stages() {
        let definition = WorkflowDefinition {
            schema: DEFINITION_SCHEMA.into(),
            id: "fanout".into(),
            version: 1,
            entry: "delegate".into(),
            nodes: vec![
                NodeDefinition {
                    id: "delegate".into(),
                    uses: "agent.session".into(),
                    inputs: NodeInputs {
                        role: Some("worker".into()),
                        ..Default::default()
                    },
                    completion: CompletionDefinition::default(),
                    on: BTreeMap::from([(
                        "completed".into(),
                        vec!["publish-a".into(), "publish-b".into()],
                    )]),
                },
                NodeDefinition {
                    id: "publish-a".into(),
                    uses: "result.publish".into(),
                    inputs: NodeInputs::default(),
                    completion: CompletionDefinition::default(),
                    on: BTreeMap::new(),
                },
                NodeDefinition {
                    id: "publish-b".into(),
                    uses: "result.publish".into(),
                    inputs: NodeInputs::default(),
                    completion: CompletionDefinition::default(),
                    on: BTreeMap::new(),
                },
            ],
        };
        validate_definition(&definition).unwrap();
    }

    #[test]
    fn publish_capability_cannot_silently_ignore_inputs_or_evidence() {
        let publish = |inputs: NodeInputs, completion: CompletionDefinition| WorkflowDefinition {
            schema: DEFINITION_SCHEMA.into(),
            id: "publish-only".into(),
            version: 1,
            entry: "publish".into(),
            nodes: vec![NodeDefinition {
                id: "publish".into(),
                uses: "result.publish".into(),
                inputs,
                completion,
                on: BTreeMap::new(),
            }],
        };

        assert!(validate_definition(&publish(
            NodeInputs {
                workspace: Some(".".into()),
                ..Default::default()
            },
            CompletionDefinition::default(),
        ))
        .unwrap_err()
        .to_string()
        .contains("不能声明 with"));
        assert!(validate_definition(&publish(
            NodeInputs::default(),
            CompletionDefinition {
                all: vec![EvidenceRequirement {
                    key: "checks".into(),
                    verify: "value.nonEmpty".into(),
                }],
            },
        ))
        .unwrap_err()
        .to_string()
        .contains("不能声明 completion"));
        validate_definition(&publish(
            NodeInputs::default(),
            CompletionDefinition::default(),
        ))
        .unwrap();
    }

    #[test]
    fn an_auto_only_graph_reaches_a_terminal_run() {
        let definition = WorkflowDefinition {
            schema: DEFINITION_SCHEMA.into(),
            id: "publish-only".into(),
            version: 1,
            entry: "publish".into(),
            nodes: vec![NodeDefinition {
                id: "publish".into(),
                uses: "result.publish".into(),
                inputs: NodeInputs::default(),
                completion: CompletionDefinition::default(),
                on: BTreeMap::new(),
            }],
        };
        let mut run = RunRecord {
            id: "wr_test".into(),
            workspace_id: "w_test".into(),
            parent_session_id: "s_root".into(),
            workflow_id: definition.id.clone(),
            bundle_digest: "sha256:test".into(),
            task_id: "task".into(),
            task_prompt: "publish".into(),
            status: "running".into(),
            revision: 0,
            definition,
            roles: BTreeMap::new(),
            nodes: BTreeMap::from([(
                "publish".into(),
                NodeRecord {
                    uses: "result.publish".into(),
                    status: "completed".into(),
                    session_id: None,
                    evidence: BTreeMap::new(),
                },
            )]),
            leases: BTreeMap::new(),
            created_at_ms: 1,
            updated_at_ms: 1,
        };

        settle_if_terminal(&mut run);
        assert_eq!(run.status, "completed");
    }

    #[test]
    fn workflow_paths_cannot_escape_project_source() {
        let root = tempfile::tempdir().unwrap();
        assert!(safe_relative(root.path(), "../outside.yaml").is_err());
        assert!(safe_relative(root.path(), "/outside.yaml").is_err());
        assert_eq!(
            safe_relative(root.path(), "workflows/direct.yaml").unwrap(),
            root.path().join("workflows/direct.yaml")
        );
    }

    #[cfg(unix)]
    #[test]
    fn workflow_symlinks_cannot_escape_the_project_boundary() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = initialize_project(project.path(), "genet", Some("qwen3.8-flash")).unwrap();
        fs::write(outside.path().join("secret.md"), "outside\n").unwrap();
        symlink(
            outside.path().join("secret.md"),
            source.join("prompts/escaped.md"),
        )
        .unwrap();
        symlink(outside.path(), project.path().join("escaped-workspace")).unwrap();

        assert!(existing_relative_within(&source, "prompts/escaped.md", "角色 Prompt").is_err());
        assert!(
            existing_relative_within(project.path(), "escaped-workspace", "角色 Workspace")
                .is_err()
        );

        let linked_project_file = tempfile::tempdir().unwrap();
        let linked_project_source =
            initialize_project(linked_project_file.path(), "genet", Some("qwen3.8-flash")).unwrap();
        let external_project_file = outside.path().join("external-project.yaml");
        fs::write(
            &external_project_file,
            format!("schema: {PROJECT_SCHEMA}\ndefaultWorkflow: direct-change\n"),
        )
        .unwrap();
        fs::remove_file(linked_project_source.join(PROJECT_FILE)).unwrap();
        symlink(
            &external_project_file,
            linked_project_source.join(PROJECT_FILE),
        )
        .unwrap();
        assert!(inspect(linked_project_file.path()).is_err());

        let linked_catalog_file = tempfile::tempdir().unwrap();
        let linked_catalog_source =
            initialize_project(linked_catalog_file.path(), "genet", Some("qwen3.8-flash")).unwrap();
        let external_catalog_file = outside.path().join("external-catalog.yaml");
        fs::write(
            &external_catalog_file,
            format!(
                "schema: {CATALOG_SCHEMA}\nworkflows:\n  - id: direct-change\n    path: direct-change.yaml\n"
            ),
        )
        .unwrap();
        fs::remove_file(linked_catalog_source.join(CATALOG_FILE)).unwrap();
        symlink(
            &external_catalog_file,
            linked_catalog_source.join(CATALOG_FILE),
        )
        .unwrap();
        assert!(inspect(linked_catalog_file.path()).is_err());

        let linked_workflows_dir = tempfile::tempdir().unwrap();
        let linked_workflows_source =
            initialize_project(linked_workflows_dir.path(), "genet", Some("qwen3.8-flash"))
                .unwrap();
        let external_workflows_dir = outside.path().join("external-workflows");
        fs::create_dir(&external_workflows_dir).unwrap();
        fs::copy(
            linked_workflows_source.join(CATALOG_FILE),
            external_workflows_dir.join("catalog.yaml"),
        )
        .unwrap();
        fs::copy(
            linked_workflows_source.join("workflows/direct-change.yaml"),
            external_workflows_dir.join("direct-change.yaml"),
        )
        .unwrap();
        fs::remove_dir_all(linked_workflows_source.join("workflows")).unwrap();
        symlink(
            &external_workflows_dir,
            linked_workflows_source.join("workflows"),
        )
        .unwrap();
        assert!(inspect(linked_workflows_dir.path()).is_err());

        let linked_home = tempfile::tempdir().unwrap();
        symlink(outside.path(), linked_home.path().join(".genethub")).unwrap();
        assert!(initialize_project(linked_home.path(), "genet", Some("qwen3.8-flash")).is_err());

        let linked_source = tempfile::tempdir().unwrap();
        fs::create_dir(linked_source.path().join(".genethub")).unwrap();
        let external_workflow = outside.path().join("workflow");
        fs::create_dir(&external_workflow).unwrap();
        fs::write(
            external_workflow.join(PROJECT_FILE),
            format!("schema: {PROJECT_SCHEMA}\ndefaultWorkflow: direct-change\n"),
        )
        .unwrap();
        symlink(
            &external_workflow,
            linked_source.path().join(".genethub/workflow"),
        )
        .unwrap();
        assert!(source_root(linked_source.path()).is_err());
    }
}
