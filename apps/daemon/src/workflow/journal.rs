//! Bounded, append-only references for committed Workflow Run revisions.
use super::*;
use std::collections::BTreeSet;
use std::io::{Seek, SeekFrom};

const MAX_LINE_BYTES: usize = 4 * 1024;
const MAX_JOURNAL_BYTES: u64 = 16 * 1024 * 1024;
const FINAL_EVENT_RESERVE: u64 = MAX_LINE_BYTES as u64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct JournalEvent {
    pub seq: u64,
    pub revision: u64,
    pub at_ms: i64,
    pub event_type: String,
    pub actor: String,
    pub rule: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

fn path(runtime: &RuntimeStore, run: &RunRecord) -> Result<Option<PathBuf>> {
    let Some(relative) = run.snapshot_relative.as_deref() else {
        return Ok(None);
    };
    let snapshot = runtime.project_file(relative)?;
    Ok(Some(snapshot.with_file_name("journal.jsonl")))
}

/// Returns the committed high-water marks to store in the same Run snapshot.
/// The old snapshot commits the journal length, so an uncommitted crash tail
/// can be truncated before retrying without interpreting its contents.
pub(super) fn append(runtime: &RuntimeStore, run: &RunRecord) -> Result<(u64, u64)> {
    let Some(path) = path(runtime, run)? else {
        return Ok((0, 0));
    };
    let snapshot = path.with_file_name("run.json");
    let (committed_seq, committed_bytes, committed_revision, previous_messages) =
        match crate::config::sensitive_metadata(&snapshot) {
            Ok(metadata) => {
                crate::config::reject_link_or_reparse(&snapshot, &metadata)?;
                if !metadata.is_file() {
                    bail!("Workflow Run snapshot 不是普通文件");
                }
                ensure_record_size("Workflow Run", metadata.len(), MAX_RUN_RECORD_BYTES)?;
                let previous = decode_run_record(&fs::read(&snapshot)?)?;
                (previous.journal_seq, previous.journal_bytes, previous.revision,
                    previous.flow_messages.into_iter().map(|message| message.message_id).collect::<BTreeSet<_>>())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (0, 0, 0, BTreeSet::new()),
            Err(error) => return Err(error.into()),
        };
    if run.revision < committed_revision {
        bail!("Workflow Run revision 不得回退");
    }
    match crate::config::sensitive_metadata(&path) {
        Ok(metadata) => {
            crate::config::reject_link_or_reparse(&path, &metadata)?;
            if !metadata.is_file() || metadata.len() > MAX_JOURNAL_BYTES {
                bail!("Workflow journal 损坏或超过上限");
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    crate::config::restrict_to_owner(&path)?;
    if file.metadata()?.len() < committed_bytes {
        bail!("Workflow journal 比已提交的 Run 快照短");
    }
    file.set_len(committed_bytes)?;
    file.seek(SeekFrom::Start(committed_bytes))?;
    let mut events = Vec::new();
    for message in &run.flow_messages {
        if previous_messages.contains(&message.message_id) {
            continue;
        }
        events.push(JournalEvent {
            seq: 0,
            revision: run.revision,
            at_ms: message.created_at_ms,
            event_type: message.kind.clone(),
            actor: "event".into(),
            rule: "flow-message".into(),
            run_id: run.id.clone(),
            session_id: Some(message.sender_session_id.clone()),
            node_id: message.node_id.clone(),
            message_id: Some(message.message_id.clone()),
        });
    }
    events.push(JournalEvent {
        seq: 0,
        revision: run.revision,
        at_ms: now_ms(),
        event_type: format!("run.{}", run.status),
        actor: "event".into(),
        rule: "save-run".into(),
        run_id: run.id.clone(),
        session_id: run.executor_session_id.clone(),
        node_id: None,
        message_id: None,
    });
    let mut lines = Vec::new();
    let mut next_bytes = committed_bytes;
    let mut seq = committed_seq;
    for mut event in events {
        seq = seq.checked_add(1).ok_or_else(|| anyhow!("Workflow journal seq 已耗尽"))?;
        event.seq = seq;
        let mut line = serde_json::to_vec(&event)?;
        line.push(b'\n');
        if line.len() > MAX_LINE_BYTES {
            bail!("Workflow journal 单行超过 4 KiB");
        }
        next_bytes = next_bytes.checked_add(line.len() as u64)
            .ok_or_else(|| anyhow!("Workflow journal 大小溢出"))?;
        if next_bytes > MAX_JOURNAL_BYTES - FINAL_EVENT_RESERVE {
            bail!("journalFull: Workflow journal 已达到 16 MiB 上限");
        }
        lines.extend_from_slice(&line);
    }
    file.write_all(&lines)?;
    file.sync_data()?;
    Ok((seq, next_bytes))
}

pub(super) fn read(
    runtime: &RuntimeStore,
    run: &RunRecord,
    since: u64,
    limit: usize,
) -> Result<Vec<JournalEvent>> {
    let Some(path) = path(runtime, run)? else {
        return Ok(Vec::new());
    };
    let metadata = crate::config::sensitive_metadata(&path)?;
    crate::config::reject_link_or_reparse(&path, &metadata)?;
    if !metadata.is_file() || metadata.len() > MAX_JOURNAL_BYTES || metadata.len() < run.journal_bytes {
        bail!("Workflow journal 损坏或长度无效");
    }
    let bytes = fs::read(&path)?;
    let committed = &bytes[..run.journal_bytes as usize];
    if !committed.is_empty() && committed.last() != Some(&b'\n') {
        bail!("Workflow journal 已提交尾部不完整");
    }
    let mut events = Vec::new();
    let mut expected = 1u64;
    for line in committed.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
        if line.len() + 1 > MAX_LINE_BYTES {
            bail!("Workflow journal 单行超过 4 KiB");
        }
        let event: JournalEvent = serde_json::from_slice(line)?;
        if event.run_id != run.id || event.seq != expected || event.revision > run.revision {
            bail!("Workflow journal 与 Run 快照不一致");
        }
        expected += 1;
        if event.seq > since {
            events.push(event);
            if events.len() >= limit.clamp(1, 1024) {
                break;
            }
        }
    }
    if expected - 1 != run.journal_seq {
        bail!("Workflow journal 缺少已提交事件");
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_tail_is_discarded_before_the_next_commit() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "w_project", project.path()).unwrap();
        let mut run: RunRecord = serde_json::from_value(serde_json::json!({
            "id": "wr_root", "workspaceId": "w_project", "parentSessionId": "s_pm",
            "workflowId": "direct", "bundleDigest": "sha256:test", "taskId": "task",
            "taskPrompt": "work", "status": "running", "revision": 1,
            "definition": {"schema": DEFINITION_SCHEMA, "id": "direct", "version": 1, "nodes": []},
            "roles": {}, "nodes": {}, "leases": {}, "createdAtMs": 1, "updatedAtMs": 1
        })).unwrap();
        run.snapshot_relative = Some(pm_snapshot_relative(&runtime, "wr_root", "wr_root").unwrap());
        save_run(&runtime, &run).unwrap();
        let first = load_run(&runtime, &run.id).unwrap();
        assert_eq!(first.journal_seq, 1);
        let journal = path(&runtime, &first).unwrap().unwrap();
        OpenOptions::new().append(true).open(&journal).unwrap().write_all(b"orphan\n").unwrap();
        run.revision = 2;
        run.status = "completed".into();
        run.flow_messages.push(serde_json::from_value(serde_json::json!({
            "schema": "test", "messageId": "fm_first", "kind": "node.completed",
            "projectWorkspaceId": "w_project", "executorSessionId": "s_executor",
            "runId": "wr_root", "nodeId": "review", "senderSessionId": "s_worker",
            "recipientSessionId": "s_executor", "payload": {"private": "body"},
            "createdAtMs": 2
        })).unwrap());
        save_run(&runtime, &run).unwrap();
        let second = load_run(&runtime, &run.id).unwrap();
        assert_eq!(second.journal_seq, 3);
        assert_eq!(fs::metadata(&journal).unwrap().len(), second.journal_bytes);
        let events = read(&runtime, &second, 0, 10).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[1].event_type, "node.completed");
        assert_eq!(events[1].node_id.as_deref(), Some("review"));
        assert!(!serde_json::to_string(&events).unwrap().contains("body"));
        assert_eq!(events[2].event_type, "run.completed");
    }
}
