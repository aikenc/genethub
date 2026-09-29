//! PM-owned request state, Run lineage and finite shared bounds.
use super::*;

pub(super) const DEFAULT_MAX_REQUEST_RUNS: u32 = 3;
pub(super) const DEFAULT_MAX_LLM_ROUNDS: u64 = 256;
pub(super) const MAX_CONFIGURED_REQUEST_RUNS: u32 = 64;
pub(super) const MAX_CONFIGURED_LLM_ROUNDS: u64 = 8_192;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestBudget {
    #[serde(default)]
    pub revision: u64,
    #[serde(default = "default_max_runs")]
    pub max_runs: u32,
    #[serde(default = "default_max_llm_rounds")]
    pub max_llm_rounds: u64,
}

impl Default for RequestBudget {
    fn default() -> Self {
        Self {
            revision: 0,
            max_runs: DEFAULT_MAX_REQUEST_RUNS,
            max_llm_rounds: DEFAULT_MAX_LLM_ROUNDS,
        }
    }
}

impl RequestBudget {
    pub(super) fn status(&self) -> WorkflowRequestBudgetStatus {
        WorkflowRequestBudgetStatus {
            revision: self.revision,
            max_runs: self.max_runs,
            max_llm_rounds: self.max_llm_rounds,
        }
    }
}

fn default_max_runs() -> u32 {
    DEFAULT_MAX_REQUEST_RUNS
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
    #[serde(default)]
    pub(super) requirement: genehub_proto::WorkflowRequirementStatus,
    #[serde(default)]
    pub(super) latest_business_run: String,
    #[serde(default)]
    pub(super) next_check_at_ms: i64,
    #[serde(default)]
    pub(super) patrol_failures: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryExtra {
    pub max_runs: u32,
    pub max_llm_rounds: u64,
}

pub(super) fn stopped(run: &RunRecord) -> bool {
    run.program_result().is_some() || !run.unfinished()
}

pub(super) fn read_record(runtime: &RuntimeStore, root_run_id: &str) -> Result<RequestRecord> {
    let path = record_path(runtime, root_run_id, false)?;
    let metadata = crate::config::sensitive_metadata(&path)?;
    crate::config::reject_link_or_reparse(&path, &metadata)?;
    if !metadata.is_file() {
        bail!("Workflow request 不是普通文件");
    }
    ensure_record_size("Workflow request", metadata.len(), MAX_RUN_RECORD_BYTES)?;
    let record: RequestRecord = serde_json::from_slice(&fs::read(&path)?)?;
    if record.schema != "genehub.workflow.request.v2" || record.root_run_id != root_run_id {
        bail!("Workflow request identity mismatch");
    }
    Ok(record)
}

/// Resolve an implicit retry from PM's request record. Parsing every Run in
/// the project would let one unrelated damaged snapshot block a new request.
fn root_for_message(runtime: &RuntimeStore, message_id: &str) -> Result<Option<String>> {
    let directory = runtime.directory(Path::new("requests"), false)?;
    let listing = match fs::read_dir(&directory) {
        Ok(listing) => listing,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("读取 Workflow PM request 目录"),
    };
    let mut found = None;
    for entry in listing {
        let entry = entry?;
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Err(error) = validate_id(&id, "request id") {
            // An invalid directory name cannot identify a committed request.
            tracing::warn!(request_id = %id, %error, "ignoring invalid Workflow request directory");
            continue;
        }
        let record = match read_record(runtime, &id) {
            Ok(record) => record,
            Err(error) if !run_path(runtime, &id, false)?.exists() => {
                // A dispatch reserves its request directory before committing
                // the root Run locator. An unreadable reservation has no
                // committed request to associate with this PM message.
                tracing::warn!(request_id = %id, %error, "ignoring uncommitted Workflow request reservation");
                continue;
            }
            Err(error) => {
                // The immutable root snapshot can prove that a damaged
                // request record belongs to another PM message. If it cannot
                // prove that, fail closed: silently making a second root for
                // the same message would duplicate work and side effects.
                match load_run_indexed_raw(runtime, &id) {
                    Ok(root)
                        if group_id(&root) == id
                            && root
                                .request
                                .as_ref()
                                .is_some_and(|link| link.original_message_id != message_id) =>
                    {
                        tracing::warn!(request_id = %id, %error,
                            "ignoring unrelated damaged Workflow request record");
                        continue;
                    }
                    Ok(_) => {}
                    Err(snapshot_error) => tracing::warn!(request_id = %id, %snapshot_error,
                        "cannot establish ownership of damaged Workflow request"),
                }
                return Err(error).with_context(|| format!("读取 Workflow 请求 {id}"));
            }
        };
        if record.original_message_id == message_id && found.replace(record.root_run_id).is_some() {
            bail!("多个 Workflow 请求绑定同一 PM 消息");
        }
    }
    Ok(found)
}

pub(super) fn recovery_extra(runtime: &RuntimeStore, root_run_id: &str) -> Result<RecoveryExtra> {
    Ok(read_record(runtime, root_run_id)?.recovery_extra)
}

/// Fixed Human grant contract, shared by the decision card and accounting.
/// Free-text reasons never select or change these amounts.
pub(super) struct HumanBudgetGrant {
    pub runs: u32,
    pub llm_rounds: u64,
    pub scope: &'static str,
}

impl HumanBudgetGrant {
    pub fn description(&self) -> String {
        format!(
            "最多增加 {} 次{}、{} 轮 LLM",
            self.runs, self.scope, self.llm_rounds
        )
    }
}

pub(super) fn human_budget_grant(kind: &str) -> Option<HumanBudgetGrant> {
    match kind {
        "a" => Some(HumanBudgetGrant {
            runs: 1,
            llm_rounds: 128,
            scope: "业务 Run",
        }),
        "c" => Some(HumanBudgetGrant {
            runs: 1,
            llm_rounds: 100,
            scope: "恢复",
        }),
        _ => None,
    }
}

/// Called only after a daemon-authored Human question receives its answer.
/// The request ID is the idempotency key, so a crash between this write and
/// the Human exit receipt cannot spend approval twice.
pub(super) fn apply_human_budget(
    runtime: &RuntimeStore,
    root_run_id: &str,
    request_id: &str,
    kind: &str,
) -> Result<()> {
    let mut record = read_record(runtime, root_run_id)?;
    if record
        .approved_human_exits
        .iter()
        .any(|id| id == request_id)
    {
        return Ok(());
    }
    if record.approved_human_exits.len() >= 64 {
        bail!("Workflow Human approval history is full");
    }
    let grant = human_budget_grant(kind).ok_or_else(|| {
        crate::rpc_error::failure(
            genehub_proto::ErrorCode::Unsupported,
            format!("Human exit {kind} does not adjust a budget"),
        )
    })?;
    match kind {
        "a" => {
            record.budget.max_runs = record
                .budget
                .max_runs
                .saturating_add(grant.runs)
                .min(MAX_CONFIGURED_REQUEST_RUNS);
            record.budget.max_llm_rounds = record
                .budget
                .max_llm_rounds
                .saturating_add(grant.llm_rounds)
                .min(MAX_CONFIGURED_LLM_ROUNDS);
            record.budget.revision = record.budget.revision.saturating_add(1);
        }
        "c" => {
            record.recovery_extra.max_runs = record
                .recovery_extra
                .max_runs
                .saturating_add(grant.runs)
                .min(recovery::MAX_RECOVERY_RUNS);
            record.recovery_extra.max_llm_rounds = record
                .recovery_extra
                .max_llm_rounds
                .saturating_add(grant.llm_rounds)
                .min(recovery::MAX_RECOVERY_LLM_ROUNDS);
        }
        _ => {
            unreachable!("only Human exits a and c carry a budget grant")
        }
    }
    record.approved_human_exits.push(request_id.into());
    crate::config::save_private(
        &record_path(runtime, root_run_id, true)?,
        &encode_private_record("Workflow request", &record, MAX_RUN_RECORD_BYTES)?,
    )
}

pub(super) fn validate_proposal(
    runtime: &RuntimeStore,
    run: &RunRecord,
    proposal: &genehub_proto::WorkflowBudgetProposal,
) -> Result<()> {
    if !(1..=MAX_CONFIGURED_LLM_ROUNDS).contains(&proposal.max_llm_rounds)
        || !(1..=MAX_CONFIGURED_REQUEST_RUNS).contains(&proposal.max_runs)
    {
        bail!("预算需要有效的 Run 次数和 LLM 请求次数上限");
    }
    let observed = snapshot(runtime, run, now_ms())?;
    let current = &observed.budget;
    if proposal.expected_revision != current.revision {
        bail!("budgetProposalStale: 预算已改变，请读取当前预算后重新提出方案");
    }
    if proposal.max_llm_rounds < current.max_llm_rounds
        || proposal.max_runs < current.max_runs
        || (proposal.max_llm_rounds == current.max_llm_rounds
            && proposal.max_runs == current.max_runs)
    {
        bail!("预算申请必须提高至少一项上限，不能降低另一项");
    }
    if proposal.max_llm_rounds <= observed.observed_llm_rounds
        || proposal.max_runs <= observed.used_runs
    {
        bail!("budgetProposalInsufficient: 该方案批准后仍没有可用额度");
    }
    Ok(())
}

pub(super) fn apply_human_decision(
    runtime: &RuntimeStore,
    run: &RunRecord,
    exit: &recovery::HumanExit,
    answer: &str,
) -> Result<()> {
    if answer == "approve" && matches!(exit.kind.as_str(), "a" | "c") && exit.budget.is_none() {
        return apply_human_budget(runtime, group_id(run), &exit.request_id, &exit.kind);
    }
    let mut record = read_record(runtime, group_id(run))?;
    if record
        .approved_human_exits
        .iter()
        .any(|id| id == &exit.request_id)
    {
        return Ok(());
    }
    if record.approved_human_exits.len() >= 64 {
        bail!("Workflow Human decision history is full");
    }
    if answer == "approve" && exit.kind == "a" {
        let proposal = exit
            .budget
            .as_ref()
            .ok_or_else(|| anyhow!("预算卡缺少明确方案"))?;
        validate_proposal(runtime, run, proposal)?;
        record.budget.max_llm_rounds = proposal.max_llm_rounds;
        record.budget.max_runs = proposal.max_runs;
        record.budget.revision = record.budget.revision.saturating_add(1);
    } else if answer == "acceptScope" && exit.kind == "b" {
        if let Some(scope) = &exit.scope {
            record.requirement.scope = Some(scope.clone());
            record.requirement.revision = record.requirement.revision.saturating_add(1);
        }
    } else {
        return Ok(());
    }
    record.approved_human_exits.push(exit.request_id.clone());
    write_record(runtime, group_id(run), &record)
}

fn record_path(runtime: &RuntimeStore, root_run_id: &str, create: bool) -> Result<PathBuf> {
    validate_id(root_run_id, "request id")?;
    Ok(runtime
        .directory(&Path::new("requests").join(root_run_id), create)?
        .join("request.json"))
}

pub(super) fn save_record(runtime: &RuntimeStore, run: &RunRecord) -> Result<()> {
    if group_id(run) != run.id {
        return Ok(());
    }
    let Some(link) = run.request.as_ref() else {
        return Ok(());
    };
    let existing = match crate::config::sensitive_metadata(&record_path(runtime, &run.id, false)?) {
        Ok(_) => Some(read_record(runtime, &run.id)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let record = RequestRecord {
        schema: "genehub.workflow.request.v2".into(),
        root_run_id: run.id.clone(),
        original_message_id: link.original_message_id.clone(),
        goal: run.task_prompt.clone(),
        budget: existing
            .as_ref()
            .filter(|record| record.budget.revision > link.budget.revision)
            .map(|record| record.budget.clone())
            .unwrap_or_else(|| link.budget.clone()),
        cancelled: link.cancelled,
        cancelled_at_ms: link.cancelled_at_ms,
        cancelled_by_agent: link.cancelled_by_agent,
        resume_message_id: link.resume_message_id.clone(),
        recovery_extra: existing
            .as_ref()
            .map(|record| record.recovery_extra.clone())
            .unwrap_or_default(),
        requirement: existing
            .as_ref()
            .map(|r| r.requirement.clone())
            .unwrap_or_default(),
        latest_business_run: existing
            .as_ref()
            .map(|r| r.latest_business_run.clone())
            .unwrap_or_default(),
        next_check_at_ms: existing
            .as_ref()
            .map(|r| r.next_check_at_ms)
            .unwrap_or_default(),
        patrol_failures: existing
            .as_ref()
            .map(|r| r.patrol_failures)
            .unwrap_or_default(),
        approved_human_exits: existing
            .map(|record| record.approved_human_exits)
            .unwrap_or_default(),
    };
    let body = encode_private_record("Workflow request", &record, MAX_RUN_RECORD_BYTES)?;
    crate::config::save_private(&record_path(runtime, &run.id, true)?, &body)
}

pub(super) fn load_record(runtime: &RuntimeStore, run: &mut RunRecord) -> Result<()> {
    if group_id(run) != run.id || run.request.is_none() {
        return Ok(());
    }
    let record = read_record(runtime, &run.id)?;
    if record.goal != run.task_prompt {
        bail!("Workflow request identity mismatch");
    }
    let link = run
        .request
        .as_mut()
        .ok_or_else(|| anyhow!("request root has no link"))?;
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

pub(super) fn activities(
    run: &RunRecord,
) -> impl Iterator<Item = &crate::session::store::ExecutionActivity> {
    run.nodes.values().flat_map(|node| {
        node.prior_activity
            .iter()
            .chain(std::iter::once(&node.activity))
    })
}

/// One accounting projection for graph queries, check and admission. Replace
/// the persisted current Run with its in-memory version, without double counting.
pub(super) fn observation(
    runtime: &RuntimeStore,
    runs: &[RunRecord],
    run: &RunRecord,
    now: i64,
) -> Result<genehub_proto::WorkflowRequestBudgetSnapshot> {
    let group = runs
        .iter()
        .filter(|other| {
            group_id(other) == group_id(run) && other.id != run.id && other.handles.is_empty()
        })
        .chain(std::iter::once(run).filter(|run| run.handles.is_empty()))
        .collect::<Vec<_>>();
    let root = group
        .iter()
        .find(|other| other.id == group_id(run))
        .ok_or_else(|| anyhow!("missing request root {}", group_id(run)))?;
    let budget = read_record(runtime, group_id(run))?.budget.status();
    let observed_llm_rounds = group
        .iter()
        .flat_map(|other| activities(other))
        .fold(0u64, |sum, activity| {
            sum.saturating_add(activity.llm_rounds)
        });
    let used_runs = group.len().min(u32::MAX as usize) as u32;
    Ok(genehub_proto::WorkflowRequestBudgetSnapshot {
        current_run_admitted: true,
        current_run_can_execute: run.status() == "running"
            && !cancelled(root)
            && budget.max_llm_rounds > observed_llm_rounds,
        request_run_id: group_id(run).into(),
        observed_at_ms: now,
        remaining_runs: budget.max_runs.saturating_sub(used_runs),
        remaining_llm_rounds: budget.max_llm_rounds.saturating_sub(observed_llm_rounds),
        budget,
        used_runs,
        observed_llm_rounds,
    })
}

pub(super) fn snapshot(
    runtime: &RuntimeStore,
    run: &RunRecord,
    now: i64,
) -> Result<genehub_proto::WorkflowRequestBudgetSnapshot> {
    let mut snapshot = observation(runtime, &request_runs(runtime, group_id(run))?, run, now)?;
    if !run.handles.is_empty() {
        snapshot.current_run_can_execute = run.status() == "running"
            && !cancelled(&load_run(runtime, group_id(run))?)
            && !recovery::budget_exhausted(runtime, run, now)?;
    }
    Ok(snapshot)
}

pub(super) fn budget_exhausted(runtime: &RuntimeStore, run: &RunRecord, now: i64) -> Result<bool> {
    if !run.handles.is_empty() {
        return recovery::budget_exhausted(runtime, run, now);
    }
    let snapshot = snapshot(runtime, run, now)?;
    Ok(snapshot.remaining_llm_rounds == 0)
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
        .map(|request| request.cancelled && !request.cancelled_by_agent)
        .unwrap_or(matches!(root.status(), "cancelling" | "cancelled"))
}

pub(super) async fn association(
    state: &Shared,
    runtime: &RuntimeStore,
    parent: &str,
    run_id: &str,
    retry_of: Option<&str>,
) -> Result<RequestLink> {
    let (message_id, task_run, _) = state.sessions.current_request(parent).await?;
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
        None => match message_id.as_deref() {
            Some(message) => match root_for_message(runtime, message)? {
                Some(id) => {
                    let run = load_run(runtime, &id)?;
                    if run.parent_session_id != parent {
                        bail!("request target belongs to another PM session");
                    }
                    Some(run)
                }
                None => None,
            },
            None => None,
        },
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
    let goal = super::requirement::status(runtime, &root)?;
    if goal.state == genehub_proto::WorkflowRequirementState::Completed {
        let (message, _, user) = state.sessions.current_request(parent).await?;
        let fresh = match message.as_deref() {
            Some(id) if user => {
                state
                    .sessions
                    .user_input_after(parent, id, goal.completed_at_ms.unwrap_or(i64::MAX))
                    .await?
            }
            _ => false,
        };
        if !fresh {
            bail!("requirementCompleted: a later user input is needed to reopen this goal");
        }
    }
    let snapshot = observation(runtime, &group, &root, now_ms())?;
    if snapshot.remaining_runs == 0 {
        bail!(
            "requestBudgetExceeded: the original request has reached its {} Run limit",
            snapshot.budget.max_runs
        );
    }
    if snapshot.remaining_llm_rounds == 0 {
        bail!("requestBudgetExceeded: the original request has exhausted its LLM call allowance");
    }
    // `recoverable` is deliberately absent: it means a Run is stuck, and
    // reworking it is the standard response to being stuck. Requiring an
    // explicit cancel first added a step that could only ever be answered
    // one way. The states kept here are the ones where execution is still
    // genuinely in motion and a second Run would race it.
    if group
        .iter()
        .any(|run| matches!(run.status(), "running" | "stopping" | "cancelling"))
    {
        bail!("activeRunConflict: finish or cancel the previous execution before rework");
    }
    if root
        .request
        .as_ref()
        .map(|request| request.cancelled)
        .unwrap_or(root.status() == "cancelled")
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

/// Callers hold the requirement operation lock and verified writer.
pub(super) fn write_record(runtime: &RuntimeStore, id: &str, record: &RequestRecord) -> Result<()> {
    let mut record = record.clone();
    record.schema = "genehub.workflow.request.v2".into();
    invalidate_settled_marker(runtime, id)?;
    crate::config::save_private(
        &record_path(runtime, id, true)?,
        &encode_private_record("Workflow request", &record, MAX_RUN_RECORD_BYTES)?,
    )
}
