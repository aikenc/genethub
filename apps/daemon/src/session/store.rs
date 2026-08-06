//! Session persistence: one self-contained directory per session, laid out so
//! that a path locates a file and a reference locates a byte range — never a
//! scan (`docs/session-storage.md`).
//!
//! Sessions live in the workspace they are about, not in the daemon's data
//! directory:
//!
//! ```text
//! <workspace>/.genethub/sessions/<session>/meta.json
//! <workspace>/.genethub/sessions/<session>/chat.jsonl                 narrative + one row per round
//! <workspace>/.genethub/sessions/<session>/rounds/r-000/index.jsonl   one row per trunk
//! <workspace>/.genethub/sessions/<session>/rounds/r-000/t-0000.jsonl  one trunk's batches and blob rows
//! <workspace>/.genethub/sessions/<session>/blobs/b-9f.jsonl           blob payloads, bucketed by content id
//! <workspace>/.genethub/sessions/<session>/state/                     adapter scratch
//! ```
//!
//! Deltas are never written. Only settled items reach disk, which keeps a
//! session proportional to what was actually said rather than to the number of
//! tokens streamed (`docs/daemon.md` §4).

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    BlobKind, BlobOverview, BlobPayload, BlobRef, PermissionRequest, RoundBatch, RoundBatchSummary,
    RoundTrunk, RoundTrunkSummary, SessionStatus, SessionSummary, TimelineItem, UnsupportedFormat,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::rounds::RoundRecord;
use crate::adapter::PersistHandle;

/// Content ids are the first 24 hex characters of a SHA-256. 96 bits keeps
/// collisions negligible at any session size, and every trunk row carries one.
const BLOB_ID_CHARS: usize = 24;
/// Refuses a locator that would have the daemon allocate an absurd buffer for
/// a client-supplied length. No single settled item legitimately reaches this.
const MAX_BLOB_BYTES: u64 = 512 * 1024 * 1024;

/// The shape this build writes a session in.
///
/// Sessions live in the user's project, so a beta, a release and a dev build
/// all read and write the same directories. That only stays safe if a build can
/// tell, before touching anything, whether the session in front of it was
/// written by something it does not understand.
///
/// Bump this only when an older build reading the result would be *wrong*, not
/// merely incomplete. Adding a field does not qualify: serde ignores what it
/// does not know, so an older build keeps working and a bump would lock it out
/// for nothing. Every bump is one-way for every session the new build writes
/// to, which is exactly the weight it should carry.
///
/// 4 — the path-as-index layout: `chat.jsonl`, `rounds/`, `blobs/`.
pub const SESSION_FORMAT: u32 = 4;

/// What a `meta.json` from before versioning is: the layout numbered 4, which
/// is the only one that has ever been written into a workspace.
fn format_before_versions() -> u32 {
    4
}

/// The part of a `meta.json` whose shape can never change.
///
/// Read on its own, ahead of the rest, because a version a build can only
/// discover by successfully parsing the whole file is no version check at all —
/// the case it exists for is precisely the one where the rest of the file has
/// changed. It carries only what is needed to say "this conversation is here,
/// and I cannot open it": the version that decides that, plus enough to name
/// the row so the user can see what they are being kept out of.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaHeader {
    #[serde(default = "format_before_versions")]
    format: u32,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    created_at_ms: i64,
    #[serde(default)]
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    /// Which workspace this conversation belongs to.
    ///
    /// Derived from where the session was found, never stored. The id is a
    /// random uuid minted per installation, so the one a beta build wrote means
    /// nothing to a release build reading the same folder; the session sitting
    /// inside the project it is about is the fact that survives both.
    #[serde(default, skip)]
    pub workspace_id: String,
    /// The layout this session is stored in, taken from the file's frozen
    /// header rather than from this field, and always written as this build's
    /// [`SESSION_FORMAT`] — see [`Store::save_meta`].
    #[serde(default = "format_before_versions", skip_deserializing)]
    pub format: u32,
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
    /// A session written by a build from the future, described from its
    /// location and its file's frozen header alone.
    ///
    /// Nothing else in the file is trusted, because by definition this build
    /// does not know what the rest of it means.
    fn unopenable(id: String, workspace_id: String, cwd: PathBuf, header: MetaHeader) -> Self {
        SessionMeta {
            id,
            workspace_id,
            format: header.format,
            agent_id: String::new(),
            title: header.title,
            cwd,
            model_id: None,
            mode_id: None,
            effort_id: None,
            created_at_ms: header.created_at_ms,
            updated_at_ms: header.updated_at_ms,
            archived: false,
            persist: None,
            pending_permission: None,
        }
    }

    /// Whether this build understands the session's layout well enough to read
    /// it, let alone add to it.
    pub fn openable(&self) -> bool {
        self.format <= SESSION_FORMAT
    }

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
            unsupported: (!self.openable()).then_some(UnsupportedFormat {
                written: self.format,
                supported: SESSION_FORMAT,
            }),
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

/// The directory a workspace keeps its sessions in.
pub fn sessions_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(HOME_DIR_NAME).join("sessions")
}

/// The per-workspace directory GeneHub owns inside the user's own project.
const HOME_DIR_NAME: &str = ".genethub";

/// The file whose kernel lock decides which build may write a workspace's
/// sessions. Its contents name the holder, for the message, and nothing else.
const OWNER_LOCK: &str = "owner.lock";

/// A registered workspace: where it is, and whether this daemon may write it.
struct Home {
    root: PathBuf,
    /// The workspace's write lock while this daemon holds it. Dropping the
    /// handle releases it, so it lives exactly as long as the entry does, and
    /// a crash releases it too — the kernel holds it, not a file's contents.
    lock: Option<File>,
}

/// Which directory on disk belongs to each workspace id.
///
/// A conversation is about a body of code, so it is kept with that code rather
/// than in the daemon's data directory: copying a project copies its history,
/// deleting one deletes it, and an uninstall does not take it away. Only the
/// workspace registry knows where a workspace lives, so the store is told, and
/// a session whose workspace is no longer registered is not locatable at all —
/// which is the honest answer, not a path in some fallback directory.
#[derive(Clone, Default)]
pub struct WorkspaceHomes {
    roots: Arc<RwLock<BTreeMap<String, Home>>>,
}

impl WorkspaceHomes {
    pub fn attach(&self, workspace_id: &str, root: &Path) {
        let Ok(mut roots) = self.roots.write() else {
            return;
        };
        match roots.get_mut(workspace_id) {
            // Re-registering the same folder must not drop the write lock the
            // daemon is holding for it.
            Some(home) if home.root == root => {}
            Some(home) => *home = Home::at(root),
            None => {
                roots.insert(workspace_id.to_string(), Home::at(root));
            }
        }
    }

    /// Where a workspace lives on disk.
    pub fn root(&self, workspace_id: &str) -> Result<PathBuf> {
        let roots = self
            .roots
            .read()
            .map_err(|_| anyhow!("the workspace registry is poisoned"))?;
        roots
            .get(workspace_id)
            .map(|home| home.root.clone())
            .ok_or_else(|| anyhow!("no such workspace: {workspace_id}"))
    }

    fn home_dir(&self, workspace_id: &str) -> Result<PathBuf> {
        Ok(self.root(workspace_id)?.join(HOME_DIR_NAME))
    }

    fn sessions_dir(&self, workspace_id: &str) -> Result<PathBuf> {
        Ok(self.home_dir(workspace_id)?.join("sessions"))
    }

    /// Every registered workspace's sessions directory, in id order.
    fn all_sessions_dirs(&self) -> Vec<(String, PathBuf)> {
        let Ok(roots) = self.roots.read() else {
            return Vec::new();
        };
        roots
            .iter()
            .map(|(id, home)| (id.clone(), sessions_dir(&home.root)))
            .collect()
    }

    /// Whether this daemon already owns the workspace's write lock.
    fn holds(&self, workspace_id: &str) -> bool {
        self.roots.read().is_ok_and(|roots| {
            roots
                .get(workspace_id)
                .is_some_and(|home| home.lock.is_some())
        })
    }

    /// Takes the workspace's write lock, or names who is holding it.
    ///
    /// Sessions live in the project, so a beta and a release pointed at the
    /// same folder are two processes over one set of files. Both may read;
    /// only one may write, and the one that loses says so instead of
    /// interleaving its rounds into the other's `chat.jsonl`.
    ///
    /// Claimed on the first write rather than when the workspace is
    /// registered, because merely opening a folder must not leave a
    /// `.genethub` behind in it. Re-attempted while unheld, so the loser
    /// starts working the moment the other build quits — no restart, no
    /// stale-lock cleanup, since the kernel drops it even on a crash.
    fn claim(&self, workspace_id: &str, home_dir: &Path) -> Result<()> {
        let mut roots = self
            .roots
            .write()
            .map_err(|_| anyhow!("the workspace registry is poisoned"))?;
        let home = roots
            .get_mut(workspace_id)
            .ok_or_else(|| anyhow!("no such workspace: {workspace_id}"))?;
        if home.lock.is_some() {
            return Ok(());
        }
        let path = home_dir.join(OWNER_LOCK);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => {}
            Err(error) if crate::lifecycle::lock_contended(&error) => {
                let holder = fs::read_to_string(&path)
                    .ok()
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| "another GeneHub".to_string());
                return Err(anyhow!(
                    "{holder} has this project's sessions open, so this one can only read them"
                ));
            }
            Err(error) => return Err(error).with_context(|| format!("locking {}", path.display())),
        }
        // Diagnostics only, so the loser has a name to put in its message. The
        // kernel lock is what decides; these bytes decide nothing.
        let stamp = format!("{} (pid {})\n", crate::channel::PRODUCT, std::process::id());
        let _ = file
            .set_len(0)
            .and_then(|()| (&file).write_all(stamp.as_bytes()));
        home.lock = Some(file);
        Ok(())
    }
}

impl Home {
    fn at(root: &Path) -> Self {
        Home {
            root: root.to_path_buf(),
            lock: None,
        }
    }
}

#[derive(Clone)]
pub struct Store {
    homes: WorkspaceHomes,
}

impl Store {
    pub fn new(homes: WorkspaceHomes) -> Self {
        Store { homes }
    }

    pub fn session_dir(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self.homes.sessions_dir(workspace_id)?.join(session_id))
    }

    fn meta_path(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self
            .session_dir(workspace_id, session_id)?
            .join("meta.json"))
    }

    fn chat_path(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self
            .session_dir(workspace_id, session_id)?
            .join("chat.jsonl"))
    }

    fn round_dir(&self, workspace_id: &str, session_id: &str, ord: u32) -> Result<PathBuf> {
        Ok(self
            .session_dir(workspace_id, session_id)?
            .join("rounds")
            .join(format!("r-{ord:03}")))
    }

    fn trunk_index_path(&self, workspace_id: &str, session_id: &str, ord: u32) -> Result<PathBuf> {
        Ok(self
            .round_dir(workspace_id, session_id, ord)?
            .join("index.jsonl"))
    }

    fn trunk_path(
        &self,
        workspace_id: &str,
        session_id: &str,
        ord: u32,
        trunk: u32,
    ) -> Result<PathBuf> {
        Ok(self
            .round_dir(workspace_id, session_id, ord)?
            .join(format!("t-{trunk:04}.jsonl")))
    }

    fn blob_dir(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self.session_dir(workspace_id, session_id)?.join("blobs"))
    }

    /// Private per-session scratch space for adapters.
    pub fn scratch_dir(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        Ok(self.session_dir(workspace_id, session_id)?.join("state"))
    }

    /// The adapter's scratch space, ready to be written into.
    pub fn make_scratch_dir(&self, workspace_id: &str, session_id: &str) -> Result<PathBuf> {
        let dir = self.scratch_dir(workspace_id, session_id)?;
        self.prepare_write(workspace_id, &dir)?;
        Ok(dir)
    }

    /// The one gate every write to a workspace passes through: claims the
    /// write lock, establishes the GeneHub home the first time, and creates
    /// the directory being written into.
    ///
    /// Reads deliberately do not come here. A build that cannot write a
    /// workspace can still show every conversation in it.
    fn prepare_write(&self, workspace_id: &str, dir: &Path) -> Result<()> {
        let home = self.homes.home_dir(workspace_id)?;
        // Holding the lock means the home was established to put it in, so the
        // ordinary case — one more append to a workspace already being written
        // — costs a map lookup and a stat, not a syscall per level.
        if !self.homes.holds(workspace_id) {
            self.establish_home(&home)?;
            self.homes.claim(workspace_id, &home)?;
        }
        if dir.exists() {
            return Ok(());
        }
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        for path in dir.ancestors().take_while(|path| path.starts_with(&home)) {
            crate::config::restrict_dir_to_owner(path)?;
        }
        Ok(())
    }

    /// Two things have to be true of a workspace's GeneHub home before any
    /// session lands in it. It must be owner-only, because conversations were
    /// owner-only when they lived under the daemon's data directory and moving
    /// them into a project must not quietly widen who can read them. And it
    /// must be invisible to the project's own version control, or the first
    /// thing a user sees after their first message is their own `git status`
    /// full of session files.
    fn establish_home(&self, home: &Path) -> Result<()> {
        if home.exists() {
            return Ok(());
        }
        fs::create_dir_all(home).with_context(|| format!("creating {}", home.display()))?;
        crate::config::restrict_dir_to_owner(home)?;
        let ignore = home.join(".gitignore");
        fs::write(&ignore, "*\n").with_context(|| format!("writing {}", ignore.display()))
    }

    // -- meta ---------------------------------------------------------------

    /// Writes the meta, stamping it with the layout this build writes.
    ///
    /// The stamp is applied here rather than by the caller so that "the file
    /// says what wrote it" cannot be forgotten at one of the dozen places a
    /// session is touched.
    pub fn save_meta(&self, meta: &SessionMeta) -> Result<()> {
        let path = self.meta_path(&meta.workspace_id, &meta.id)?;
        self.prepare_write(
            &meta.workspace_id,
            path.parent().expect("meta.json always has a parent"),
        )?;
        let stamped = SessionMeta {
            format: SESSION_FORMAT,
            ..meta.clone()
        };
        crate::config::save_private(&path, serde_json::to_string_pretty(&stamped)?.as_bytes())
    }

    pub fn load_meta(&self, workspace_id: &str, session_id: &str) -> Result<SessionMeta> {
        let path = self.meta_path(workspace_id, session_id)?;
        let raw =
            fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let header: MetaHeader = serde_json::from_str(&raw)
            .with_context(|| format!("reading the header of {}", path.display()))?;
        if header.format > SESSION_FORMAT {
            return Ok(SessionMeta::unopenable(
                session_id.to_string(),
                workspace_id.to_string(),
                self.homes.root(workspace_id)?,
                header,
            ));
        }
        let mut meta: SessionMeta = serde_json::from_str(&raw)?;
        meta.workspace_id = workspace_id.to_string();
        meta.format = header.format;
        Ok(meta)
    }

    /// Every session of every registered workspace, newest first.
    ///
    /// A workspace the user has not opened on this machine contributes nothing,
    /// because its directory is the only place its sessions exist.
    ///
    /// Sessions a newer build wrote are listed too, marked as unopenable. They
    /// are the user's conversations sitting in the user's own folder, so the
    /// answer to "where did my chats go" has to be visible rather than an empty
    /// list, even though this build cannot show what is inside them.
    pub fn list_meta(&self) -> Result<Vec<SessionMeta>> {
        let mut out = Vec::new();
        for (workspace_id, sessions) in self.homes.all_sessions_dirs() {
            let Ok(entries) = fs::read_dir(&sessions) else {
                continue;
            };
            for entry in entries.flatten() {
                let session_id = entry.file_name().to_string_lossy().into_owned();
                if !entry.path().join("meta.json").exists() {
                    continue;
                }
                match self.load_meta(&workspace_id, &session_id) {
                    Ok(meta) => out.push(meta),
                    Err(error) => tracing::warn!(
                        session = %session_id,
                        %error,
                        "skipping a session whose meta could not be read"
                    ),
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
        let path = self.chat_path(workspace_id, session_id)?;
        self.prepare_write(
            workspace_id,
            path.parent().expect("chat.jsonl always has a parent"),
        )?;
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
        let path = self.chat_path(workspace_id, session_id)?;
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
        let dir = self.round_dir(workspace_id, session_id, ord)?;
        self.prepare_write(workspace_id, &dir)?;
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
        let path = self.trunk_path(workspace_id, session_id, ord, trunk.summary.index)?;
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
        let path = self.trunk_index_path(workspace_id, session_id, ord)?;
        self.prepare_write(
            workspace_id,
            path.parent().expect("index.jsonl always has a parent"),
        )?;
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
        let path = self.trunk_index_path(workspace_id, session_id, ord)?;
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
        let path = self.trunk_path(workspace_id, session_id, ord, summary.index)?;
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
    ///
    /// Content addressing here buys immutability and a stable name, not
    /// deduplication: every payload embeds the id of the item it belongs to, so
    /// two different items never hash alike and there is nothing to fold
    /// together. An append that repeats content costs disk and nothing else,
    /// because each reference is complete on its own.
    pub fn put_blob(&self, workspace_id: &str, session_id: &str, value: Value) -> Result<BlobRef> {
        let encoded = serde_json::to_vec(&value)?;
        let digest = Sha256::digest(&encoded);
        let id: String = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            .chars()
            .take(BLOB_ID_CHARS)
            .collect();
        let bucket = id[..2].to_string();
        let dir = self.blob_dir(workspace_id, session_id)?;
        self.prepare_write(workspace_id, &dir)?;
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
        Ok(BlobRef {
            id,
            bytes: encoded.len() as u64,
            at: format!("{bucket}:{offset}:{}", line.len()),
        })
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
            .blob_dir(workspace_id, session_id)?
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
    /// session that never got as far as being written.
    pub fn delete(&self, workspace_id: &str, session_id: &str) -> Result<()> {
        let dir = self.session_dir(workspace_id, session_id)?;
        if !dir.exists() {
            return Ok(());
        }
        // Removing a conversation is a write like any other, and the build that
        // holds the workspace may be in the middle of appending to this one.
        if !self.homes.holds(workspace_id) {
            self.homes
                .claim(workspace_id, &self.homes.home_dir(workspace_id)?)?;
        }
        let _ = fs::remove_dir_all(dir);
        Ok(())
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
