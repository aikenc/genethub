//! Committed Run event references, rolled by UTC day and segment size.
use super::*;
use std::io::{Seek, SeekFrom};

const MAX_LINE_BYTES: usize = 4 * 1024;
pub(super) const MAX_SEGMENT_BYTES: u64 = 16 * 1024 * 1024;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const RETAIN_DAYS: i64 = 7;

pub(super) struct AppendOutcome {
    pub seq: u64,
    pub bytes: u64,
    pub segment: String,
}

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

fn directory(runtime: &RuntimeStore, run: &RunRecord) -> Result<Option<PathBuf>> {
    let Some(relative) = run.snapshot_relative.as_deref() else {
        return Ok(None);
    };
    let snapshot = runtime.project_file(relative)?;
    Ok(Some(snapshot.parent().ok_or_else(|| anyhow!("Run snapshot 缺少父目录"))?.to_path_buf()))
}

fn day_key(at_ms: i64) -> Result<String> {
    let at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(at_ms)
        .ok_or_else(|| anyhow!("Workflow journal 时间超出可表示范围"))?;
    Ok(at.format("%Y%m%d").to_string())
}

fn segment_name(day: &str, ordinal: u32) -> String {
    format!("journal-{day}-{ordinal:04}.jsonl")
}

fn segment_parts(name: &str) -> Option<(&str, u32)> {
    let body = name.strip_prefix("journal-")?.strip_suffix(".jsonl")?;
    let (day, ordinal) = body.split_once('-')?;
    if day.len() != 8 || !day.bytes().all(|byte| byte.is_ascii_digit())
        || ordinal.len() != 4 || !ordinal.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((day, ordinal.parse().ok()?))
}

fn segments(directory: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if segment_parts(&name).is_none() {
            continue;
        }
        let path = entry.path();
        let metadata = crate::config::sensitive_metadata(&path)?;
        crate::config::reject_link_or_reparse(&path, &metadata)?;
        if !metadata.is_file() || metadata.len() > MAX_SEGMENT_BYTES {
            bail!("Workflow journal 分段损坏：{}", path.display());
        }
        found.push((name, path));
    }
    found.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(found)
}

fn prune_directory(directory: &Path, at_ms: i64) -> Result<()> {
    let cutoff = day_key(at_ms.saturating_sub((RETAIN_DAYS - 1) * DAY_MS))?;
    for (name, path) in segments(directory)? {
        let (day, _) = segment_parts(&name).expect("listed segment");
        if day < cutoff.as_str() {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

pub(super) fn prune(runtime: &RuntimeStore, run: &RunRecord, at_ms: i64) -> Result<()> {
    if let Some(directory) = directory(runtime, run)? {
        prune_directory(&directory, at_ms)?;
    }
    Ok(())
}

fn append_line(directory: &Path, name: &str, committed_bytes: u64, line: &[u8]) -> Result<u64> {
    let path = directory.join(name);
    match crate::config::sensitive_metadata(&path) {
        Ok(metadata) => {
            crate::config::reject_link_or_reparse(&path, &metadata)?;
            if !metadata.is_file() || metadata.len() != committed_bytes {
                bail!("Workflow journal 分段长度与 Run 快照不一致");
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && committed_bytes == 0 => {}
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
    file.seek(SeekFrom::Start(committed_bytes))?;
    file.write_all(line)?;
    file.sync_data()?;
    Ok(committed_bytes + line.len() as u64)
}

/// The Run snapshot commits the current segment and its byte high-water mark.
/// Any newer segment or trailing bytes left by a crash are discarded on retry.
pub(super) fn append_at_with_limit(runtime: &RuntimeStore, run: &RunRecord, at_ms: i64, maximum: u64) -> Result<AppendOutcome> {
    let Some(directory) = directory(runtime, run)? else {
        return Ok(AppendOutcome { seq: 0, bytes: 0, segment: String::new() });
    };
    let snapshot = directory.join("run.json");
    let (mut seq, mut bytes, mut current, revision, status, previous_message_total) =
        match crate::config::sensitive_metadata(&snapshot) {
            Ok(metadata) => {
                crate::config::reject_link_or_reparse(&snapshot, &metadata)?;
                if !metadata.is_file() {
                    bail!("Workflow Run snapshot 不是普通文件");
                }
                ensure_record_size("Workflow Run", metadata.len(), MAX_RUN_RECORD_BYTES)?;
                let previous = decode_run_record(&fs::read(&snapshot)?)?;
                if previous.handles != run.handles {
                    bail!("Workflow recovery handles 创建后不可改变");
                }
                (previous.journal_seq, previous.journal_bytes, previous.journal_segment,
                    previous.revision, Some(previous.status),
                    previous.flow_message_total)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound =>
                (0, 0, String::new(), 0, None, 0),
            Err(error) => return Err(error.into()),
        };
    if run.revision < revision {
        bail!("Workflow Run revision 不得回退");
    }
    if seq > 0 && segment_parts(&current).is_none() {
        bail!("Workflow journal 缺少分段定位；旧单文件日志不自动迁移");
    }
    let current_exists = !current.is_empty()
        && segments(&directory)?.iter().any(|(name, _)| name == &current);
    let cutoff = day_key(at_ms.saturating_sub((RETAIN_DAYS - 1) * DAY_MS))?;
    if !current.is_empty() && !current_exists
        && segment_parts(&current).expect("validated segment").0 >= cutoff.as_str() {
        bail!("Workflow journal 已提交分段不存在");
    }
    for (name, path) in segments(&directory)? {
        if current.is_empty() || name > current {
            fs::remove_file(&path)?;
        } else if name == current {
            let file = OpenOptions::new().write(true).open(&path)?;
            if file.metadata()?.len() < bytes {
                bail!("Workflow journal 比已提交的 Run 快照短");
            }
            file.set_len(bytes)?;
            file.sync_data()?;
        }
    }
    prune_directory(&directory, at_ms)?;
    let mut events = Vec::new();
    let new_messages = run.flow_message_total.checked_sub(previous_message_total)
        .ok_or_else(|| anyhow!("Workflow flow message count 不得回退"))?;
    let new_messages = usize::try_from(new_messages).unwrap_or(usize::MAX);
    if new_messages > run.flow_messages.len() {
        bail!("Workflow flow message receipts 缺少未提交事件");
    }
    for message in run.flow_messages.iter().skip(run.flow_messages.len() - new_messages) {
            events.push(JournalEvent {
                seq: 0, revision: run.revision, at_ms: message.created_at_ms,
                event_type: message.kind.clone(), actor: "event".into(), rule: "flow-message".into(),
                run_id: run.id.clone(), session_id: Some(message.sender_session_id.clone()),
                node_id: message.node_id.clone(), message_id: Some(message.message_id.clone()),
            });
    }
    if run.revision != revision || status.as_deref() != Some(run.status.as_str()) {
        events.push(JournalEvent {
            seq: 0, revision: run.revision, at_ms,
            event_type: format!("run.{}", run.status),
            actor: if run.journal_actor.is_empty() { "event".into() } else { run.journal_actor.clone() },
            rule: "save-run".into(), run_id: run.id.clone(),
            session_id: run.executor_session_id.clone(), node_id: None, message_id: None,
        });
    }
    let today = day_key(at_ms)?;
    for mut event in events {
        seq = seq.checked_add(1).ok_or_else(|| anyhow!("Workflow journal seq 已耗尽"))?;
        event.seq = seq;
        let mut line = serde_json::to_vec(&event)?;
        line.push(b'\n');
        if line.len() > MAX_LINE_BYTES {
            bail!("Workflow journal 单行超过 4 KiB");
        }
        let (current_day, ordinal) = segment_parts(&current).unwrap_or(("", 0));
        let day = if current_day > today.as_str() { current_day } else { today.as_str() };
        if line.len() as u64 > maximum {
            bail!("Workflow journal 事件超过分段容量");
        }
        if current.is_empty() || current_day != day || bytes + line.len() as u64 > maximum {
            let next_ordinal = if current_day == day && !current.is_empty() {
                ordinal.checked_add(1).ok_or_else(|| anyhow!("Workflow journal 当日分段序号耗尽"))?
            } else { 0 };
            if next_ordinal > 9999 {
                bail!("Workflow journal 当日分段序号耗尽");
            }
            current = segment_name(day, next_ordinal);
            bytes = 0;
        }
        bytes = append_line(&directory, &current, bytes, &line)?;
    }
    Ok(AppendOutcome { seq, bytes, segment: current })
}

pub(super) fn read(
    runtime: &RuntimeStore,
    run: &RunRecord,
    since: u64,
    limit: usize,
) -> Result<Vec<JournalEvent>> {
    read_at(runtime, run, since, limit, now_ms())
}

fn read_at(runtime: &RuntimeStore, run: &RunRecord, since: u64, limit: usize, at_ms: i64) -> Result<Vec<JournalEvent>> {
    let Some(directory) = directory(runtime, run)? else { return Ok(Vec::new()); };
    if run.journal_seq == 0 { return Ok(Vec::new()); }
    let (current_day, _) = segment_parts(&run.journal_segment)
        .ok_or_else(|| anyhow!("Workflow journal 分段定位无效"))?;
    let cutoff = day_key(at_ms.saturating_sub((RETAIN_DAYS - 1) * DAY_MS))?;
    if current_day < cutoff.as_str() { return Ok(Vec::new()); }
    let mut result = Vec::new();
    let mut previous_seq = None;
    let mut saw_current = false;
    for (name, path) in segments(&directory)? {
        let (day, _) = segment_parts(&name).expect("listed segment");
        if day < cutoff.as_str() || name > run.journal_segment { continue; }
        let mut bytes = fs::read(&path)?;
        if name == run.journal_segment {
            saw_current = true;
            if bytes.len() < run.journal_bytes as usize { bail!("Workflow journal 已提交尾部缺失"); }
            bytes.truncate(run.journal_bytes as usize);
        }
        if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
            bail!("Workflow journal 已提交尾部不完整");
        }
        for line in bytes.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
            if line.len() + 1 > MAX_LINE_BYTES { bail!("Workflow journal 单行超过 4 KiB"); }
            let event: JournalEvent = serde_json::from_slice(line)?;
            if event.run_id != run.id || event.revision > run.revision || event.seq > run.journal_seq
                || previous_seq.is_some_and(|previous| event.seq != previous + 1) {
                bail!("Workflow journal 与 Run 快照不一致");
            }
            previous_seq = Some(event.seq);
            if event.seq > since && result.len() < limit.clamp(1, 1024) {
                result.push(event);
            }
        }
    }
    if !saw_current || previous_seq != Some(run.journal_seq) {
        bail!("Workflow journal 缺少已提交事件");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(runtime: &RuntimeStore, id: &str) -> RunRecord {
        let mut run: RunRecord = serde_json::from_value(serde_json::json!({
            "id": id, "workspaceId": "w_project", "parentSessionId": "s_pm",
            "workflowId": "direct", "bundleDigest": "sha256:test", "taskId": "task",
            "taskPrompt": "work", "status": "running", "revision": 1,
            "definition": {"schema": DEFINITION_SCHEMA, "id": "direct", "version": 1, "nodes": []},
            "roles": {}, "nodes": {}, "leases": {}, "createdAtMs": 1, "updatedAtMs": 1
        })).unwrap();
        run.snapshot_relative = Some(pm_snapshot_relative(runtime, id, id).unwrap());
        run
    }

    #[test]
    fn crash_tail_is_discarded_before_the_next_commit() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "w_project", project.path()).unwrap();
        let mut run = run(&runtime, "wr_root");
        save_run(&runtime, &run).unwrap();
        let first = load_run(&runtime, &run.id).unwrap();
        assert_eq!(first.journal_seq, 1);
        save_run(&runtime, &run).unwrap();
        assert_eq!(load_run(&runtime, &run.id).unwrap().journal_seq, 1);
        let journal = directory(&runtime, &first).unwrap().unwrap().join(&first.journal_segment);
        OpenOptions::new().append(true).open(&journal).unwrap().write_all(b"orphan\n").unwrap();
        run.revision = 2;
        run.status = "completed".into();
        run.journal_actor = "patrol".into();
        save_run(&runtime, &run).unwrap();
        let second = load_run(&runtime, &run.id).unwrap();
        assert_eq!(second.journal_seq, 2);
        assert_eq!(fs::metadata(&journal).unwrap().len(), second.journal_bytes);
        let events = read(&runtime, &second, 0, 10).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].event_type, "run.completed");
        assert_eq!(events[1].actor, "patrol");
    }

    #[test]
    fn seven_day_rotation_prunes_old_segments() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "w_project", project.path()).unwrap();
        let mut run = run(&runtime, "wr_roll");
        let first_day = chrono::DateTime::parse_from_rfc3339("2026-09-01T12:00:00Z").unwrap().timestamp_millis();
        save_run_with_journal_time(&runtime, &run, first_day).unwrap();
        let first = load_run(&runtime, &run.id).unwrap();
        run.revision = 2;
        let eighth_day = first_day + 7 * DAY_MS;
        save_run_with_journal_time(&runtime, &run, eighth_day).unwrap();
        let second = load_run(&runtime, &run.id).unwrap();
        assert_ne!(first.journal_segment, second.journal_segment);
        assert!(!directory(&runtime, &first).unwrap().unwrap().join(&first.journal_segment).exists());
        let events = read_at(&runtime, &second, 0, 10, eighth_day).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].seq, 2);
    }

    #[test]
    fn full_segment_rolls_without_stopping_run() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "w_project", project.path()).unwrap();
        let mut run = run(&runtime, "wr_size");
        let at = now_ms();
        save_run_with_journal_time(&runtime, &run, at).unwrap();
        let first = load_run(&runtime, &run.id).unwrap();
        run.revision = 2;
        save_run_with_journal_options(&runtime, &run, at, first.journal_bytes + 1).unwrap();
        let second = load_run(&runtime, &run.id).unwrap();
        assert_ne!(first.journal_segment, second.journal_segment);
        assert_eq!(second.status, "running");
        assert_eq!(read_at(&runtime, &second, 0, 10, at).unwrap().len(), 2);
    }

    #[test]
    fn run_snapshot_keeps_bounded_message_receipts_after_journaling() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "w_project", project.path()).unwrap();
        let mut run = run(&runtime, "wr_receipts");
        run.executor_session_id = Some("s_executor".into());
        for index in 0..(MAX_FLOW_MESSAGES + 6) {
            let mut message = flow_message(
                &run, "node.assigned", None, "s_pm", "s_executor", None,
                serde_json::json!({"index": index}),
            ).unwrap();
            message.message_id = format!("fm_{index}");
            push_flow_message(&mut run, message);
        }
        save_run(&runtime, &run).unwrap();
        let committed = load_run(&runtime, &run.id).unwrap();
        assert_eq!(committed.journal_seq, (MAX_FLOW_MESSAGES + 7) as u64);
        assert_eq!(committed.flow_messages.len(), MAX_FLOW_MESSAGES);
        assert_eq!(committed.flow_messages[0].message_id, "fm_6");
        let events = read(&runtime, &committed, MAX_FLOW_MESSAGES as u64, 20).unwrap();
        assert_eq!(events.len(), 7);
        assert_eq!(events.last().unwrap().seq, committed.journal_seq);
        save_run(&runtime, &run).unwrap();
        assert_eq!(load_run(&runtime, &run.id).unwrap().journal_seq, committed.journal_seq);
    }

    #[test]
    fn recovery_handles_cannot_change_after_first_snapshot() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = RuntimeStore::new(data.path(), "w_project", project.path()).unwrap();
        let mut run = run(&runtime, "wr_handle");
        run.handles.push(recovery::Handle {
            run_id: "wr_business".into(), trigger_seq: 1, reason: "execution failed".into(),
        });
        save_run(&runtime, &run).unwrap();
        run.handles[0].trigger_seq = 2;
        assert!(save_run(&runtime, &run).unwrap_err().to_string().contains("handles"));
    }
}
