//! Session persistence: one self-contained directory per session, laid out so
//! that a path locates a file and a reference locates a byte range — never a
//! scan (`docs/session-storage.md`).
//!
//! ```text
//! <root>/<workspace>/<session>/meta.json
//! <root>/<workspace>/<session>/chat.jsonl                 narrative + one row per round
//! <root>/<workspace>/<session>/rounds/r-000/index.jsonl   one row per trunk
//! <root>/<workspace>/<session>/rounds/r-000/t-0000.jsonl  one trunk's batches and blob rows
//! <root>/<workspace>/<session>/blobs/b-9f.jsonl           blob payloads, bucketed by content id
//! <root>/<workspace>/<session>/state/                     adapter scratch
//! ```
//!
//! Deltas are never written. Only settled items reach disk, which keeps a
//! session proportional to what was actually said rather than to the number of
//! tokens streamed (`docs/daemon.md` §4).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use genehub_proto::{
    BlobKind, BlobOverview, BlobPayload, BlobRef, PermissionRequest, RoundBatch, RoundBatchSummary,
    RoundTrunk, RoundTrunkSummary, SessionStatus, SessionSummary, TimelineItem,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::rounds::{self, RoundRecord};
use crate::adapter::PersistHandle;

/// Content ids are the first 24 hex characters of a SHA-256. 96 bits keeps
/// collisions negligible at any session size, and every trunk row carries one.
const BLOB_ID_CHARS: usize = 24;
/// Refuses a locator that would have the daemon allocate an absurd buffer for
/// a client-supplied length. No single settled item legitimately reaches this.
const MAX_BLOB_BYTES: u64 = 512 * 1024 * 1024;

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

/// Everything `chat.jsonl` holds, already folded.
#[derive(Debug, Clone, Default)]
pub struct ChatLog {
    /// Session narrative, in order. Never contains tool calls or reasoning.
    pub items: Vec<TimelineItem>,
    /// One entry per round, in order, last write per `roundId` winning.
    pub rounds: Vec<RoundRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum ChatRow {
    Item { item: TimelineItem },
    Round { round: RoundRecord },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum TrunkRow {
    #[serde(rename_all = "camelCase")]
    Batch {
        index: u32,
        first_item_id: String,
        blob_count: u32,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monologue: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Blob {
        item_id: String,
        kind: BlobKind,
        overview: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blob: Option<BlobRef>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobRecord {
    id: String,
    value: Value,
}

/// Content already written during this process's lifetime, so the same file
/// read twice in one run is stored once.
///
/// Deliberately not persisted: rebuilding it on open would mean reading every
/// blob id back, which is the O(N) open this layout exists to remove. Dedup is
/// an optimisation, not a correctness property — a duplicate payload after a
/// restart costs disk and nothing else, because each reference is complete on
/// its own (`docs/session-storage.md` §3.3).
pub type BlobDedup = HashMap<String, BlobRef>;

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

    fn workspace_dir(&self, workspace_id: &str) -> PathBuf {
        self.root.join(workspace_id)
    }

    pub fn session_dir(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.workspace_dir(workspace_id).join(session_id)
    }

    fn meta_path(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.session_dir(workspace_id, session_id).join("meta.json")
    }

    fn chat_path(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.session_dir(workspace_id, session_id)
            .join("chat.jsonl")
    }

    fn round_dir(&self, workspace_id: &str, session_id: &str, ord: u32) -> PathBuf {
        self.session_dir(workspace_id, session_id)
            .join("rounds")
            .join(format!("r-{ord:03}"))
    }

    fn trunk_index_path(&self, workspace_id: &str, session_id: &str, ord: u32) -> PathBuf {
        self.round_dir(workspace_id, session_id, ord)
            .join("index.jsonl")
    }

    fn trunk_path(&self, workspace_id: &str, session_id: &str, ord: u32, trunk: u32) -> PathBuf {
        self.round_dir(workspace_id, session_id, ord)
            .join(format!("t-{trunk:04}.jsonl"))
    }

    fn blob_dir(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.session_dir(workspace_id, session_id).join("blobs")
    }

    /// Private per-session scratch space for adapters.
    pub fn scratch_dir(&self, workspace_id: &str, session_id: &str) -> PathBuf {
        self.session_dir(workspace_id, session_id).join("state")
    }

    // -- meta ---------------------------------------------------------------

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

    /// Every session on disk, newest first.
    ///
    /// Pre-relayout sessions kept their meta beside the timeline as
    /// `<session>.meta.json`; they are still listed so a user can open one and
    /// have it migrated, rather than watching their history disappear.
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
                let meta_path = if path.is_dir() {
                    path.join("meta.json")
                } else if path.to_string_lossy().ends_with(".meta.json") {
                    path
                } else {
                    continue;
                };
                if !meta_path.exists() {
                    continue;
                }
                match fs::read_to_string(&meta_path).map(|raw| serde_json::from_str(&raw)) {
                    Ok(Ok(meta)) => out.push(meta),
                    _ => tracing::warn!("skipping unreadable session meta {}", meta_path.display()),
                }
            }
        }
        out.sort_by_key(|meta: &SessionMeta| std::cmp::Reverse(meta.updated_at_ms));
        Ok(out)
    }

    // -- chat layer ---------------------------------------------------------

    /// Appends settled narrative items. Existing lines are never rewritten, so
    /// a crash can lose the tail but cannot corrupt what came before.
    ///
    /// Tool calls and reasoning are rejected rather than silently dropped:
    /// they belong to a round's trunk files, and a caller that sends one here
    /// has a bug that would otherwise show up much later as a session whose
    /// narrative mysteriously contains work.
    pub fn append_chat_items(
        &self,
        workspace_id: &str,
        session_id: &str,
        items: &[TimelineItem],
    ) -> Result<()> {
        let rows: Vec<ChatRow> = items
            .iter()
            .filter(|item| !is_work_item(item))
            .map(|item| ChatRow::Item { item: item.clone() })
            .collect();
        self.append_chat_rows(workspace_id, session_id, &rows)
    }

    /// Records a round's current state. Called twice per round — once when it
    /// opens, once when it settles — and read last-wins per `roundId`.
    pub fn append_round(
        &self,
        workspace_id: &str,
        session_id: &str,
        record: &RoundRecord,
    ) -> Result<()> {
        self.append_chat_rows(
            workspace_id,
            session_id,
            &[ChatRow::Round {
                round: record.clone(),
            }],
        )
    }

    fn append_chat_rows(
        &self,
        workspace_id: &str,
        session_id: &str,
        rows: &[ChatRow],
    ) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let path = self.chat_path(workspace_id, session_id);
        fs::create_dir_all(path.parent().expect("chat.jsonl always has a parent"))?;
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        crate::config::restrict_to_owner(&path)?;
        for row in rows {
            writeln!(file, "{}", serde_json::to_string(row)?)?;
        }
        file.flush()?;
        Ok(())
    }

    /// Reads the chat layer back, skipping lines that do not parse.
    ///
    /// A single bad line — a half-written record from a power cut, or a record
    /// from a newer version — must not make the whole conversation unopenable.
    pub fn load_chat(&self, workspace_id: &str, session_id: &str) -> Result<ChatLog> {
        let path = self.chat_path(workspace_id, session_id);
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ChatLog::default()),
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        let mut log = ChatLog::default();
        for (index, line) in BufReader::new(file).lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<ChatRow>(&line) {
                Ok(ChatRow::Item { item }) => log.items.push(item),
                Ok(ChatRow::Round { round }) => {
                    match log
                        .rounds
                        .iter_mut()
                        .find(|existing| existing.round_id == round.round_id)
                    {
                        Some(existing) => *existing = round,
                        None => log.rounds.push(round),
                    }
                }
                Err(error) => tracing::warn!(
                    "skipping unreadable line {} of {}: {error}",
                    index + 1,
                    path.display()
                ),
            }
        }
        log.rounds.sort_by_key(|round| round.ord);
        Ok(log)
    }

    // -- round layer --------------------------------------------------------

    /// Writes one trunk in full and records its summary.
    ///
    /// A trunk file is always written whole rather than appended to, so it is
    /// never half a trunk: the open trunk is rewritten at each turn boundary
    /// and the last write is the settled one. At a hundred rows the rewrite is
    /// a few tens of kilobytes, which is cheaper than the bookkeeping needed to
    /// append safely across turn boundaries.
    pub fn write_trunk(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
        trunk: &RoundTrunk,
    ) -> Result<()> {
        let dir = self.round_dir(workspace_id, session_id, ord);
        fs::create_dir_all(&dir)?;
        let mut body = Vec::new();
        for batch in &trunk.batches {
            writeln!(
                body,
                "{}",
                serde_json::to_string(&TrunkRow::Batch {
                    index: batch.summary.index,
                    first_item_id: batch.summary.first_item_id.clone(),
                    blob_count: batch.summary.blob_count,
                    text: batch.summary.text.clone(),
                    monologue: batch.monologue.clone(),
                })?
            )?;
            for blob in &batch.blobs {
                writeln!(
                    body,
                    "{}",
                    serde_json::to_string(&TrunkRow::Blob {
                        item_id: blob.item_id.clone(),
                        kind: blob.kind,
                        overview: blob.overview.clone(),
                        blob: blob.blob.clone(),
                    })?
                )?;
            }
        }
        let path = self.trunk_path(workspace_id, session_id, ord, trunk.summary.index);
        crate::config::save_private(&path, &body)?;
        self.append_trunk_summary(workspace_id, session_id, ord, &trunk.summary)
    }

    fn append_trunk_summary(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
        summary: &RoundTrunkSummary,
    ) -> Result<()> {
        let path = self.trunk_index_path(workspace_id, session_id, ord);
        fs::create_dir_all(path.parent().expect("index.jsonl always has a parent"))?;
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        crate::config::restrict_to_owner(&path)?;
        writeln!(file, "{}", serde_json::to_string(summary)?)?;
        file.flush()?;
        Ok(())
    }

    /// One round's trunk index, last write per trunk index winning.
    pub fn load_trunk_index(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
    ) -> Result<Vec<RoundTrunkSummary>> {
        let path = self.trunk_index_path(workspace_id, session_id, ord);
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        let mut summaries: Vec<RoundTrunkSummary> = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let Ok(summary) = serde_json::from_str::<RoundTrunkSummary>(&line) else {
                tracing::warn!("skipping unreadable trunk index line in {}", path.display());
                continue;
            };
            match summaries
                .iter_mut()
                .find(|existing| existing.index == summary.index)
            {
                Some(existing) => *existing = summary,
                None => summaries.push(summary),
            }
        }
        summaries.sort_by_key(|summary| summary.index);
        Ok(summaries)
    }

    /// One trunk's batches. The summary comes from the caller's index read, so
    /// this touches exactly one small file.
    pub fn load_trunk(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
        summary: &RoundTrunkSummary,
    ) -> Result<RoundTrunk> {
        let path = self.trunk_path(workspace_id, session_id, ord, summary.index);
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RoundTrunk {
                    summary: summary.clone(),
                    batches: Vec::new(),
                })
            }
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        let mut batches: Vec<RoundBatch> = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<TrunkRow>(&line) {
                Ok(TrunkRow::Batch {
                    index,
                    first_item_id,
                    blob_count,
                    text,
                    monologue,
                }) => batches.push(RoundBatch {
                    summary: RoundBatchSummary {
                        index,
                        first_item_id,
                        blob_count,
                        text,
                    },
                    monologue,
                    blobs: Vec::new(),
                }),
                Ok(TrunkRow::Blob {
                    item_id,
                    kind,
                    overview,
                    blob,
                }) => {
                    // A blob row before any batch row means a truncated write.
                    // Attaching it to a synthetic batch keeps the content
                    // visible instead of silently dropping it.
                    if batches.is_empty() {
                        batches.push(RoundBatch {
                            summary: RoundBatchSummary {
                                index: 0,
                                first_item_id: item_id.clone(),
                                blob_count: 0,
                                text: String::new(),
                            },
                            monologue: None,
                            blobs: Vec::new(),
                        });
                    }
                    batches
                        .last_mut()
                        .expect("just ensured non-empty")
                        .blobs
                        .push(BlobOverview {
                            item_id,
                            kind,
                            overview,
                            blob,
                        });
                }
                Err(error) => {
                    tracing::warn!(
                        "skipping unreadable trunk row in {}: {error}",
                        path.display()
                    )
                }
            }
        }
        Ok(RoundTrunk {
            summary: summary.clone(),
            batches,
        })
    }

    // -- blob layer ---------------------------------------------------------

    /// Stores canonical JSON by content id, returning a reference that already
    /// knows where the bytes are.
    ///
    /// The returned `at` is what makes reads a seek instead of a scan; nothing
    /// else indexes blobs, so the row that keeps this reference is the index.
    pub fn put_blob(
        &self,
        workspace_id: &str,
        session_id: &str,
        value: Value,
        seen: &mut BlobDedup,
    ) -> Result<BlobRef> {
        let encoded = serde_json::to_vec(&value)?;
        let digest = Sha256::digest(&encoded);
        let id: String = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            .chars()
            .take(BLOB_ID_CHARS)
            .collect();
        if let Some(existing) = seen.get(&id) {
            return Ok(existing.clone());
        }
        let bucket = &id[..2];
        let dir = self.blob_dir(workspace_id, session_id);
        fs::create_dir_all(&dir)?;
        let path = dir.join(format!("b-{bucket}.jsonl"));
        let line = serde_json::to_vec(&BlobRecord {
            id: id.clone(),
            value,
        })?;
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        crate::config::restrict_to_owner(&path)?;
        let offset = file.metadata()?.len();
        file.write_all(&line)?;
        file.write_all(b"\n")?;
        file.flush()?;
        let blob = BlobRef {
            id: id.clone(),
            bytes: encoded.len() as u64,
            at: format!("{bucket}:{offset}:{}", line.len()),
        };
        seen.insert(id, blob.clone());
        Ok(blob)
    }

    /// Resolves a reference: one seek, one bounded read, one parse.
    ///
    /// The locator arrives from a client, so it is treated as untrusted input.
    /// It cannot reach outside this session — the bucket is two hex characters
    /// — but it can still name a nonsense range, and the id read back must
    /// match the id asked for before the payload is handed over.
    pub fn get_blob(
        &self,
        workspace_id: &str,
        session_id: &str,
        blob: &BlobRef,
    ) -> Result<Option<BlobPayload>> {
        let Some((bucket, offset, length)) = parse_locator(&blob.at) else {
            return Ok(None);
        };
        if !is_blob_id(&blob.id) || length == 0 || length > MAX_BLOB_BYTES {
            return Ok(None);
        }
        let path = self
            .blob_dir(workspace_id, session_id)
            .join(format!("b-{bucket}.jsonl"));
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
        };
        if offset.saturating_add(length) > file.metadata()?.len() {
            return Ok(None);
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut buffer = vec![0u8; length as usize];
        file.read_exact(&mut buffer)?;
        let Ok(record) = serde_json::from_slice::<BlobRecord>(&buffer) else {
            return Ok(None);
        };
        if record.id != blob.id {
            return Ok(None);
        }
        Ok(Some(BlobPayload {
            id: record.id,
            value: record.value,
        }))
    }

    // -- lifecycle ----------------------------------------------------------

    /// Removes every trace of a session from disk.
    ///
    /// The scratch directory goes with the rest. It is where adapters keep a
    /// CLI's own idea of the conversation — a `--resume` id, a thread file —
    /// and leaving it behind would mean a deleted conversation still exists
    /// inside the agent, which is not what anyone means by "delete".
    ///
    /// Missing files are not an error: this is also the cleanup path for a
    /// session that never got as far as being written, and it still sweeps the
    /// pre-relayout filenames so an interrupted migration leaves nothing.
    pub fn delete(&self, workspace_id: &str, session_id: &str) -> Result<()> {
        let _ = fs::remove_dir_all(self.session_dir(workspace_id, session_id));
        for legacy in self.legacy_paths(workspace_id, session_id) {
            let _ = fs::remove_file(legacy);
        }
        let _ = fs::remove_dir_all(
            self.workspace_dir(workspace_id)
                .join(format!("{session_id}.state")),
        );
        Ok(())
    }

    fn legacy_paths(&self, workspace_id: &str, session_id: &str) -> Vec<PathBuf> {
        let dir = self.workspace_dir(workspace_id);
        vec![
            dir.join(format!("{session_id}.jsonl")),
            dir.join(format!("{session_id}.rounds.jsonl")),
            dir.join(format!("{session_id}.blobrefs.jsonl")),
            dir.join(format!("{session_id}.meta.json")),
        ]
    }

    /// Rewrites a pre-relayout session into the current layout, once.
    ///
    /// The guard is whether `chat.jsonl` exists — a file's presence, not its
    /// contents, exactly as the older one-shot migrations decided. Old files
    /// are removed only after the new ones are fully written, so an
    /// interruption leaves the session in its old shape and the next open
    /// tries again.
    ///
    /// Payload that an even older migration already condensed away is gone for
    /// good; those items arrive here with no blob to reference, and this does
    /// not pretend otherwise.
    pub fn migrate_session_layout(&self, workspace_id: &str, session_id: &str) -> Result<bool> {
        if self.chat_path(workspace_id, session_id).exists() {
            return Ok(false);
        }
        let legacy_timeline = self
            .workspace_dir(workspace_id)
            .join(format!("{session_id}.jsonl"));
        let legacy_meta = self
            .workspace_dir(workspace_id)
            .join(format!("{session_id}.meta.json"));
        if !legacy_timeline.exists() && !legacy_meta.exists() {
            return Ok(false);
        }

        if legacy_meta.exists() {
            let raw = fs::read_to_string(&legacy_meta)?;
            let meta: SessionMeta = serde_json::from_str(&raw)?;
            self.save_meta(&meta)?;
        }

        let items = load_legacy_items(&legacy_timeline)?;
        let mut seen = BlobDedup::new();
        let mut rows: Vec<ChatRow> = Vec::new();
        for legacy in rounds::migrate_legacy(&items) {
            let ord = legacy.record.ord;
            let mut record = legacy.record;
            let trunks = rounds::trunks_from_items(&legacy.items);
            for trunk in &trunks {
                let mut stored = trunk.clone();
                for batch in &mut stored.batches {
                    for blob in &mut batch.blobs {
                        let Some(source) =
                            legacy.items.iter().find(|item| item.id() == blob.item_id)
                        else {
                            continue;
                        };
                        blob.blob = Some(self.put_blob(
                            workspace_id,
                            session_id,
                            serde_json::to_value(source)?,
                            &mut seen,
                        )?);
                    }
                }
                self.write_trunk(workspace_id, session_id, ord, &stored)?;
            }
            record.trunk_count = trunks.len() as u32;
            rows.push(ChatRow::Round { round: record });
            for item in &legacy.items {
                if !is_work_item(item) {
                    rows.push(ChatRow::Item { item: item.clone() });
                }
            }
        }
        self.append_chat_rows(workspace_id, session_id, &rows)?;
        // Only now is the new shape complete enough to drop the old one.
        for legacy in self.legacy_paths(workspace_id, session_id) {
            let _ = fs::remove_file(legacy);
        }
        let legacy_blobs = self
            .workspace_dir(workspace_id)
            .join(session_id)
            .join("blobs");
        if legacy_blobs.exists() {
            for entry in fs::read_dir(&legacy_blobs)?.flatten() {
                if entry.path().extension().is_some_and(|ext| ext == "batch") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        let legacy_state = self
            .workspace_dir(workspace_id)
            .join(format!("{session_id}.state"));
        if legacy_state.exists() {
            let _ = fs::rename(legacy_state, self.scratch_dir(workspace_id, session_id));
        }
        Ok(true)
    }
}

/// Tool calls and reasoning belong to the round layer, never to the narrative.
pub fn is_work_item(item: &TimelineItem) -> bool {
    matches!(
        item,
        TimelineItem::ToolCall { .. } | TimelineItem::Reasoning { .. }
    )
}

fn is_blob_id(id: &str) -> bool {
    id.len() == BLOB_ID_CHARS && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_locator(at: &str) -> Option<(String, u64, u64)> {
    let mut parts = at.split(':');
    let bucket = parts.next()?;
    let offset = parts.next()?.parse().ok()?;
    let length = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if bucket.len() != 2 || !bucket.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some((bucket.to_string(), offset, length))
}

fn load_legacy_items(path: &Path) -> Result<Vec<TimelineItem>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
    };
    let mut items = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<TimelineItem>(&line) {
            Ok(item) => items.push(item),
            Err(error) => tracing::warn!("skipping unreadable legacy line: {error}"),
        }
    }
    Ok(items)
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
