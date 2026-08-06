//! Session persistence: append-only JSONL for the timeline, JSON for metadata.
//!
//! Deltas are never written. Only settled items reach disk, which keeps a
//! session file proportional to what was actually said rather than to the
//! number of tokens streamed (`docs/daemon.md` §4).

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use genehub_proto::{
    BlobKind, BlobPayload, BlobRef, PermissionRequest, SessionStatus, SessionSummary, TimelineItem,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::rounds::{self, RoundRecord};
use crate::adapter::PersistHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub workspace_id: String,
    pub agent_id: String,
    /// `None` until it has been named. Metas written before this was optional
    /// read back as `Some`, which is the right answer for them.
    #[serde(default)]
    pub title: Option<String>,
    pub cwd: PathBuf,
    pub model_id: Option<String>,
    pub mode_id: Option<String>,
    /// Metas written before this existed read back as `None`, which is the right
    /// answer for them: no level was ever chosen.
    #[serde(default)]
    pub effort_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub persist: Option<PersistHandle>,
    /// A stopped interaction waiting for a user who may return much later.
    /// Stored in meta so no live socket or Agent process is required.
    #[serde(default)]
    pub pending_permission: Option<PermissionRequest>,
}

impl SessionMeta {
    pub fn summary(&self, status: SessionStatus) -> SessionSummary {
        SessionSummary {
            id: self.id.clone(),
            workspace_id: self.workspace_id.clone(),
            agent_id: self.agent_id.clone(),
            title: self.title.clone(),
            status,
            model_id: self.model_id.clone(),
            mode_id: self.mode_id.clone(),
            effort_id: self.effort_id.clone(),
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            archived: self.archived,
        }
    }
}

#[derive(Clone)]
pub struct Store {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobBatchRecord {
    hash: String,
    value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobIndexRecord {
    item_id: String,
    kind: BlobKind,
    blob: BlobRef,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Store { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn dir(&self, workspace_id: &str) -> PathBuf {
        self.root.join(workspace_id)
    }

    fn timeline_path(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.dir(workspace_id).join(format!("{session_id}.jsonl"))
    }

    fn rounds_path(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.dir(workspace_id)
            .join(format!("{session_id}.rounds.jsonl"))
    }

    fn blob_dir(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.dir(workspace_id).join(session_id).join("blobs")
    }

    fn blob_index_path(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.dir(workspace_id)
            .join(format!("{session_id}.blobrefs.jsonl"))
    }

    fn meta_path(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.dir(workspace_id)
            .join(format!("{session_id}.meta.json"))
    }

    pub fn save_meta(&self, meta: &SessionMeta) -> Result<()> {
        let path = self.meta_path(&meta.workspace_id, &meta.id);
        crate::config::save_private(&path, serde_json::to_string_pretty(meta)?.as_bytes())
    }

    pub fn load_meta(&self, workspace_id: &str, session_id: &str) -> Result<SessionMeta> {
        let path = self.meta_path(workspace_id, session_id);
        let raw =
            fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        Ok(serde_json::from_str(&raw)?)
    }

    /// Appends settled items. Existing lines are never rewritten, so a crash
    /// can lose the tail but cannot corrupt what came before.
    pub fn append_items(
        &self,
        workspace_id: &str,
        session_id: &str,
        items: &[TimelineItem],
    ) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let dir = self.dir(workspace_id);
        fs::create_dir_all(&dir)?;
        let path = self.timeline_path(workspace_id, session_id);
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        crate::config::restrict_to_owner(&path)?;
        for item in items {
            writeln!(file, "{}", serde_json::to_string(item)?)?;
        }
        file.flush()?;
        Ok(())
    }

    /// Atomically replaces a timeline during a privacy/shape migration.
    ///
    /// Ordinary writes stay append-only. This path exists so an old detailed
    /// tool payload cannot remain on disk after the overview-only boundary has
    /// learned how to read it.
    pub fn replace_items(
        &self,
        workspace_id: &str,
        session_id: &str,
        items: &[TimelineItem],
    ) -> Result<()> {
        let path = self.timeline_path(workspace_id, session_id);
        let mut body = Vec::new();
        for item in items {
            writeln!(body, "{}", serde_json::to_string(item)?)?;
        }
        crate::config::save_private(&path, &body)
    }

    /// Reads the timeline back, skipping lines we cannot parse.
    ///
    /// A single bad line — a half-written record from a power cut, or a record
    /// from a newer version — must not make the whole conversation unopenable.
    pub fn load_items(&self, workspace_id: &str, session_id: &str) -> Result<Vec<TimelineItem>> {
        let path = self.timeline_path(workspace_id, session_id);
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        let mut items = Vec::new();
        for (index, line) in BufReader::new(file).lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<TimelineItem>(&line) {
                Ok(item) => items.push(item),
                Err(error) => {
                    tracing::warn!(
                        "skipping unreadable line {} of {}: {error}",
                        index + 1,
                        path.display()
                    );
                }
            }
        }
        Ok(items)
    }

    /// Stores canonical JSON source content by SHA-256. The first two hash
    /// characters select an append-only batch file, so a long session does not
    /// create one filesystem entry per tool call or thinking block.
    pub fn put_blob(
        &self,
        workspace_id: &str,
        session_id: &str,
        item_id: &str,
        kind: BlobKind,
        value: Value,
    ) -> Result<BlobRef> {
        let encoded = serde_json::to_vec(&value)?;
        let digest = Sha256::digest(&encoded);
        let hash = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let blob = BlobRef {
            hash: hash.clone(),
            bytes: encoded.len() as u64,
        };
        let dir = self.blob_dir(workspace_id, session_id);
        fs::create_dir_all(&dir)?;
        let batch_path = dir.join(format!("{}.batch", &hash[..2]));
        let already_stored = match File::open(&batch_path) {
            Ok(file) => BufReader::new(file)
                .lines()
                .map_while(Result::ok)
                .filter_map(|line| serde_json::from_str::<BlobBatchRecord>(&line).ok())
                .any(|record| record.hash == hash),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error).context("opening blob batch"),
        };
        if !already_stored {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&batch_path)?;
            crate::config::restrict_to_owner(&batch_path)?;
            writeln!(
                file,
                "{}",
                serde_json::to_string(&BlobBatchRecord {
                    hash: hash.clone(),
                    value,
                })?
            )?;
            file.flush()?;
        }

        let index_path = self.blob_index_path(workspace_id, session_id);
        let mut index = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&index_path)?;
        crate::config::restrict_to_owner(&index_path)?;
        writeln!(
            index,
            "{}",
            serde_json::to_string(&BlobIndexRecord {
                item_id: item_id.to_string(),
                kind,
                blob: blob.clone(),
            })?
        )?;
        index.flush()?;
        Ok(blob)
    }

    pub fn load_blob_refs(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<std::collections::HashMap<String, (BlobKind, BlobRef)>> {
        let path = self.blob_index_path(workspace_id, session_id);
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(std::collections::HashMap::new())
            }
            Err(error) => return Err(error).with_context(|| format!("opening {}", path.display())),
        };
        let mut refs = std::collections::HashMap::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if let Ok(record) = serde_json::from_str::<BlobIndexRecord>(&line) {
                refs.insert(record.item_id, (record.kind, record.blob));
            }
        }
        Ok(refs)
    }

    /// One-time compatibility upgrade for sessions written before source
    /// blobs existed. Their compact timeline is the only surviving source, so
    /// it is content-addressed as-is rather than pretending discarded detail
    /// can be reconstructed.
    pub fn ensure_blobs_migrated(
        &self,
        workspace_id: &str,
        session_id: &str,
        legacy_items: &[TimelineItem],
    ) -> Result<()> {
        let marker = self.blob_index_path(workspace_id, session_id);
        if marker.exists() {
            return Ok(());
        }
        for item in legacy_items {
            let kind = match item {
                TimelineItem::Reasoning { .. } => BlobKind::Reasoning,
                TimelineItem::ToolCall { .. } => BlobKind::ToolCall,
                _ => continue,
            };
            self.put_blob(
                workspace_id,
                session_id,
                item.id(),
                kind,
                serde_json::to_value(item)?,
            )?;
        }
        if !marker.exists() {
            if let Some(parent) = marker.parent() {
                fs::create_dir_all(parent)?;
            }
            File::create(&marker)?;
            crate::config::restrict_to_owner(&marker)?;
        }
        Ok(())
    }

    pub fn get_blob(
        &self,
        workspace_id: &str,
        session_id: &str,
        hash: &str,
    ) -> Result<Option<BlobPayload>> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Ok(None);
        }
        let path = self
            .blob_dir(workspace_id, session_id)
            .join(format!("{}.batch", &hash[..2]));
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("opening {}", path.display())),
        };
        for line in BufReader::new(file).lines() {
            let line = line?;
            if let Ok(record) = serde_json::from_str::<BlobBatchRecord>(&line) {
                if record.hash == hash {
                    return Ok(Some(BlobPayload {
                        hash: record.hash,
                        value: record.value,
                    }));
                }
            }
        }
        Ok(None)
    }

    /// Appends one settled round. Never rewrites an earlier line, for the same
    /// crash-safety reason as `append_items`: a half-written line is losable,
    /// what came before it is not.
    pub fn append_round(
        &self,
        workspace_id: &str,
        session_id: &str,
        record: &RoundRecord,
    ) -> Result<()> {
        let dir = self.dir(workspace_id);
        fs::create_dir_all(&dir)?;
        let path = self.rounds_path(workspace_id, session_id);
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        crate::config::restrict_to_owner(&path)?;
        writeln!(file, "{}", serde_json::to_string(record)?)?;
        file.flush()?;
        Ok(())
    }

    /// Reads the round ledger back, skipping lines that do not parse — a
    /// half-written record from a power cut, or a future schema version this
    /// build does not know — the same tolerance `load_items` has for the
    /// timeline (§8 step 2: "崩溃留下的半行如何丢弃、旧版本 schema 如何读").
    pub fn load_rounds(&self, workspace_id: &str, session_id: &str) -> Result<Vec<RoundRecord>> {
        let path = self.rounds_path(workspace_id, session_id);
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        let mut records = Vec::new();
        for (index, line) in BufReader::new(file).lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<RoundRecord>(&line) {
                Ok(record) => records.push(record),
                Err(error) => {
                    tracing::warn!(
                        "skipping unreadable round ledger line {} of {}: {error}",
                        index + 1,
                        path.display()
                    );
                }
            }
        }
        Ok(records)
    }

    /// Backfills the round ledger for a session that predates it, exactly
    /// once: a no-op as soon as the ledger file exists on disk, even if that
    /// file ends up holding zero records — the file's presence is the whole
    /// guard, not its content, so a session with no completed turn yet is
    /// never mistaken for one still needing migration.
    ///
    /// Called from `SessionManager::live` with the same items already loaded
    /// for the overview-condense migration, so this never re-reads the
    /// timeline on its own.
    pub fn ensure_rounds_migrated(
        &self,
        workspace_id: &str,
        session_id: &str,
        legacy_items: &[TimelineItem],
    ) -> Result<()> {
        let path = self.rounds_path(workspace_id, session_id);
        if !path.exists() {
            let records = rounds::migrate_legacy(legacy_items);
            return self.write_rounds(workspace_id, session_id, &records);
        }
        let mut records = self.load_rounds(workspace_id, session_id)?;
        if records
            .iter()
            .all(|record| record.schema_version >= rounds::SCHEMA_VERSION)
        {
            return Ok(());
        }
        let items_by_id: std::collections::HashMap<&str, &TimelineItem> =
            legacy_items.iter().map(|item| (item.id(), item)).collect();
        for record in &mut records {
            if record.schema_version >= rounds::SCHEMA_VERSION {
                continue;
            }
            let round_items: Vec<TimelineItem> = record
                .item_ids
                .iter()
                .filter_map(|id| items_by_id.get(id.as_str()).map(|item| (*item).clone()))
                .collect();
            record.trunk_summaries = rounds::summarize_trunks(&round_items);
            record.schema_version = rounds::SCHEMA_VERSION;
        }
        self.write_rounds(workspace_id, session_id, &records)
    }

    /// Bulk (over)write used only by the one-time legacy migration above.
    /// Every other writer appends one record at a time as a round settles
    /// (`append_round`) — this is not a general-purpose rewrite path.
    fn write_rounds(
        &self,
        workspace_id: &str,
        session_id: &str,
        records: &[RoundRecord],
    ) -> Result<()> {
        let dir = self.dir(workspace_id);
        fs::create_dir_all(&dir)?;
        let path = self.rounds_path(workspace_id, session_id);
        let mut body = Vec::new();
        for record in records {
            writeln!(body, "{}", serde_json::to_string(record)?)?;
        }
        crate::config::save_private(&path, &body)
    }

    /// Every session on disk, newest first.
    pub fn list_meta(&self) -> Result<Vec<SessionMeta>> {
        let mut out = Vec::new();
        let Ok(workspaces) = fs::read_dir(&self.root) else {
            return Ok(out);
        };
        for workspace in workspaces.flatten() {
            if !workspace.path().is_dir() {
                continue;
            }
            let Ok(entries) = fs::read_dir(workspace.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.to_string_lossy().ends_with(".meta.json") {
                    continue;
                }
                match fs::read_to_string(&path).map(|raw| serde_json::from_str(&raw)) {
                    Ok(Ok(meta)) => out.push(meta),
                    _ => tracing::warn!("skipping unreadable session meta {}", path.display()),
                }
            }
        }
        out.sort_by_key(|meta: &SessionMeta| std::cmp::Reverse(meta.updated_at_ms));
        Ok(out)
    }

    /// Removes every trace of a session from disk.
    ///
    /// The scratch directory goes with the rest. It is where adapters keep a
    /// CLI's own idea of the conversation — a `--resume` id, a thread file —
    /// and leaving it behind would mean a deleted conversation still exists
    /// inside the agent, which is not what anyone means by "delete".
    ///
    /// Missing files are not an error: this is also the cleanup path for a
    /// session that never got as far as being written.
    pub fn delete(&self, workspace_id: &str, session_id: &str) -> Result<()> {
        let _ = fs::remove_file(self.timeline_path(workspace_id, session_id));
        let _ = fs::remove_file(self.rounds_path(workspace_id, session_id));
        let _ = fs::remove_file(self.blob_index_path(workspace_id, session_id));
        let _ = fs::remove_dir_all(self.dir(workspace_id).join(session_id));
        let _ = fs::remove_file(self.meta_path(workspace_id, session_id));
        let _ = fs::remove_dir_all(self.scratch_dir(workspace_id, session_id));
        Ok(())
    }

    /// Private per-session scratch space for adapters.
    pub fn scratch_dir(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.dir(workspace_id).join(format!("{session_id}.state"))
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A first line of user text, trimmed into something that fits a sidebar.
///
/// `None` when there is nothing to name it after; the session stays untitled
/// rather than being called something in a language nobody chose.
pub fn title_from(text: &str) -> Option<String> {
    let first = text.lines().find(|line| !line.trim().is_empty())?;
    let trimmed: String = first.trim().chars().take(60).collect();
    (!trimmed.is_empty()).then_some(trimmed)
}

pub fn ensure_within(root: &Path, candidate: &Path) -> Result<PathBuf> {
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    // Resolve without requiring existence, so writes to new files still work.
    let normalized = normalize(&joined);
    let root = normalize(root);
    if !normalized.starts_with(&root) {
        anyhow::bail!("path escapes the workspace");
    }
    Ok(normalized)
}

/// Lexical path cleanup. `canonicalize` is unusable here because the target may
/// not exist yet, and on Windows it produces verbatim paths that break prefix
/// comparison.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{
        PermissionOption, PermissionOptionKind, PermissionRequestKind, ToolStatus,
    };

    fn meta(id: &str) -> SessionMeta {
        SessionMeta {
            effort_id: None,
            id: id.into(),
            workspace_id: "w1".into(),
            agent_id: "genet".into(),
            title: Some("demo".into()),
            cwd: PathBuf::from("/tmp"),
            model_id: None,
            mode_id: None,
            created_at_ms: 1,
            updated_at_ms: 2,
            archived: false,
            persist: None,
            pending_permission: None,
        }
    }

    #[test]
    fn items_round_trip_through_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let items = vec![
            TimelineItem::UserMessage {
                id: "1".into(),
                text: "hi".into(),
                attachments: vec![],
            },
            TimelineItem::ToolCall {
                id: "2".into(),
                name: "bash".into(),
                status: ToolStatus::Ok,
                detail: genehub_proto::ToolCallDetail::Shell {
                    command: "ls".into(),
                    output: "a".into(),
                    exit_code: Some(0),
                },
            },
        ];
        store.append_items("w1", "s1", &items).unwrap();
        assert_eq!(store.load_items("w1", "s1").unwrap(), items);
    }

    #[test]
    fn appending_twice_keeps_both_batches_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        for text in ["one", "two"] {
            store
                .append_items(
                    "w1",
                    "s1",
                    &[TimelineItem::AssistantMessage {
                        id: text.into(),
                        text: text.into(),
                    }],
                )
                .unwrap();
        }
        let loaded = store.load_items("w1", "s1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id(), "one");
    }

    #[test]
    fn replacing_a_legacy_timeline_removes_its_old_payload() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let legacy = TimelineItem::ToolCall {
            id: "tool".into(),
            name: "bash".into(),
            status: ToolStatus::Ok,
            detail: genehub_proto::ToolCallDetail::Shell {
                command: "cat secrets".into(),
                output: "old detailed output".into(),
                exit_code: Some(0),
            },
        };
        store.append_items("w1", "s1", &[legacy]).unwrap();
        let overview = TimelineItem::ToolCall {
            id: "tool".into(),
            name: "bash".into(),
            status: ToolStatus::Ok,
            detail: genehub_proto::ToolCallDetail::Overview {
                tool_kind: genehub_proto::ToolKind::Shell,
                overview: "cat secrets".into(),
                input: "cat secrets".into(),
                output: "old detailed output".into(),
            },
        };
        store
            .replace_items("w1", "s1", std::slice::from_ref(&overview))
            .unwrap();

        assert_eq!(store.load_items("w1", "s1").unwrap(), vec![overview]);
        let raw = fs::read_to_string(dir.path().join("w1/s1.jsonl")).unwrap();
        assert!(!raw.contains("kind\":\"shell"));

        let final_item = TimelineItem::AssistantMessage {
            id: "final".into(),
            text: "second replacement".into(),
        };
        store
            .replace_items("w1", "s1", std::slice::from_ref(&final_item))
            .unwrap();
        assert_eq!(store.load_items("w1", "s1").unwrap(), vec![final_item]);
    }

    /// A truncated tail is the normal outcome of a power cut on an append-only
    /// log. Losing the last line is acceptable; losing the session is not.
    #[test]
    fn a_corrupt_line_does_not_take_the_session_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        store
            .append_items(
                "w1",
                "s1",
                &[TimelineItem::AssistantMessage {
                    id: "1".into(),
                    text: "good".into(),
                }],
            )
            .unwrap();
        let path = dir.path().join("w1").join("s1.jsonl");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{{\"type\":\"assistantMes").unwrap();
        drop(file);

        let loaded = store.load_items("w1", "s1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id(), "1");
    }

    #[test]
    fn a_session_with_no_log_yet_loads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert!(store.load_items("w1", "never").unwrap().is_empty());
    }

    fn round(round_id: &str) -> RoundRecord {
        RoundRecord {
            schema_version: rounds::SCHEMA_VERSION,
            round_id: round_id.into(),
            started_at_ms: 1,
            ended_at_ms: 2,
            outcome: rounds::RoundOutcome::Completed,
            adapter_turn_ids: vec!["t1".into()],
            item_ids: vec!["u1".into()],
            blocked_ms: 0,
            synthesized: false,
            trunk_summaries: vec![],
        }
    }

    #[test]
    fn rounds_round_trip_through_the_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        store.append_round("w1", "s1", &round("r1")).unwrap();
        store.append_round("w1", "s1", &round("r2")).unwrap();

        let loaded = store.load_rounds("w1", "s1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].round_id, "r1");
        assert_eq!(loaded[1].round_id, "r2");
    }

    #[test]
    fn trunk_summaries_round_trip_through_the_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let mut with_trunks = round("r1");
        with_trunks.trunk_summaries = vec![rounds::TrunkSummary {
            index: 0,
            first_item_id: "a1".into(),
            blob_count: 3,
            title: "reading the config first".into(),
            batches: vec![rounds::BatchSummary {
                index: 0,
                first_item_id: "a1".into(),
                blob_count: 3,
                text: "reading the config first".into(),
            }],
        }];
        store.append_round("w1", "s1", &with_trunks).unwrap();

        let loaded = store.load_rounds("w1", "s1").unwrap();
        assert_eq!(loaded[0].trunk_summaries, with_trunks.trunk_summaries);
    }

    #[test]
    fn a_round_line_written_before_trunks_existed_still_loads_with_an_empty_trunk_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let path = dir.path().join("w1");
        std::fs::create_dir_all(&path).unwrap();
        // A hand-written line with no `trunkSummaries` key at all, as an
        // on-disk ledger from before this field shipped would have.
        std::fs::write(
            path.join("s1.rounds.jsonl"),
            "{\"schemaVersion\":1,\"roundId\":\"r1\",\"startedAtMs\":1,\"endedAtMs\":2,\
             \"outcome\":\"completed\",\"adapterTurnIds\":[\"t1\"],\"itemIds\":[\"u1\"],\
             \"blockedMs\":0}\n",
        )
        .unwrap();

        let loaded = store.load_rounds("w1", "s1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(
            loaded[0].trunk_summaries.is_empty(),
            "a pre-trunk record has nothing honest to backfill this field with"
        );
    }

    #[test]
    fn a_session_with_no_ledger_yet_loads_as_an_empty_round_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert!(store.load_rounds("w1", "never").unwrap().is_empty());
    }

    #[test]
    fn a_corrupt_round_line_does_not_take_the_ledger_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        store.append_round("w1", "s1", &round("r1")).unwrap();
        let path = dir.path().join("w1").join("s1.rounds.jsonl");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{{\"roundId\":\"broke").unwrap();
        drop(file);

        let loaded = store.load_rounds("w1", "s1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].round_id, "r1");
    }

    #[test]
    fn deleting_a_session_takes_its_round_ledger_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        store.append_round("w1", "s1", &round("r1")).unwrap();
        store.delete("w1", "s1").unwrap();
        assert!(store.load_rounds("w1", "s1").unwrap().is_empty());
        assert!(!dir.path().join("w1").join("s1.rounds.jsonl").exists());
    }

    #[test]
    fn migrating_an_old_session_writes_the_ledger_file_even_with_zero_rounds() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        // No `TurnSummary` in this history at all — a session that never
        // completed a turn before this upgrade shipped.
        store
            .ensure_rounds_migrated(
                "w1",
                "s1",
                &[TimelineItem::UserMessage {
                    id: "u1".into(),
                    text: "hi".into(),
                    attachments: vec![],
                }],
            )
            .unwrap();

        assert!(store.load_rounds("w1", "s1").unwrap().is_empty());
        assert!(
            dir.path().join("w1").join("s1.rounds.jsonl").exists(),
            "the ledger file itself must exist so a second call knows migration already ran"
        );
    }

    #[test]
    fn migration_never_runs_twice_even_if_the_ledger_would_otherwise_differ() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let legacy_items = |turn_id: &str| {
            vec![
                TimelineItem::UserMessage {
                    id: "u1".into(),
                    text: "hi".into(),
                    attachments: vec![],
                },
                TimelineItem::TurnSummary {
                    id: format!("turn-summary-{turn_id}"),
                    stats: genehub_proto::TurnStats {
                        turn_id: turn_id.into(),
                        outcome: genehub_proto::TurnOutcome::Completed,
                        started_at_ms: 1,
                        finished_at_ms: 2,
                        duration_ms: 1,
                        usage: genehub_proto::Usage::default(),
                        tool_calls: 0,
                        fork_checkpoint: None,
                    },
                },
            ]
        };

        store
            .ensure_rounds_migrated("w1", "s1", &legacy_items("t1"))
            .unwrap();
        // A second call with different history (as if the in-memory replay
        // diverged) must not touch the file the first call already wrote.
        store
            .ensure_rounds_migrated("w1", "s1", &legacy_items("t2"))
            .unwrap();

        let loaded = store.load_rounds("w1", "s1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].round_id, "legacy_r_t1");
    }

    #[test]
    fn schema_one_trunks_upgrade_once_to_sixty_four_sixteen_shape() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let root = dir.path().join("w1");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("s1.rounds.jsonl"),
            "{\"schemaVersion\":1,\"roundId\":\"r1\",\"startedAtMs\":1,\"endedAtMs\":2,\
             \"outcome\":\"completed\",\"adapterTurnIds\":[\"t1\"],\
             \"itemIds\":[\"u1\",\"a1\",\"c1\",\"turn-summary-t1\"],\"blockedMs\":0,\
             \"trunkSummaries\":[{\"index\":0,\"firstItemId\":\"a1\",\"itemCount\":1,\
             \"overview\":\"old title\"}]}\n",
        )
        .unwrap();
        let items = vec![
            TimelineItem::UserMessage {
                id: "u1".into(),
                text: "do it".into(),
                attachments: vec![],
            },
            TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "先读取配置。再修改".into(),
            },
            TimelineItem::ToolCall {
                id: "c1".into(),
                name: "read".into(),
                status: ToolStatus::Ok,
                detail: genehub_proto::ToolCallDetail::Read {
                    path: "a.txt".into(),
                    content: "source".into(),
                    truncated: false,
                },
            },
            TimelineItem::TurnSummary {
                id: "turn-summary-t1".into(),
                stats: genehub_proto::TurnStats {
                    turn_id: "t1".into(),
                    outcome: genehub_proto::TurnOutcome::Completed,
                    started_at_ms: 1,
                    finished_at_ms: 2,
                    duration_ms: 1,
                    usage: genehub_proto::Usage::default(),
                    tool_calls: 1,
                    fork_checkpoint: None,
                },
            },
        ];

        store.ensure_rounds_migrated("w1", "s1", &items).unwrap();
        let upgraded = store.load_rounds("w1", "s1").unwrap();
        assert_eq!(upgraded[0].schema_version, rounds::SCHEMA_VERSION);
        assert_eq!(upgraded[0].trunk_summaries[0].blob_count, 1);
        assert_eq!(upgraded[0].trunk_summaries[0].title, "先读取配置。");
        assert_eq!(upgraded[0].trunk_summaries[0].batches.len(), 1);

        store.ensure_rounds_migrated("w1", "s1", &[]).unwrap();
        assert_eq!(
            store.load_rounds("w1", "s1").unwrap()[0].trunk_summaries,
            upgraded[0].trunk_summaries
        );
    }

    #[test]
    fn schema_two_batches_upgrade_once_to_join_leading_reasoning_to_its_monologue() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let root = dir.path().join("w1");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("s1.rounds.jsonl"),
            "{\"schemaVersion\":2,\"roundId\":\"r1\",\"startedAtMs\":1,\"endedAtMs\":2,\
             \"outcome\":\"completed\",\"adapterTurnIds\":[\"t1\"],\
             \"itemIds\":[\"u1\",\"r1\",\"a1\",\"c1\",\"a2\",\"turn-summary-t1\"],\
             \"blockedMs\":0,\"trunkSummaries\":[]}\n",
        )
        .unwrap();
        let items = vec![
            TimelineItem::UserMessage {
                id: "u1".into(),
                text: "do it".into(),
                attachments: vec![],
            },
            TimelineItem::Reasoning {
                id: "r1".into(),
                text: "先判断入口".into(),
            },
            TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "开始核对网络边界".into(),
            },
            TimelineItem::ToolCall {
                id: "c1".into(),
                name: "read".into(),
                status: ToolStatus::Ok,
                detail: genehub_proto::ToolCallDetail::Read {
                    path: "a.txt".into(),
                    content: "source".into(),
                    truncated: false,
                },
            },
            TimelineItem::AssistantMessage {
                id: "a2".into(),
                text: "完成核对".into(),
            },
            TimelineItem::TurnSummary {
                id: "turn-summary-t1".into(),
                stats: genehub_proto::TurnStats {
                    turn_id: "t1".into(),
                    outcome: genehub_proto::TurnOutcome::Completed,
                    started_at_ms: 1,
                    finished_at_ms: 2,
                    duration_ms: 1,
                    usage: genehub_proto::Usage::default(),
                    tool_calls: 1,
                    fork_checkpoint: None,
                },
            },
        ];

        store.ensure_rounds_migrated("w1", "s1", &items).unwrap();
        let upgraded = store.load_rounds("w1", "s1").unwrap();
        assert_eq!(upgraded[0].schema_version, rounds::SCHEMA_VERSION);
        assert_eq!(upgraded[0].trunk_summaries[0].batches.len(), 2);
        assert_eq!(
            upgraded[0].trunk_summaries[0].batches[0].first_item_id,
            "r1"
        );
        assert_eq!(
            upgraded[0].trunk_summaries[0].batches[0].text,
            "开始核对网络边界"
        );

        store.ensure_rounds_migrated("w1", "s1", &[]).unwrap();
        assert_eq!(
            store.load_rounds("w1", "s1").unwrap()[0].trunk_summaries,
            upgraded[0].trunk_summaries
        );
    }

    #[test]
    fn blobs_are_content_addressed_batched_and_retrievable() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let value = serde_json::json!({"type":"reasoning","id":"r1","text":"完整思考"});
        let first = store
            .put_blob("w1", "s1", "r1", BlobKind::Reasoning, value.clone())
            .unwrap();
        let second = store
            .put_blob("w1", "s1", "r2", BlobKind::Reasoning, value.clone())
            .unwrap();
        assert_eq!(
            first.hash, second.hash,
            "equal content deduplicates by hash"
        );
        assert_eq!(
            store
                .get_blob("w1", "s1", &first.hash)
                .unwrap()
                .unwrap()
                .value,
            value
        );
        let batch = dir
            .path()
            .join("w1")
            .join("s1")
            .join("blobs")
            .join(format!("{}.batch", &first.hash[..2]));
        assert_eq!(
            std::fs::read_to_string(batch).unwrap().lines().count(),
            1,
            "the hash bucket stores equal content only once"
        );
        assert_eq!(store.load_blob_refs("w1", "s1").unwrap().len(), 2);
    }

    #[test]
    fn metadata_round_trips_and_lists_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let mut older = meta("s1");
        older.updated_at_ms = 100;
        let mut newer = meta("s2");
        newer.updated_at_ms = 200;
        store.save_meta(&older).unwrap();
        store.save_meta(&newer).unwrap();

        let listed = store.list_meta().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "s2");
        assert_eq!(
            store.load_meta("w1", "s1").unwrap().title.as_deref(),
            Some("demo")
        );

        older.title = Some("saved again".into());
        store.save_meta(&older).unwrap();
        assert_eq!(
            store.load_meta("w1", "s1").unwrap().title.as_deref(),
            Some("saved again")
        );
    }

    #[test]
    fn a_stopped_interaction_survives_a_daemon_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let mut session = meta("s1");
        session.pending_permission = Some(PermissionRequest {
            id: "p1".into(),
            kind: PermissionRequestKind::Permission,
            title: "Write outside the workspace?".into(),
            detail: Some("/tmp/report.txt".into()),
            options: vec![PermissionOption {
                id: "allow".into(),
                label: "Allow".into(),
                kind: PermissionOptionKind::AllowOnce,
            }],
            tool_call_id: Some("call-1".into()),
        });
        store.save_meta(&session).unwrap();

        let restored = Store::new(dir.path()).load_meta("w1", "s1").unwrap();
        let request = restored.pending_permission.unwrap();
        assert_eq!(request.id, "p1");
        assert_eq!(request.kind, PermissionRequestKind::Permission);
        assert_eq!(request.tool_call_id.as_deref(), Some("call-1"));
    }

    #[test]
    fn titles_come_from_the_first_non_empty_line_and_stay_short() {
        assert_eq!(
            title_from("\n\nhello there\nmore").as_deref(),
            Some("hello there")
        );
        assert_eq!(title_from("   "), None, "nothing to name it after");
        assert_eq!(title_from(&"x".repeat(200)).unwrap().chars().count(), 60);
    }

    #[test]
    fn paths_inside_the_workspace_resolve() {
        let root = Path::new("/work/project");
        assert_eq!(
            ensure_within(root, Path::new("src/main.rs")).unwrap(),
            PathBuf::from("/work/project/src/main.rs")
        );
        assert_eq!(
            ensure_within(root, Path::new("./a/../b.txt")).unwrap(),
            PathBuf::from("/work/project/b.txt")
        );
    }

    #[test]
    fn traversal_out_of_the_workspace_is_refused() {
        let root = Path::new("/work/project");
        assert!(ensure_within(root, Path::new("../secrets")).is_err());
        assert!(ensure_within(root, Path::new("a/../../secrets")).is_err());
        assert!(ensure_within(root, Path::new("/etc/passwd")).is_err());
    }

    /// A sibling directory sharing a name prefix must not pass a naive
    /// `starts_with` on the string form.
    #[test]
    fn a_sibling_with_a_shared_prefix_is_not_inside_the_workspace() {
        assert!(ensure_within(Path::new("/work/proj"), Path::new("/work/project-evil/x")).is_err());
    }
}
