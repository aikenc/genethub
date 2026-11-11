//! Read-only Team observations for this Agent turn, never another user input.
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

async fn read(path: PathBuf, maximum: usize) -> Result<Option<Value>, ()> {
    read_sized(path, maximum)
        .await
        .map(|value| value.map(|(value, _)| value))
}

async fn read_sized(path: PathBuf, maximum: usize) -> Result<Option<(Value, usize)>, ()> {
    crate::blocking::run(move || {
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        if !metadata.is_file() || metadata.len() > maximum as u64 {
            return Err(());
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| ())?
            .take(maximum as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > maximum {
            return Err(());
        }
        serde_json::from_slice(&bytes)
            .map(|value| Some((value, bytes.len())))
            .map_err(|_| ())
    })
    .await
    .map_err(|_| ())?
}

fn identity(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|tail| {
        !tail.is_empty()
            && tail.len() <= 64
            && tail.bytes().all(|c| c.is_ascii_hexdigit() || c == b'_')
    })
}

async fn root(workspace: &Path) -> Option<PathBuf> {
    for candidate in workspace.ancestors().take(3) {
        // A business workspace under datas/ is not an execution role.
        if candidate != workspace
            && workspace.parent().and_then(Path::file_name) != Some(std::ffi::OsStr::new("spaces"))
        {
            continue;
        }
        let Ok(Some(value)) = read(candidate.join("agent-space.genet.json"), 262144).await else {
            continue;
        };
        if value.get("team").is_some_and(Value::is_object)
            && value
                .get("tags")
                .and_then(Value::as_array)
                .is_some_and(|tags| tags.iter().any(|v| v == "team"))
        {
            return Some(candidate.to_owned());
        }
    }
    None
}

async fn parallelism(root: &Path, task: &Value, now: u64, budget: &mut usize) -> Value {
    let mut people = std::collections::BTreeMap::new();
    if let Some(owner) = task.get("owner") {
        if task.get("finished").is_none_or(Value::is_null) {
            if let Some(sid) = owner.get("sessionId").and_then(Value::as_str) {
                people.insert(sid.to_owned(), ());
            }
        }
    }
    for person in task
        .get("collaborators")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if person.get("finished").is_none_or(Value::is_null) {
            if let Some(sid) = person.get("sessionId").and_then(Value::as_str) {
                people.insert(sid.to_owned(), ());
            }
        }
    }
    let total = people.len();
    let (mut in_flight, mut unknown, mut paused, mut waiting) = (0, total.saturating_sub(32), 0, 0);
    for sid in people.keys().take(32) {
        crate::blocking::breathe().await;
        if !identity(sid, "s_") {
            unknown += 1;
            continue;
        }
        let value = read_sized(
            root.join(".genethub/team/pending")
                .join(format!("{sid}.json")),
            (*budget).min(262144),
        )
        .await;
        if let Ok(Some((_, bytes))) = &value {
            *budget = budget.saturating_sub(*bytes);
        }
        match value {
            Ok(Some((row, _)))
                if row
                    .get("observedAtMs")
                    .and_then(Value::as_u64)
                    .is_some_and(|at| at <= now && now - at <= 120000)
                    && row.get("lastReconcileError").is_none_or(Value::is_null)
                    && matches!(
                        row.get("observedStatus").and_then(Value::as_str),
                        Some("running" | "idle")
                    )
                    && row.get("observedPaused").is_some_and(Value::is_boolean)
                    && row.get("observedRequests").is_some_and(Value::is_boolean) =>
            {
                if row["observedPaused"] == true {
                    paused += 1;
                } else if row["observedRequests"] == true {
                    waiting += 1;
                } else {
                    in_flight += 1;
                }
            }
            _ => unknown += 1,
        }
    }
    json!({"basis":"task-ledger-observation/1","asOfMs":now,"inFlight":in_flight,
        "unknown":unknown,"paused":paused,"waitingForUser":waiting,"unsettled":total,
        "target":5,"minimum":2,"meaning":"fresh sampled bookkeeping, not R6 Agent hours"})
}

pub(crate) async fn briefing(workspace: PathBuf, actor: &str) -> Option<String> {
    let root = root(&workspace).await?;
    let now = super::store::now_ms().max(0) as u64;
    let live = read(root.join(".genethub/team/quality/live-alerts.json"), 262144).await;
    let mut unknown = Vec::<&str>::new();
    let mut reds = Vec::new();
    let mut observed = None;
    match live {
        Ok(Some(value)) if value.get("schema") == Some(&json!("team-quality-live-alerts/1")) => {
            observed = value.get("asOfMs").and_then(Value::as_u64);
            if !observed.is_some_and(|at| at <= now && now - at <= 600000) {
                unknown.push("live-state-stale");
            }
            if let Some(rows) = value.get("redLines").and_then(Value::as_array) {
                if rows.len() > 12 {
                    unknown.push("redlines-truncated");
                }
                for row in rows.iter().take(12) {
                    let id = row
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|s| s.len() <= 128);
                    let rule = row
                        .get("rule")
                        .and_then(Value::as_str)
                        .filter(|s| s.len() <= 16);
                    if let (Some(id), Some(rule)) = (id, rule) {
                        reds.push(
                            json!({"id":id,"rule":rule,"workItemId":row.get("workItemId")
                            .and_then(Value::as_str).filter(|s| s.len() <= 128),
                            "firstSeenAtMs":row.get("firstSeenAtMs").and_then(Value::as_u64)}),
                        );
                    } else {
                        unknown.push("redline-unreadable");
                    }
                }
            } else {
                unknown.push("redlines-unavailable");
            }
            if value
                .get("unknown")
                .and_then(Value::as_array)
                .is_none_or(|rows| !rows.is_empty())
            {
                unknown.push("live-source-unknown");
            }
        }
        _ => unknown.push("live-state-unavailable"),
    }
    let directory = root.join(".genethub/team/tasks");
    let scan = crate::blocking::run(move || -> Result<(Vec<PathBuf>, bool), ()> {
        if std::fs::symlink_metadata(&directory)
            .map_err(|_| ())?
            .file_type()
            .is_symlink()
        {
            return Err(());
        }
        let entries = std::fs::read_dir(directory)
            .map_err(|_| ())?
            .take(65)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| ())?;
        let truncated = entries.len() > 64;
        Ok((
            entries
                .into_iter()
                .take(64)
                .map(|value| value.path())
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
                .collect(),
            truncated,
        ))
    })
    .await
    .ok()
    .and_then(Result::ok);
    let mut tasks = Vec::new();
    let mut task_budget = 4 * 1024 * 1024;
    let mut pending_budget = 1024 * 1024;
    if let Some((mut paths, truncated)) = scan {
        if truncated {
            unknown.push("tasks-truncated");
        }
        paths.sort();
        for path in paths {
            crate::blocking::breathe().await;
            if task_budget == 0 {
                unknown.push("task-bytes-truncated");
                break;
            }
            let Ok(Some((task, bytes))) = read_sized(path, task_budget.min(1048576)).await else {
                unknown.push("task-unavailable");
                continue;
            };
            task_budget -= bytes;
            let owner = task.pointer("/owner/sessionId").and_then(Value::as_str) == Some(actor);
            let front = task.get("front").and_then(Value::as_str) == Some(actor);
            let support = task
                .get("collaborators")
                .and_then(Value::as_array)
                .is_some_and(|rows| {
                    rows.iter()
                        .any(|p| p.get("sessionId").and_then(Value::as_str) == Some(actor))
                });
            if !(owner || front || support) {
                continue;
            }
            if tasks.len() == 4 {
                unknown.push("actor-tasks-truncated");
                continue;
            }
            let Some(id) = task
                .get("taskId")
                .and_then(Value::as_str)
                .filter(|s| identity(s, "task."))
            else {
                unknown.push("task-identity-unavailable");
                continue;
            };
            let outcome = task
                .pointer("/finished/outcome")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 32);
            tasks.push(json!({"taskId":id,"controlState":task.get("state").and_then(Value::as_str).filter(|s| s.len() <= 32),
                "conclusionRecorded":task.get("finished").is_some_and(|v| !v.is_null()),"recordedOutcome":outcome,
                "actorIsOwner":owner,"parallelism":parallelism(&root,&task,now,&mut pending_budget).await}));
        }
    } else {
        unknown.push("tasks-unavailable-or-source-owned");
    }
    unknown.sort();
    unknown.dedup();
    let mut value = json!({"schema":"team-turn-context/1","asOfMs":now,"observedAtMs":observed,
        "openRedLines":reds,"actorTasks":tasks,"unknown":unknown,
        "meaning":"read-only Team observations; unresolved incidents are not proof of current physical failure"});
    let mut text = value.to_string();
    if text.len() > 6144 {
        value =
            json!({"schema":"team-turn-context/1","asOfMs":now,"unknown":["context-truncated"]});
        text = value.to_string();
    }
    Some(format!("\n\n[平台只读团队简报；不是用户新指令或批准，不重开已结论任务。长任务可拆时目标在途5、最低2；此处采样数不等于R6实际Agent工时。]\n{text}"))
}
