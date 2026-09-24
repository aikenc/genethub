//! PM-owned request state, Run lineage and finite shared bounds.
use super::*;

pub(super) const DEFAULT_MAX_REQUEST_RUNS: u32 = 3;
pub(super) const DEFAULT_REQUEST_DEADLINE_MS: u64 = 2 * 60 * 60 * 1000;
pub(super) const DEFAULT_MAX_LLM_ROUNDS: u64 = 256;
pub(super) const MAX_CONFIGURED_REQUEST_RUNS: u32 = 64;
pub(super) const MAX_CONFIGURED_REQUEST_DEADLINE_SECONDS: u64 = 7 * 24 * 60 * 60;
pub(super) const MAX_CONFIGURED_LLM_ROUNDS: u64 = 8_192;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestBudget {
    #[serde(default)]
    pub revision: u64,
    #[serde(default = "default_max_runs")]
    pub max_runs: u32,
    #[serde(default = "default_deadline_ms")]
    pub deadline_ms: u64,
    #[serde(default = "default_max_llm_rounds")]
    pub max_llm_rounds: u64,
}

impl Default for RequestBudget {
    fn default() -> Self {
        Self {
            revision: 0,
            max_runs: DEFAULT_MAX_REQUEST_RUNS,
            deadline_ms: DEFAULT_REQUEST_DEADLINE_MS,
            max_llm_rounds: DEFAULT_MAX_LLM_ROUNDS,
        }
    }
}

impl RequestBudget {
    pub(super) fn status(&self) -> WorkflowRequestBudgetStatus {
        WorkflowRequestBudgetStatus {
            revision: self.revision,
            max_runs: self.max_runs,
            deadline_ms: self.deadline_ms,
            max_llm_rounds: self.max_llm_rounds,
        }
    }
}

fn default_max_runs() -> u32 {
    DEFAULT_MAX_REQUEST_RUNS
}
fn default_deadline_ms() -> u64 {
    DEFAULT_REQUEST_DEADLINE_MS
}
fn default_max_llm_rounds() -> u64 {
    DEFAULT_MAX_LLM_ROUNDS
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestLink {
    pub original_message_id: String,
    pub root_run_id: String,
    #[serde(default)]
    pub budget: RequestBudget,
    pub retry_of: Option<String>,
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default)]
    pub cancelled_at_ms: i64,
    /// Whether the executor cancelled its own execution instead of the user
    /// withdrawing the request. Legacy records carry no actor and are read as
    /// a user cancellation, which is the stricter of the two.
    #[serde(default)]
    pub cancelled_by_agent: bool,
    #[serde(default)]
    pub resume_message_id: Option<String>,
}

/// The request is owned by PM, independently of any one execution Session.
/// Run snapshots retain a link for routing; this record owns the mutable goal
/// and limits shared by all Runs in the request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestRecord {
    schema: String,
    root_run_id: String,
    original_message_id: String,
    goal: String,
    budget: RequestBudget,
    cancelled: bool,
    cancelled_at_ms: i64,
    cancelled_by_agent: bool,
    resume_message_id: Option<String>,
    #[serde(default)]
    recovery_extra: RecoveryExtra,
    #[serde(default)]
    approved_human_exits: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryExtra {
    pub max_runs: u32,
    pub max_llm_rounds: u64,
    pub deadline_seconds: u64,
}

fn read_record(runtime: &RuntimeStore, root_run_id: &str) -> Result<RequestRecord> {
    let path = record_path(runtime, root_run_id, false)?;
    let metadata = crate::config::sensitive_metadata(&path)?;
    crate::config::reject_link_or_reparse(&path, &metadata)?;
    if !metadata.is_file() { bail!("Workflow request 不是普通文件"); }
    ensure_record_size("Workflow request", metadata.len(), MAX_RUN_RECORD_BYTES)?;
    let record: RequestRecord = serde_json::from_slice(&fs::read(&path)?)?;
    if record.schema != "genehub.workflow.request.v1" || record.root_run_id != root_run_id {
        bail!("Workflow request identity mismatch");
    }
    Ok(record)
}

pub(super) fn recovery_extra(runtime: &RuntimeStore, root_run_id: &str) -> Result<RecoveryExtra> {
    Ok(read_record(runtime, root_run_id)?.recovery_extra)
}

/// Called only after a daemon-authored Human question receives its answer.
/// The request ID is the idempotency key, so a crash between this write and
/// the Human exit receipt cannot spend approval twice.
pub(super) fn apply_human_budget(runtime: &RuntimeStore, root_run_id: &str, request_id: &str, kind: &str) -> Result<()> {
    let mut record = read_record(runtime, root_run_id)?;
    if record.approved_human_exits.iter().any(|id| id == request_id) { return Ok(()); }
    if record.approved_human_exits.len() >= 64 { bail!("Workflow Human approval history is full"); }
    match kind {
        "a" => {
            record.budget.max_runs = record.budget.max_runs.saturating_add(1).min(MAX_CONFIGURED_REQUEST_RUNS);
            record.budget.max_llm_rounds = record.budget.max_llm_rounds.saturating_add(128).min(MAX_CONFIGURED_LLM_ROUNDS);
            record.budget.deadline_ms = record.budget.deadline_ms.saturating_add(3_600_000)
                .min(MAX_CONFIGURED_REQUEST_DEADLINE_SECONDS.saturating_mul(1000));
            record.budget.revision = record.budget.revision.saturating_add(1);
        }
        "c" => {
            record.recovery_extra.max_runs = record.recovery_extra.max_runs.saturating_add(1).min(recovery::MAX_RECOVERY_RUNS);
            record.recovery_extra.max_llm_rounds = record.recovery_extra.max_llm_rounds.saturating_add(100).min(recovery::MAX_RECOVERY_LLM_ROUNDS);
            record.recovery_extra.deadline_seconds = record.recovery_extra.deadline_seconds.saturating_add(1800).min(recovery::MAX_RECOVERY_DEADLINE_SECONDS);
        }
        _ => bail!("Human exit {kind} does not adjust a budget"),
    }
    record.approved_human_exits.push(request_id.into());
    crate::config::save_private(&record_path(runtime, root_run_id, true)?, &encode_private_record("Workflow request", &record, MAX_RUN_RECORD_BYTES)?)
}

fn record_path(runtime: &RuntimeStore, root_run_id: &str, create: bool) -> Result<PathBuf> {
    validate_id(root_run_id, "request id")?;
    Ok(runtime.directory(&Path::new("requests").join(root_run_id), create)?.join("request.json"))
}

pub(super) fn save_record(runtime: &RuntimeStore, run: &RunRecord) -> Result<()> {
    if group_id(run) != run.id { return Ok(()); }
    let Some(link) = run.request.as_ref() else { return Ok(()); };
    let existing = match crate::config::sensitive_metadata(&record_path(runtime, &run.id, false)?) {
        Ok(_) => Some(read_record(runtime, &run.id)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let record = RequestRecord {
        schema: "genehub.workflow.request.v1".into(),
        root_run_id: run.id.clone(),
        original_message_id: link.original_message_id.clone(),
        goal: run.task_prompt.clone(),
        budget: existing.as_ref().filter(|record| record.budget.revision > link.budget.revision)
            .map(|record| record.budget.clone()).unwrap_or_else(|| link.budget.clone()),
        cancelled: link.cancelled,
        cancelled_at_ms: link.cancelled_at_ms,
        cancelled_by_agent: link.cancelled_by_agent,
        resume_message_id: link.resume_message_id.clone(),
        recovery_extra: existing.as_ref().map(|record| record.recovery_extra.clone()).unwrap_or_default(),
        approved_human_exits: existing.map(|record| record.approved_human_exits).unwrap_or_default(),
    };
    let body = encode_private_record("Workflow request", &record, MAX_RUN_RECORD_BYTES)?;
    crate::config::save_private(&record_path(runtime, &run.id, true)?, &body)
}

pub(super) fn load_record(runtime: &RuntimeStore, run: &mut RunRecord) -> Result<()> {
    if group_id(run) != run.id || run.request.is_none() { return Ok(()); }
    let record = read_record(runtime, &run.id)?;
    if record.goal != run.task_prompt {
        bail!("Workflow request identity mismatch");
    }
    let link = run.request.as_mut().ok_or_else(|| anyhow!("request root has no link"))?;
    link.original_message_id = record.original_message_id;
    link.budget = record.budget;
    link.cancelled = record.cancelled;
    link.cancelled_at_ms = record.cancelled_at_ms;
    link.cancelled_by_agent = record.cancelled_by_agent;
    link.resume_message_id = record.resume_message_id;
    Ok(())
}

pub(super) fn budget(run: &RunRecord) -> RequestBudget {
    run.request
        .as_ref()
        .map(|request| request.budget.clone())
        .unwrap_or_default()
}

pub(super) fn group_id(run: &RunRecord) -> &str {
    run.request
        .as_ref()
        .map(|request| request.root_run_id.as_str())
        .unwrap_or(&run.id)
}

/// Charge execution and cleanup, not the time a terminal Run awaits a new request.
/// The stored terminal timestamp is stable across notice delivery and restart.
pub(super) fn execution_ms(run: &RunRecord, now: i64) -> i64 {
    let end = if matches!(run.status.as_str(), "running" | "stopping" | "cancelling") {
        now
    } else {
        run.updated_at_ms
    };
    let pending_wait = if run.status == "running"
        && run.supervision.waiting
        && run.supervision.last_checked_at_ms > 0
    {
        end.saturating_sub(run.supervision.last_checked_at_ms)
            .max(0)
    } else {
        0
    };
    end.saturating_sub(run.created_at_ms)
        .saturating_sub(run.supervision.human_wait_ms)
        .saturating_sub(run.supervision.recovery_wait_ms)
        .saturating_sub(pending_wait)
        .max(0)
}

pub(super) fn activities(
    run: &RunRecord,
) -> impl Iterator<Item = &crate::session::store::ExecutionActivity> {
    run.nodes
        .values()
        .flat_map(|node| {
            node.prior_activity
                .iter()
                .chain(std::iter::once(&node.activity))
        })
}

/// One accounting projection for graph queries, check and admission. Replace
/// the persisted current Run with its in-memory version, without double counting.
pub(super) fn observation(
    runs: &[RunRecord],
    run: &RunRecord,
    now: i64,
) -> Result<genehub_proto::WorkflowRequestBudgetSnapshot> {
    let group = runs
        .iter()
        .filter(|other| group_id(other) == group_id(run) && other.id != run.id && other.handles.is_empty())
        .chain(std::iter::once(run).filter(|run| run.handles.is_empty()))
        .collect::<Vec<_>>();
    let root = group
        .iter()
        .find(|other| other.id == group_id(run))
        .ok_or_else(|| anyhow!("missing request root {}", group_id(run)))?;
    let budget = budget(root).status();
    let execution_ms = group.iter().fold(0u64, |sum, other| {
        sum.saturating_add(execution_ms(other, now) as u64)
    });
    let observed_llm_rounds = group
        .iter()
        .flat_map(|other| activities(other))
        .fold(0u64, |sum, activity| {
            sum.saturating_add(activity.llm_rounds)
        });
    let used_runs = group.len().min(u32::MAX as usize) as u32;
    Ok(genehub_proto::WorkflowRequestBudgetSnapshot {
        request_run_id: group_id(run).into(),
        observed_at_ms: now,
        remaining_runs: budget.max_runs.saturating_sub(used_runs),
        remaining_llm_rounds: budget.max_llm_rounds.saturating_sub(observed_llm_rounds),
        remaining_execution_ms: budget.deadline_ms.saturating_sub(execution_ms),
        budget,
        used_runs,
        observed_llm_rounds,
        execution_ms,
    })
}

pub(super) fn snapshot(
    runtime: &RuntimeStore,
    run: &RunRecord,
    now: i64,
) -> Result<genehub_proto::WorkflowRequestBudgetSnapshot> {
    observation(&request_runs(runtime, group_id(run))?, run, now)
}

pub(super) fn budget_exhausted(runtime: &RuntimeStore, run: &RunRecord, now: i64) -> Result<bool> {
    if !run.handles.is_empty() { return recovery::budget_exhausted(runtime, run, now); }
    let snapshot = snapshot(runtime, run, now)?;
    Ok(snapshot.remaining_llm_rounds == 0
        || (!run.supervision.waiting && snapshot.remaining_execution_ms == 0))
}

pub(super) fn request_lock(runtime: &RuntimeStore, root: &str) -> Result<ExclusiveFileLock> {
    lock_run(runtime, &format!("request-{root}"))
}

pub(super) fn ensure_open(runtime: &RuntimeStore, run: &RunRecord) -> Result<()> {
    let root = load_run(runtime, group_id(run))?;
    if cancelled(&root) {
        bail!(
            "taskCancelled: the original request was cancelled; explicit user recovery is required"
        );
    }
    Ok(())
}

pub(super) fn cancelled(root: &RunRecord) -> bool {
    // A root Run may stay cancelled after an explicit retry reopens its
    // request. The request fence, not that old attempt's status, owns the
    // entire retry group.
    root.request
        .as_ref()
        .map(|request| request.cancelled)
        .unwrap_or(matches!(root.status.as_str(), "cancelling" | "cancelled"))
}

pub(super) async fn association(
    state: &Shared,
    runtime: &RuntimeStore,
    parent: &str,
    run_id: &str,
    retry_of: Option<&str>,
) -> Result<RequestLink> {
    let (message_id, task_run, _) = state.sessions.current_request(parent).await?;
    let runs = all_runs(runtime)?;
    let previous = match retry_of.or(task_run.as_deref()) {
        Some(id) => {
            let run = load_run(runtime, id)?;
            if run.parent_session_id != parent
                && !exception_authority(state, &run.workspace_id, parent).await?
            {
                bail!("retry target belongs to another PM session");
            }
            Some(run)
        }
        None => message_id
            .as_ref()
            .and_then(|message| {
                runs.iter().find(|run| {
                    run.parent_session_id == parent
                        && run
                            .request
                            .as_ref()
                            .is_some_and(|request| &request.original_message_id == message)
                })
            })
            .cloned(),
    };
    if let Some(previous) = previous {
        let root = load_run(runtime, group_id(&previous))?;
        return Ok(RequestLink {
            original_message_id: root
                .request
                .as_ref()
                .map(|request| request.original_message_id.clone())
                .unwrap_or_else(|| format!("legacy:{}", root.id)),
            root_run_id: root.id,
            retry_of: Some(previous.id),
            budget: root
                .request
                .as_ref()
                .map(|request| request.budget.clone())
                .unwrap_or_default(),
            ..Default::default()
        });
    }
    Ok(RequestLink {
        original_message_id: message_id.unwrap_or_else(|| format!("legacy:{run_id}")),
        root_run_id: run_id.into(),
        ..Default::default()
    })
}

pub(super) async fn admit(
    state: &Shared,
    runtime: &RuntimeStore,
    parent: &str,
    link: &RequestLink,
    resume_cancelled: bool,
) -> Result<()> {
    if link.retry_of.is_none() {
        return Ok(());
    }
    let mut root = load_run(runtime, &link.root_run_id)?;
    let group = request_runs(runtime, &link.root_run_id)?;
    let snapshot = observation(&group, &root, now_ms())?;
    if snapshot.remaining_runs == 0 {
        bail!(
            "requestBudgetExceeded: the original request has reached its {} Run limit",
            snapshot.budget.max_runs
        );
    }
    if snapshot.remaining_execution_ms == 0 {
        bail!("requestBudgetExceeded: the original request has exceeded its execution deadline");
    }
    if snapshot.remaining_llm_rounds == 0 {
        bail!("requestBudgetExceeded: the original request has exhausted its LLM call allowance");
    }
    // `recoverable` is deliberately absent: it means a Run is stuck, and
    // reworking it is the standard response to being stuck. Requiring an
    // explicit cancel first added a step that could only ever be answered
    // one way. The states kept here are the ones where execution is still
    // genuinely in motion and a second Run would race it.
    if group.iter().any(|run| {
        matches!(run.status.as_str(), "running" | "stopping" | "cancelling")
    }) {
        bail!("activeRunConflict: finish or cancel the previous execution before rework");
    }
    if root
        .request
        .as_ref()
        .map(|request| request.cancelled)
        .unwrap_or(root.status == "cancelled")
    {
        let (message_id, _, user_input) = state.sessions.current_request(parent).await?;
        let cancelled_at = root
            .request
            .as_ref()
            .map(|request| request.cancelled_at_ms)
            .filter(|at| *at > 0)
            .unwrap_or(root.updated_at_ms);
        let after_cancellation = match message_id.as_deref() {
            Some(id) => {
                state
                    .sessions
                    .user_input_after(parent, id, cancelled_at)
                    .await?
            }
            None => false,
        };
        // Nothing was withdrawn when the executor cancelled its own stuck
        // execution, so the request budget is the limiter and the explicit
        // flag is what keeps the resumption deliberate. A user cancellation
        // still needs the user back.
        let by_agent = root
            .request
            .as_ref()
            .is_some_and(|request| request.cancelled_by_agent);
        if by_agent {
            if !resume_cancelled {
                bail!(
                    "taskCancelled: resuming an execution the executor cancelled needs explicit --resume-cancelled"
                );
            }
        } else if !resume_cancelled
            || !user_input
            || !after_cancellation
            || message_id.as_deref() == Some(&link.original_message_id)
            || message_id.is_none()
        {
            bail!(
                "taskCancelled: recovery needs a new user message after cancellation and explicit --resume-cancelled"
            );
        }
        let mut request = root.request.take().unwrap_or_else(|| RequestLink {
            root_run_id: root.id.clone(),
            original_message_id: link.original_message_id.clone(),
            ..Default::default()
        });
        if !by_agent && request.resume_message_id == message_id {
            bail!("this recovery message was already consumed");
        }
        request.cancelled = false;
        request.cancelled_by_agent = false;
        request.resume_message_id = message_id;
        root.request = Some(request);
        root.revision += 1;
        save_run(runtime, &root)?;
    }
    Ok(())
}
