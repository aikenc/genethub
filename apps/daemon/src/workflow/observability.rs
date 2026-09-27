//! Read-time facts. Package code owns dependency graphs and quality semantics.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

fn node_labels(run: &RunRecord) -> BTreeMap<String, String> {
    use workflow_engine::{Block, BlockKind};
    fn visit(block: &Block, titles: &mut BTreeMap<String, String>) {
        if let Some(title) = block.title.as_deref().filter(|s| !s.trim().is_empty()) {
            titles.insert(block.id.clone(), title.chars().take(160).collect());
        }
        match &block.kind {
            BlockKind::Sequence { steps, .. } => {
                for child in steps {
                    visit(child, titles);
                }
            }
            BlockKind::Parallel { branches, .. } => {
                for child in branches {
                    visit(child, titles);
                }
            }
            BlockKind::If { then, r#else, .. } => {
                visit(then, titles);
                if let Some(child) = r#else {
                    visit(child, titles);
                }
            }
            BlockKind::Choice { branches, default } => {
                for branch in branches {
                    visit(&branch.body, titles);
                }
                visit(default, titles);
            }
            BlockKind::Loop { body, .. } | BlockKind::ForEach { body, .. } => visit(body, titles),
            _ => {}
        }
    }
    let mut titles = BTreeMap::new();
    if let Some(definition) = run.definition.structure.as_ref() {
        visit(&definition.body, &mut titles);
        for body in definition.procedures.values() {
            visit(body, &mut titles);
        }
    }
    run.engine
        .as_ref()
        .map(|engine| {
            engine
                .operations
                .values()
                .filter_map(|operation| {
                    let frame = engine.frames.get(&operation.frame)?;
                    Some((
                        structured::node_id(operation.frame),
                        titles.get(&frame.node)?.clone(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn summary(runs: &[RunRecord], selected: &RunRecord) -> Result<Value> {
    let now = now_ms();
    let budget = request::observation(runs, selected, now)?;
    let group = runs
        .iter()
        .filter(|r| request::group_id(r) == request::group_id(selected));
    let mut work_ms = 0i64;
    let mut edges = Vec::new();
    let mut rounds = BTreeMap::new();
    let mut cost = 0u64;
    let mut recoveries = 0;
    for run in group {
        for activity in request::activities(run) {
            cost = cost.saturating_add(activity.estimated_milli_cny);
        }
        recoveries += usize::from(!run.handles.is_empty() && run.status == "running");
        for node in run.nodes.values() {
            if node.assigned_at_ms > 0 && node.uses == "agent.session" {
                let end = if node.settled_at_ms > 0 {
                    node.settled_at_ms
                } else if matches!(node.status.as_str(), "running" | "finishing") {
                    now
                } else {
                    run.updated_at_ms
                };
                if end > node.assigned_at_ms {
                    work_ms = work_ms.saturating_add(end - node.assigned_at_ms);
                    edges.push((node.assigned_at_ms, 1i32));
                    edges.push((end, -1i32));
                }
            }
            for frame in &node.scope {
                if let Some(round) = frame.round {
                    rounds
                        .entry((run.id.clone(), frame.id))
                        .and_modify(|r: &mut u32| *r = (*r).max(round))
                        .or_insert(round);
                }
            }
        }
    }
    edges.sort(); // Settlements before assignments at the same instant.
    let mut active = 0i32;
    let mut peak = 0i32;
    let mut occupied_ms = 0i64;
    let mut previous = None;
    for (at, delta) in edges {
        if active > 0 {
            if let Some(previous) = previous {
                occupied_ms += at - previous;
            }
        }
        active += delta;
        peak = peak.max(active);
        previous = Some(at);
    }
    let used = (budget.observed_llm_rounds as f64 / budget.budget.max_llm_rounds.max(1) as f64)
        .max(budget.execution_ms as f64 / budget.budget.deadline_ms.max(1) as f64);
    Ok(
        json!({"parallelism": work_ms as f64 / occupied_ms.max(1) as f64,
        "workerOccupiedMs":work_ms,"occupiedMs":occupied_ms,
        "peakWorkers": peak, "executionMs": budget.execution_ms,
        "reworkRounds": rounds.values().map(|r| r.saturating_sub(1)).sum::<u32>(),
        "budgetPercent": used * 100., "estimatedMilliCny": cost, "recovering": recoveries,
        "iterations": rounds.iter().map(|((run_id, frame_id), round)| json!({"runId":run_id,"frameId":frame_id,"rounds":round})).collect::<Vec<_>>(),
        "additionalIterationRounds": rounds.values().map(|r|r.saturating_sub(1)).sum::<u32>(),
        "callBudgetPercent": budget.observed_llm_rounds as f64 / budget.budget.max_llm_rounds.max(1) as f64 * 100.,
        "timeBudgetPercent": budget.execution_ms as f64 / budget.budget.deadline_ms.max(1) as f64 * 100.,
        "requestBudget": budget,
        "calls": budget.observed_llm_rounds,"nodeLabels":node_labels(selected)}),
    )
}

/// Authoring sugar only: the execution engine sees ordinary literal values.
pub(super) fn inline_literals(
    root: &Path,
    bytes: &[u8],
    files: &mut Vec<(String, Vec<u8>)>,
) -> Result<Vec<u8>> {
    let mut value: Value = serde_yaml::from_slice(bytes)?;
    fn visit(root: &Path, value: &mut Value, files: &mut Vec<(String, Vec<u8>)>) -> Result<()> {
        if value.get("op").and_then(Value::as_str) == Some("include") {
            let object = value
                .as_object()
                .ok_or_else(|| anyhow!("include must be an object"))?;
            if object.len() != 2 {
                bail!("literal include accepts only op and path");
            }
            let path = object
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("include needs path"))?
                .to_owned();
            let bytes = read_source(&existing_relative_within(root, &path, "字面量 include")?)?;
            let included: Value = serde_yaml::from_slice(&bytes)?;
            // Do not recursively interpret data as code.
            *value = json!({"op": "literal", "value": included});
            files.push((path, bytes));
            return Ok(());
        }
        // A literal's authored data may itself legitimately contain "op".
        if value.get("op").and_then(Value::as_str) == Some("literal") {
            return Ok(());
        }
        match value {
            Value::Array(items) => {
                for item in items {
                    visit(root, item, files)?;
                }
            }
            Value::Object(fields) => {
                for item in fields.values_mut() {
                    visit(root, item, files)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(root, &mut value, files)?;
    Ok(serde_json::to_vec(&value)?)
}

pub(super) async fn stamp_rate(state: &Shared, session: &SessionSummary) -> Result<()> {
    let preferences = state
        .config
        .read()
        .await
        .agent_preferences
        .clone()
        .unwrap_or_default();
    let configured = preferences
        .model_profiles
        .iter()
        .find(|p| p.agent_id == session.agent_id && p.model_id == session.model_id)
        .and_then(|p| p.cost.clone());
    let level_configured = configured.is_some();
    let level = match configured {
        Some(level) => level,
        None => {
            let agents = state.registry.list(&state.providers().await).await;
            agents
                .iter()
                .find(|agent| agent.id == session.agent_id)
                .and_then(|agent| {
                    crate::agent_routing::inferred_profile(
                        agent,
                        agent
                            .catalog
                            .models
                            .iter()
                            .find(|model| Some(&model.id) == session.model_id.as_ref()),
                    )
                    .cost
                })
                .unwrap_or_default()
        }
    };
    let rates = preferences.cost_rates.unwrap_or_default();
    let unit = rates.rate(&level);
    let rate_version = hex_digest(&serde_json::to_vec(&rates)?);
    state
        .sessions
        .set_execution_rate(
            &session.id,
            json!({
                "level": level, "unitMilliCny": unit,
                "agentId": session.agent_id, "modelId": session.model_id,
                "capturedAtMs": now_ms(), "configDigest":rate_version,
                "levelSource": if level_configured {"configured"} else {"inferred"}
            }),
        )
        .await
}

/// Pin all view/standard files in the same build as the executable workflow.
pub(super) fn collect_sources(
    root: &Path,
    folder: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
    total: &mut u64,
) -> Result<()> {
    let directory = root.join(folder);
    if !directory.exists() {
        return Ok(());
    }
    let directory = existing_relative_within(root, folder, "工作流构建资源")?;
    for item in fs::read_dir(directory)? {
        let item = item?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| anyhow!("构建资源路径不是 UTF-8"))?;
        let relative = format!("{folder}/{name}");
        let path = existing_relative_within(root, &relative, "工作流构建资源")?;
        if path.is_dir() {
            if relative.split('/').count() > 16 {
                bail!("工作流构建资源目录太深");
            }
            collect_sources(root, &relative, files, total)?;
        } else if path.is_file() {
            if files.len() >= 4096 {
                bail!("工作流构建资源文件太多");
            }
            insert_candidate_source(files, total, relative, read_source(&path)?)?;
        }
    }
    Ok(())
}

pub(crate) fn view(runtime: &RuntimeStore, run_id: &str, path: Option<&str>) -> Result<Value> {
    validate_id(run_id, "runId")?;
    let run = load_run(runtime, run_id)?;
    let build = load_run_candidate(runtime, &run)?;
    if let Some(path) = path {
        // Membership in the immutable snapshot is the only source of bytes;
        // never fall back to the package's currently edited source tree.
        let bytes = build
            .source_files
            .get(path)
            .ok_or_else(|| anyhow!("工作流构建中没有文件：{path}"))?;
        return Ok(json!({"build": build.digest, "path": path, "base64": STANDARD.encode(bytes)}));
    }
    let views = build
        .source_files
        .iter()
        .filter_map(|(path, bytes)| {
            let parts: Vec<_> = path.split('/').collect();
            if parts.len() != 3 || parts[0] != "views" || parts[2] != "index.html" {
                return None;
            }
            let html = String::from_utf8_lossy(bytes);
            let title = html
                .as_bytes()
                .windows(7)
                .position(|s| s.eq_ignore_ascii_case(b"<title>"))
                .and_then(|start| {
                    html.as_bytes()[start + 7..]
                        .windows(8)
                        .position(|s| s.eq_ignore_ascii_case(b"</title>"))
                        .map(|end| html[start + 7..start + 7 + end].trim())
                })
                .filter(|s| !s.is_empty())
                .unwrap_or(parts[1]);
            Some(json!({"id": parts[1], "title": title, "entry": path}))
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"workspaceId": run.workspace_id, "runId": run.id, "build": build.digest,
        "packageId": build.package.id, "views": views}),
    )
}

pub(crate) async fn profile(
    state: &Shared,
    runtime: &RuntimeStore,
    run_id: &str,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<Value> {
    validate_id(run_id, "runId")?;
    let selected = load_run(runtime, run_id)?;
    let mut runs = all_runs(runtime)?
        .into_iter()
        .filter(|r| request::group_id(r) == request::group_id(&selected))
        .collect::<Vec<_>>();
    let offset = offset.unwrap_or(0) as usize;
    let limit = limit.unwrap_or(64).clamp(1, 128) as usize;
    let total_nodes = runs.iter().map(|r| r.nodes.len()).sum::<usize>();
    if offset > total_nodes {
        bail!("profile offset exceeds node count");
    }
    let mut ordinal = 0usize;
    let mut included = 0usize;
    let mut node_bytes = 0u64;
    let mut page_full = false;
    let mut rows = Vec::new();
    let mut estimated = 0u64;
    let mut priced = 0u64;
    let mut calls = 0u64;
    let mut recovery_calls = 0u64;
    let mut recovery_cost = 0u64;
    let mut rates = BTreeMap::<String, Value>::new();
    let mut missing_sources = Vec::new();
    let now = now_ms();
    for run in &mut runs {
        // The request reconciler persists these same counters. Fresh reading
        // improves live UI accuracy without modifying any Run or session.
        for (node_id, node) in &mut run.nodes {
            if let Some(id) = &node.session_id {
                match state.sessions.execution_activity(id).await {
                    Ok(activity) => node.activity = activity,
                    Err(_) => missing_sources.push(json!({"kind":"sessionActivity","runId":run.id,"nodeId":node_id,"sessionId":id,"fallback":"lastPersistedActivity"})),
                }
            }
        }
        for activity in request::activities(run) {
            estimated = estimated.saturating_add(activity.estimated_milli_cny);
            priced = priced.saturating_add(activity.priced_llm_rounds);
            calls = calls.saturating_add(activity.llm_rounds);
            if !run.handles.is_empty() {
                recovery_calls = recovery_calls.saturating_add(activity.llm_rounds);
                recovery_cost = recovery_cost.saturating_add(activity.estimated_milli_cny);
            }
            let closed_calls = activity.cost_segments.iter().map(|s| s.calls).sum::<u64>();
            let closed_cost = activity
                .cost_segments
                .iter()
                .map(|s| s.milli_cny)
                .sum::<u64>();
            let segments = activity
                .cost_segments
                .iter()
                .map(|s| (&s.rate, s.calls, s.milli_cny))
                .chain(activity.cost_rate.iter().map(|r| {
                    (
                        r,
                        activity.priced_llm_rounds.saturating_sub(closed_calls),
                        activity.estimated_milli_cny.saturating_sub(closed_cost),
                    )
                }));
            for (rate, segment_calls, segment_cost) in segments {
                let key = serde_json::to_string(&json!([
                    rate["agentId"],
                    rate["modelId"],
                    rate["level"],
                    rate["unitMilliCny"],
                    rate["configDigest"]
                ]))?;
                let row = rates
                    .entry(key)
                    .or_insert_with(|| json!({"rate":rate,"calls":0u64,"milliCny":0u64}));
                row["calls"] = json!(row["calls"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(segment_calls));
                row["milliCny"] = json!(row["milliCny"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(segment_cost));
            }
        }
        let mut nodes = serde_json::to_value(&run.nodes)?;
        if let Some(engine) = &run.engine {
            for operation in engine.operations.values() {
                if let Some(node) = nodes.get_mut(structured::node_id(operation.frame)) {
                    node["input"] = operation.input.clone();
                }
            }
        }
        if let Some(nodes) = nodes.as_object_mut() {
            nodes.retain(|_, node| {
                let position = ordinal;
                ordinal += 1;
                if position < offset || included >= limit || page_full {
                    return false;
                }
                let size = serde_json::to_vec(node)
                    .map(|b| b.len() as u64)
                    .unwrap_or(u64::MAX);
                if included > 0 && node_bytes.saturating_add(size) > 600_000 {
                    page_full = true;
                    return false;
                }
                node_bytes = node_bytes.saturating_add(size);
                included += 1;
                true
            });
        }
        // Do not repeat the engine's accumulated intermediate values. The
        // native definition and page of node facts suffice for package analysis;
        // workflow.get remains the full detailed execution interface.
        let status = json!({"id":run.id,"workspaceId":run.workspace_id,"parentSessionId":run.parent_session_id,
            "executorSessionId":run.executor_session_id,"taskId":run.task_id,"workflowId":run.definition.id,
            "status":run.status,"revision":run.revision,"dcgDigest":run.dcg_digest,
            "structure":{"definition":run.definition.structure}});
        let messages = run.delivery_queue.iter().map(|m| json!({"kind": m.kind, "nodeId": m.node_id, "attempt": m.attempt, "createdAtMs": m.created_at_ms, "senderSessionId": m.sender_session_id, "recipientSessionId": m.recipient_session_id})).collect::<Vec<_>>();
        rows.push(json!({"run": status, "nodes": nodes,
            "messages": messages, "recoveryHandles": run.handles,
            "createdAtMs": run.created_at_ms, "updatedAtMs": run.updated_at_ms,
            "executionMs": request::execution_ms(run, now)}));
    }
    let live = runs
        .iter()
        .find(|r| r.id == selected.id)
        .unwrap_or(&selected);
    let budget = request::observation(&runs, live, now)?;
    let result = json!({"schema": "genehub.workflow.profile.v1", "runId": run_id,
        "requestRunId": request::group_id(live), "atMs": now, "budget": budget,
        "cost": {"currency": "CNY", "source": "estimatedCalls", "milliCny": estimated,
            "pricedCalls": priced, "unpricedCalls": calls.saturating_sub(priced),
            "calls": calls,"businessCalls":calls.saturating_sub(recovery_calls),"recoveryCalls":recovery_calls,
            "businessMilliCny":estimated.saturating_sub(recovery_cost),"recoveryMilliCny":recovery_cost,
            "byModelRate":rates.into_values().collect::<Vec<_>>()},
        "missingSources":missing_sources, "runs": rows, "offset":offset,"totalNodes":total_nodes,
        "nextOffset":if offset + included < total_nodes {Some(offset + included)} else {None}});
    ensure_record_size(
        "Workflow profile",
        serialized_json_size(&result)?,
        2_500_000,
    )?;
    Ok(result)
}
