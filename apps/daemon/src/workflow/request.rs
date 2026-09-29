//! PM-owned request state, Run lineage and finite shared bounds.
use super::*;

pub(super) const DEFAULT_REQUEST_DEADLINE_MS: u64 = 2 * 60 * 60 * 1000;
pub(super) const DEFAULT_MAX_LLM_ROUNDS: u64 = 256;
pub(super) const MAX_CONFIGURED_REQUEST_DEADLINE_SECONDS: u64 = 7 * 24 * 60 * 60;
pub(super) const MAX_CONFIGURED_LLM_ROUNDS: u64 = 8_192;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestBudget {
    #[serde(default)]
    pub revision: u64,
    #[serde(default = "default_deadline_ms")]
    pub deadline_ms: u64,
    #[serde(default = "default_max_llm_rounds")]
    pub max_llm_rounds: u64,
}

impl Default for RequestBudget {
    fn default() -> Self {
        Self {
            revision: 0,
            deadline_ms: DEFAULT_REQUEST_DEADLINE_MS,
            max_llm_rounds: DEFAULT_MAX_LLM_ROUNDS,
        }
    }
}

impl RequestBudget {
    pub(super) fn status(&self) -> WorkflowRequestBudgetStatus {
        WorkflowRequestBudgetStatus {
            revision: self.revision,
            deadline_ms: self.deadline_ms,
            max_llm_rounds: self.max_llm_rounds,
        }
    }
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

/// Activity intervals live in the existing Run supervision snapshot. Closing
/// an interval is atomic with the state transition; later bookkeeping cannot
/// move its end. Request usage is the union across all related Runs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExecutionClock {
    pub intervals: Vec<(i64, i64)>,
    pub active_since_ms: Option<i64>,
    /// Journal seq of the state event that ended the latest execution
    /// segment. Answers, notices and budget edits append later events
    /// without moving it, so recovery admission keys on this boundary.
    #[serde(default)]
    pub stop_seq: Option<u64>,
}

impl ExecutionClock {
    fn intervals_at(&self, now: i64) -> Vec<(i64, i64)> {
        let mut intervals = self.intervals.clone();
        if let Some(start) = self.active_since_ms { intervals.push((start, now.max(start))); }
        intervals
    }
}

fn union_ms(mut intervals: Vec<(i64, i64)>) -> u64 {
    intervals.sort_unstable();
    let mut elapsed = 0u64;
    let mut end = i64::MIN;
    for (start, stop) in intervals {
        elapsed = elapsed.saturating_add(stop.saturating_sub(start.max(end)).max(0) as u64);
        end = end.max(stop);
    }
    elapsed
}

pub(super) fn read_record(runtime: &RuntimeStore, root_run_id: &str) -> Result<RequestRecord> {
    let path = record_path(runtime, root_run_id, false)?;
    let metadata = crate::config::sensitive_metadata(&path)?;
    crate::config::reject_link_or_reparse(&path, &metadata)?;
    if !metadata.is_file() { bail!("Workflow request 不是普通文件"); }
    ensure_record_size("Workflow request", metadata.len(), MAX_RUN_RECORD_BYTES)?;
    let record: RequestRecord = serde_json::from_slice(&fs::read(&path)?)?;
    if !matches!(record.schema.as_str(), "genehub.workflow.request.v1" | "genehub.workflow.request.v2") || record.root_run_id != root_run_id {
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
        let Some(id) = entry.file_name().to_str().map(str::to_string) else { continue; };
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
                    Ok(root) if group_id(&root) == id && root.request.as_ref()
                        .is_some_and(|link| link.original_message_id != message_id) => {
                        tracing::warn!(request_id = %id, %error,
                            "ignoring unrelated damaged Workflow request record");
                        continue;
                    }
                    Ok(_) => {},
                    Err(snapshot_error) => tracing::warn!(request_id = %id, %snapshot_error,
                        "cannot establish ownership of damaged Workflow request"),
                }
                return Err(error).with_context(|| format!("读取 Workflow 请求 {id}"));
            }
        };
        if record.original_message_id == message_id {
            if found.replace(record.root_run_id).is_some() {
                bail!("多个 Workflow 请求绑定同一 PM 消息");
            }
        }
    }
    Ok(found)
}

pub(super) fn validate_limits(rounds: u64, seconds: u64) -> Result<()> {
    if !(1..=MAX_CONFIGURED_LLM_ROUNDS).contains(&rounds)
        || !(1..=MAX_CONFIGURED_REQUEST_DEADLINE_SECONDS).contains(&seconds) {
        bail!("预算必须包含有效的 LLM 请求次数与处理时间上限");
    }
    Ok(())
}

pub(super) fn validate_proposal(runtime: &RuntimeStore, run: &RunRecord,
    proposal: &genehub_proto::WorkflowBudgetProposal) -> Result<()> {
    validate_limits(proposal.max_llm_rounds, proposal.deadline_seconds)?;
    let observed = snapshot(runtime, run, now_ms())?;
    let current = &observed.budget;
    if proposal.expected_revision != current.revision {
        bail!("budgetProposalStale: 预算已改变，请读取当前预算后重新提出方案");
    }
    let deadline = proposal.deadline_seconds.saturating_mul(1000);
    if proposal.max_llm_rounds < current.max_llm_rounds || deadline < current.deadline_ms
        || (proposal.max_llm_rounds == current.max_llm_rounds && deadline == current.deadline_ms) {
        bail!("预算申请必须明确提高至少一项上限，不能捆绑降低另一项");
    }
    if proposal.max_llm_rounds <= observed.observed_llm_rounds || deadline <= observed.execution_ms {
        bail!("budgetProposalInsufficient: 该方案批准后仍没有可用额度，请先修正方案");
    }
    Ok(())
}

/// One exact Human decision, applied at most once even if the reply is replayed.
/// A stale proposal never overwrites a later budget or grants a fixed increment.
pub(super) fn apply_human_decision(runtime: &RuntimeStore, run: &RunRecord,
    exit: &recovery::HumanExit, answer: &str) -> Result<()> {
    let root_id = group_id(run);
    let mut record = read_record(runtime, root_id)?;
    if record.approved_human_exits.iter().any(|id| id == &exit.request_id) { return Ok(()); }
    if record.approved_human_exits.len() >= 1024 { bail!("Workflow Human decision history is full"); }
    if exit.kind == "c" { bail!("旧恢复额度方案已失效；请由 PM 提出统一预算方案"); }
    if answer == "approve" && exit.kind == "a" {
        let proposal = exit.budget.as_ref().ok_or_else(|| anyhow!("预算卡缺少明确方案"))?;
        validate_proposal(runtime, run, proposal)?;
        record.budget.max_llm_rounds = proposal.max_llm_rounds;
        record.budget.deadline_ms = proposal.deadline_seconds.saturating_mul(1000);
        record.budget.revision = record.budget.revision.saturating_add(1);
    } else if answer == "acceptScope" && exit.kind == "b" {
        record.requirement.scope = Some(exit.scope.clone().ok_or_else(|| anyhow!("范围卡缺少目标变更"))?);
        record.requirement.revision = record.requirement.revision.saturating_add(1);
    } else { return Ok(()); }
    record.approved_human_exits.push(exit.request_id.clone());
    write_record(runtime, root_id, &record)
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
        schema: "genehub.workflow.request.v2".into(),
        root_run_id: run.id.clone(),
        original_message_id: link.original_message_id.clone(),
        goal: run.task_prompt.clone(),
        budget: existing.as_ref().filter(|record| record.budget.revision > link.budget.revision)
            .map(|record| record.budget.clone()).unwrap_or_else(|| link.budget.clone()),
        cancelled: link.cancelled,
        cancelled_at_ms: link.cancelled_at_ms,
        cancelled_by_agent: link.cancelled_by_agent,
        resume_message_id: link.resume_message_id.clone(),
        requirement: existing.as_ref().map(|r| r.requirement.clone()).unwrap_or_default(),
        latest_business_run: existing.as_ref().map(|r| r.latest_business_run.clone()).unwrap_or_default(),
        next_check_at_ms: existing.as_ref().map(|r| r.next_check_at_ms).unwrap_or_default(),
        patrol_failures: existing.as_ref().map(|r| r.patrol_failures).unwrap_or_default(),
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

fn executing(run: &RunRecord) -> bool { run.executing() }

/// A settled state ends the current execution segment.
pub(super) fn stopped(run: &RunRecord) -> bool {
    run.program_result().is_some() || !run.unfinished()
}

/// Runs saved before the clock existed. Their journals may be pruned, so the
/// last Worker activity and the old wait counters bound the estimate; a later
/// cancellation, notice or Human reply never extends it.
fn legacy_clock(run: &RunRecord, now: i64) -> ExecutionClock {
    let active = executing(run);
    let end = if active { now } else {
        run.nodes.values().fold(run.created_at_ms, |end, node|
            end.max(node.result_accepted_at_ms).max(node.activity.last_at_ms).max(node.assigned_at_ms))
            .min(run.updated_at_ms)
    };
    let elapsed = end.saturating_sub(run.created_at_ms)
        .saturating_sub(run.supervision.human_wait_ms.max(0))
        .saturating_sub(run.supervision.recovery_wait_ms.max(0))
        .max(0);
    ExecutionClock {
        intervals: (elapsed > 0).then(|| (run.created_at_ms, run.created_at_ms.saturating_add(elapsed))).into_iter().collect(),
        active_since_ms: active.then_some(now),
        stop_seq: None,
    }
}

/// Advances the clock against the committed snapshot, never a stale in-memory
/// copy. Returns true when this save commits the first stop after execution;
/// the caller then records that state event's journal seq as the boundary.
pub(super) fn checkpoint_clock(previous: Option<&RunRecord>, run: &mut RunRecord, now: i64) -> bool {
    let mut clock = match previous {
        Some(previous) => previous.supervision.execution.clone().unwrap_or_else(|| legacy_clock(previous, now)),
        None => run.supervision.execution.clone().unwrap_or_default(),
    };
    match (clock.active_since_ms, executing(run)) {
        (Some(start), false) => {
            match clock.intervals.last_mut() {
                Some((_, end)) if *end >= start => *end = (*end).max(now),
                _ if now > start => clock.intervals.push((start, now)),
                _ => {}
            }
            clock.active_since_ms = None;
        }
        (None, true) => clock.active_since_ms = Some(now),
        _ => {}
    }
    run.supervision.execution = Some(clock);
    stopped(run) && previous.is_none_or(|previous| !stopped(previous))
}

fn activity_intervals(run: &RunRecord, now: i64) -> Vec<(i64, i64)> {
    match run.supervision.execution.as_ref() {
        Some(clock) => clock.intervals_at(now),
        None => legacy_clock(run, now).intervals_at(now),
    }
}

/// Effective processing time of one Run; request usage is the union.
pub(super) fn execution_ms(run: &RunRecord, now: i64) -> u64 {
    union_ms(activity_intervals(run, now))
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
    runtime: &RuntimeStore,
    runs: &[RunRecord],
    run: &RunRecord,
    now: i64,
) -> Result<genehub_proto::WorkflowRequestBudgetSnapshot> {
    let group = runs
        .iter()
        .filter(|other| group_id(other) == group_id(run) && other.id != run.id)
        .chain(std::iter::once(run))
        .collect::<Vec<_>>();
    let root = group
        .iter()
        .find(|other| other.id == group_id(run))
        .ok_or_else(|| anyhow!("missing request root {}", group_id(run)))?;
    // The request record owns mutable limits. The in-memory Run supplies
    // fresh activity only and must never resurrect an older budget revision.
    let budget = match read_record(runtime, group_id(run)) {
        Ok(record) => record.budget.status(),
        Err(error) if error.downcast_ref::<io::Error>().is_some_and(|e| e.kind() == io::ErrorKind::NotFound) => budget(root).status(),
        Err(error) => return Err(error),
    };
    let mut intervals = Vec::new();
    for item in &group { intervals.extend(activity_intervals(item, now)); }
    let execution_ms = union_ms(intervals);
    let observed_llm_rounds = group
        .iter()
        .flat_map(|other| activities(other))
        .fold(0u64, |sum, activity| {
            sum.saturating_add(activity.llm_rounds)
        });
    Ok(genehub_proto::WorkflowRequestBudgetSnapshot {
        current_run_admitted: true,
        current_run_can_execute: run.program_open()
            && !cancelled(root) && budget.max_llm_rounds > observed_llm_rounds
            && budget.deadline_ms > execution_ms,
        request_run_id: group_id(run).into(),
        observed_at_ms: now,
        remaining_llm_rounds: budget.max_llm_rounds.saturating_sub(observed_llm_rounds),
        remaining_execution_ms: budget.deadline_ms.saturating_sub(execution_ms),
        budget,
        observed_llm_rounds,
        execution_ms,
    })
}

pub(super) fn snapshot(
    runtime: &RuntimeStore,
    run: &RunRecord,
    now: i64,
) -> Result<genehub_proto::WorkflowRequestBudgetSnapshot> {
    observation(runtime, &request_runs(runtime, group_id(run))?, run, now)
}

pub(super) fn budget_exhausted(runtime: &RuntimeStore, run: &RunRecord, now: i64) -> Result<bool> {
    let snapshot = snapshot(runtime, run, now)?;
    Ok(snapshot.remaining_llm_rounds == 0 || snapshot.remaining_execution_ms == 0)
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
            Some(id) if user => state.sessions.user_input_after(parent, id, goal.completed_at_ms.unwrap_or(i64::MAX)).await?,
            _ => false,
        };
        if !fresh { bail!("requirementCompleted: a later user input is needed to reopen this goal"); }
    }
    let snapshot = observation(runtime, &group, &root, now_ms())?;
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
        run.unfinished()
    }) {
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
    crate::config::save_private(&record_path(runtime, id, true)?, &encode_private_record("Workflow request", &record, MAX_RUN_RECORD_BYTES)?)
}
