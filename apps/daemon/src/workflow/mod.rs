//! Project-owned Workflow source and the deliberately small execution kernel.
//!
//! Business stages do not exist here. A project graph names generic capability
//! providers (`agent.session`, `result.publish`), their inputs, evidence gates
//! and outgoing events. Adding a review, approval, branch or PM therefore
//! requires a project node; the daemon never inserts one by convention.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use genehub_proto::{
    ManagedSessionInfo, SessionSummary, SessionUserInteraction, WorkflowActivationStatus,
    WorkflowCatalogEntryStatus, WorkflowNodeRunStatus, WorkflowProjectStatus, WorkflowRunStatus,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::state::Shared;

const SOURCE_DIR: &str = ".genethub/workflow";
const PROJECT_FILE: &str = "project.yaml";
const CATALOG_FILE: &str = "workflows/catalog.yaml";
const MAX_SOURCE_BYTES: u64 = 256 * 1024;
const MAX_WORKFLOWS: usize = 64;
const MAX_NODES: usize = 64;
const MAX_CANDIDATE_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CANDIDATE_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CANDIDATE_RECORD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ACTIVATION_HISTORY: usize = 4_096;
const MAX_ACTIVATION_RECORD_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RUN_RECORD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LEASE_RECORD_BYTES: u64 = 64 * 1024;
const DEFAULT_LEASE_SECONDS: u64 = 60 * 60;
const MAX_LEASE_SECONDS: u64 = 24 * 60 * 60;

const PROJECT_SCHEMA: &str = "genehub.workflow.project.v1";
const CATALOG_SCHEMA: &str = "genehub.workflow.catalog.v1";
const DEFINITION_SCHEMA: &str = "genehub.workflow.definition.v1";
const ROLE_SCHEMA: &str = "genehub.workflow.role.v1";
const CANDIDATE_SCHEMA: &str = "genehub.workflow.candidate.v1";
const ACTIVATION_SCHEMA: &str = "genehub.workflow.activation.v1";
const BOOTSTRAP_PACK_ID: &str = "genehub.workflow.bootstrap.direct.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectDefinition {
    schema: String,
    default_workflow: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogDefinition {
    schema: String,
    workflows: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogEntry {
    id: String,
    path: String,
    #[serde(default, rename = "match")]
    matching: Option<WorkflowMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    digest: String,
    definition: WorkflowDefinition,
    roles: BTreeMap<String, RoleSnapshot>,
    #[serde(skip)]
    source_files: BTreeMap<String, Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DcgCandidateRecord {
    schema: String,
    digest: String,
    snapshot_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bootstrap_pack_digest: Option<String>,
    project: ProjectDefinition,
    catalog: CatalogDefinition,
    workflows: BTreeMap<String, Bundle>,
    source_files: BTreeMap<String, Vec<u8>>,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DcgActivationRecord {
    schema: String,
    revision: u64,
    active_digest: String,
    history: Vec<DcgActivationEvent>,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DcgActivationEvent {
    revision: u64,
    active_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_digest: Option<String>,
    activated_at_ms: i64,
}

/// Daemon-owned Workflow control state for one registered Workspace.
///
/// Project source remains in `.genethub/workflow/`, but Candidate,
/// Activation, Run and lease records must not share the Agent-writable project
/// tree. Project-local V1 runtime records are deliberately not imported here:
/// an Agent can write that tree, so an implicit migration cannot establish
/// provenance. A future importer must be an explicit, separately authorized
/// protocol.
#[derive(Debug, Clone)]
pub(crate) struct RuntimeStore {
    root: PathBuf,
}

static LOCAL_WORKFLOW_LOCKS: LazyLock<Mutex<BTreeSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(BTreeSet::new()));

/// Same-daemon ownership for an advisory lock path.
///
/// The WASM host adapter intentionally treats a path already held by its Guest
/// as re-entrant because it cannot associate a second guest `File` with an
/// async task. Workflow operations can hold a lock across awaits, so they need
/// this task-independent ownership layer before asking the host for the
/// cross-process lock.
struct LocalWorkflowLock {
    path: PathBuf,
}

impl LocalWorkflowLock {
    fn try_acquire(path: &Path) -> Result<Option<Self>> {
        let mut held = LOCAL_WORKFLOW_LOCKS
            .lock()
            .map_err(|_| anyhow!("Workflow 本地锁注册表已损坏"))?;
        if !held.insert(path.to_path_buf()) {
            return Ok(None);
        }
        Ok(Some(Self {
            path: path.to_path_buf(),
        }))
    }
}

impl Drop for LocalWorkflowLock {
    fn drop(&mut self) {
        match LOCAL_WORKFLOW_LOCKS.lock() {
            Ok(mut held) => {
                held.remove(&self.path);
            }
            Err(poisoned) => {
                poisoned.into_inner().remove(&self.path);
                tracing::warn!(
                    path = %self.path.display(),
                    "recovered a poisoned Workflow local-lock registry"
                );
            }
        }
    }
}

/// Cross-platform advisory lock whose lifetime has the same meaning in the
/// native daemon and the WASM Guest. The WASM frontdoor keeps the real host
/// lock in a path-keyed handle map, so dropping the guest `File` alone does not
/// release it; every Workflow lock must call the shared unlock API explicitly.
struct ExclusiveFileLock {
    _local: LocalWorkflowLock,
    file: File,
    path: PathBuf,
}

impl Drop for ExclusiveFileLock {
    fn drop(&mut self) {
        if let Err(error) = crate::fs_lock::unlock(&self.file, &self.path) {
            tracing::warn!(
                path = %self.path.display(),
                %error,
                "could not release Workflow control lock"
            );
        }
    }
}

fn try_exclusive_file_lock(path: &Path) -> Result<Option<ExclusiveFileLock>> {
    let Some(local) = LocalWorkflowLock::try_acquire(path)? else {
        return Ok(None);
    };
    match crate::config::sensitive_metadata(path) {
        Ok(metadata) => {
            crate::config::reject_link_or_reparse(path, &metadata)?;
            if !metadata.is_file() {
                bail!("Workflow lock 不是普通文件：{}", path.display());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("检查 {}", path.display())),
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .with_context(|| format!("打开 Workflow lock：{}", path.display()))?;
    crate::config::restrict_to_owner(path)?;
    match crate::fs_lock::try_lock_exclusive(&file, path) {
        Ok(()) => Ok(Some(ExclusiveFileLock {
            _local: local,
            file,
            path: path.to_path_buf(),
        })),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(error).with_context(|| format!("锁定 {}", path.display())),
    }
}

fn lock_exclusive_file(path: &Path, contended: &str) -> Result<ExclusiveFileLock> {
    try_exclusive_file_lock(path)?.ok_or_else(|| anyhow!(contended.to_string()))
}

async fn wait_for_exclusive_file_lock(path: &Path, contended: &str) -> Result<ExclusiveFileLock> {
    const ATTEMPTS: usize = 100;
    for attempt in 0..ATTEMPTS {
        if let Some(guard) = try_exclusive_file_lock(path)? {
            return Ok(guard);
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    bail!("{contended}");
}

impl RuntimeStore {
    pub(crate) fn new(data_root: &Path, workspace_id: &str, project_root: &Path) -> Result<Self> {
        validate_id(workspace_id, "workspace id")?;
        if matches!(workspace_id, "." | "..") {
            bail!("workspace id 不能是路径导航片段");
        }
        let data_root = data_root
            .canonicalize()
            .with_context(|| format!("读取 daemon data 目录：{}", data_root.display()))?;
        let _project_root = project_root
            .canonicalize()
            .with_context(|| format!("读取项目根目录：{}", project_root.display()))?;
        Ok(Self {
            root: data_root.join("workflow-runtime").join(workspace_id),
        })
    }

    fn directory(&self, relative: &Path, create: bool) -> Result<PathBuf> {
        let data_root = self
            .root
            .parent()
            .and_then(Path::parent)
            .expect("Workflow runtime has a daemon data root");
        let relative_root = self
            .root
            .strip_prefix(data_root)
            .expect("Workflow runtime is below daemon data root");
        let mut current = data_root.to_path_buf();
        for component in relative_root.components().chain(relative.components()) {
            let Component::Normal(component) = component else {
                bail!("Workflow runtime 必须使用普通相对路径");
            };
            current.push(component);
            match crate::config::sensitive_metadata(&current) {
                Ok(metadata) => {
                    crate::config::reject_link_or_reparse(&current, &metadata)?;
                    if !metadata.is_dir() {
                        bail!("Workflow runtime 路径不是目录：{}", current.display());
                    }
                    if create {
                        crate::config::restrict_dir_to_owner(&current)?;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                    crate::config::ensure_real_directory(&current)?;
                    crate::config::restrict_dir_to_owner(&current)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(self.root.join(relative));
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("检查 Workflow runtime：{}", current.display()))
                }
            }
        }
        Ok(current)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRecord {
    id: String,
    workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    executor_workspace_id: Option<String>,
    parent_session_id: String,
    workflow_id: String,
    #[serde(default)]
    dcg_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    activation_revision: Option<u64>,
    bundle_digest: String,
    task_id: String,
    task_prompt: String,
    status: String,
    revision: u64,
    #[serde(default)]
    executor_turns: u32,
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

/// Chinese project-controller contract for an ordinary main Session. PM is a
/// responsibility marker on a non-worker PipeSpace, never a Session kind.
pub fn root_session_guidance(cwd: &Path) -> Option<String> {
    let source = find_source_root(cwd);
    let location = source
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| format!("{SOURCE_DIR}/（尚未初始化）"));
    Some(format!(
        "<genehub_workflow_controller>\n\
你在当前项目的普通主会话中工作；若所在非 Worker PipeSpace 标记了 PM，你代表用户承担项目管理职责，\
但 PM 不是独立的 Space 或 Session 类型。先理解用户目标，再按两个互不替代的维度判断：\
业务问题或工作流改进；简单任务或复杂任务。项目流程源位于 `{location}`。\n\
需要查看项目可用流程时，使用环境变量 `GENEHUB_CLI` 指向的绝对命令运行 `workflow inspect`；\
只有用户明确要建立项目方法且目录尚未初始化时才运行 `workflow init`。源文件改动只形成 Candidate，不会热切换\
活动 DCG；只有用户明确要求晋级或回滚时，才依据 inspect 返回的当前 revision 运行 `workflow activate`，不得静默\
替用户改变项目方法。简单任务优先选择项目的直达流程；\
派发时用 `--kind` 和 `--complexity` 明确给出两个维度，让项目 catalog 选择流程；\
不得自行补上项目图中没有声明的评审、分支、合并或用户批准节点。新模型中的 Run 应绑定项目已有的\
Workflow Executor WorkerSpace，不为每次 Run 新建 Executor；Coder、Reviewer、Tester 的能力来自对应子\
PipeSpace，受管 Session 只是这些 Space 内的一次执行。\n\
</genehub_workflow_controller>"
    ))
}

fn bootstrap_files(agent_id: &str, model_id: Option<&str>) -> Vec<(String, Vec<u8>)> {
    let model = model_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("modelId: {value}\n"))
        .unwrap_or_default();
    vec![
        (
            PROJECT_FILE.into(),
            format!("schema: {PROJECT_SCHEMA}\ndefaultWorkflow: direct-change\n").into_bytes(),
        ),
        (
            CATALOG_FILE.into(),
            format!(
                "schema: {CATALOG_SCHEMA}\nworkflows:\n  - id: direct-change\n    path: direct-change.yaml\n    match:\n      kind: business\n      complexity: simple\n"
            )
            .into_bytes(),
        ),
        (
            "workflows/direct-change.yaml".into(),
            format!(
                "schema: {DEFINITION_SCHEMA}\nid: direct-change\nversion: 1\nentry: implement\nnodes:\n  - id: implement\n    uses: agent.session\n    with:\n      role: worker\n      workspace: .\n      writeLease:\n        targetRef: current\n        ttlSeconds: 3600\n    completion:\n      all:\n        - key: commit\n          verify: git.commitOnTarget\n        - key: checks\n          verify: value.nonEmpty\n    on:\n      completed: [publish]\n  - id: publish\n    uses: result.publish\n"
            )
            .into_bytes(),
        ),
        (
            "roles/worker.yaml".into(),
            format!(
                "schema: {ROLE_SCHEMA}\nid: worker\nagentId: {agent_id}\n{model}userInteraction: readOnly\nprompt: prompts/direct-worker.md\n"
            )
            .into_bytes(),
        ),
        (
            "prompts/direct-worker.md".into(),
            "你是当前项目直达流程中的实现 Worker。只处理根会话交付的精确目标，不扩大范围，不替用户改变流程。\n\
先核对仓库与目标 ref，再完成实现和项目要求的检查。只有真实提交已经位于租约目标 ref、检查已经实际执行后，\
才可按系统合同上报证据；不得编造 commit、测试或检查结果。\n"
                .as_bytes()
                .to_vec(),
        ),
    ]
}

fn bootstrap_pack_digest(agent_id: &str, model_id: Option<&str>) -> String {
    let mut digest = Sha256::new();
    digest.update((BOOTSTRAP_PACK_ID.len() as u64).to_le_bytes());
    digest.update(BOOTSTRAP_PACK_ID.as_bytes());
    for (path, bytes) in bootstrap_files(agent_id, model_id) {
        digest.update((path.len() as u64).to_le_bytes());
        digest.update(path.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    format!("sha256:{:x}", digest.finalize())
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

    for (relative, body) in bootstrap_files(agent_id, model_id) {
        write_new_or_same(&source.join(relative), &body)?;
    }
    Ok(source)
}

/// Applies the deterministic built-in genesis pack and activates its compiled
/// candidate. The source writer is idempotent and refuses every differing
/// pre-existing file; the activation is likewise a no-op when the same digest
/// is already active.
pub(crate) fn initialize_and_activate(
    root: &Path,
    runtime: &RuntimeStore,
    agent_id: &str,
    model_id: Option<&str>,
) -> Result<WorkflowProjectStatus> {
    let bootstrap_digest = bootstrap_pack_digest(agent_id, model_id);
    initialize_project(root, agent_id, model_id)?;
    activate_project_inner(root, runtime, None, None, Some(bootstrap_digest), true)
}

pub(crate) fn inspect(root: &Path, runtime: &RuntimeStore) -> Result<WorkflowProjectStatus> {
    let root = root
        .canonicalize()
        .with_context(|| format!("读取项目根目录：{}", root.display()))?;
    let activation = load_activation(runtime)?;
    let active = activation
        .as_ref()
        .map(|activation| load_candidate(runtime, &activation.active_digest))
        .transpose()?;
    let source = root.join(SOURCE_DIR);
    let (candidate, candidate_error) =
        match source_root(&root).and_then(|source| compile_candidate(&source)) {
            Ok(candidate) => (Some(candidate), None),
            Err(error) if active.is_some() => (None, Some(format!("{error:#}"))),
            Err(error) => return Err(error),
        };
    let effective = active
        .as_ref()
        .or(candidate.as_ref())
        .expect("an active or compilable candidate exists");
    let mut workflows = Vec::new();
    for entry in &effective.catalog.workflows {
        let bundle = effective
            .workflows
            .get(&entry.id)
            .ok_or_else(|| anyhow!("DCG Candidate 缺少 Workflow：{}", entry.id))?;
        workflows.push(WorkflowCatalogEntryStatus {
            id: entry.id.clone(),
            path: entry.path.clone(),
            digest: bundle.digest.clone(),
            match_kind: entry.matching.as_ref().and_then(|value| value.kind.clone()),
            match_complexity: entry
                .matching
                .as_ref()
                .and_then(|value| value.complexity.clone()),
        });
    }
    Ok(WorkflowProjectStatus {
        schema: effective.project.schema.clone(),
        root: source.display().to_string(),
        default_workflow: effective.project.default_workflow.clone(),
        workflows,
        candidate_digest: candidate.as_ref().map(|candidate| candidate.digest.clone()),
        candidate_error,
        active_digest: active.as_ref().map(|candidate| candidate.digest.clone()),
        activation_revision: activation.as_ref().map_or(0, |value| value.revision),
        source_changed: active.as_ref().is_some_and(|active| {
            candidate
                .as_ref()
                .is_none_or(|candidate| active.digest != candidate.digest)
        }),
        bootstrap_pack_digest: active
            .as_ref()
            .and_then(|candidate| candidate.bootstrap_pack_digest.clone()),
        activation_history: activation
            .as_ref()
            .map(|activation| {
                activation
                    .history
                    .iter()
                    .map(|event| WorkflowActivationStatus {
                        revision: event.revision,
                        digest: event.active_digest.clone(),
                        previous_digest: event.previous_digest.clone(),
                        activated_at_ms: event.activated_at_ms,
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Activates either the currently compiled source or a previously persisted
/// candidate. Every non-genesis change requires an explicit activation CAS.
pub(crate) fn activate_project(
    root: &Path,
    runtime: &RuntimeStore,
    candidate_digest: Option<&str>,
    expected_revision: u64,
) -> Result<WorkflowProjectStatus> {
    activate_project_inner(
        root,
        runtime,
        candidate_digest,
        Some(expected_revision),
        None,
        false,
    )
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
    let workspace = state.workspaces.project_entry(root_workspace_id).await?;
    let runtime = RuntimeStore::new(&state.paths.root, root_workspace_id, &workspace.root)?;
    // Resolve the durable execution carrier before compiling source. A
    // registered project reuses the one direct child that mounts the executor
    // component across Runs; legacy directory projects intentionally keep the
    // V1 in-place path.
    let executor_workspace_id = state
        .workspaces
        .reusable_component_space(root_workspace_id, crate::agent_space::COMPONENT_EXECUTOR)
        .await?
        .map(|workspace| workspace.id);
    let (candidate, activation_revision) = dispatch_candidate(&workspace.root, &runtime)?;
    let entry = candidate
        .catalog
        .workflows
        .iter()
        .find(|entry| entry.id == workflow_id)
        .ok_or_else(|| anyhow!("Workflow 不存在：{workflow_id}"))?;
    let bundle = candidate
        .workflows
        .get(&entry.id)
        .cloned()
        .ok_or_else(|| anyhow!("活动 DCG Candidate 缺少 Workflow：{}", entry.id))?;
    let now = now_ms();
    let run_id = format!("wr_{}", uuid::Uuid::new_v4().simple());
    let mut run = RunRecord {
        id: run_id.clone(),
        workspace_id: root_workspace_id.to_string(),
        executor_workspace_id,
        parent_session_id: parent_session_id.to_string(),
        workflow_id: workflow_id.to_string(),
        dcg_digest: candidate.digest,
        activation_revision,
        bundle_digest: bundle.digest,
        task_id: task_id.to_string(),
        task_prompt: task_prompt.to_string(),
        status: "running".into(),
        revision: 0,
        executor_turns: 0,
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
    let sessions = activate(state, &workspace.root, &runtime, &mut run, vec![entry]).await?;
    settle_if_terminal(&mut run);
    run.revision = 1;
    run.updated_at_ms = now_ms();
    if let Err(error) = save_run(&runtime, &run) {
        let leases = run.leases.values().cloned().collect::<Vec<_>>();
        return Err(with_activation_cleanup(
            state,
            &runtime,
            &sessions,
            &leases,
            error.context("持久化新 Workflow Run"),
        )
        .await);
    }
    if run.status == "completed" {
        release_leases(&runtime, &run).await?;
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
    let runtime = RuntimeStore::new(&state.paths.root, root_workspace_id, &workspace.root)?;
    let _lock = lock_run(&runtime, run_id)?;
    let mut run = load_run(&runtime, run_id)?;
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
    save_run(&runtime, &run)?;

    let mut cleanup_errors = Vec::new();
    if let Err(error) = release_leases(&runtime, &run).await {
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

pub(crate) fn get(runtime: &RuntimeStore, run_id: &str) -> Result<WorkflowRunStatus> {
    validate_id(run_id, "runId")?;
    Ok(run_status(&load_run(runtime, run_id)?))
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
    let runtime = RuntimeStore::new(&state.paths.root, root_workspace_id, &workspace.root)?;
    let _lock = lock_run(&runtime, run_id)?;
    let mut run = load_run(&runtime, run_id)?;
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
    let leases_before = run.leases.keys().cloned().collect::<BTreeSet<_>>();
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
    let sessions = activate(state, &workspace.root, &runtime, &mut run, targets).await?;
    settle_if_terminal(&mut run);
    run.revision = run.revision.saturating_add(1);
    run.updated_at_ms = now_ms();
    if let Err(error) = save_run(&runtime, &run) {
        let leases = run
            .leases
            .iter()
            .filter(|(node_id, _)| !leases_before.contains(*node_id))
            .map(|(_, lease)| lease.clone())
            .collect::<Vec<_>>();
        return Err(with_activation_cleanup(
            state,
            &runtime,
            &sessions,
            &leases,
            error.context("持久化 Workflow 节点完成状态"),
        )
        .await);
    }
    if run.status == "completed" {
        release_leases(&runtime, &run).await?;
    }
    Ok(Transition {
        status: run_status(&run),
        sessions,
    })
}

async fn with_activation_cleanup(
    state: &Shared,
    runtime: &RuntimeStore,
    sessions: &[(SessionSummary, String)],
    leases: &[LeaseRecord],
    error: anyhow::Error,
) -> anyhow::Error {
    let mut cleanup_errors = Vec::new();
    for (session, _) in sessions {
        if let Err(cleanup) = state.sessions.delete(&session.id).await {
            cleanup_errors.push(format!("删除受管 Session {}：{cleanup:#}", session.id));
        }
    }
    for lease in leases {
        if let Err(cleanup) = release_lease(runtime, lease).await {
            cleanup_errors.push(format!("释放目标 ref 租约：{cleanup:#}"));
        }
    }
    if cleanup_errors.is_empty() {
        error
    } else {
        anyhow!("{error:#}；激活补偿失败：{}", cleanup_errors.join("；"))
    }
}

async fn activate(
    state: &Shared,
    project_root: &Path,
    runtime: &RuntimeStore,
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
                        let lease = acquire_lease(runtime, &cwd, &run.id, &node.id, policy).await?;
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
            if let Err(cleanup) = release_lease(runtime, lease).await {
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
    runtime: &RuntimeStore,
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
    let directory = runtime.directory(Path::new("ref-leases"), true)?;
    let guard_path = directory.join(format!("{key}.guard"));
    let _guard = lock_exclusive_file(&guard_path, "目标 ref 租约正在被另一个请求修改")?;
    let path = directory.join(format!("{key}.json"));
    if let Some(existing) = load_lease_if_present(&path)? {
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
    let body = encode_private_record("Workflow 租约", &record, MAX_LEASE_RECORD_BYTES)?;
    crate::config::save_private(&path, &body)?;
    Ok(record)
}

async fn release_leases(runtime: &RuntimeStore, run: &RunRecord) -> Result<()> {
    for lease in run.leases.values() {
        release_lease(runtime, lease).await?;
    }
    Ok(())
}

async fn release_lease(runtime: &RuntimeStore, lease: &LeaseRecord) -> Result<()> {
    let key = hex_digest(format!("{}\0{}", lease.repository, lease.target_ref).as_bytes());
    let directory = runtime.directory(Path::new("ref-leases"), false)?;
    let path = directory.join(format!("{key}.json"));
    if load_lease_if_present(&path)?.is_none() {
        return Ok(());
    }
    let guard_path = directory.join(format!("{key}.guard"));
    let _guard =
        wait_for_exclusive_file_lock(&guard_path, "目标 ref 租约在释放时持续被另一个请求修改")
            .await?;
    let Some(current) = load_lease_if_present(&path)? else {
        return Ok(());
    };
    if current.run_id == lease.run_id && current.node_id == lease.node_id {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn load_lease_if_present(path: &Path) -> Result<Option<LeaseRecord>> {
    let metadata = match crate::config::sensitive_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("检查 {}", path.display())),
    };
    crate::config::reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_file() {
        bail!("Workflow 租约不是普通文件：{}", path.display());
    }
    ensure_record_size("Workflow 租约", metadata.len(), MAX_LEASE_RECORD_BYTES)?;
    Ok(Some(
        serde_json::from_slice(&fs::read(path)?)
            .with_context(|| format!("读取 Workflow 租约：{}", path.display()))?,
    ))
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
    if catalog.workflows.is_empty() || catalog.workflows.len() > MAX_WORKFLOWS {
        bail!("Workflow 数量必须在 1..={MAX_WORKFLOWS} 之间");
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
    for (path, bytes) in &digest_files {
        digest.update((path.len() as u64).to_le_bytes());
        digest.update(path.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    Ok(Bundle {
        digest: format!("sha256:{:x}", digest.finalize()),
        definition,
        roles,
        source_files: digest_files.into_iter().collect(),
    })
}

fn compile_candidate(source: &Path) -> Result<DcgCandidateRecord> {
    let (project, catalog, project_files) = load_project_files(source)?;
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
    let mut workflows = BTreeMap::new();
    let mut source_files = BTreeMap::new();
    let mut source_bytes = 0;
    let mut snapshot_bytes = serialized_json_size(&(&project, &catalog))?;
    ensure_record_size(
        "DCG Candidate 展开执行快照",
        snapshot_bytes,
        MAX_CANDIDATE_SNAPSHOT_BYTES,
    )?;
    for (path, bytes) in project_files {
        insert_candidate_source(&mut source_files, &mut source_bytes, path, bytes)?;
    }
    for entry in &catalog.workflows {
        let mut bundle = load_bundle_from(source, entry)?;
        for (path, bytes) in &bundle.source_files {
            insert_candidate_source(
                &mut source_files,
                &mut source_bytes,
                path.clone(),
                bytes.clone(),
            )?;
        }
        // These bytes are only needed while compiling the content identity.
        // Keeping one copy per Bundle would multiply a shared role/prompt by
        // the catalog width even though Candidate.source_files already owns a
        // deduplicated copy.
        bundle.source_files.clear();
        snapshot_bytes = snapshot_bytes
            .checked_add(serialized_json_size(&bundle)?)
            .ok_or_else(|| anyhow!("DCG Candidate 展开执行快照大小溢出"))?;
        ensure_record_size(
            "DCG Candidate 展开执行快照",
            snapshot_bytes,
            MAX_CANDIDATE_SNAPSHOT_BYTES,
        )?;
        workflows.insert(entry.id.clone(), bundle);
    }
    let snapshot_digest = digest_snapshot(&project, &catalog, &workflows)?;
    let digest = digest_candidate(&source_files, &snapshot_digest);
    Ok(DcgCandidateRecord {
        schema: CANDIDATE_SCHEMA.into(),
        digest,
        snapshot_digest,
        bootstrap_pack_digest: None,
        project,
        catalog,
        workflows,
        source_files,
        created_at_ms: now_ms(),
    })
}

fn insert_candidate_source(
    files: &mut BTreeMap<String, Vec<u8>>,
    source_bytes: &mut u64,
    path: String,
    bytes: Vec<u8>,
) -> Result<()> {
    if let Some(existing) = files.get(&path) {
        if existing != &bytes {
            bail!("编译 DCG Candidate 时源文件发生变化：{path}");
        }
        return Ok(());
    }
    let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if size > MAX_SOURCE_BYTES {
        bail!("DCG Candidate 单个源文件不能超过 {MAX_SOURCE_BYTES} 字节：{path}");
    }
    let next = source_bytes
        .checked_add(size)
        .ok_or_else(|| anyhow!("DCG Candidate 源文件总大小溢出"))?;
    if next > MAX_CANDIDATE_SOURCE_BYTES {
        bail!("DCG Candidate 源文件总大小不能超过 {MAX_CANDIDATE_SOURCE_BYTES} 字节");
    }
    files.insert(path, bytes);
    *source_bytes = next;
    Ok(())
}

fn digest_candidate(files: &BTreeMap<String, Vec<u8>>, snapshot_digest: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"genehub.workflow.candidate.v1\0");
    digest.update((CANDIDATE_SCHEMA.len() as u64).to_le_bytes());
    digest.update(CANDIDATE_SCHEMA.as_bytes());
    digest.update((snapshot_digest.len() as u64).to_le_bytes());
    digest.update(snapshot_digest.as_bytes());
    for (path, bytes) in files {
        digest.update((path.len() as u64).to_le_bytes());
        digest.update(path.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    format!("sha256:{:x}", digest.finalize())
}

fn digest_snapshot(
    project: &ProjectDefinition,
    catalog: &CatalogDefinition,
    workflows: &BTreeMap<String, Bundle>,
) -> Result<String> {
    let snapshot = (project, catalog, workflows);
    ensure_record_size(
        "DCG Candidate 展开执行快照",
        serialized_json_size(&snapshot)?,
        MAX_CANDIDATE_SNAPSHOT_BYTES,
    )?;
    let mut digest = Sha256::new();
    digest.update(b"genehub.workflow.snapshot.v1");
    serde_json::to_writer(DigestWriter(&mut digest), &snapshot)?;
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn validate_candidate_sources(files: &BTreeMap<String, Vec<u8>>) -> Result<()> {
    if files.is_empty() {
        bail!("DCG Candidate 缺少源文件身份");
    }
    let mut total = 0_u64;
    for (path, bytes) in files {
        safe_relative(Path::new("."), path)
            .with_context(|| format!("DCG Candidate 源路径无效：{path}"))?;
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if size > MAX_SOURCE_BYTES {
            bail!("DCG Candidate 单个源文件不能超过 {MAX_SOURCE_BYTES} 字节：{path}");
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| anyhow!("DCG Candidate 源文件总大小溢出"))?;
        if total > MAX_CANDIDATE_SOURCE_BYTES {
            bail!("DCG Candidate 源文件总大小不能超过 {MAX_CANDIDATE_SOURCE_BYTES} 字节");
        }
    }
    Ok(())
}

fn validate_candidate(candidate: &DcgCandidateRecord) -> Result<()> {
    if candidate.schema != CANDIDATE_SCHEMA {
        bail!("不支持的 DCG Candidate schema：{}", candidate.schema);
    }
    validate_candidate_sources(&candidate.source_files)?;
    let snapshot_digest =
        digest_snapshot(&candidate.project, &candidate.catalog, &candidate.workflows)?;
    if candidate.snapshot_digest != snapshot_digest {
        bail!("DCG Candidate snapshot digest 不匹配");
    }
    if candidate.digest != digest_candidate(&candidate.source_files, &snapshot_digest) {
        bail!("DCG Candidate digest 未绑定源文件与执行快照");
    }
    if candidate.project.schema != PROJECT_SCHEMA {
        bail!("DCG Candidate project schema 无效");
    }
    if candidate.catalog.schema != CATALOG_SCHEMA {
        bail!("DCG Candidate catalog schema 无效");
    }
    if candidate.catalog.workflows.is_empty() || candidate.catalog.workflows.len() > MAX_WORKFLOWS {
        bail!("DCG Candidate Workflow 数量必须在 1..={MAX_WORKFLOWS} 之间");
    }
    validate_id(&candidate.project.default_workflow, "defaultWorkflow")?;
    if !candidate
        .catalog
        .workflows
        .iter()
        .any(|entry| entry.id == candidate.project.default_workflow)
    {
        bail!("DCG Candidate 的 defaultWorkflow 不在 catalog 中");
    }
    let mut catalog_ids = BTreeSet::new();
    for entry in &candidate.catalog.workflows {
        validate_id(&entry.id, "catalog workflow id")?;
        if !catalog_ids.insert(entry.id.clone()) {
            bail!("DCG Candidate catalog 存在重复 Workflow：{}", entry.id);
        }
        let bundle = candidate
            .workflows
            .get(&entry.id)
            .ok_or_else(|| anyhow!("DCG Candidate 缺少 Workflow：{}", entry.id))?;
        validate_definition(&bundle.definition)?;
        if bundle.definition.id != entry.id {
            bail!("DCG Candidate 的 catalog 与 Workflow id 不一致");
        }
    }
    if candidate.workflows.keys().cloned().collect::<BTreeSet<_>>() != catalog_ids {
        bail!("DCG Candidate 的 catalog 与执行快照集合不一致");
    }
    Ok(())
}

fn activate_project_inner(
    root: &Path,
    runtime: &RuntimeStore,
    candidate_digest: Option<&str>,
    expected_revision: Option<u64>,
    bootstrap_pack_digest: Option<String>,
    genesis: bool,
) -> Result<WorkflowProjectStatus> {
    let root = root
        .canonicalize()
        .with_context(|| format!("读取项目根目录：{}", root.display()))?;
    let _lock = lock_activation(runtime)?;
    let current = load_activation(runtime)?;
    let current_revision = current.as_ref().map_or(0, |value| value.revision);
    if let Some(expected) = expected_revision {
        if expected != current_revision {
            bail!("DCG activation revision 冲突：当前为 {current_revision}，请求为 {expected}");
        }
    } else if !genesis {
        bail!("DCG activate 必须提供 expected revision");
    }

    let (candidate, persist) = match candidate_digest {
        Some(digest) => {
            if bootstrap_pack_digest.is_some() {
                bail!("历史 Candidate 不能重新声明 Bootstrap Pack");
            }
            (load_candidate(runtime, digest)?, false)
        }
        None => {
            let source = source_root(&root)?;
            let mut candidate = compile_candidate(&source)?;
            // Reject a hybrid snapshot if a tool was editing the project while
            // the candidate was compiled. Candidate creation is cheap and the
            // second read is a stronger boundary than trusting file mtimes.
            let confirmed = compile_candidate(&source)?;
            if candidate.digest != confirmed.digest
                || candidate.snapshot_digest != confirmed.snapshot_digest
            {
                bail!("DCG 源在 Candidate 编译期间发生变化；请重试");
            }
            candidate.bootstrap_pack_digest = bootstrap_pack_digest;
            (candidate, true)
        }
    };
    validate_candidate(&candidate)?;

    if current
        .as_ref()
        .is_some_and(|activation| activation.active_digest == candidate.digest)
    {
        drop(_lock);
        return inspect(&root, runtime);
    }
    if genesis && current.is_some() {
        bail!("项目已经激活不同的 DCG；genesis 不会覆盖现有活动版本");
    }
    if current
        .as_ref()
        .is_some_and(|activation| activation.history.len() >= MAX_ACTIVATION_HISTORY)
    {
        bail!("DCG Activation history 已达到 {MAX_ACTIVATION_HISTORY} 条上限");
    }
    let candidate = if persist {
        persist_candidate(runtime, candidate)?
    } else {
        candidate
    };

    let now = now_ms().max(
        current
            .as_ref()
            .map_or(1, |activation| activation.updated_at_ms),
    );
    let revision = current_revision
        .checked_add(1)
        .ok_or_else(|| anyhow!("DCG Activation revision 已耗尽"))?;
    let previous_digest = current
        .as_ref()
        .map(|activation| activation.active_digest.clone());
    let mut history = current.map_or_else(Vec::new, |activation| activation.history);
    history.push(DcgActivationEvent {
        revision,
        active_digest: candidate.digest.clone(),
        previous_digest,
        activated_at_ms: now,
    });
    let activation = DcgActivationRecord {
        schema: ACTIVATION_SCHEMA.into(),
        revision,
        active_digest: candidate.digest,
        history,
        updated_at_ms: now,
    };
    let body = encode_private_record("DCG Activation", &activation, MAX_ACTIVATION_RECORD_BYTES)?;
    crate::config::save_private(&activation_path(runtime, true)?, &body)?;
    drop(_lock);
    inspect(&root, runtime)
}

fn persist_candidate(
    runtime: &RuntimeStore,
    candidate: DcgCandidateRecord,
) -> Result<DcgCandidateRecord> {
    validate_candidate(&candidate)?;
    let path = candidate_path(runtime, &candidate.digest, true)?;
    match crate::config::sensitive_metadata(&path) {
        Ok(_) => {
            let existing = load_candidate(runtime, &candidate.digest)?;
            if existing.bootstrap_pack_digest.is_some() || candidate.bootstrap_pack_digest.is_none()
            {
                return Ok(existing);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("检查 {}", path.display())),
    }
    let body = encode_private_record("DCG Candidate", &candidate, MAX_CANDIDATE_RECORD_BYTES)?;
    crate::config::save_private(&path, &body)?;
    Ok(candidate)
}

fn load_candidate(runtime: &RuntimeStore, digest: &str) -> Result<DcgCandidateRecord> {
    let path = candidate_path(runtime, digest, false)?;
    let metadata = crate::config::sensitive_metadata(&path)
        .with_context(|| format!("DCG Candidate 不存在：{digest}"))?;
    crate::config::reject_link_or_reparse(&path, &metadata)?;
    if !metadata.is_file() {
        bail!("DCG Candidate 不是普通文件：{}", path.display());
    }
    ensure_record_size("DCG Candidate", metadata.len(), MAX_CANDIDATE_RECORD_BYTES)?;
    let candidate: DcgCandidateRecord = serde_json::from_slice(
        &fs::read(&path).with_context(|| format!("DCG Candidate 不存在：{digest}"))?,
    )
    .with_context(|| format!("读取 DCG Candidate：{}", path.display()))?;
    validate_candidate(&candidate)?;
    if candidate.digest != digest {
        bail!("DCG Candidate 文件名与内容摘要不匹配");
    }
    Ok(candidate)
}

fn load_activation(runtime: &RuntimeStore) -> Result<Option<DcgActivationRecord>> {
    let path = activation_path(runtime, false)?;
    match crate::config::sensitive_metadata(&path) {
        Ok(metadata) => {
            crate::config::reject_link_or_reparse(&path, &metadata)?;
            if !metadata.is_file() {
                bail!("DCG Activation 不是普通文件：{}", path.display());
            }
            ensure_record_size(
                "DCG Activation",
                metadata.len(),
                MAX_ACTIVATION_RECORD_BYTES,
            )?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("检查 {}", path.display())),
    }
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("读取 {}", path.display())),
    };
    let activation: DcgActivationRecord =
        serde_json::from_slice(&raw).with_context(|| format!("解析 {}", path.display()))?;
    if activation.schema != ACTIVATION_SCHEMA {
        bail!("不支持的 DCG Activation schema：{}", activation.schema);
    }
    if activation.history.len() > MAX_ACTIVATION_HISTORY {
        bail!("DCG Activation history 超过 {MAX_ACTIVATION_HISTORY} 条上限");
    }
    if activation.revision == 0 || activation.revision != activation.history.len() as u64 {
        bail!("DCG Activation revision 与 history 长度不一致");
    }
    let mut previous_digest: Option<&str> = None;
    let mut previous_time = 0;
    for (index, event) in activation.history.iter().enumerate() {
        if event.revision != index as u64 + 1 {
            bail!("DCG Activation history revision 不连续");
        }
        candidate_hex(&event.active_digest)?;
        if event.previous_digest.as_deref() != previous_digest {
            bail!("DCG Activation history 前序摘要不连续");
        }
        if event.activated_at_ms <= 0 || event.activated_at_ms < previous_time {
            bail!("DCG Activation history 时间顺序无效");
        }
        previous_digest = Some(&event.active_digest);
        previous_time = event.activated_at_ms;
    }
    let last = activation
        .history
        .last()
        .ok_or_else(|| anyhow!("DCG Activation 缺少 history"))?;
    if last.active_digest != activation.active_digest
        || activation.updated_at_ms != last.activated_at_ms
    {
        bail!("DCG Activation 当前指针与 history 不一致");
    }
    Ok(Some(activation))
}

fn dispatch_candidate(
    root: &Path,
    runtime: &RuntimeStore,
) -> Result<(DcgCandidateRecord, Option<u64>)> {
    match load_activation(runtime)? {
        Some(activation) => Ok((
            load_candidate(runtime, &activation.active_digest)?,
            Some(activation.revision),
        )),
        None => Ok((compile_candidate(&source_root(root)?)?, None)),
    }
}

fn candidate_path(runtime: &RuntimeStore, digest: &str, create_parent: bool) -> Result<PathBuf> {
    let hex = candidate_hex(digest)?;
    let directory = runtime.directory(Path::new("candidates"), create_parent)?;
    Ok(directory.join(format!("{hex}.json")))
}

fn candidate_hex(digest: &str) -> Result<&str> {
    let Some(hex) = digest.strip_prefix("sha256:") else {
        bail!("DCG Candidate digest 必须使用 sha256");
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        bail!("DCG Candidate digest 格式无效");
    }
    Ok(hex)
}

fn activation_path(runtime: &RuntimeStore, create_parent: bool) -> Result<PathBuf> {
    Ok(runtime
        .directory(Path::new(""), create_parent)?
        .join("activation.json"))
}

fn lock_activation(runtime: &RuntimeStore) -> Result<ExclusiveFileLock> {
    let path = runtime
        .directory(Path::new(""), true)?
        .join("activation.lock");
    lock_exclusive_file(&path, "DCG Activation 正由另一个请求修改")
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
    ensure_source_visible_with(home, |_| Ok(()))
}

fn ensure_source_visible_with(
    home: &Path,
    before_append: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
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

    let mut options = OpenOptions::new();
    options.read(true).append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o644)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }

    let mut file = options
        .open(&path)
        .with_context(|| format!("安全打开 {}", path.display()))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
        bail!(
            ".genethub/.gitignore 必须是小于 {MAX_SOURCE_BYTES} 字节的普通文件：{}",
            path.display()
        );
    }
    let mut raw = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    (&mut file)
        .take(MAX_SOURCE_BYTES.saturating_add(1))
        .read_to_end(&mut raw)?;
    if u64::try_from(raw.len()).unwrap_or(u64::MAX) > MAX_SOURCE_BYTES {
        bail!(".genethub/.gitignore 在读取期间超过 {MAX_SOURCE_BYTES} 字节上限");
    }
    let existing = String::from_utf8(raw).context(".genethub/.gitignore 必须是 UTF-8")?;
    let existing_lines = existing.lines().map(str::trim).collect::<BTreeSet<_>>();
    let missing = ["*", "!.gitignore", "!workflow/", "!workflow/**"]
        .into_iter()
        .filter(|required| !existing_lines.contains(required))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }

    let mut addition = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        addition.push('\n');
    }
    for required in missing {
        addition.push_str(required);
        addition.push('\n');
    }
    before_append(&path)?;
    file.write_all(addition.as_bytes())?;
    file.sync_all()?;

    // A project writer may rename the opened inode and replace the pathname
    // while initialization is running. Writes above stay on the already-open
    // regular file; this postcondition turns the replacement into a failed
    // initialization instead of silently claiming the visible file changed.
    let published = crate::config::sensitive_metadata(&path)
        .with_context(|| format!("复核 {}", path.display()))?;
    crate::config::reject_link_or_reparse(&path, &published)?;
    if !published.is_file() {
        bail!(".genethub/.gitignore 不是普通文件：{}", path.display());
    }
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
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = crate::config::sensitive_metadata(path)?;
            crate::config::reject_link_or_reparse(path, &metadata)?;
            if !metadata.is_file() || fs::read(path)? != body {
                bail!("拒绝覆盖已有项目 Workflow 源：{}", path.display());
            }
            return Ok(());
        }
        Err(error) => return Err(error).with_context(|| format!("创建 {}", path.display())),
    };
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

fn ensure_record_size(label: &str, actual: u64, maximum: u64) -> Result<()> {
    if actual > maximum {
        bail!("{label} 超过 {maximum} 字节上限");
    }
    Ok(())
}

#[derive(Default)]
struct CountingWriter {
    bytes: u64,
}

impl Write for CountingWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let size = u64::try_from(buffer.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "JSON chunk size overflow"))?;
        self.bytes = self.bytes.checked_add(size).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "JSON serialized size overflow")
        })?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct DigestWriter<'a>(&'a mut Sha256);

impl Write for DigestWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn serialized_json_size<T: Serialize>(value: &T) -> Result<u64> {
    let mut writer = CountingWriter::default();
    serde_json::to_writer(&mut writer, value)?;
    Ok(writer.bytes)
}

fn encode_private_record<T: Serialize>(label: &str, value: &T, maximum: u64) -> Result<Vec<u8>> {
    let body = serde_json::to_vec_pretty(value)?;
    ensure_record_size(
        label,
        u64::try_from(body.len()).unwrap_or(u64::MAX),
        maximum,
    )?;
    Ok(body)
}

fn run_path(runtime: &RuntimeStore, run_id: &str, create_parent: bool) -> Result<PathBuf> {
    Ok(runtime
        .directory(Path::new("runs"), create_parent)?
        .join(format!("{run_id}.json")))
}

/// Whether a Run in this project still depends on `carrier_workspace_id` as
/// its execution carrier.
///
/// Asked before an AgentSpace is moved in the ownership tree. A Run pinned
/// its carrier when it started, so reparenting that Space mid-flight would
/// leave the Run pointing at a Space that now belongs to a different project
/// and scope — the change is refused instead of silently reinterpreted.
///
/// Runs have no index, so this scans the project's Run directory. The scan is
/// capped: a directory past the cap cannot be proven safe, and reporting a
/// dependency is the conservative answer.
pub(crate) fn carrier_has_active_run(
    data_root: &Path,
    project_workspace_id: &str,
    project_root: &Path,
    carrier_workspace_id: &str,
) -> Result<bool> {
    const MAX_SCANNED_RUNS: usize = 4_096;
    let runtime = RuntimeStore::new(data_root, project_workspace_id, project_root)?;
    let directory = runtime.directory(Path::new("runs"), false)?;
    let listing = match fs::read_dir(&directory) {
        Ok(listing) => listing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("读取 Workflow Run 目录：{}", directory.display()))
        }
    };
    for (scanned, item) in listing.enumerate() {
        if scanned >= MAX_SCANNED_RUNS {
            bail!("Workflow Run 目录超过 {MAX_SCANNED_RUNS} 条，无法证明该 AgentSpace 空闲");
        }
        let path = item?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Some(run_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let run = load_run(&runtime, run_id)?;
        if run.status == "running"
            && run.executor_workspace_id.as_deref() == Some(carrier_workspace_id)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn save_run(runtime: &RuntimeStore, run: &RunRecord) -> Result<()> {
    let path = run_path(runtime, &run.id, true)?;
    let body = encode_private_record("Workflow Run", run, MAX_RUN_RECORD_BYTES)?;
    crate::config::save_private(&path, &body)
}

fn load_run(runtime: &RuntimeStore, run_id: &str) -> Result<RunRecord> {
    let path = run_path(runtime, run_id, false)?;
    let metadata = crate::config::sensitive_metadata(&path)
        .with_context(|| format!("Workflow Run 不存在：{run_id}"))?;
    crate::config::reject_link_or_reparse(&path, &metadata)?;
    if !metadata.is_file() {
        bail!("Workflow Run 不是普通文件：{}", path.display());
    }
    ensure_record_size("Workflow Run", metadata.len(), MAX_RUN_RECORD_BYTES)?;
    serde_json::from_slice(&fs::read(&path)?)
        .with_context(|| format!("读取 Workflow Run：{}", path.display()))
}

fn lock_run(runtime: &RuntimeStore, run_id: &str) -> Result<ExclusiveFileLock> {
    let path = runtime
        .directory(Path::new("locks"), true)?
        .join(format!("{run_id}.lock"));
    lock_exclusive_file(&path, "Workflow Run 正由另一个请求修改")
}

fn run_status(run: &RunRecord) -> WorkflowRunStatus {
    WorkflowRunStatus {
        id: run.id.clone(),
        workspace_id: run.workspace_id.clone(),
        executor_workspace_id: run.executor_workspace_id.clone(),
        parent_session_id: run.parent_session_id.clone(),
        workflow_id: run.workflow_id.clone(),
        dcg_digest: if run.dcg_digest.is_empty() {
            run.bundle_digest.clone()
        } else {
            run.dcg_digest.clone()
        },
        activation_revision: run.activation_revision,
        bundle_digest: run.bundle_digest.clone(),
        task_id: run.task_id.clone(),
        status: run.status.clone(),
        revision: run.revision,
        executor_turns: run.executor_turns,
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

    fn test_runtime(root: &Path) -> RuntimeStore {
        RuntimeStore::new(root, "workspace", root).unwrap()
    }

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
        let runtime = test_runtime(root.path());
        let status = inspect(root.path(), &runtime).unwrap();
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
        let runtime = test_runtime(root.path());
        let source = initialize_project(root.path(), "genet", Some("qwen3.8-flash")).unwrap();
        let before = inspect(root.path(), &runtime).unwrap().workflows[0]
            .digest
            .clone();
        fs::write(
            source.join("prompts/direct-worker.md"),
            "这是项目自己版本化的新提示词。\n",
        )
        .unwrap();
        let after = inspect(root.path(), &runtime).unwrap().workflows[0]
            .digest
            .clone();
        assert_ne!(before, after);
    }

    #[test]
    fn catalog_workflow_count_is_bounded_before_bundle_loading() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join(SOURCE_DIR);
        fs::create_dir_all(source.join("workflows")).unwrap();
        fs::write(
            source.join(PROJECT_FILE),
            format!("schema: {PROJECT_SCHEMA}\ndefaultWorkflow: flow-0\n"),
        )
        .unwrap();
        let mut catalog = format!("schema: {CATALOG_SCHEMA}\nworkflows:\n");
        for index in 0..=MAX_WORKFLOWS {
            catalog.push_str(&format!(
                "  - id: flow-{index}\n    path: flow-{index}.yaml\n"
            ));
        }
        fs::write(source.join(CATALOG_FILE), catalog).unwrap();

        let error = compile_candidate(&source).unwrap_err().to_string();
        assert!(error.contains("Workflow 数量必须在"));
    }

    #[test]
    fn candidate_source_bytes_have_an_aggregate_budget() {
        let mut files = BTreeMap::new();
        let mut total = 0;
        let chunks = MAX_CANDIDATE_SOURCE_BYTES / MAX_SOURCE_BYTES;
        for index in 0..chunks {
            insert_candidate_source(
                &mut files,
                &mut total,
                format!("prompts/{index}.md"),
                vec![b'x'; MAX_SOURCE_BYTES as usize],
            )
            .unwrap();
        }
        assert_eq!(total, MAX_CANDIDATE_SOURCE_BYTES);
        let error = insert_candidate_source(
            &mut files,
            &mut total,
            "prompts/overflow.md".into(),
            vec![b'x'],
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("源文件总大小不能超过"));
    }

    #[test]
    fn candidate_drops_compile_only_bundle_sources() {
        let root = tempfile::tempdir().unwrap();
        let source = initialize_project(root.path(), "genet", Some("qwen3.8-flash")).unwrap();
        let candidate = compile_candidate(&source).unwrap();

        assert!(!candidate.source_files.is_empty());
        assert!(candidate
            .workflows
            .values()
            .all(|bundle| bundle.source_files.is_empty()));
    }

    #[test]
    fn repeated_shared_prompt_cannot_amplify_the_expanded_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join(SOURCE_DIR);
        fs::create_dir_all(source.join("workflows")).unwrap();
        fs::create_dir_all(source.join("roles")).unwrap();
        fs::create_dir_all(source.join("prompts")).unwrap();
        fs::write(
            source.join(PROJECT_FILE),
            format!("schema: {PROJECT_SCHEMA}\ndefaultWorkflow: flow-0\n"),
        )
        .unwrap();
        let mut catalog = format!("schema: {CATALOG_SCHEMA}\nworkflows:\n");
        for index in 0..MAX_WORKFLOWS {
            let id = format!("flow-{index}");
            catalog.push_str(&format!("  - id: {id}\n    path: {id}.yaml\n"));
            fs::write(
                source.join(format!("workflows/{id}.yaml")),
                format!(
                    "schema: {DEFINITION_SCHEMA}\nid: {id}\nversion: 1\nentry: implement\nnodes:\n  - id: implement\n    uses: agent.session\n    with:\n      role: worker\n"
                ),
            )
            .unwrap();
        }
        fs::write(source.join(CATALOG_FILE), catalog).unwrap();
        fs::write(
            source.join("roles/worker.yaml"),
            format!(
                "schema: {ROLE_SCHEMA}\nid: worker\nagentId: genet\nuserInteraction: readOnly\nprompt: prompts/shared.md\n"
            ),
        )
        .unwrap();
        fs::write(
            source.join("prompts/shared.md"),
            vec![b'x'; MAX_SOURCE_BYTES as usize],
        )
        .unwrap();

        let error = compile_candidate(&source).unwrap_err().to_string();
        assert!(error.contains("展开执行快照"), "{error}");
    }

    #[test]
    fn oversized_activation_history_is_rejected_before_use() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path());
        let digest = format!("sha256:{}", "a".repeat(64));
        let history = (0..=MAX_ACTIVATION_HISTORY)
            .map(|index| DcgActivationEvent {
                revision: index as u64 + 1,
                active_digest: digest.clone(),
                previous_digest: (index > 0).then(|| digest.clone()),
                activated_at_ms: index as i64 + 1,
            })
            .collect::<Vec<_>>();
        let activation = DcgActivationRecord {
            schema: ACTIVATION_SCHEMA.into(),
            revision: history.len() as u64,
            active_digest: digest,
            updated_at_ms: history.len() as i64,
            history,
        };
        let path = activation_path(&runtime, true).unwrap();
        crate::config::save_private(&path, &serde_json::to_vec_pretty(&activation).unwrap())
            .unwrap();

        let error = load_activation(&runtime).unwrap_err().to_string();
        assert!(error.contains("history 超过"));
    }

    #[test]
    fn genesis_records_one_idempotent_candidate_activation() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path());
        let first =
            initialize_and_activate(root.path(), &runtime, "genet", Some("qwen3.8-flash")).unwrap();
        let candidate = first.candidate_digest.clone().unwrap();
        assert_eq!(first.active_digest.as_deref(), Some(candidate.as_str()));
        assert_eq!(first.activation_revision, 1);
        assert!(!first.source_changed);
        assert_eq!(
            first.bootstrap_pack_digest.as_deref(),
            Some(bootstrap_pack_digest("genet", Some("qwen3.8-flash")).as_str())
        );
        assert_ne!(
            bootstrap_pack_digest("genet", Some("qwen3.8-flash")),
            bootstrap_pack_digest("genet", Some("another-model"))
        );

        let second =
            initialize_and_activate(root.path(), &runtime, "genet", Some("qwen3.8-flash")).unwrap();
        assert_eq!(second.active_digest, first.active_digest);
        assert_eq!(second.activation_revision, 1);
        let activation = load_activation(&runtime).unwrap().unwrap();
        assert_eq!(activation.history.len(), 1);
        assert!(candidate_path(&runtime, &candidate, false)
            .unwrap()
            .is_file());
    }

    #[test]
    fn genesis_does_not_relabel_an_existing_manual_activation() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path());
        initialize_project(root.path(), "genet", Some("qwen3.8-flash")).unwrap();
        let manual = activate_project(root.path(), &runtime, None, 0).unwrap();
        assert_eq!(manual.activation_revision, 1);
        assert_eq!(manual.bootstrap_pack_digest, None);

        let repeated =
            initialize_and_activate(root.path(), &runtime, "genet", Some("qwen3.8-flash")).unwrap();
        assert_eq!(repeated.active_digest, manual.active_digest);
        assert_eq!(repeated.activation_revision, 1);
        assert_eq!(repeated.bootstrap_pack_digest, None);
        assert_eq!(repeated.activation_history.len(), 1);
    }

    #[test]
    fn source_candidate_requires_cas_activation_and_can_roll_back() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path());
        let initial =
            initialize_and_activate(root.path(), &runtime, "genet", Some("qwen3.8-flash")).unwrap();
        let old = initial.active_digest.unwrap();
        fs::write(
            root.path()
                .join(".genethub/workflow/prompts/direct-worker.md"),
            "新的项目提示词。\n",
        )
        .unwrap();

        let changed = inspect(root.path(), &runtime).unwrap();
        let new = changed.candidate_digest.clone().unwrap();
        assert_ne!(new, old);
        assert_eq!(changed.active_digest.as_deref(), Some(old.as_str()));
        assert!(changed.source_changed);
        assert!(activate_project(root.path(), &runtime, None, 0)
            .unwrap_err()
            .to_string()
            .contains("revision 冲突"));
        assert!(!candidate_path(&runtime, &new, false).unwrap().is_file());

        let promoted = activate_project(root.path(), &runtime, None, 1).unwrap();
        assert_eq!(promoted.active_digest.as_deref(), Some(new.as_str()));
        assert_eq!(promoted.activation_revision, 2);
        assert!(!promoted.source_changed);

        let rolled_back = activate_project(root.path(), &runtime, Some(&old), 2).unwrap();
        assert_eq!(rolled_back.active_digest.as_deref(), Some(old.as_str()));
        assert_eq!(rolled_back.activation_revision, 3);
        assert_eq!(rolled_back.activation_history.len(), 3);
        assert_eq!(rolled_back.activation_history[1].digest, new);
        assert_eq!(rolled_back.activation_history[2].digest, old);
        assert!(rolled_back.source_changed);
        let (dispatch, revision) = dispatch_candidate(root.path(), &runtime).unwrap();
        assert_eq!(dispatch.digest, old);
        assert_eq!(revision, Some(3));
    }

    #[test]
    fn broken_candidate_source_does_not_disable_the_active_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path());
        let initialized =
            initialize_and_activate(root.path(), &runtime, "genet", Some("qwen3.8-flash")).unwrap();
        let active = initialized.active_digest.unwrap();
        fs::write(
            root.path()
                .join(".genethub/workflow/workflows/direct-change.yaml"),
            "not: a valid workflow\n",
        )
        .unwrap();

        let status = inspect(root.path(), &runtime).unwrap();
        assert_eq!(status.candidate_digest, None);
        assert!(status.candidate_error.is_some());
        assert_eq!(status.active_digest.as_deref(), Some(active.as_str()));
        assert!(status.source_changed);
        assert_eq!(status.workflows.len(), 1);
        let (dispatch, revision) = dispatch_candidate(root.path(), &runtime).unwrap();
        assert_eq!(dispatch.digest, active);
        assert_eq!(revision, Some(1));
    }

    #[test]
    fn missing_candidate_source_does_not_disable_the_active_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path());
        let initialized =
            initialize_and_activate(root.path(), &runtime, "genet", Some("qwen3.8-flash")).unwrap();
        let active = initialized.active_digest.unwrap();
        fs::remove_dir_all(root.path().join(SOURCE_DIR)).unwrap();

        let status = inspect(root.path(), &runtime).unwrap();
        assert_eq!(status.candidate_digest, None);
        assert!(status
            .candidate_error
            .as_deref()
            .is_some_and(|error| error.contains("项目尚未初始化 Workflow")));
        assert_eq!(status.active_digest.as_deref(), Some(active.as_str()));
        assert!(status.source_changed);
        assert_eq!(status.workflows.len(), 1);
        let (dispatch, revision) = dispatch_candidate(root.path(), &runtime).unwrap();
        assert_eq!(dispatch.digest, active);
        assert_eq!(revision, Some(1));
    }

    #[test]
    fn a_failed_activation_save_keeps_the_previous_pointer() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path());
        let initialized =
            initialize_and_activate(root.path(), &runtime, "genet", Some("qwen3.8-flash")).unwrap();
        let active = initialized.active_digest.unwrap();
        fs::write(
            root.path()
                .join(".genethub/workflow/prompts/direct-worker.md"),
            "候选提示词。\n",
        )
        .unwrap();
        let activation_path = activation_path(&runtime, true).unwrap();
        crate::config::fail_next_private_save(&activation_path);
        assert!(activate_project(root.path(), &runtime, None, 1).is_err());

        let status = inspect(root.path(), &runtime).unwrap();
        assert_eq!(status.active_digest.as_deref(), Some(active.as_str()));
        assert_eq!(status.activation_revision, 1);
        assert!(status.source_changed);
    }

    #[test]
    fn corrupted_activation_history_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime(root.path());
        initialize_and_activate(root.path(), &runtime, "genet", Some("qwen3.8-flash")).unwrap();
        let mut activation = load_activation(&runtime).unwrap().unwrap();
        let active = activation.active_digest.clone();
        activation.history[0].previous_digest = Some(active);
        let path = activation_path(&runtime, false).unwrap();
        crate::config::save_private(&path, &serde_json::to_vec_pretty(&activation).unwrap())
            .unwrap();

        assert!(load_activation(&runtime)
            .unwrap_err()
            .to_string()
            .contains("前序摘要不连续"));
    }

    #[cfg(unix)]
    #[test]
    fn activation_runtime_cannot_escape_through_a_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "workspace", root.path()).unwrap();
        initialize_and_activate(root.path(), &runtime, "genet", Some("qwen3.8-flash")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let candidates = data.path().join("workflow-runtime/workspace/candidates");
        fs::remove_dir_all(&candidates).unwrap();
        symlink(outside.path(), &candidates).unwrap();
        assert!(inspect(root.path(), &runtime).is_err());
    }

    #[tokio::test]
    async fn project_local_runtime_never_enters_the_trusted_control_plane() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "workspace", project.path()).unwrap();
        let untrusted = project.path().join(".genethub/runtime/workflows");
        fs::create_dir_all(untrusted.join("runs")).unwrap();
        fs::write(untrusted.join("runs/wr_forged.json"), b"{}").unwrap();
        assert!(load_run(&runtime, "wr_forged")
            .unwrap_err()
            .to_string()
            .contains("不存在"));

        let lease = LeaseRecord {
            run_id: "wr_forged".into(),
            node_id: "implement".into(),
            repository: project.path().display().to_string(),
            target_ref: "refs/heads/main".into(),
            base_commit: "deadbeef".into(),
            expires_at_ms: i64::MAX,
        };
        let key = hex_digest(format!("{}\0{}", lease.repository, lease.target_ref).as_bytes());
        let untrusted_lease = untrusted.join(format!("ref-leases/{key}.json"));
        fs::create_dir_all(untrusted_lease.parent().unwrap()).unwrap();
        fs::write(&untrusted_lease, serde_json::to_vec(&lease).unwrap()).unwrap();

        release_lease(&runtime, &lease).await.unwrap();
        assert!(untrusted_lease.is_file());
        assert!(!runtime
            .directory(Path::new("ref-leases"), false)
            .unwrap()
            .join(format!("{key}.json"))
            .exists());
    }

    #[test]
    fn workflow_lock_guard_releases_through_the_cross_platform_api() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workflow.lock");
        let first = lock_exclusive_file(&path, "first lock contended").unwrap();
        assert!(try_exclusive_file_lock(&path).unwrap().is_none());
        drop(first);
        assert!(try_exclusive_file_lock(&path).unwrap().is_some());
    }

    #[test]
    fn workflow_local_lock_rejects_same_daemon_reentry() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workflow.lock");
        let first = LocalWorkflowLock::try_acquire(&path).unwrap().unwrap();
        assert!(LocalWorkflowLock::try_acquire(&path).unwrap().is_none());
        drop(first);
        assert!(LocalWorkflowLock::try_acquire(&path).unwrap().is_some());
    }

    #[tokio::test]
    async fn late_lease_release_preserves_a_successor_record() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "workspace", project.path()).unwrap();
        let directory = runtime.directory(Path::new("ref-leases"), true).unwrap();
        let old = LeaseRecord {
            run_id: "wr_old".into(),
            node_id: "implement".into(),
            repository: project.path().display().to_string(),
            target_ref: "refs/heads/main".into(),
            base_commit: "old".into(),
            expires_at_ms: 1,
        };
        let mut successor = old.clone();
        successor.run_id = "wr_new".into();
        successor.base_commit = "new".into();
        successor.expires_at_ms = i64::MAX;
        let key = hex_digest(format!("{}\0{}", old.repository, old.target_ref).as_bytes());
        let lease_path = directory.join(format!("{key}.json"));
        let guard_path = directory.join(format!("{key}.guard"));
        crate::config::save_private(&lease_path, &serde_json::to_vec(&old).unwrap()).unwrap();

        let acquisition = lock_exclusive_file(&guard_path, "fixture guard contended").unwrap();
        let release_runtime = runtime.clone();
        let release_old = old.clone();
        let release =
            tokio::spawn(async move { release_lease(&release_runtime, &release_old).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        crate::config::save_private(&lease_path, &serde_json::to_vec(&successor).unwrap()).unwrap();
        drop(acquisition);
        release.await.unwrap().unwrap();

        let current = load_lease_if_present(&lease_path).unwrap().unwrap();
        assert_eq!(current.run_id, successor.run_id);
        assert_eq!(current.base_commit, successor.base_commit);
    }

    #[test]
    fn trusted_runtime_survives_project_local_runtime_replacement() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "workspace", project.path()).unwrap();
        let initialized =
            initialize_and_activate(project.path(), &runtime, "genet", Some("qwen3.8-flash"))
                .unwrap();
        let active = initialized.active_digest.unwrap();

        let untrusted = project.path().join(".genethub/runtime/workflows");
        fs::create_dir_all(untrusted.join("candidates")).unwrap();
        fs::write(untrusted.join("activation.json"), br#"{"schema":"forged"}"#).unwrap();
        fs::write(untrusted.join("candidates/forged.json"), b"forged").unwrap();

        let status = inspect(project.path(), &runtime).unwrap();
        assert_eq!(status.active_digest.as_deref(), Some(active.as_str()));
        let (candidate, revision) = dispatch_candidate(project.path(), &runtime).unwrap();
        assert_eq!(candidate.digest, active);
        assert_eq!(revision, Some(1));
        assert!(activation_path(&runtime, false)
            .unwrap()
            .starts_with(data.path()));
        assert!(!activation_path(&runtime, false)
            .unwrap()
            .starts_with(project.path()));
    }

    #[test]
    fn candidate_digest_binds_the_normalized_execution_snapshot() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "workspace", project.path()).unwrap();
        let initialized =
            initialize_and_activate(project.path(), &runtime, "genet", Some("qwen3.8-flash"))
                .unwrap();
        let digest = initialized.active_digest.unwrap();
        let mut candidate = load_candidate(&runtime, &digest).unwrap();
        candidate
            .workflows
            .get_mut("direct-change")
            .unwrap()
            .definition
            .version += 1;
        candidate.snapshot_digest =
            digest_snapshot(&candidate.project, &candidate.catalog, &candidate.workflows).unwrap();

        assert!(validate_candidate(&candidate)
            .unwrap_err()
            .to_string()
            .contains("未绑定源文件与执行快照"));
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
            executor_workspace_id: None,
            parent_session_id: "s_root".into(),
            workflow_id: definition.id.clone(),
            dcg_digest: "sha256:dcg".into(),
            activation_revision: Some(1),
            bundle_digest: "sha256:test".into(),
            task_id: "task".into(),
            task_prompt: "publish".into(),
            status: "running".into(),
            revision: 0,
            executor_turns: 0,
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
    fn a_carrier_is_only_reported_busy_while_its_run_is_still_running() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "w_project", project.path()).unwrap();
        let carrier = |status: &str, executor: Option<&str>| RunRecord {
            id: format!("wr_{status}"),
            workspace_id: "w_project".into(),
            executor_workspace_id: executor.map(str::to_string),
            parent_session_id: "s_root".into(),
            workflow_id: "direct".into(),
            dcg_digest: "sha256:dcg".into(),
            activation_revision: Some(1),
            bundle_digest: "sha256:test".into(),
            task_id: "task".into(),
            task_prompt: "work".into(),
            status: status.into(),
            revision: 0,
            executor_turns: 0,
            definition: WorkflowDefinition {
                schema: DEFINITION_SCHEMA.into(),
                id: "direct".into(),
                version: 1,
                entry: "work".into(),
                nodes: Vec::new(),
            },
            roles: BTreeMap::new(),
            nodes: BTreeMap::new(),
            leases: BTreeMap::new(),
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        let busy = |space: &str| {
            carrier_has_active_run(data.path(), "w_project", project.path(), space).unwrap()
        };

        assert!(
            !busy("w_executor"),
            "a project that has never dispatched pins nothing"
        );
        save_run(&runtime, &carrier("completed", Some("w_executor"))).unwrap();
        assert!(
            !busy("w_executor"),
            "a settled Run must not keep its carrier pinned forever"
        );
        save_run(&runtime, &carrier("running", Some("w_executor"))).unwrap();
        assert!(busy("w_executor"));
        assert!(
            !busy("w_other"),
            "one busy carrier must not freeze the whole tree"
        );
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
    fn initializer_rejects_a_linked_visibility_file() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let home = project.path().join(".genethub");
        fs::create_dir(&home).unwrap();
        let target = outside.path().join("keep.txt");
        fs::write(&target, "outside stays unchanged\n").unwrap();
        symlink(&target, home.join(".gitignore")).unwrap();

        assert!(initialize_project(project.path(), "genet", Some("qwen3.8-flash")).is_err());
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            "outside stays unchanged\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn visibility_update_does_not_follow_a_swapped_path() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let home = project.path().join(".genethub");
        fs::create_dir(&home).unwrap();
        let visible = home.join(".gitignore");
        let opened_inode = home.join(".gitignore.opened");
        let target = outside.path().join("keep.txt");
        fs::write(&visible, "project-local\n").unwrap();
        fs::write(&target, "outside stays unchanged\n").unwrap();

        let error = ensure_source_visible_with(&home, |path| {
            fs::rename(path, &opened_inode)?;
            symlink(&target, path)?;
            Ok(())
        })
        .unwrap_err()
        .to_string();

        assert!(error.contains("symbolic link"), "{error}");
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            "outside stays unchanged\n"
        );
        let updated = fs::read_to_string(opened_inode).unwrap();
        assert!(updated.contains("!workflow/**"));
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
        let linked_project_runtime = test_runtime(linked_project_file.path());
        assert!(inspect(linked_project_file.path(), &linked_project_runtime).is_err());

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
        let linked_catalog_runtime = test_runtime(linked_catalog_file.path());
        assert!(inspect(linked_catalog_file.path(), &linked_catalog_runtime).is_err());

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
        let linked_workflows_runtime = test_runtime(linked_workflows_dir.path());
        assert!(inspect(linked_workflows_dir.path(), &linked_workflows_runtime).is_err());

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
