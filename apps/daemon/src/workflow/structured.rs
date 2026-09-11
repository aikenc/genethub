//! Host adapter for the pure engine. Only this layer performs I/O.
use super::*;
use workflow_engine as engine;

pub(super) fn node_id(frame: u64) -> String {
    format!("operation-{frame}")
}
pub(super) fn session_id(run: &str, node: &str) -> String {
    format!(
        "s_{}",
        &hex_digest(format!("{run}\0{node}").as_bytes())[..32]
    )
}
fn program(run: &RunRecord) -> Result<engine::Program> {
    engine::compile(
        run.definition
            .structure
            .clone()
            .ok_or_else(|| anyhow!("missing structured definition"))?,
    )
    .map_err(Into::into)
}
pub(super) fn initialize(run: &mut RunRecord) -> Result<()> {
    let program = program(run)?;
    let transition = engine::start(
        &program,
        engine::StartRequest {
            execution_id: run.id.clone(),
            input: program.definition().input.clone(),
            now_ms: now_ms().max(0) as u64,
            deadline_ms: program
                .definition()
                .timeout_ms
                .map(|timeout| (run.created_at_ms.max(0) as u64).saturating_add(timeout)),
        },
    )?;
    apply(run, transition)?;
    Ok(())
}
fn apply(run: &mut RunRecord, transition: engine::Transition) -> Result<()> {
    run.engine = Some(transition.state);
    if let Some(executor) = run.executor_session_id.clone() {
        for entry in transition.history {
            // Every entry has a distinct identity even within one host revision.
            let mut event = flow_message(
                run,
                "structure.transition",
                None,
                &executor,
                &run.parent_session_id,
                Some(run.revision),
                serde_json::to_value(&entry)?,
            )?;
            event.message_id = format!(
                "{}-{}-{}-{}",
                event.message_id,
                run.engine.as_ref().unwrap().revision,
                entry.frame,
                run.flow_messages.len()
            );
            push_flow_message(run, event);
        }
    }
    sync_status(run);
    Ok(())
}
fn sync_status(run: &mut RunRecord) {
    let Some(snapshot) = &run.engine else {
        return;
    };
    match snapshot.status {
        engine::Status::Completed => run.status = "completed".into(),
        engine::Status::Blocked | engine::Status::Stopping => {
            let reason = snapshot
                .outcome
                .as_ref()
                .map(|o| format!("{}: {}", o.code, o.value))
                .unwrap_or_else(|| "流程受阻".into());
            control::request_stop(run, "blocked", reason);
        }
        engine::Status::Cancelled | engine::Status::Cancelling => {
            control::request_stop(run, "cancelled", "任务已请求取消".into())
        }
        engine::Status::Running => {}
    }
}
pub(super) fn settled(run: &mut RunRecord, id: &str) -> Result<()> {
    let program = match program(run).and_then(|p| {
        engine::inspect(
            &p,
            run.engine
                .as_ref()
                .ok_or_else(|| anyhow!("missing engine snapshot"))?,
        )?;
        Ok(p)
    }) {
        Ok(p) => p,
        Err(error) => {
            control::request_stop(run, "blocked", format!("结构化执行快照无法恢复：{error:#}"));
            return Ok(());
        }
    };
    let snapshot = run
        .engine
        .as_ref()
        .ok_or_else(|| anyhow!("missing engine snapshot"))?;
    let Some(op) = snapshot
        .operations
        .values()
        .find(|op| node_id(op.frame) == id)
    else {
        return Ok(());
    };
    let record = &run.nodes[id];
    let code = control::outcome_event(record.outcome.unwrap_or_default());
    let transition = engine::advance(
        &program,
        snapshot,
        engine::Input {
            expected_revision: snapshot.revision,
            now_ms: now_ms().max(0) as u64,
            event: engine::Event::ActivityUpdate {
                id: op.id.clone(),
                update_seq: op.update_seq + 1,
                update: engine::ActivityUpdate::Settled {
                    outcome: engine::Outcome {
                        code: code.into(),
                        success: code == "completed",
                        value: serde_json::json!({"outcome":code,"evidence":record.evidence,"reason":record.reason}),
                    },
                },
            },
        },
    )?;
    apply(run, transition)
}

pub(super) async fn drive(state: &Shared, runtime: &RuntimeStore, run_id: &str) -> Result<()> {
    let sessions = {
        let _guard = lock_run(runtime, run_id)?;
        let mut run = load_run(runtime, run_id)?;
        if run.engine.is_none() || run.status != "running" {
            return Ok(());
        }
        let _request = request::request_lock(runtime, request::group_id(&run))?;
        request::ensure_open(runtime, &run)?;
        if request::budget_exhausted(runtime, &run, now_ms())? {
            control::request_stop(
                &mut run,
                "blocked",
                "原始请求达到执行期限或 LLM 调用上限".into(),
            );
            run.revision += 1;
            save_run(runtime, &run)?;
            return Ok(());
        }
        let p = match program(&run).and_then(|p| {
            engine::inspect(&p, run.engine.as_ref().unwrap())?;
            Ok(p)
        }) {
            Ok(p) => p,
            Err(error) => {
                control::request_stop(
                    &mut run,
                    "blocked",
                    format!("结构化执行快照无法恢复：{error:#}"),
                );
                run.revision += 1;
                save_run(runtime, &run)?;
                return Ok(());
            }
        };
        let snapshot = run.engine.as_ref().unwrap();
        let transition = engine::advance(
            &p,
            snapshot,
            engine::Input {
                expected_revision: snapshot.revision,
                now_ms: now_ms().max(0) as u64,
                event: engine::Event::Drive,
            },
        )?;
        let progressed =
            !transition.history.is_empty() || transition.state.status != snapshot.status;
        apply(&mut run, transition)?;
        finalize(runtime, &mut run).await;
        // Internal clock observations do not invalidate a user's Run revision.
        // The engine has its own CAS revision for its persisted state.
        if progressed {
            run.revision += 1;
            run.updated_at_ms = now_ms();
        }
        // Commit all new operation identities before creating any host execution.
        save_run(runtime, &run)?;
        if run.status != "running" {
            return Ok(());
        }
        let operations = engine::pending(run.engine.as_ref().unwrap()).operations;
        let mut sessions = Vec::new();
        for op in operations {
            if run.status != "running" {
                break;
            }
            if op.phase == engine::OperationPhase::Cancelling {
                continue;
            }
            let id = node_id(op.frame);
            if let Some(record) = run.nodes.get(&id) {
                if record.status == "running" {
                    if let Some(sid) = &record.session_id {
                        let inspection = state.sessions.inspect(sid, None).await?;
                        if inspection.round_count == 0 && !state.sessions.has_execution(sid).await {
                            sessions.push((
                                inspection.summary,
                                task_message(&run, &runtime_node(&run, &id)?),
                            ));
                        }
                    }
                    continue;
                }
                if record.status != "pending" {
                    continue;
                }
            }
            let activity = run
                .definition
                .nodes
                .iter()
                .find(|n| n.id == op.activity)
                .ok_or_else(|| anyhow!("missing activity {}", op.activity))?;
            if !run.nodes.contains_key(&id) {
                run.nodes.insert(
                    id.clone(),
                    NodeRecord {
                        scope: engine::ancestry(&p, run.engine.as_ref().unwrap(), op.frame)?,
                        definition_id: Some(op.activity.clone()),
                        activity: Default::default(),
                        outcome: None,
                        reason: None,
                        assigned_at_ms: 0,
                        uses: activity.uses.clone(),
                        status: "pending".into(),
                        session_id: None,
                        evidence: BTreeMap::new(),
                    },
                );
            }
            // Persist the assignment intent; create_managed_named recovers the stable identity.
            save_run(runtime, &run)?;
            let node = runtime_node(&run, &id)?;
            if let Some(policy) = &node.inputs.write_lease {
                let execution = execution_workspace(
                    state,
                    &run.workspace_id,
                    run.executor_workspace_id.as_deref(),
                    node.inputs.role.as_deref().unwrap_or_default(),
                    run.execution_root
                        .as_deref()
                        .map(Path::new)
                        .unwrap_or(&runtime.project_root),
                    node.inputs.workspace.as_deref(),
                )
                .await?;
                let target = if policy.target_ref == "current" {
                    crate::git::current_ref(&execution.task_cwd).await?
                } else {
                    policy.target_ref.clone()
                };
                let repository = execution.task_cwd.display().to_string();
                let blocked = run.leases.values().any(|lease| {
                    lease.repository == repository
                        && lease.target_ref == target
                        && run
                            .nodes
                            .get(&lease.node_id)
                            .is_some_and(|r| matches!(r.status.as_str(), "running" | "finishing"))
                });
                if blocked {
                    continue;
                }
            }
            match activate(
                state,
                &runtime.project_root,
                runtime,
                &mut run,
                vec![id.clone()],
            )
            .await
            {
                Ok(created) => sessions.extend(created),
                Err(error) => {
                    control::request_stop(
                        &mut run,
                        "blocked",
                        format!("活动 {id} 启动待核对：{error:#}"),
                    );
                    break;
                }
            }
            if run.nodes[&id].uses == "result.publish" {
                // This capability publishes the verified Run result, not an external network side effect.
                run.nodes.get_mut(&id).unwrap().outcome =
                    Some(genehub_proto::WorkflowNodeOutcome::Completed);
                settled(&mut run, &id)?;
                finalize(runtime, &mut run).await;
            }
            run.revision += 1;
            save_run(runtime, &run)?;
        }
        if !sessions.is_empty() || run.status != "running" {
            record_assigned_messages(&mut run, &sessions)?;
            run.revision += 1;
            save_run(runtime, &run)?;
        }
        if run.status == "completed" {
            release_leases(runtime, &run).await?;
        }
        sessions
    };
    for (session, message) in sessions {
        // Session workspace may be an attached AgentSpace; the Run owns the project workspace.
        let run = load_run(runtime, run_id)?;
        if !state.sessions.has_execution(&session.id).await {
            control::start_assigned(state, &run.workspace_id, run_id, &session, message).await?;
        }
    }
    Ok(())
}

/// Host cleanup has already retired all executions. Reflect the stop in the
/// pure snapshot before persisting the Run's terminal projection.
pub(super) fn retired(run: &mut RunRecord) -> Result<()> {
    if run.engine.is_none() {
        return Ok(());
    }
    let Ok(p) = program(run) else {
        return Ok(());
    };
    let mut snapshot = run.engine.clone().unwrap();
    if engine::inspect(&p, &snapshot).is_err() {
        // Preserve the invalid snapshot as evidence. Host cleanup is proven,
        // but this engine state must never be interpreted or resumed.
        return Ok(());
    }
    // Preserve failure versus user cancellation in both persisted projections.
    let reason = run
        .stop
        .as_ref()
        .map(|s| s.reason.clone())
        .unwrap_or_default();
    let event = if run.stop.as_ref().is_some_and(|s| s.target == "cancelled") {
        engine::Event::Cancel { reason }
    } else {
        engine::Event::Abort { reason }
    };
    snapshot = engine::advance(
        &p,
        &snapshot,
        engine::Input {
            expected_revision: snapshot.revision,
            now_ms: now_ms().max(0) as u64,
            event,
        },
    )?
    .state;
    for op in snapshot.operations.values().cloned().collect::<Vec<_>>() {
        snapshot = engine::advance(
            &p,
            &snapshot,
            engine::Input {
                expected_revision: snapshot.revision,
                now_ms: now_ms().max(0) as u64,
                event: engine::Event::ActivityUpdate {
                    id: op.id,
                    update_seq: op.update_seq + 1,
                    update: engine::ActivityUpdate::Settled {
                        outcome: engine::Outcome::failed("cancelled", "host cleanup confirmed"),
                    },
                },
            },
        )?
        .state;
    }
    run.engine = Some(snapshot);
    Ok(())
}

/// Versioned read-only view for CLI and Workbench. It deliberately excludes
/// execution context and pending command bodies; the snapshot remains private.
pub(super) fn projection(run: &RunRecord) -> Option<serde_json::Value> {
    let snapshot = run.engine.as_ref()?;
    let active = program(run).and_then(|p| engine::inspect(&p, snapshot).map_err(Into::into));
    Some(serde_json::json!({
        "schema":"genehub.workflow.structure.v1",
        "definition":run.definition.structure,
        "revision":snapshot.revision,
        "active":active.as_ref().ok(),
        "error":active.as_ref().err().map(|e|e.to_string()),
        "instances":run.nodes.iter().map(|(id,node)| serde_json::json!({
            "nodeId":id,"scope":node.scope,
        })).collect::<Vec<_>>(),
    }))
}

pub(super) async fn finalize(runtime: &RuntimeStore, run: &mut RunRecord) {
    if run.status == "completed" {
        if let Err(error) = release_leases(runtime, run).await {
            control::request_stop(
                run,
                "blocked",
                format!("流程活动完成，但资源收尾失败：{error:#}"),
            );
        }
    }
}

/// Start the activity timer once, at durable host admission, not while it waits
/// for a resource. Recovery of an already admitted operation retains its timer.
pub(super) fn accepted(run: &mut RunRecord, node: &str) -> Result<bool> {
    let Some(snapshot) = run.engine.as_ref() else {
        return Ok(false);
    };
    let Some(op) = snapshot
        .operations
        .values()
        .find(|op| node_id(op.frame) == node)
    else {
        return Ok(false);
    };
    if op.phase != engine::OperationPhase::Requested {
        return Ok(false);
    }
    let transition = engine::advance(
        &program(run)?,
        snapshot,
        engine::Input {
            expected_revision: snapshot.revision,
            now_ms: now_ms().max(0) as u64,
            event: engine::Event::ActivityUpdate {
                id: op.id.clone(),
                update_seq: op.update_seq + 1,
                update: engine::ActivityUpdate::Accepted,
            },
        },
    )?;
    apply(run, transition)?;
    Ok(true)
}
