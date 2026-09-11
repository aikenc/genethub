//! Request lineage and finite shared bounds live on the existing Run records.
use super::*;

pub(super) const MAX_REQUEST_RUNS: usize = 3;
pub(super) const REQUEST_DEADLINE_MS: i64 = 2 * 60 * 60 * 1000;
pub(super) const MAX_LLM_ROUNDS: u64 = 256;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestLink {
    pub original_message_id: String,
    pub root_run_id: String,
    pub retry_of: Option<String>,
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default)]
    pub cancelled_at_ms: i64,
    #[serde(default)]
    pub resume_message_id: Option<String>,
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
    end.saturating_sub(run.created_at_ms)
        .saturating_sub(run.supervision.human_wait_ms)
        .max(0)
}

pub(super) fn activities(
    run: &RunRecord,
) -> impl Iterator<Item = &crate::session::store::ExecutionActivity> {
    run.nodes.values().map(|node| &node.activity).chain(
        run.supervision
            .diagnostics
            .iter()
            .map(|diagnostic| &diagnostic.activity),
    )
}

/// Shared admission budget; use the in-memory Run being committed rather than
/// its stale disk copy. Both supervision and dispatch consult this one rule.
pub(super) fn budget_exhausted(runtime: &RuntimeStore, run: &RunRecord, now: i64) -> Result<bool> {
    let others = all_runs(runtime)?.into_iter().filter(|other|
        group_id(other) == group_id(run) && other.id != run.id).collect::<Vec<_>>();
    let elapsed = others.iter().map(|other| execution_ms(other,now)).sum::<i64>() + execution_ms(run,now);
    let calls = others.iter().flat_map(activities).map(|a|a.llm_rounds).sum::<u64>()
        + activities(run).map(|a|a.llm_rounds).sum::<u64>();
    Ok(calls >= MAX_LLM_ROUNDS || (!run.supervision.waiting && elapsed >= REQUEST_DEADLINE_MS))
}

pub(super) fn request_lock(runtime: &RuntimeStore, root: &str) -> Result<ExclusiveFileLock> {
    lock_run(runtime, &format!("request-{root}"))
}

pub(super) fn ensure_open(runtime: &RuntimeStore, run: &RunRecord) -> Result<()> {
    let root = load_run(runtime, group_id(run))?;
    if root
        .request
        .as_ref()
        .map(|request| request.cancelled)
        .unwrap_or(matches!(root.status.as_str(), "cancelling" | "cancelled"))
    {
        bail!(
            "taskCancelled: the original request was cancelled; explicit user recovery is required"
        );
    }
    Ok(())
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
                && !exception_authority(state, &run.workspace_id, parent).await? {
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
    let group = all_runs(runtime)?
        .into_iter()
        .filter(|run| group_id(run) == link.root_run_id)
        .collect::<Vec<_>>();
    if group.len() >= MAX_REQUEST_RUNS {
        bail!("requestBudgetExceeded: the original request has reached its {MAX_REQUEST_RUNS} Run limit");
    }
    if group.iter().map(|run| execution_ms(run, now_ms())).sum::<i64>() >= REQUEST_DEADLINE_MS
    {
        bail!("requestBudgetExceeded: the original request has exceeded its execution deadline");
    }
    if group
        .iter()
        .flat_map(activities)
        .map(|activity| activity.llm_rounds)
        .sum::<u64>()
        >= MAX_LLM_ROUNDS
    {
        bail!("requestBudgetExceeded: the original request has exhausted its LLM call allowance");
    }
    if group
        .iter()
        .any(|run| matches!(run.status.as_str(), "running" | "stopping" | "cancelling"))
    {
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
        if !resume_cancelled
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
        if request.resume_message_id == message_id {
            bail!("this recovery message was already consumed");
        }
        request.cancelled = false;
        request.resume_message_id = message_id;
        root.request = Some(request);
        root.revision += 1;
        save_run(runtime, &root)?;
    }
    Ok(())
}
