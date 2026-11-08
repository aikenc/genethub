//! Directory projection on the existing PageCatalog, subscription bus and
//! discovery task. No replay log, message-body cache or execution state here.
use super::*;
use genehub_proto::{
    CatalogBatch, CatalogKnownSession, CatalogKnownWorkspace, CatalogSessionRef, CatalogSessionRow,
    CatalogWorkspaceRow,
};

const PART_BYTES: usize = 128 * 1024;
const SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;

pub(super) fn is_active(s: &SessionSummary) -> bool {
    matches!(
        s.status,
        SessionStatus::Running | SessionStatus::Waiting | SessionStatus::Failed
    ) || s.interaction_summary.as_ref().is_some_and(|i| i.count > 0)
        || s.coordination
            .as_ref()
            .is_some_and(|c| c.active || c.pending > 0 || c.ready > 0 || c.unknown > 0 || c.stale)
}
fn key(m: &SessionMeta) -> CatalogSessionRef {
    CatalogSessionRef {
        workspace_id: m.workspace_id.clone(),
        id: m.id.clone(),
    }
}
pub(super) fn summary_etag(summary: &SessionSummary) -> Result<String> {
    let mut stable = summary.clone();
    stable.last_activity_at_ms = None;
    stable.lineage = None;
    if let Some(preview) = &mut stable.message_preview {
        if preview.text.chars().count() > 200 {
            preview.text = preview.text.chars().take(200).collect::<String>() + "…";
        }
    }
    digest(&stable)
}
fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&serde_json::to_value(value)?)?)
    ))
}

/// Break a logical snapshot/change into bounded events before admission. The
/// endpoint charges these bytes to its existing Writer budget while queued.
async fn parts(mut input: CatalogBatch) -> Result<Vec<CatalogBatch>> {
    let mut output = Vec::new();
    let mut current = CatalogBatch::default();
    let mut bytes = 0;
    let mut budget = crate::blocking::WorkBudget::new();
    macro_rules! append {
        ($field:ident) => {
            for value in input.$field.drain(..) {
                budget.checkpoint().await;
                let size = serde_json::to_vec(&value)?.len();
                anyhow::ensure!(
                    size < PART_BYTES - 4096,
                    "directory capacity: one row exceeds event budget"
                );
                if bytes + size > PART_BYTES - 4096 {
                    output.push(std::mem::take(&mut current));
                    bytes = 0;
                }
                current.$field.push(value);
                bytes += size;
            }
        };
    }
    append!(sessions);
    append!(removed_sessions);
    append!(active);
    append!(inactive);
    append!(workspaces);
    append!(removed_workspaces);
    // Scope errors are bounded by the same frame limit, never silently omitted.
    current.scope_errors = input.scope_errors;
    output.push(current);
    let mut total = 0;
    for part in &output {
        budget.checkpoint().await;
        let length = serde_json::to_vec(part)?.len();
        anyhow::ensure!(
            length <= PART_BYTES,
            "directory capacity: scope diagnostics exceed event budget"
        );
        total += length;
    }
    anyhow::ensure!(
        total <= SNAPSHOT_BYTES,
        "directory capacity: snapshot exceeds 64 MiB"
    );
    Ok(output)
}

impl SessionManager {
    pub(super) async fn activity_metadata(
        &self,
        workspace: Option<&str>,
        strict: bool,
    ) -> Result<Vec<SessionMeta>> {
        let lives: Vec<_> = self.sessions.read().await.values().cloned().collect();
        let mut ids = Vec::new();
        for live in lives {
            let status = *live.status.lock().await;
            if matches!(
                status,
                SessionStatus::Running | SessionStatus::Waiting | SessionStatus::Failed
            ) {
                ids.push(live.meta.lock().await.id.clone());
            }
        }
        self.store.activity_metadata(workspace, &ids, strict).await
    }

    async fn catalog_row(&self, meta: &Arc<SessionMeta>) -> Result<CatalogSessionRow> {
        let mut summary = self.project_meta(meta).await;
        summary.lineage = None;
        if let Some(preview) = &mut summary.message_preview {
            if preview.text.chars().count() > 200 {
                preview.text = preview.text.chars().take(200).collect::<String>() + "…";
            }
        }
        let active = is_active(&summary);
        // Token traffic updates the open transcript, not directory revisions.
        Ok(CatalogSessionRow {
            etag: summary_etag(&summary)?,
            summary,
            active,
        })
    }

    pub(crate) fn catalog_wake(&self) -> Arc<tokio::sync::Notify> {
        self.store.catalog_wake()
    }

    /// Called by the already-existing Space discovery task, and before taking
    /// a repair snapshot. Native writers only dirty a key and wake that task.
    pub(crate) async fn refresh_catalog(
        &self,
        workspaces: &crate::workspace::Workspaces,
    ) -> Result<()> {
        if self.catalog_updates.receiver_count() == 0 {
            // No observer needs a change history. Cached browsers validate
            // against current content on their next connection.
            self.store.catalog_edit(|p| {
                p.dirty.clear();
                p.removed.clear();
                p.rows.clear();
            });
            return Ok(());
        }
        let _gate = self.catalog_gate.lock().await;
        self.refresh_catalog_locked(workspaces).await.map(|_| ())
    }

    async fn refresh_catalog_locked(
        &self,
        workspaces: &crate::workspace::Workspaces,
    ) -> Result<(
        Vec<genehub_proto::WorkspaceInfo>,
        HashSet<CatalogSessionRef>,
    )> {
        let active = self.activity_metadata(None, false).await?;
        let active_keys: HashSet<_> = active.iter().map(key).collect();
        let emitting = self.catalog_updates.receiver_count() > 0;
        let (mut keys, removed) = self.store.catalog_edit(|p| {
            let dirty = std::mem::take(&mut p.dirty);
            // Without a directory observer, history need not be projected.
            // A future browser validates just its cached read set.
            let mut keys = if emitting { dirty } else { HashSet::new() };
            keys.extend(
                p.rows
                    .iter()
                    .filter(|(_, (_, active))| *active)
                    .map(|(k, _)| k.clone()),
            );
            (keys, std::mem::take(&mut p.removed))
        });
        keys.extend(active_keys.iter().cloned());
        let mut batch = CatalogBatch::default();
        let mut budget = crate::blocking::WorkBudget::new();
        for meta in self.store.catalog_metadata_keys(&keys) {
            budget.checkpoint().await;
            let row = self.catalog_row(&meta).await?;
            if self.store.catalog_accept(&meta, &row) {
                batch.sessions.push(row);
            }
        }
        let present: HashSet<_> = self
            .store
            .catalog_metadata_keys(&removed)
            .iter()
            .map(|m| key(m))
            .collect();
        self.store.catalog_edit(|p| {
            for removed in removed.difference(&present) {
                p.rows.remove(removed);
                batch.removed_sessions.push(removed.clone());
            }
        });
        let spaces = workspaces.list().await;
        let mut hashes = HashMap::new();
        for workspace in &spaces {
            budget.checkpoint().await;
            hashes.insert(workspace.id.clone(), digest(workspace)?);
        }
        self.store.catalog_edit(|p| {
            batch.workspaces = spaces
                .iter()
                .filter(|w| p.workspaces.get(&w.id) != hashes.get(&w.id))
                .map(|w| CatalogWorkspaceRow {
                    workspace: w.clone(),
                    etag: hashes[&w.id].clone(),
                })
                .collect();
            batch.removed_workspaces = p
                .workspaces
                .keys()
                .filter(|id| !hashes.contains_key(*id))
                .cloned()
                .collect();
            p.workspaces = hashes;
        });
        let errors = self.store.catalog_scope_errors();
        let errors_hash = digest(&errors)?;
        self.store.catalog_edit(|p| {
            if p.errors != errors_hash {
                p.errors = errors_hash;
                batch.scope_errors = Some(errors);
            }
        });
        let changed = !batch.sessions.is_empty()
            || !batch.removed_sessions.is_empty()
            || !batch.workspaces.is_empty()
            || !batch.removed_workspaces.is_empty()
            || batch.scope_errors.is_some();
        if changed {
            let frames = match parts(batch).await {
                Ok(frames) => frames,
                Err(error) => {
                    let _ = self.catalog_updates.send(Arc::new(CatalogBatch {
                        reset_required: true,
                        ..Default::default()
                    }));
                    return Err(error);
                }
            };
            // A large logical change cannot fit the live broadcast window.
            // Repair it once from the current index rather than emitting a
            // partial burst that every healthy single-threaded peer must lose.
            let frames = if frames.len() > 16 {
                vec![CatalogBatch {
                    reset_required: true,
                    ..Default::default()
                }]
            } else {
                frames
            };
            let last = frames.len() - 1;
            for (index, mut part) in frames.into_iter().enumerate() {
                self.store.catalog_edit(|p| {
                    part.previous_revision = p.revision;
                    p.revision += 1;
                    part.revision = p.revision;
                });
                part.first = index == 0;
                part.complete = index == last;
                if emitting {
                    let _ = self.catalog_updates.send(Arc::new(part));
                }
            }
        }
        Ok((spaces, active_keys))
    }

    /// Subscribe before the snapshot handoff. Cached row hashes allow browser
    /// restarts to repair from current data, including deletions, without a log.
    pub(crate) async fn catalog_sync(
        &self,
        workspaces: &crate::workspace::Workspaces,
        known_sessions: Vec<CatalogKnownSession>,
        known_workspaces: Vec<CatalogKnownWorkspace>,
    ) -> Result<(
        u64,
        Vec<CatalogBatch>,
        broadcast::Receiver<Arc<CatalogBatch>>,
    )> {
        anyhow::ensure!(
            known_sessions.len() <= 12_000 && known_workspaces.len() <= 4096,
            "directory capacity: cached read set is too large"
        );
        anyhow::ensure!(
            known_sessions
                .iter()
                .all(|k| k.id.len() <= 200 && k.workspace_id.len() <= 200 && k.etag.len() <= 64)
                && known_workspaces
                    .iter()
                    .all(|k| k.id.len() <= 200 && k.etag.len() <= 64),
            "invalid directory cache reference"
        );
        let _gate = self.catalog_gate.lock().await;
        let (spaces, active) = self.refresh_catalog_locked(workspaces).await?;
        let receiver = self.catalog_updates.subscribe();
        let revision = self.store.catalog_edit(|p| p.revision);
        let known: HashMap<_, _> = known_sessions
            .into_iter()
            .map(|k| {
                (
                    CatalogSessionRef {
                        workspace_id: k.workspace_id.clone(),
                        id: k.id.clone(),
                    },
                    k,
                )
            })
            .collect();
        let mut keys = active.clone();
        keys.extend(known.keys().cloned());
        let metadata = self.store.catalog_metadata_keys(&keys);
        let present: HashSet<_> = metadata.iter().map(|m| key(m)).collect();
        let mut batch = CatalogBatch {
            scope_errors: Some(self.store.catalog_scope_errors()),
            ..Default::default()
        };
        let mut budget = crate::blocking::WorkBudget::new();
        for meta in metadata {
            budget.checkpoint().await;
            let row = self.catalog_row(&meta).await?;
            let reference = key(&meta);
            match known.get(&reference) {
                Some(old) if old.etag == row.etag => {
                    if old.active != row.active {
                        if row.active {
                            batch.active.push(reference);
                        } else {
                            batch.inactive.push(reference);
                        }
                    }
                }
                _ => batch.sessions.push(row),
            }
        }
        batch.removed_sessions = known
            .keys()
            .filter(|k| {
                !present.contains(*k)
                    && !batch.scope_errors.as_ref().is_some_and(|errors| {
                        errors.iter().any(|error| {
                            error
                                .workspace_id
                                .as_ref()
                                .is_none_or(|id| id == &k.workspace_id)
                        })
                    })
            })
            .cloned()
            .collect();
        let known_spaces: HashMap<_, _> = known_workspaces
            .into_iter()
            .map(|w| (w.id, w.etag))
            .collect();
        let space_hashes = self.store.catalog_edit(|p| p.workspaces.clone());
        batch.workspaces = spaces
            .into_iter()
            .filter(|w| known_spaces.get(&w.id) != space_hashes.get(&w.id))
            .map(|w| CatalogWorkspaceRow {
                etag: space_hashes[&w.id].clone(),
                workspace: w,
            })
            .collect();
        batch.removed_workspaces = known_spaces
            .keys()
            .filter(|id| !space_hashes.contains_key(*id))
            .cloned()
            .collect();
        let mut frames = parts(batch).await?;
        let last = frames.len() - 1;
        for (i, frame) in frames.iter_mut().enumerate() {
            frame.revision = revision;
            frame.previous_revision = revision;
            frame.snapshot = true;
            frame.first = i == 0;
            frame.complete = i == last;
        }
        Ok((revision, frames, receiver))
    }
}
