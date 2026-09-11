use crate::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const FORMAT: u32 = 1;
const FUEL: usize = 256;
const MAX_CONTROL_STEPS: u64 = 1_000_000;
const MAX_DATA: usize = 4 * 1024 * 1024;

pub fn start(program: &Program, request: StartRequest) -> Result<Transition> {
    if request.execution_id.is_empty() || request.execution_id.len() > 128 {
        return Err(Error::State("invalid execution id".into()));
    }
    let root = Frame {
        node: program.definition.body.id.clone(),
        parent: None,
        context: context(request.input),
        cursor: Cursor::Enter,
        outcome: None,
    };
    let state = EngineState {
        format_version: FORMAT,
        definition_digest: program.digest.clone(),
        execution_id: request.execution_id,
        revision: 0,
        logical_time_ms: request.now_ms,
        deadline_ms: request.deadline_ms,
        next_id: 2,
        operations_started: 0,
        control_steps: 0,
        status: Status::Running,
        root: 1,
        frames: BTreeMap::from([(1, root)]),
        operations: BTreeMap::new(),
        outcome: None,
        needs_drive: true,
    };
    advance(
        program,
        &state,
        Input {
            expected_revision: 0,
            now_ms: request.now_ms,
            event: Event::Drive,
        },
    )
}
fn context(input: Value) -> Value {
    json!({"input": input, "vars": null, "results": {}, "item": null})
}

pub fn pending(state: &EngineState) -> PendingWork {
    PendingWork {
        operations: state.operations.values().cloned().collect(),
        wake_at_ms: if state.status == Status::Running {
            state
                .deadline_ms
                .into_iter()
                .chain(state.operations.values().filter_map(|op| op.deadline_ms))
                .min()
        } else {
            None
        },
        needs_drive: state.needs_drive,
    }
}

pub fn advance(program: &Program, previous: &EngineState, input: Input) -> Result<Transition> {
    if previous.revision != input.expected_revision {
        return Err(Error::Conflict {
            expected: input.expected_revision,
            actual: previous.revision,
        });
    }
    validate_state(program, previous)?;
    let mut state = previous.clone();
    let mut history = Vec::new();
    if matches!(
        state.status,
        Status::Completed | Status::Blocked | Status::Cancelled
    ) {
        return Ok(Transition { state, history });
    }
    state.logical_time_ms = state.logical_time_ms.max(input.now_ms);
    if let Event::Cancel { reason } = &input.event {
        stop(
            &mut state,
            Status::Cancelling,
            Outcome::failed("cancelled", reason),
        );
    } else if let Event::Abort { reason } = &input.event {
        stop(
            &mut state,
            Status::Stopping,
            Outcome::failed("hostFailure", reason),
        );
    } else if state.status == Status::Running
        && state
            .deadline_ms
            .is_some_and(|d| state.logical_time_ms >= d)
    {
        stop(
            &mut state,
            Status::Stopping,
            Outcome::failed("deadlineExceeded", "execution deadline reached"),
        );
    }
    if state.status == Status::Running
        && state.operations.values().any(|op| {
            op.deadline_ms
                .is_some_and(|deadline| state.logical_time_ms >= deadline)
        })
    {
        stop(
            &mut state,
            Status::Stopping,
            Outcome::failed(
                "activityTimeout",
                "activity deadline reached; host cleanup required",
            ),
        );
    }
    if let Event::ActivityUpdate {
        id,
        update_seq,
        update,
    } = input.event
    {
        if let Some(op) = state.operations.get(&id).cloned() {
            if update_seq > op.update_seq {
                match update {
                    ActivityUpdate::Settled { mut outcome } => {
                        state.operations.remove(&id);
                        if state.status == Status::Running && op.phase != OperationPhase::Cancelling
                        {
                            let frame = &state.frames[&op.frame];
                            let BlockKind::Task { accept, .. } = &program.nodes[&frame.node].kind
                            else {
                                return Err(Error::State("operation owner is not task".into()));
                            };
                            outcome.success = accept.contains(&outcome.code);
                            complete(&mut state, op.frame, outcome, &mut history)?;
                        }
                    }
                    update => {
                        let target = state.operations.get_mut(&id).expect("operation");
                        target.update_seq = update_seq;
                        if target.phase == OperationPhase::Requested
                            && matches!(update, ActivityUpdate::Accepted)
                        {
                            target.deadline_ms = target
                                .timeout_ms
                                .map(|ms| state.logical_time_ms.saturating_add(ms));
                        }
                        if target.phase != OperationPhase::Cancelling {
                            target.phase = match update {
                                ActivityUpdate::Waiting => OperationPhase::Waiting,
                                _ => OperationPhase::Running,
                            };
                        }
                    }
                }
            }
        }
    }
    state.needs_drive = false;
    if state.status == Status::Running {
        let mut fuel = FUEL;
        while fuel > 0 {
            let mut changed = false;
            let ids = state.frames.keys().copied().collect::<Vec<_>>();
            for id in ids {
                if fuel == 0 {
                    break;
                }
                if !state.frames.contains_key(&id) || state.frames[&id].outcome.is_some() {
                    continue;
                }
                if state.control_steps >= MAX_CONTROL_STEPS {
                    stop(
                        &mut state,
                        Status::Stopping,
                        Outcome::failed(
                            "controlBudgetExceeded",
                            "pure control step budget exhausted",
                        ),
                    );
                    break;
                }
                match step(program, &mut state, id, &mut history) {
                    Ok(progress) => {
                        changed |= progress;
                        if progress {
                            fuel -= 1;
                            state.control_steps += 1;
                        }
                    }
                    Err(Error::Condition(message)) => {
                        stop(
                            &mut state,
                            Status::Stopping,
                            Outcome::failed("conditionError", message),
                        );
                        changed = true;
                        fuel -= 1;
                    }
                    Err(error) => return Err(error),
                }
                if state.status != Status::Running {
                    break;
                }
            }
            if state.status != Status::Running {
                break;
            }
            if let Some(outcome) = state
                .frames
                .get(&state.root)
                .and_then(|f| f.outcome.clone())
            {
                if outcome.success && state.operations.is_empty() {
                    state.status = Status::Completed;
                    state.outcome = Some(outcome);
                } else {
                    stop(&mut state, Status::Stopping, outcome);
                }
                break;
            }
            if !changed {
                break;
            }
            state.needs_drive = fuel == 0;
        }
        // A large waiting frontier is not runnable work; avoid endless Drive polling.
        if fuel == 0 {
            state.needs_drive = true;
        }
    }
    if matches!(state.status, Status::Stopping | Status::Cancelling) && state.operations.is_empty()
    {
        state.status = if state.status == Status::Cancelling {
            Status::Cancelled
        } else {
            Status::Blocked
        };
        state.needs_drive = false;
    }
    if state.status != Status::Running {
        state.needs_drive = false;
    }
    if serde_json::to_vec(&state)?.len() > MAX_DATA {
        return Err(Error::State("snapshot data exceeds 4 MiB".into()));
    }
    if serde_json::to_vec(&state)? != serde_json::to_vec(previous)? {
        state.revision = previous
            .revision
            .checked_add(1)
            .ok_or_else(|| Error::State("revision overflow".into()))?;
    }
    Ok(Transition { state, history })
}

pub(crate) fn validate_state(program: &Program, state: &EngineState) -> Result<()> {
    if state.format_version != FORMAT || state.definition_digest != program.digest {
        return Err(Error::State(
            "unsupported version or definition digest mismatch".into(),
        ));
    }
    if !state.frames.contains_key(&state.root)
        || state.frames.len() > program.definition.limits.max_frames
    {
        return Err(Error::State("invalid frame frontier".into()));
    }
    if state.root != 1
        || state.frames[&state.root].node != program.definition.body.id
        || state.frames[&state.root].parent.is_some()
        || state.operations.len() > program.definition.limits.max_concurrency
        || state.operations_started > program.definition.limits.max_operations
        || state.control_steps > MAX_CONTROL_STEPS
    {
        return Err(Error::State("invalid root or operation bounds".into()));
    }
    let mut owned = std::collections::BTreeSet::new();
    for (id, frame) in &state.frames {
        let Some(block) = program.nodes.get(&frame.node) else {
            return Err(Error::State("unknown frame definition".into()));
        };
        if *id >= state.next_id
            || frame
                .parent
                .is_some_and(|p| p >= *id || !state.frames.contains_key(&p))
            || !frame.context.is_object()
            || ["input", "vars", "results", "item"]
                .iter()
                .any(|key| frame.context.get(*key).is_none())
            || (matches!(block.kind, BlockKind::Sequence { .. })
                && !frame.context["results"].is_object())
        {
            return Err(Error::State(
                "invalid frame identity, parent or context".into(),
            ));
        }
        if state.status != Status::Running {
            continue;
        }
        let children: Vec<u64> = match (&block.kind, &frame.cursor) {
            (_, Cursor::Enter) if frame.outcome.is_none() => vec![],
            (_, Cursor::Done) if frame.outcome.is_some() => vec![],
            (BlockKind::Task { .. }, Cursor::Task { operation })
                if state.operations.contains_key(operation) =>
            {
                vec![]
            }
            (BlockKind::Sequence { steps }, Cursor::Sequence { next, child })
                if *next <= steps.len() && frame.context["results"].is_object() =>
            {
                child.iter().copied().collect()
            }
            (BlockKind::Loop { max_rounds, .. }, Cursor::Loop { entered, child })
                if entered <= max_rounds =>
            {
                child.iter().copied().collect()
            }
            (
                BlockKind::If { .. } | BlockKind::Choice { .. } | BlockKind::Call { .. },
                Cursor::Selected { child },
            ) => vec![*child],
            (BlockKind::Parallel { .. }, Cursor::Parallel { children, .. }) => {
                children.values().copied().collect()
            }
            (
                BlockKind::ForEach {
                    max_concurrency, ..
                },
                Cursor::ForEach {
                    items,
                    keys,
                    next,
                    children,
                    ..
                },
            ) if keys.len() == items.len()
                && keys.iter().collect::<std::collections::BTreeSet<_>>().len() == keys.len()
                && *next <= items.len()
                && children.len() <= *max_concurrency =>
            {
                children.values().copied().collect()
            }
            _ => return Err(Error::State("invalid frame cursor".into())),
        };
        for child in children {
            let child_name = state.frames.get(&child).map(|f| f.node.as_str());
            let allowed = match (&block.kind, &frame.cursor) {
                (BlockKind::Sequence { steps }, Cursor::Sequence { next, .. }) => steps
                    .get(*next)
                    .is_some_and(|b| Some(b.id.as_str()) == child_name),
                (BlockKind::Loop { body, .. } | BlockKind::ForEach { body, .. }, _) => {
                    Some(body.id.as_str()) == child_name
                }
                (BlockKind::If { then, r#else, .. }, _) => {
                    Some(then.id.as_str()) == child_name
                        || r#else
                            .as_ref()
                            .is_some_and(|b| Some(b.id.as_str()) == child_name)
                }
                (BlockKind::Choice { branches, default }, _) => {
                    Some(default.id.as_str()) == child_name
                        || branches
                            .iter()
                            .any(|b| Some(b.body.id.as_str()) == child_name)
                }
                (BlockKind::Parallel { branches, .. }, _) => {
                    branches.iter().any(|b| Some(b.id.as_str()) == child_name)
                }
                (BlockKind::Call { procedure, .. }, _) => program
                    .definition
                    .procedures
                    .get(procedure)
                    .is_some_and(|b| Some(b.id.as_str()) == child_name),
                _ => false,
            };
            if !allowed {
                return Err(Error::State("child is outside its structured scope".into()));
            }
            if !owned.insert(child)
                || !state
                    .frames
                    .get(&child)
                    .is_some_and(|f| f.parent == Some(*id))
            {
                return Err(Error::State("invalid child ownership".into()));
            }
        }
    }
    if state.status == Status::Running && owned.len() + 1 != state.frames.len() {
        return Err(Error::State("orphan execution frame".into()));
    }
    for (id, op) in &state.operations {
        if id != &op.id
            || !state
                .frames
                .get(&op.frame)
                .is_some_and(|f| matches!(&f.cursor,Cursor::Task { operation } if operation == id))
        {
            return Err(Error::State("invalid operation binding".into()));
        }
    }
    Ok(())
}
fn stop(state: &mut EngineState, status: Status, outcome: Outcome) {
    state.status = status;
    state.outcome = Some(outcome);
    for op in state.operations.values_mut() {
        op.phase = OperationPhase::Cancelling;
    }
}
fn complete(
    state: &mut EngineState,
    id: u64,
    outcome: Outcome,
    history: &mut Vec<HistoryEntry>,
) -> Result<()> {
    let frame = state
        .frames
        .get_mut(&id)
        .ok_or_else(|| Error::State("missing completion frame".into()))?;
    history.push(HistoryEntry {
        frame: id,
        parent: frame.parent,
        node: frame.node.clone(),
        event: "completed".into(),
        detail: serde_json::to_value(&outcome)?,
    });
    frame.outcome = Some(outcome);
    frame.cursor = Cursor::Done;
    Ok(())
}
fn child(
    state: &mut EngineState,
    program: &Program,
    parent: u64,
    block: &Block,
    ctx: Value,
    history: &mut Vec<HistoryEntry>,
) -> Result<u64> {
    if state.frames.len() >= program.definition.limits.max_frames {
        return Err(Error::Condition("frame capacity exceeded".into()));
    }
    let id = state.next_id;
    state.next_id = id
        .checked_add(1)
        .ok_or_else(|| Error::State("identity exhausted".into()))?;
    state.frames.insert(
        id,
        Frame {
            node: block.id.clone(),
            parent: Some(parent),
            context: ctx,
            cursor: Cursor::Enter,
            outcome: None,
        },
    );
    history.push(HistoryEntry {
        frame: id,
        parent: Some(parent),
        node: block.id.clone(),
        event: "entered".into(),
        detail: Value::Null,
    });
    Ok(id)
}
fn collected(state: &mut EngineState, id: u64) -> Option<(String, Outcome)> {
    let frame = state.frames.get(&id)?;
    let result = frame.outcome.clone()?;
    let name = frame.node.clone();
    state.frames.remove(&id);
    Some((name, result))
}
fn results_value(results: &BTreeMap<String, Outcome>) -> Value {
    Value::Object(
        results
            .iter()
            .map(|(id, o)| (id.clone(), o.value.clone()))
            .collect(),
    )
}
fn step(
    program: &Program,
    state: &mut EngineState,
    id: u64,
    history: &mut Vec<HistoryEntry>,
) -> Result<bool> {
    let frame = state.frames[&id].clone();
    let block = &program.nodes[&frame.node];
    match (&block.kind, frame.cursor) {
        (
            BlockKind::Task {
                activity,
                input,
                timeout_ms,
                ..
            },
            Cursor::Enter,
        ) => {
            if state.operations.len() >= program.definition.limits.max_concurrency {
                return Ok(false);
            }
            if state.operations_started >= program.definition.limits.max_operations {
                stop(
                    state,
                    Status::Stopping,
                    Outcome::failed("budgetExceeded", "operation budget exhausted"),
                );
                return Ok(true);
            }
            let op = format!("{}-op-{}", state.execution_id, id);
            let input = input.evaluate(&frame.context)?;
            state.operations.insert(
                op.clone(),
                Operation {
                    timeout_ms: *timeout_ms,
                    deadline_ms: None,
                    id: op.clone(),
                    frame: id,
                    activity: activity.clone(),
                    input,
                    phase: OperationPhase::Requested,
                    update_seq: 0,
                },
            );
            state.operations_started += 1;
            state.frames.get_mut(&id).unwrap().cursor = Cursor::Task { operation: op };
        }
        (BlockKind::Task { .. }, Cursor::Task { .. }) => return Ok(false),
        (BlockKind::Sequence { .. }, Cursor::Enter) => {
            state.frames.get_mut(&id).unwrap().cursor = Cursor::Sequence {
                next: 0,
                child: None,
            }
        }
        (
            BlockKind::Sequence { steps },
            Cursor::Sequence {
                mut next,
                child: active,
            },
        ) => {
            if let Some(active) = active {
                let Some((name, result)) = collected(state, active) else {
                    return Ok(false);
                };
                if !result.success {
                    complete(state, id, result, history)?;
                    return Ok(true);
                }
                state.frames.get_mut(&id).unwrap().context["results"][name] = result.value;
                next += 1;
            }
            if let Some(block) = steps.get(next) {
                let ctx = state.frames[&id].context.clone();
                let c = child(state, program, id, block, ctx, history)?;
                state.frames.get_mut(&id).unwrap().cursor = Cursor::Sequence {
                    next,
                    child: Some(c),
                };
            } else {
                complete(
                    state,
                    id,
                    Outcome::completed(state.frames[&id].context["results"].clone()),
                    history,
                )?;
            }
        }
        (
            BlockKind::If {
                condition,
                then,
                r#else,
            },
            Cursor::Enter,
        ) => {
            let selected = if condition.condition(&frame.context)? {
                Some(then.as_ref())
            } else {
                r#else.as_deref()
            };
            select(program, state, id, selected, frame.context, history)?;
        }
        (BlockKind::Choice { branches, default }, Cursor::Enter) => {
            let mut selected = default.as_ref();
            for b in branches {
                if b.condition.condition(&frame.context)? {
                    selected = &b.body;
                    break;
                }
            }
            select(program, state, id, Some(selected), frame.context, history)?;
        }
        (BlockKind::Call { procedure, input }, Cursor::Enter) => {
            let c = &program.definition.procedures[procedure];
            select(
                program,
                state,
                id,
                Some(c),
                context(input.evaluate(&frame.context)?),
                history,
            )?;
        }
        (
            BlockKind::If { .. } | BlockKind::Choice { .. } | BlockKind::Call { .. },
            Cursor::Selected { child },
        ) => {
            let Some((_, result)) = collected(state, child) else {
                return Ok(false);
            };
            complete(state, id, result, history)?;
        }
        (BlockKind::Loop { initial, .. }, Cursor::Enter) => {
            let vars = initial.evaluate(&frame.context)?;
            let f = state.frames.get_mut(&id).unwrap();
            f.context["vars"] = vars;
            f.cursor = Cursor::Loop {
                entered: 0,
                child: None,
            };
        }
        (
            BlockKind::Loop {
                condition,
                max_rounds,
                body,
                update,
                ..
            },
            Cursor::Loop {
                entered,
                child: active,
            },
        ) => {
            if let Some(c) = active {
                let Some((_, result)) = collected(state, c) else {
                    return Ok(false);
                };
                if !result.success {
                    complete(state, id, result, history)?;
                    return Ok(true);
                }
                let f = state.frames.get_mut(&id).unwrap();
                f.context["results"] = result.value;
                let vars = update.evaluate(&f.context)?;
                f.context["vars"] = vars;
            }
            let ctx = state.frames[&id].context.clone();
            if !condition.condition(&ctx)? {
                complete(state, id, Outcome::completed(ctx["vars"].clone()), history)?;
            } else if entered >= *max_rounds {
                complete(
                    state,
                    id,
                    Outcome::failed(
                        "limitExceeded",
                        format!("{} reached {max_rounds} rounds", block.id),
                    ),
                    history,
                )?;
            } else {
                let mut iteration_context = ctx;
                iteration_context["results"] = json!({});
                let c = child(state, program, id, body, iteration_context, history)?;
                state.frames.get_mut(&id).unwrap().cursor = Cursor::Loop {
                    entered: entered + 1,
                    child: Some(c),
                };
                history.push(HistoryEntry {
                    frame: id,
                    parent: frame.parent,
                    node: block.id.clone(),
                    event: "iteration".into(),
                    detail: json!({"round":entered+1,"maxRounds":max_rounds}),
                });
            }
        }
        (BlockKind::Parallel { branches, .. }, Cursor::Enter) => {
            if state.frames.len().saturating_add(branches.len())
                > program.definition.limits.max_frames
            {
                return Err(Error::Condition("parallel exceeds frame capacity".into()));
            }
            let mut children = BTreeMap::new();
            for b in branches {
                children.insert(
                    b.id.clone(),
                    child(state, program, id, b, frame.context.clone(), history)?,
                );
            }
            state.frames.get_mut(&id).unwrap().cursor = Cursor::Parallel {
                children,
                results: BTreeMap::new(),
            };
        }
        (
            BlockKind::Parallel { failure, .. },
            Cursor::Parallel {
                mut children,
                mut results,
            },
        ) => {
            let changed = gather(state, &mut children, &mut results);
            if *failure == FailurePolicy::FailFast && results.values().any(|r| !r.success) {
                stop(
                    state,
                    Status::Stopping,
                    Outcome::failed("branchFailed", format!("{} failed", block.id)),
                );
            } else if children.is_empty() {
                finish_group(state, id, &results, history)?;
            } else {
                state.frames.get_mut(&id).unwrap().cursor = Cursor::Parallel { children, results };
                return Ok(changed);
            }
        }
        (BlockKind::ForEach { items, key, .. }, Cursor::Enter) => {
            let items = items
                .evaluate(&frame.context)?
                .as_array()
                .cloned()
                .ok_or_else(|| Error::Condition("foreach items must be array".into()))?;
            if items.len() > 4096 {
                return Err(Error::Condition("foreach exceeds 4096 items".into()));
            }
            let mut keys = Vec::with_capacity(items.len());
            let mut unique = std::collections::BTreeSet::new();
            for (index, item) in items.iter().enumerate() {
                let identity = if let Some(key) = key {
                    let mut ctx = frame.context.clone();
                    ctx["item"] = item.clone();
                    match key.evaluate(&ctx)? {
                        Value::String(s) if !s.is_empty() && s.len() <= 256 => s,
                        Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
                        _ => {
                            return Err(Error::Condition(
                                "foreach key must be a nonempty string or integer".into(),
                            ))
                        }
                    }
                } else {
                    index.to_string()
                };
                if !unique.insert(identity.clone()) {
                    return Err(Error::Condition("duplicate foreach item key".into()));
                }
                keys.push(identity);
            }
            state.frames.get_mut(&id).unwrap().cursor = Cursor::ForEach {
                items,
                keys,
                next: 0,
                children: BTreeMap::new(),
                results: BTreeMap::new(),
            };
        }
        (
            BlockKind::ForEach {
                body,
                max_concurrency,
                failure,
                ..
            },
            Cursor::ForEach {
                items,
                keys,
                mut next,
                mut children,
                mut results,
            },
        ) => {
            let mut changed = gather(state, &mut children, &mut results);
            if *failure == FailurePolicy::FailFast && results.values().any(|r| !r.success) {
                stop(
                    state,
                    Status::Stopping,
                    Outcome::failed("itemFailed", format!("{} failed", block.id)),
                );
                return Ok(true);
            }
            let to_start = (items.len() - next).min(max_concurrency.saturating_sub(children.len()));
            if state.frames.len().saturating_add(to_start) > program.definition.limits.max_frames {
                // No partial creation: capacity failure must not orphan active frames.
                stop(
                    state,
                    Status::Stopping,
                    Outcome::failed("capacityExceeded", "foreach exceeds frame capacity"),
                );
                return Ok(true);
            }
            while next < items.len() && children.len() < *max_concurrency {
                let mut ctx = frame.context.clone();
                ctx["item"] = items[next].clone();
                children.insert(
                    keys[next].clone(),
                    child(state, program, id, body, ctx, history)?,
                );
                next += 1;
                changed = true;
            }
            if children.is_empty() && next == items.len() {
                finish_group(state, id, &results, history)?;
            } else {
                state.frames.get_mut(&id).unwrap().cursor = Cursor::ForEach {
                    items,
                    keys,
                    next,
                    children,
                    results,
                };
                return Ok(changed);
            }
        }
        (_, Cursor::Done) => return Ok(false),
        _ => {
            return Err(Error::State(format!(
                "cursor does not match block {}",
                block.id
            )))
        }
    }
    Ok(true)
}
fn select(
    program: &Program,
    state: &mut EngineState,
    id: u64,
    selected: Option<&Block>,
    ctx: Value,
    history: &mut Vec<HistoryEntry>,
) -> Result<()> {
    if let Some(block) = selected {
        let c = child(state, program, id, block, ctx, history)?;
        state.frames.get_mut(&id).unwrap().cursor = Cursor::Selected { child: c };
    } else {
        complete(state, id, Outcome::completed(Value::Null), history)?;
    }
    Ok(())
}
fn gather(
    state: &mut EngineState,
    children: &mut BTreeMap<String, u64>,
    results: &mut BTreeMap<String, Outcome>,
) -> bool {
    let mut changed = false;
    for (name, id) in children.clone() {
        if let Some((_, result)) = collected(state, id) {
            children.remove(&name);
            results.insert(name, result);
            changed = true;
        }
    }
    changed
}
fn finish_group(
    state: &mut EngineState,
    id: u64,
    results: &BTreeMap<String, Outcome>,
    history: &mut Vec<HistoryEntry>,
) -> Result<()> {
    let success = results.values().all(|o| o.success);
    complete(
        state,
        id,
        Outcome {
            code: if success { "completed" } else { "branchFailed" }.into(),
            value: results_value(results),
            success,
        },
        history,
    )
}
