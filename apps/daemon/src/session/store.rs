//! Session persistence: append-only JSONL for the timeline, JSON for metadata.
//!
//! Deltas are never written. Only settled items reach disk, which keeps a
//! session file proportional to what was actually said rather than to the
//! number of tokens streamed (`docs/daemon.md` §4).

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use genehub_proto::{SessionStatus, SessionSummary, TimelineItem};
use serde::{Deserialize, Serialize};

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

    fn meta_path(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.dir(workspace_id)
            .join(format!("{session_id}.meta.json"))
    }

    pub fn save_meta(&self, meta: &SessionMeta) -> Result<()> {
        let dir = self.dir(&meta.workspace_id);
        fs::create_dir_all(&dir)?;
        let path = self.meta_path(&meta.workspace_id, &meta.id);
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(meta)?)?;
        fs::rename(&tmp, &path)?;
        Ok(())
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
        let dir = self.dir(workspace_id);
        fs::create_dir_all(&dir)?;
        let path = self.timeline_path(workspace_id, session_id);
        let tmp = path.with_extension("jsonl.tmp");
        let mut file = File::create(&tmp)?;
        for item in items {
            writeln!(file, "{}", serde_json::to_string(item)?)?;
        }
        file.flush()?;
        file.sync_all()?;
        fs::rename(&tmp, &path)?;
        Ok(())
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
    use genehub_proto::ToolStatus;

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
