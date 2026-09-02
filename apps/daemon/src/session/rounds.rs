//! Round records and trunk pagination.
//!
//! A `RoundRecord` is one line of `<session>/chat.jsonl`: the folded state of
//! one user request (`docs/session-storage.md` §3.1). It carries no item ids
//! and no trunk summaries on purpose — work items are located by path
//! (`rounds/r-NNN/t-NNNN.jsonl`) and trunk summaries live in that round's own
//! index — so nothing here grows with how long the round ran.
//!
//! Deliberately narrower than the proposal's full shape: no `contended` or
//! `workspaceDelta` field, because nothing populates them yet
//! (`docs/agent-analysis-substrate-proposal.md` §8 step 5) — an empty-looking
//! field would be a false claim of completeness (rule D).

use std::collections::HashMap;

use genehub_proto::{
    BlobKind, BlobOverview, RoundBatch, RoundBatchSummary, RoundTrunk, RoundTrunkSummary,
    TimelineItem, ToolCallDetail,
};
use serde::{Deserialize, Serialize};

use super::overview;

/// Bumped whenever `RoundRecord`'s on-disk shape changes in a way an old
/// reader could misread rather than merely ignore. A reader that meets a
/// version it does not know must fall back to a read-only, ledger-less view
/// of the session rather than guess at the new fields' meaning.
///
/// 4: the path-as-index relayout. `itemIds` and `trunkSummaries` are gone,
/// `ord` and `trunkCount` arrived, and `outcome` became optional so a round is
/// on disk the moment it opens rather than only once it settles.
pub const SCHEMA_VERSION: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoundOutcome {
    Completed,
    Failed,
    /// The interaction that was blocking this round ended without a
    /// continuation (a permission denied, or an interaction canceled) — no
    /// further adapter turn will happen for this request.
    Canceled,
    /// A later `session.send` did not name this round with `continuesRound`,
    /// so it was cut loose rather than left open forever (§3.2 direction 0).
    Superseded,
}

/// One round: the durable, referenceable unit of "what happened for one user
/// request" (G8).
///
/// Written twice — once provisionally when the round opens, once complete when
/// it settles — and read last-wins per `round_id`, so the file stays
/// append-only while a crashed daemon still leaves evidence that the request
/// existed. `outcome` is `None` on the provisional line; a `None` read back
/// from disk for a round nobody is running means the daemon died mid-request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundRecord {
    pub schema_version: u32,
    pub round_id: String,
    /// Position in the session, and the round's own directory name
    /// (`rounds/r-{ord:03}`). This is the whole mapping from the protocol's
    /// `roundId` to storage — resolved from `chat.jsonl`, which any reader has
    /// already loaded before it can ask for a round.
    pub ord: u32,
    /// The user message that opened this round, if it had one.
    #[serde(default)]
    pub user_item_id: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    /// `None` while the round is still open.
    #[serde(default)]
    pub outcome: Option<RoundOutcome>,
    /// Upstream adapter turn ids folded into this round, in order.
    #[serde(default)]
    pub adapter_turn_ids: Vec<String>,
    /// Time this round spent waiting on a human, across every pause. Not
    /// counted as the agent's own working time.
    #[serde(default)]
    pub blocked_ms: i64,
    /// `true` for a record backfilled from a session that predates the round
    /// ledger, where one adapter turn is treated as one round because the
    /// real stitching (approvals, guidance, `continuesRound`) was never
    /// recorded. A round settled live by the daemon always reports `false`.
    #[serde(default)]
    pub synthesized: bool,
    /// How many trunks this round closed. The trunk summaries themselves live
    /// in `rounds/r-NNN/index.jsonl`; keeping only the count here is what
    /// stops a day-long round from writing a quarter-megabyte line.
    #[serde(default)]
    pub trunk_count: u32,
}

pub type TrunkSummary = RoundTrunkSummary;
pub type BatchSummary = RoundBatchSummary;

/// Once a batch has accumulated this many LLM rounds, the next reasoning block
/// is useful enough to become the title of a fresh semantic batch.
pub const BATCH_REASONING_ROUND_THRESHOLD: u32 = 16;
/// A tool-only run still needs a bounded fallback when the agent provides no
/// narration or reasoning boundary at all.
pub const BATCH_MAX_ROUNDS: u32 = 64;
/// Reasoning is a blob too. Keep a wider storage safety bound so a malformed
/// or unusually chatty adapter cannot grow one batch without limit, while
/// leaving normal grouping driven by semantic tool boundaries.
pub const BATCH_MAX_BLOBS: u32 = 128;
/// Once a trunk has passed this many LLM rounds, its next semantic batch starts
/// a new trunk. This is deliberately a soft threshold: a batch is never cut in
/// half merely to make the number exact.
pub const TRUNK_ROUND_THRESHOLD: u32 = 100;
/// Hard storage bound for one trunk. An adapter that never reports LLM rounds
/// (or a model that never narrates) would otherwise grow a single trunk
/// without limit; at a batch boundary past this many blobs the trunk closes
/// regardless of the round counter.
pub const TRUNK_MAX_BLOBS: u32 = 500;

pub enum TrunkItem<'a> {
    Monologue,
    Reasoning,
    ToolCall(&'a str),
    /// A context-compaction marker, carrying the adapter's reason. It closes
    /// the batch in flight and then stands in the stream as its own zero-blob
    /// marker batch, so the compression line renders at the exact spot the
    /// work was interrupted instead of floating outside the batch flow.
    Compaction(&'a str),
}

/// Wall-clock and tool-time facts one item contributes to its batch/trunk.
#[derive(Debug, Clone, Copy, Default)]
pub struct ItemTiming {
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
    pub tool_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Default)]
struct BatchBuilder {
    item_ids: Vec<String>,
    blob_count: u32,
    monologue_item_id: Option<String>,
    first_reasoning_item_id: Option<String>,
    tool_count: u32,
    llm_rounds: u32,
    started_at_ms: Option<i64>,
    last_finished_at_ms: Option<i64>,
    tool_duration_ms: u64,
}

impl BatchBuilder {
    fn note_timing(&mut self, timing: ItemTiming) {
        if self.started_at_ms.is_none() {
            self.started_at_ms = timing.started_at_ms;
        }
        if let Some(end) = timing.finished_at_ms {
            self.last_finished_at_ms =
                Some(self.last_finished_at_ms.map_or(end, |last| last.max(end)));
        }
        if let Some(duration) = timing.tool_duration_ms {
            self.tool_duration_ms = self.tool_duration_ms.saturating_add(duration);
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClosedBatch {
    pub first_item_id: String,
    pub blob_count: u32,
    pub monologue_item_id: Option<String>,
    pub first_reasoning_item_id: Option<String>,
    pub tool_count: u32,
    /// The compaction reason when this batch is a context-compaction marker:
    /// a zero-blob batch whose only item is the compaction event itself.
    pub marker: Option<String>,
    pub llm_rounds: u32,
    pub started_at_ms: Option<i64>,
    pub duration_ms: Option<u64>,
    pub tool_duration_ms: u64,
}

impl ClosedBatch {
    fn marker(item_id: &str, reason: &str) -> Self {
        Self {
            first_item_id: item_id.to_string(),
            blob_count: 0,
            monologue_item_id: None,
            first_reasoning_item_id: None,
            tool_count: 0,
            marker: Some(reason.to_string()),
            llm_rounds: 0,
            started_at_ms: None,
            duration_ms: None,
            tool_duration_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClosedTrunk {
    pub first_item_id: String,
    pub blob_count: u32,
    pub first_monologue_item_id: Option<String>,
    pub batches: Vec<ClosedBatch>,
    pub llm_rounds: u32,
    pub started_at_ms: Option<i64>,
    pub duration_ms: Option<u64>,
    pub tool_duration_ms: u64,
}

impl ClosedTrunk {
    pub fn into_summary(self, index: u32, texts: &HashMap<String, String>) -> TrunkSummary {
        let batches: Vec<BatchSummary> = self
            .batches
            .into_iter()
            .enumerate()
            .map(|(batch_index, batch)| {
                let text = if batch.marker.is_some() {
                    // A marker batch's text is only a fallback for readers
                    // that predate the marker field; the current frontend
                    // renders its own label from `marker`.
                    "上下文压缩".to_string()
                } else {
                    batch
                        .monologue_item_id
                        .as_ref()
                        .and_then(|id| texts.get(id))
                        .map(|text| overview::shorten(text, 100))
                        .filter(|text| !text.is_empty())
                        .or_else(|| {
                            batch
                                .first_reasoning_item_id
                                .as_ref()
                                .and_then(|id| texts.get(id))
                                .map(|text| overview::shorten(text, 100))
                                .filter(|text| !text.is_empty())
                        })
                        .unwrap_or_else(|| format!("调用了 {} 次工具", batch.tool_count))
                };
                BatchSummary {
                    index: batch_index as u32,
                    first_item_id: batch.first_item_id,
                    blob_count: batch.blob_count,
                    text,
                    marker: batch.marker,
                    llm_rounds: Some(batch.llm_rounds as u64),
                    started_at_ms: batch.started_at_ms,
                    duration_ms: batch.duration_ms,
                    tool_duration_ms: Some(batch.tool_duration_ms),
                }
            })
            .collect();
        let title = self
            .first_monologue_item_id
            .as_ref()
            .and_then(|id| texts.get(id))
            .map(|text| first_sentence(text))
            .filter(|text| !text.is_empty())
            .or_else(|| {
                batches
                    .iter()
                    .find(|batch| batch.marker.is_none())
                    .map(|batch| overview::clip(&batch.text, 32))
            })
            .unwrap_or_else(|| "工作过程".to_string());
        TrunkSummary {
            index,
            first_item_id: self.first_item_id,
            blob_count: self.blob_count,
            title,
            batches,
            llm_rounds: Some(self.llm_rounds as u64),
            started_at_ms: self.started_at_ms,
            duration_ms: self.duration_ms,
            tool_duration_ms: Some(self.tool_duration_ms),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TrunkBuilder {
    current_batch: BatchBuilder,
    closed_batches: Vec<ClosedBatch>,
    blob_count: u32,
    llm_rounds: u32,
    started_at_ms: Option<i64>,
    last_finished_at_ms: Option<i64>,
    tool_duration_ms: u64,
    first_item_id: Option<String>,
    first_monologue_item_id: Option<String>,
}

impl TrunkBuilder {
    /// `llm_round_delta` is the number of LLM request rounds attributed to
    /// this item by the caller (the manager measures the cumulative counter's
    /// movement between two recorded items), never a cumulative value.
    pub fn push(
        &mut self,
        item_id: &str,
        item: TrunkItem<'_>,
        timing: ItemTiming,
        llm_round_delta: u32,
    ) -> Option<ClosedTrunk> {
        // A compaction cuts the batch short and then takes its own place in
        // the stream: a zero-blob marker batch whose first_item_id is the
        // compaction item itself, so every reader renders the marker at the
        // exact batch boundary where the context was squeezed. The marker is
        // the trunk's closing batch — the important monologue that follows a
        // squeeze opens the next trunk.
        if let TrunkItem::Compaction(reason) = item {
            self.close_batch();
            if self.first_item_id.is_none() {
                self.first_item_id = Some(item_id.to_string());
            }
            self.closed_batches
                .push(ClosedBatch::marker(item_id, reason));
            return self.close_finished();
        }
        let new_rounds = llm_round_delta;
        let mut closed_trunk = None;
        // A batch that already holds enough rounds closes before this item
        // joins it, so the item that opens the next batch is also where the
        // next round's work starts. The check counts this item's own rounds:
        // the batch that crosses the threshold with this item still contains
        // it, and the next item opens the fresh batch.
        let batch_rounds_with_item = self.current_batch.llm_rounds.saturating_add(new_rounds);
        let starts_semantic_batch = match item {
            TrunkItem::Monologue => !self.current_batch.item_ids.is_empty(),
            TrunkItem::Reasoning => {
                batch_rounds_with_item > BATCH_REASONING_ROUND_THRESHOLD
                    || self.current_batch.blob_count >= BATCH_MAX_BLOBS
            }
            TrunkItem::ToolCall(_) => {
                batch_rounds_with_item > BATCH_MAX_ROUNDS
                    || self.current_batch.blob_count >= BATCH_MAX_BLOBS
            }
            TrunkItem::Compaction(_) => unreachable!("handled above"),
        };
        if starts_semantic_batch {
            self.close_batch();
        }
        // Batch boundaries are the only safe trunk boundaries. Crossing the
        // threshold marks the trunk ready to close; the item that begins the
        // next batch belongs wholly to the new trunk. The blob count is a
        // hard backstop for adapters that never report rounds.
        if self.current_batch.item_ids.is_empty()
            && (self.llm_rounds > TRUNK_ROUND_THRESHOLD || self.blob_count >= TRUNK_MAX_BLOBS)
        {
            closed_trunk = self.close_finished();
        }

        if self.first_item_id.is_none() {
            self.first_item_id = Some(item_id.to_string());
        }
        if !self.current_batch.item_ids.iter().any(|id| id == item_id) {
            self.current_batch.item_ids.push(item_id.to_string());
        }
        self.current_batch.note_timing(timing);
        match item {
            TrunkItem::Monologue => {
                if self.current_batch.monologue_item_id.is_none() {
                    self.current_batch.monologue_item_id = Some(item_id.to_string());
                }
                if self.first_monologue_item_id.is_none() {
                    self.first_monologue_item_id = Some(item_id.to_string());
                }
            }
            TrunkItem::ToolCall(_) => {
                self.current_batch.blob_count += 1;
                self.current_batch.tool_count += 1;
                self.blob_count += 1;
            }
            TrunkItem::Reasoning => {
                self.current_batch.blob_count += 1;
                self.blob_count += 1;
                if self.current_batch.first_reasoning_item_id.is_none() {
                    self.current_batch.first_reasoning_item_id = Some(item_id.to_string());
                }
            }
            TrunkItem::Compaction(_) => unreachable!("handled above"),
        }
        // Rounds land after the split decisions on purpose: an item that
        // opens a fresh batch/trunk must not drag the rounds of the items
        // that closed the previous one into it.
        self.current_batch.llm_rounds = self.current_batch.llm_rounds.saturating_add(new_rounds);
        self.llm_rounds = self.llm_rounds.saturating_add(new_rounds);
        if self.started_at_ms.is_none() {
            self.started_at_ms = timing.started_at_ms;
        }
        if let Some(end) = timing.finished_at_ms {
            self.last_finished_at_ms =
                Some(self.last_finished_at_ms.map_or(end, |last| last.max(end)));
        }
        if let Some(duration) = timing.tool_duration_ms {
            self.tool_duration_ms = self.tool_duration_ms.saturating_add(duration);
        }
        closed_trunk
    }

    pub fn close(&mut self) -> Option<ClosedTrunk> {
        self.close_batch();
        self.close_finished()
    }

    fn close_batch(&mut self) {
        if self.current_batch.item_ids.is_empty() {
            return;
        }
        let batch = std::mem::take(&mut self.current_batch);
        let duration_ms = match (batch.started_at_ms, batch.last_finished_at_ms) {
            (Some(start), Some(end)) if end >= start => Some((end - start) as u64),
            _ => None,
        };
        self.closed_batches.push(ClosedBatch {
            first_item_id: batch.item_ids[0].clone(),
            blob_count: batch.blob_count,
            monologue_item_id: batch.monologue_item_id,
            first_reasoning_item_id: batch.first_reasoning_item_id,
            tool_count: batch.tool_count,
            marker: None,
            llm_rounds: batch.llm_rounds,
            started_at_ms: batch.started_at_ms,
            duration_ms,
            tool_duration_ms: batch.tool_duration_ms,
        });
    }

    fn close_finished(&mut self) -> Option<ClosedTrunk> {
        if self.closed_batches.is_empty() {
            return None;
        }
        let duration_ms = match (self.started_at_ms, self.last_finished_at_ms) {
            (Some(start), Some(end)) if end >= start => Some((end - start) as u64),
            _ => None,
        };
        let closed = ClosedTrunk {
            first_item_id: self.first_item_id.take().unwrap_or_default(),
            blob_count: std::mem::take(&mut self.blob_count),
            first_monologue_item_id: self.first_monologue_item_id.take(),
            batches: std::mem::take(&mut self.closed_batches),
            llm_rounds: std::mem::take(&mut self.llm_rounds),
            started_at_ms: self.started_at_ms.take(),
            duration_ms,
            tool_duration_ms: std::mem::take(&mut self.tool_duration_ms),
        };
        self.last_finished_at_ms = None;
        Some(closed)
    }
}

fn first_sentence(text: &str) -> String {
    let text = text.trim();
    let mut end = text.len();
    for (index, character) in text.char_indices() {
        if matches!(character, '。' | '！' | '？' | '.' | '!' | '?' | '\n') {
            let candidate = index + character.len_utf8();
            if text[..candidate]
                .chars()
                .filter(|character| !character.is_whitespace())
                .count()
                > 15
            {
                end = candidate;
                break;
            }
        }
    }
    overview::clip(text[..end].trim(), 100)
}

/// The wall-clock and tool-time facts one timeline item contributes to its
/// batch/trunk. Monologue and reasoning carry no timestamps; only tool calls
/// know when they started and finished.
pub fn item_timing(item: &TimelineItem) -> ItemTiming {
    match item {
        TimelineItem::ToolCall {
            started_at_ms,
            finished_at_ms,
            ..
        } => {
            let duration_ms = match (*started_at_ms, *finished_at_ms) {
                (Some(start), Some(end)) if end >= start => Some((end - start) as u64),
                _ => None,
            };
            ItemTiming {
                started_at_ms: *started_at_ms,
                finished_at_ms: *finished_at_ms,
                tool_duration_ms: duration_ms,
            }
        }
        // A monologue/reasoning/compaction marks its own instant: it starts
        // the batch clock when it leads and never extends the tool total.
        TimelineItem::AssistantMessage {
            received_at_ms: Some(at),
            ..
        }
        | TimelineItem::Reasoning {
            received_at_ms: Some(at),
            ..
        }
        | TimelineItem::Compaction {
            received_at_ms: Some(at),
            ..
        } => ItemTiming {
            started_at_ms: Some(*at),
            finished_at_ms: Some(*at),
            tool_duration_ms: None,
        },
        _ => ItemTiming::default(),
    }
}

/// Subtracts the round's blocked intervals (permission and guidance waits)
/// from the trunk's and every batch's wall-clock duration, so the displayed
/// span is time spent working, not time spent waiting on a human.
pub fn exclude_blocked(trunk: &mut RoundTrunk, intervals: &[(i64, i64)]) {
    if intervals.is_empty() {
        return;
    }
    trunk.summary.duration_ms = trunk
        .summary
        .started_at_ms
        .zip(trunk.summary.duration_ms)
        .map(|(start, duration)| net_of_blocked(start, duration, intervals));
    for batch in &mut trunk.batches {
        batch.summary.duration_ms = batch
            .summary
            .started_at_ms
            .zip(batch.summary.duration_ms)
            .map(|(start, duration)| net_of_blocked(start, duration, intervals));
    }
}

fn net_of_blocked(start: i64, duration: u64, intervals: &[(i64, i64)]) -> u64 {
    let end = start.saturating_add(duration as i64);
    let blocked: u64 = intervals
        .iter()
        .map(|&(block_start, block_end)| {
            (end.min(block_end) - start.max(block_start)).max(0) as u64
        })
        .sum();
    duration.saturating_sub(blocked)
}

/// `llm_round_deltas` maps an item id to the rounds attributed to that item
/// (never a cumulative counter), so a rebuild needs no base value and sums to
/// exactly what the live builder counted.
pub fn summarize_trunks(
    items: &[TimelineItem],
    llm_round_deltas: &HashMap<String, u32>,
) -> Vec<TrunkSummary> {
    let texts: HashMap<String, String> = items
        .iter()
        .filter_map(|item| match item {
            TimelineItem::AssistantMessage { id, text, .. } | TimelineItem::Reasoning { id, text, .. } => {
                Some((id.clone(), text.clone()))
            }
            _ => None,
        })
        .collect();
    let mut builder = TrunkBuilder::default();
    let mut trunks = Vec::new();
    for item in items {
        let kind = match item {
            TimelineItem::AssistantMessage { .. } => TrunkItem::Monologue,
            TimelineItem::Reasoning { .. } => TrunkItem::Reasoning,
            TimelineItem::ToolCall { name, .. } => TrunkItem::ToolCall(name),
            TimelineItem::Compaction { reason, .. } => TrunkItem::Compaction(reason),
            _ => continue,
        };
        let rounds = llm_round_deltas.get(item.id()).copied().unwrap_or(0);
        if let Some(trunk) = builder.push(item.id(), kind, item_timing(item), rounds) {
            trunks.push(trunk);
        }
    }
    if let Some(trunk) = builder.close() {
        trunks.push(trunk);
    }
    trunks
        .into_iter()
        .enumerate()
        .map(|(index, trunk)| trunk.into_summary(index as u32, &texts))
        .collect()
}

/// Rebuilds a round's trunks, batches and blob rows from the items it owns.
///
/// The single place trunk shape is derived, used by the live round, by the
/// storage writer and by the legacy migration — three callers that must agree
/// exactly, because a disagreement shows up as a trunk whose stored rows do
/// not match its summary. Blob references are left empty; only the writer
/// knows where a payload landed.
pub fn trunks_from_items(items: &[TimelineItem]) -> Vec<RoundTrunk> {
    trunks_from_items_with_rounds(items, &HashMap::new())
}

/// The same rebuild with per-item LLM round deltas, so a live round's open
/// trunk reports the same `llmRounds` the builder counted while streaming.
pub fn trunks_from_items_with_rounds(
    items: &[TimelineItem],
    llm_round_deltas: &HashMap<String, u32>,
) -> Vec<RoundTrunk> {
    let summaries = summarize_trunks(items, llm_round_deltas);
    let position = |id: &str| items.iter().position(|item| item.id() == id);
    let mut trunks = Vec::new();
    for (index, summary) in summaries.iter().enumerate() {
        let start = position(&summary.first_item_id).unwrap_or(0);
        let end = summaries
            .get(index + 1)
            .and_then(|next| position(&next.first_item_id))
            .unwrap_or(items.len());
        let mut batches = Vec::new();
        for (batch_index, batch) in summary.batches.iter().enumerate() {
            let batch_start = position(&batch.first_item_id).unwrap_or(start).max(start);
            let batch_end = summary
                .batches
                .get(batch_index + 1)
                .and_then(|next| position(&next.first_item_id))
                .unwrap_or(end);
            let slice = &items[batch_start.min(items.len())..batch_end.min(items.len())];
            let monologue = slice.iter().find_map(|item| match item {
                TimelineItem::AssistantMessage { text, .. } if !text.is_empty() => {
                    Some(text.clone())
                }
                _ => None,
            });
            let blobs = slice.iter().flat_map(blob_overviews).collect();
            batches.push(RoundBatch {
                summary: batch.clone(),
                monologue,
                blobs,
            });
        }
        let batches = split_produced_image_batches(batches);
        let mut summary = summary.clone();
        summary.batches = batches.iter().map(|batch| batch.summary.clone()).collect();
        trunks.push(RoundTrunk { summary, batches });
    }
    trunks
}

/// The compact rows for one work item: one for the work itself, plus one per
/// image its result carried. Image rows take a synthetic id
/// (`<tool item>:img:<n>`) — the same id the pump's blob writer used — so the
/// regular ref merge addresses their produced-image payloads.
pub fn blob_overviews(item: &TimelineItem) -> Vec<BlobOverview> {
    let (kind, overview, started_at_ms, duration_ms, tool_kind, status) = match item {
        TimelineItem::Reasoning { text, .. } => {
            (BlobKind::Reasoning, text.clone(), None, None, None, None)
        }
        TimelineItem::ToolCall {
            name,
            detail,
            status,
            started_at_ms,
            finished_at_ms,
            ..
        } => {
            let (overview, tool_kind) = match detail {
                ToolCallDetail::Overview {
                    overview,
                    tool_kind,
                    ..
                } => (overview.clone(), Some(*tool_kind)),
                _ => (name.clone(), None),
            };
            let duration_ms = match (*started_at_ms, *finished_at_ms) {
                (Some(start), Some(end)) if end >= start => Some((end - start) as u64),
                _ => None,
            };
            (
                BlobKind::ToolCall,
                overview,
                *started_at_ms,
                duration_ms,
                tool_kind,
                Some(*status),
            )
        }
        _ => return Vec::new(),
    };
    let mut rows = vec![BlobOverview {
        item_id: item.id().to_string(),
        kind,
        overview,
        blob: None,
        thumb: None,
        path: None,
        started_at_ms,
        duration_ms,
        tool_kind,
        status,
    }];
    if let TimelineItem::ToolCall { id, images, .. } = item {
        for (index, image) in images.iter().enumerate() {
            rows.push(BlobOverview {
                item_id: format!("{id}:img:{index}"),
                kind: BlobKind::Image,
                overview: image.alt.clone(),
                blob: None,
                thumb: image.thumb.clone(),
                path: image.path.clone(),
                started_at_ms: None,
                duration_ms: None,
                tool_kind: None,
                status: None,
            });
        }
    }
    rows
}

/// Session-directory originals the agent produced. Read images keep a
/// workspace path outside this prefix and stay with the tool batch.
pub fn is_produced_image_path(path: &str) -> bool {
    let normalized = path.trim_start_matches('/');
    normalized.contains(".genethub/sessions/") && normalized.contains("/images/")
}

pub fn is_produced_image(row: &BlobOverview) -> bool {
    row.kind == BlobKind::Image
        && match row.path.as_deref() {
            Some(path) => is_produced_image_path(path),
            None => row.thumb.is_some(),
        }
}

/// Pulls produced-image rows out of each work batch and places them in the
/// following batch so the process stream is tools, then one gallery per
/// semantic batch — not one gallery per tool.
pub fn split_produced_image_batches(batches: Vec<RoundBatch>) -> Vec<RoundBatch> {
    let mut out = Vec::new();
    for batch in batches {
        if batch.summary.marker.is_some() {
            out.push(batch);
            continue;
        }
        let mut work = Vec::new();
        let mut produced = Vec::new();
        for row in batch.blobs {
            if is_produced_image(&row) {
                produced.push(row);
            } else {
                work.push(row);
            }
        }
        let has_work = !work.is_empty()
            || batch
                .monologue
                .as_ref()
                .is_some_and(|text| !text.trim().is_empty());
        if has_work || produced.is_empty() {
            out.push(RoundBatch {
                blobs: work,
                ..batch
            });
        }
        if let Some(first) = produced.first() {
            out.push(RoundBatch {
                summary: RoundBatchSummary {
                    index: 0,
                    first_item_id: first.item_id.clone(),
                    blob_count: produced.len() as u32,
                    text: format!("{} 张图片", produced.len()),
                    marker: None,
                    llm_rounds: None,
                    started_at_ms: None,
                    duration_ms: None,
                    tool_duration_ms: None,
                },
                monologue: None,
                blobs: produced,
            });
        }
    }
    for (index, batch) in out.iter_mut().enumerate() {
        batch.summary.index = index as u32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(id, text)| ((*id).to_string(), (*text).to_string()))
            .collect()
    }

    fn push(builder: &mut TrunkBuilder, id: &str, item: TrunkItem<'_>) -> Option<ClosedTrunk> {
        builder.push(id, item, ItemTiming::default(), 0)
    }

    fn push_rounds(
        builder: &mut TrunkBuilder,
        id: &str,
        item: TrunkItem<'_>,
        llm_rounds: u32,
    ) -> Option<ClosedTrunk> {
        builder.push(id, item, ItemTiming::default(), llm_rounds)
    }

    #[test]
    fn monologues_split_batches_but_not_trunks() {
        let mut builder = TrunkBuilder::default();
        push(&mut builder, "a1", TrunkItem::Monologue);
        push(&mut builder, "t1", TrunkItem::ToolCall("read"));
        push(&mut builder, "t2", TrunkItem::ToolCall("read"));
        assert!(
            push(&mut builder, "a2", TrunkItem::Monologue).is_none(),
            "a monologue starts a batch, not a new trunk"
        );
        push(&mut builder, "r1", TrunkItem::Reasoning);
        let summary = builder.close().unwrap().into_summary(
            0,
            &texts(&[("a1", "先读取配置。再检查环境"), ("a2", "开始修改")]),
        );
        assert_eq!(summary.blob_count, 3);
        assert_eq!(summary.title, "先读取配置。再检查环境");
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].blob_count, 2);
        assert_eq!(summary.batches[0].text, "先读取配置。再检查环境");
        assert_eq!(summary.batches[1].text, "开始修改");
    }

    #[test]
    fn every_monologue_starts_a_fresh_semantic_batch() {
        let mut builder = TrunkBuilder::default();
        push(&mut builder, "r1", TrunkItem::Reasoning);
        push(&mut builder, "a1", TrunkItem::Monologue);
        push(&mut builder, "t1", TrunkItem::ToolCall("read"));
        push(&mut builder, "t2", TrunkItem::ToolCall("search"));
        push(&mut builder, "a2", TrunkItem::Monologue);
        let summary = builder.close().unwrap().into_summary(
            0,
            &texts(&[
                ("r1", "先判断入口"),
                ("a1", "开始核对网络边界"),
                ("a2", "已经完成核对"),
            ]),
        );

        assert_eq!(summary.batches.len(), 3);
        assert_eq!(summary.batches[0].first_item_id, "r1");
        assert_eq!(summary.batches[0].blob_count, 1);
        assert_eq!(summary.batches[0].text, "先判断入口");
        assert_eq!(summary.batches[1].first_item_id, "a1");
        assert_eq!(summary.batches[1].blob_count, 2);
        assert_eq!(summary.batches[1].text, "开始核对网络边界");
        assert_eq!(summary.batches[2].first_item_id, "a2");
        assert_eq!(summary.batches[2].blob_count, 0);
    }

    #[test]
    fn a_tool_only_batch_closes_at_sixty_four_rounds() {
        let mut builder = TrunkBuilder::default();
        // 64 rounds, each one tool call; the 65th round's first tool call
        // finds the batch at budget and opens a fresh one.
        for index in 0..BATCH_MAX_ROUNDS + 1 {
            push_rounds(
                &mut builder,
                &format!("t{index}"),
                TrunkItem::ToolCall("grep"),
                1,
            );
        }
        let summary = builder.close().unwrap().into_summary(0, &HashMap::new());
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].blob_count, 64);
        assert_eq!(summary.batches[0].llm_rounds, Some(BATCH_MAX_ROUNDS as u64));
        assert_eq!(summary.batches[0].text, "调用了 64 次工具");
        assert_eq!(summary.batches[1].blob_count, 1);
        assert_eq!(summary.batches[1].llm_rounds, Some(1));
    }

    #[test]
    fn a_tool_only_batch_closes_at_sixty_four_rounds_via_rebuild() {
        // The same shape must come out of a rebuild from items, because the
        // live round's open trunk is rebuilt from memory rather than read
        // from the builder that streamed it.
        let items: Vec<TimelineItem> = (0..BATCH_MAX_ROUNDS + 1)
            .map(|index| TimelineItem::ToolCall {
                id: format!("t{index}"),
                name: "grep".into(),
                status: genehub_proto::ToolStatus::Ok,
                detail: ToolCallDetail::Shell {
                    command: "grep".into(),
                    output: String::new(),
                    exit_code: Some(0),
                },
                images: vec![],
                started_at_ms: None,
                finished_at_ms: None,
            })
            .collect();
        let llm_rounds: HashMap<String, u32> = items
            .iter()
            .map(|item| (item.id().to_string(), 1))
            .collect();
        let trunks = trunks_from_items_with_rounds(&items, &llm_rounds);
        assert_eq!(trunks.len(), 1);
        assert_eq!(trunks[0].summary.batches.len(), 2);
        assert_eq!(trunks[0].summary.batches[0].blob_count, 64);
        assert_eq!(
            trunks[0].summary.batches[0].llm_rounds,
            Some(BATCH_MAX_ROUNDS as u64)
        );
        assert_eq!(trunks[0].summary.batches[1].blob_count, 1);
        assert_eq!(trunks[0].summary.batches[1].llm_rounds, Some(1));
    }

    #[test]
    fn reasoning_after_sixteen_rounds_titles_a_fresh_batch() {
        let mut builder = TrunkBuilder::default();
        // 16 rounds of tool work, then the round-17 reasoning block: the
        // batch already holds 16 rounds, so the reasoning titles a fresh one.
        for index in 0..BATCH_REASONING_ROUND_THRESHOLD {
            push_rounds(
                &mut builder,
                &format!("t{index}"),
                TrunkItem::ToolCall("grep"),
                1,
            );
        }
        push_rounds(&mut builder, "r1", TrunkItem::Reasoning, 1);
        push_rounds(&mut builder, "t16", TrunkItem::ToolCall("write"), 0);
        let summary = builder
            .close()
            .unwrap()
            .into_summary(0, &texts(&[("r1", "开始修改并验证结果")]));

        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].blob_count, 16);
        assert_eq!(
            summary.batches[0].llm_rounds,
            Some(BATCH_REASONING_ROUND_THRESHOLD as u64)
        );
        assert_eq!(summary.batches[0].text, "调用了 16 次工具");
        assert_eq!(summary.batches[1].first_item_id, "r1");
        assert_eq!(summary.batches[1].blob_count, 2);
        assert_eq!(summary.batches[1].llm_rounds, Some(1));
        assert_eq!(summary.batches[1].text, "开始修改并验证结果");
    }

    #[test]
    fn reasoning_before_sixteen_rounds_stays_with_the_current_batch() {
        let mut builder = TrunkBuilder::default();
        for index in 0..BATCH_REASONING_ROUND_THRESHOLD - 1 {
            push_rounds(
                &mut builder,
                &format!("t{index}"),
                TrunkItem::ToolCall("grep"),
                1,
            );
        }
        push_rounds(&mut builder, "r1", TrunkItem::Reasoning, 0);
        let summary = builder
            .close()
            .unwrap()
            .into_summary(0, &texts(&[("r1", "继续确认剩余入口")]));

        assert_eq!(summary.batches.len(), 1);
        assert_eq!(summary.batches[0].blob_count, 16);
        assert_eq!(
            summary.batches[0].llm_rounds,
            Some(BATCH_REASONING_ROUND_THRESHOLD as u64 - 1)
        );
        assert_eq!(summary.batches[0].text, "继续确认剩余入口");
    }

    #[test]
    fn the_blob_safety_limit_still_bounds_reasoning_only_batches() {
        let mut builder = TrunkBuilder::default();
        for index in 0..BATCH_MAX_BLOBS + 1 {
            push(&mut builder, &format!("r{index}"), TrunkItem::Reasoning);
        }
        let summary = builder.close().unwrap().into_summary(0, &HashMap::new());
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].blob_count, BATCH_MAX_BLOBS);
        assert_eq!(summary.batches[1].blob_count, 1);
    }

    #[test]
    fn blocked_intervals_are_subtracted_from_trunk_and_batch_durations() {
        let items = vec![
            TimelineItem::ToolCall {
                id: "t1".into(),
                name: "grep".into(),
                status: genehub_proto::ToolStatus::Ok,
                detail: ToolCallDetail::Shell {
                    command: "grep".into(),
                    output: String::new(),
                    exit_code: Some(0),
                },
                images: vec![],
                started_at_ms: Some(1_000),
                finished_at_ms: Some(2_000),
            },
            TimelineItem::ToolCall {
                id: "t2".into(),
                name: "grep".into(),
                status: genehub_proto::ToolStatus::Ok,
                detail: ToolCallDetail::Shell {
                    command: "grep".into(),
                    output: String::new(),
                    exit_code: Some(0),
                },
                images: vec![],
                started_at_ms: Some(62_000),
                finished_at_ms: Some(63_000),
            },
        ];
        let mut trunks = trunks_from_items(&items);
        assert_eq!(trunks[0].summary.duration_ms, Some(62_000));
        // A permission wait from 5s to 60s sits between the two calls.
        exclude_blocked(&mut trunks[0], &[(5_000, 60_000)]);
        assert_eq!(trunks[0].summary.duration_ms, Some(7_000));
        assert_eq!(trunks[0].batches[0].summary.duration_ms, Some(7_000));
        // The tool's own duration is untouched: it never overlapped the wait.
        assert_eq!(trunks[0].summary.tool_duration_ms, Some(2_000));
    }

    #[test]
    fn a_trunk_closes_at_the_blob_backstop_without_any_reported_rounds() {
        // An adapter that never reports LLM rounds still gets bounded trunks:
        // past 500 blobs the next batch boundary closes the trunk.
        let mut builder = TrunkBuilder::default();
        let mut closed = None;
        for index in 0..TRUNK_MAX_BLOBS {
            closed = push(
                &mut builder,
                &format!("t{index}"),
                TrunkItem::ToolCall("grep"),
            );
            assert!(closed.is_none());
        }
        // The monologue opens a fresh batch, finds the trunk over the blob
        // backstop and closes it — the opener itself joins the new trunk.
        closed = push(&mut builder, "a1", TrunkItem::Monologue);
        let summary = closed
            .expect("the first batch boundary past the backstop closes the trunk")
            .into_summary(0, &HashMap::new());
        assert_eq!(summary.blob_count, TRUNK_MAX_BLOBS);
        assert_eq!(summary.llm_rounds, Some(0));
    }

    #[test]
    fn a_trunk_closes_on_the_batch_after_its_round_threshold() {
        let mut builder = TrunkBuilder::default();
        let mut closed = None;
        // 100 rounds of tool work, then the round-101 monologue: it opens a
        // fresh batch, which crosses the threshold and closes the trunk.
        for index in 0..TRUNK_ROUND_THRESHOLD {
            closed = push_rounds(
                &mut builder,
                &format!("t{index}"),
                TrunkItem::ToolCall("grep"),
                1,
            );
            assert!(closed.is_none());
        }
        closed = push_rounds(&mut builder, "a100", TrunkItem::Monologue, 1);
        assert!(
            closed.is_none(),
            "the monologue that opens the next batch belongs to the new trunk"
        );
        closed = push_rounds(&mut builder, "t100", TrunkItem::ToolCall("grep"), 0);
        assert!(closed.is_none(), "the trunk closes once a new round begins");
        closed = push_rounds(&mut builder, "a101", TrunkItem::Monologue, 1);
        let summary = closed
            .expect("the round-102 monologue closes the over-budget trunk")
            .into_summary(0, &texts(&[("a100", "开始收尾"), ("a101", "继续")]));
        assert_eq!(summary.llm_rounds, Some(101));
        assert_eq!(
            summary
                .batches
                .iter()
                .filter_map(|batch| batch.llm_rounds)
                .sum::<u64>(),
            101,
            "every counted round must belong to a listed batch, or the rows for \
             the trailing partial batch are written nowhere"
        );
        assert_eq!(summary.batches.len(), 3);
        assert_eq!(summary.batches[0].blob_count, 64);
        assert_eq!(summary.batches[0].llm_rounds, Some(64));
        assert_eq!(summary.batches[1].blob_count, 36);
        assert_eq!(summary.batches[1].llm_rounds, Some(36));
        assert_eq!(summary.batches[2].first_item_id, "a100");
        assert_eq!(summary.batches[2].llm_rounds, Some(1));
        let rest = builder.close().unwrap().into_summary(1, &HashMap::new());
        assert_eq!(rest.llm_rounds, Some(1));
        assert_eq!(rest.batches.len(), 1);
        assert_eq!(rest.batches[0].first_item_id, "a101");
    }

    #[test]
    fn a_short_acknowledgement_is_not_the_whole_title_of_a_longer_monologue() {
        assert_eq!(
            first_sentence("收到。我现在继续检查流式更新期间的页面稳定性。后续内容"),
            "收到。我现在继续检查流式更新期间的页面稳定性。"
        );
        assert_eq!(first_sentence("收到。"), "收到。");
    }

    #[test]
    fn no_monologue_uses_the_first_thinking_text_for_batch_and_trunk() {
        let mut builder = TrunkBuilder::default();
        push(&mut builder, "r1", TrunkItem::Reasoning);
        push(&mut builder, "t1", TrunkItem::ToolCall("read"));
        let summary = builder
            .close()
            .unwrap()
            .into_summary(0, &texts(&[("r1", "先确认数据结构，再开始修改")]));
        assert_eq!(summary.batches[0].text, "先确认数据结构，再开始修改");
        assert_eq!(summary.title, "先确认数据结构，再开始修改");
    }

    #[test]
    fn consecutive_monologues_each_start_a_batch() {
        let mut builder = TrunkBuilder::default();
        push(&mut builder, "a1", TrunkItem::Monologue);
        push(&mut builder, "a2", TrunkItem::Monologue);
        let summary = builder
            .close()
            .unwrap()
            .into_summary(0, &texts(&[("a1", "第一句"), ("a2", "第二句")]));
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].text, "第一句");
        assert_eq!(summary.batches[1].text, "第二句");
    }

    #[test]
    fn a_compaction_closes_the_trunk_as_its_last_marker_batch() {
        let mut builder = TrunkBuilder::default();
        push(&mut builder, "a1", TrunkItem::Monologue);
        push(&mut builder, "t1", TrunkItem::ToolCall("read"));
        let closed = push(&mut builder, "c1", TrunkItem::Compaction("auto"))
            .expect("a compaction closes the trunk it lands in");
        push(&mut builder, "a2", TrunkItem::Monologue);
        push(&mut builder, "t2", TrunkItem::ToolCall("write"));
        let first = closed.into_summary(0, &texts(&[("a1", "先读取配置")]));
        let second = builder
            .close()
            .unwrap()
            .into_summary(1, &texts(&[("a2", "再写入修改")]));

        assert_eq!(first.batches.len(), 2);
        assert_eq!(first.batches[0].first_item_id, "a1");
        assert_eq!(first.batches[0].marker, None);
        let marker = &first.batches[1];
        assert_eq!(marker.first_item_id, "c1");
        assert_eq!(marker.blob_count, 0);
        assert_eq!(marker.marker.as_deref(), Some("auto"));
        assert_eq!(first.blob_count, 1, "a marker carries no blob");
        assert_eq!(first.title, "先读取配置");

        assert_eq!(second.batches.len(), 1);
        assert_eq!(second.batches[0].first_item_id, "a2");
        assert_eq!(second.batches[0].marker, None);
        assert_eq!(second.title, "再写入修改");
    }

    #[test]
    fn consecutive_compactions_close_one_trunk_each() {
        let mut builder = TrunkBuilder::default();
        push(&mut builder, "t1", TrunkItem::ToolCall("read"));
        let first = push(&mut builder, "c1", TrunkItem::Compaction("auto"))
            .expect("first compaction closes its trunk");
        let second = push(&mut builder, "c2", TrunkItem::Compaction("manual"))
            .expect("a second compaction closes its own marker-only trunk");
        push(&mut builder, "t2", TrunkItem::ToolCall("write"));
        let first = first.into_summary(0, &HashMap::new());
        let second = second.into_summary(1, &HashMap::new());
        let third = builder.close().unwrap().into_summary(2, &HashMap::new());

        assert_eq!(first.batches.len(), 2);
        assert_eq!(first.batches[1].first_item_id, "c1");
        assert_eq!(first.batches[1].marker.as_deref(), Some("auto"));
        assert_eq!(second.batches.len(), 1);
        assert_eq!(second.batches[0].first_item_id, "c2");
        assert_eq!(second.batches[0].marker.as_deref(), Some("manual"));
        assert_eq!(third.batches.len(), 1);
        assert_eq!(third.batches[0].first_item_id, "t2");
    }

    #[test]
    fn a_compaction_before_any_work_opens_and_closes_its_own_trunk() {
        let mut builder = TrunkBuilder::default();
        let closed = push(&mut builder, "c1", TrunkItem::Compaction("auto"))
            .expect("a leading compaction still closes a trunk");
        push(&mut builder, "t1", TrunkItem::ToolCall("read"));
        let first = closed.into_summary(0, &HashMap::new());
        let second = builder.close().unwrap().into_summary(1, &HashMap::new());

        assert_eq!(first.first_item_id, "c1");
        assert_eq!(first.batches.len(), 1);
        assert_eq!(first.batches[0].marker.as_deref(), Some("auto"));
        assert_eq!(second.batches.len(), 1);
        assert_eq!(second.batches[0].first_item_id, "t1");
        assert_eq!(
            second.title, "调用了 1 次工具",
            "a leading marker batch must not become the next trunk's title"
        );
    }

    #[test]
    fn timing_rolls_up_from_tool_items() {
        let mut builder = TrunkBuilder::default();
        builder.push(
            "t1",
            TrunkItem::ToolCall("read"),
            ItemTiming {
                started_at_ms: Some(1_000),
                finished_at_ms: Some(4_000),
                tool_duration_ms: Some(3_000),
            },
            0,
        );
        builder.push(
            "t2",
            TrunkItem::ToolCall("write"),
            ItemTiming {
                started_at_ms: Some(5_000),
                finished_at_ms: Some(9_500),
                tool_duration_ms: Some(4_500),
            },
            0,
        );
        let summary = builder.close().unwrap().into_summary(0, &HashMap::new());
        assert_eq!(summary.started_at_ms, Some(1_000));
        assert_eq!(summary.duration_ms, Some(8_500));
        assert_eq!(summary.tool_duration_ms, Some(7_500));
        assert_eq!(summary.batches[0].started_at_ms, Some(1_000));
        assert_eq!(summary.batches[0].duration_ms, Some(8_500));
        assert_eq!(summary.batches[0].tool_duration_ms, Some(7_500));
    }

    #[test]
    fn a_marker_batch_closes_its_trunk_and_the_next_monologue_opens_a_new_one() {
        let items = vec![
            TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "先读取配置".into(),
                received_at_ms: None,
            },
            TimelineItem::Compaction {
                id: "c1".into(),
                reason: "auto".into(),
                received_at_ms: None,
            },
            TimelineItem::AssistantMessage {
                id: "a2".into(),
                text: "再写入修改".into(),
                received_at_ms: None,
            },
        ];
        let trunks = trunks_from_items(&items);
        assert_eq!(trunks.len(), 2);
        let first = &trunks[0];
        assert_eq!(first.batches.len(), 2);
        assert_eq!(first.batches[0].monologue.as_deref(), Some("先读取配置"));
        let marker = &first.batches[1];
        assert_eq!(marker.summary.marker.as_deref(), Some("auto"));
        assert_eq!(marker.summary.first_item_id, "c1");
        assert!(
            marker.monologue.is_none() && marker.blobs.is_empty(),
            "the marker batch must not absorb neighbouring work"
        );
        let second = &trunks[1];
        assert_eq!(second.batches.len(), 1);
        assert_eq!(second.batches[0].monologue.as_deref(), Some("再写入修改"));
    }

    #[test]
    fn closing_an_empty_builder_produces_nothing() {
        assert!(TrunkBuilder::default().close().is_none());
    }

    fn produced(id: &str, name: &str, path: &str) -> TimelineItem {
        TimelineItem::ToolCall {
            id: id.into(),
            name: name.into(),
            status: genehub_proto::ToolStatus::Ok,
            detail: ToolCallDetail::Overview {
                tool_kind: genehub_proto::ToolKind::Other,
                overview: name.into(),
                input: String::new(),
                output: String::new(),
            },
            images: vec![genehub_proto::ToolImage {
                alt: name.into(),
                mime: "image/png".into(),
                data_base64: None,
                thumb: Some(genehub_proto::ImageThumb {
                    mime: "image/jpeg".into(),
                    data_base64: "dGh1bWI=".into(),
                    width: 128,
                    height: 64,
                }),
                path: Some(path.into()),
            }],
            started_at_ms: None,
            finished_at_ms: None,
        }
    }

    #[test]
    fn produced_images_follow_the_tool_batch_as_one_gallery() {
        let items = vec![
            TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "开始画。".into(),
                received_at_ms: None,
            },
            produced(
                "t1",
                "imageGeneration",
                ".genethub/sessions/s1/images/aa.png",
            ),
            produced(
                "t2",
                "imageGeneration",
                ".genethub/sessions/s1/images/bb.png",
            ),
        ];
        let trunks = trunks_from_items(&items);
        assert_eq!(trunks.len(), 1);
        let batches = &trunks[0].batches;
        assert_eq!(batches.len(), 2, "one work batch then one image batch");
        assert_eq!(
            batches[0]
                .blobs
                .iter()
                .map(|row| row.kind)
                .collect::<Vec<_>>(),
            vec![BlobKind::ToolCall, BlobKind::ToolCall]
        );
        assert_eq!(batches[1].summary.text, "2 张图片");
        assert_eq!(batches[1].summary.first_item_id, "t1:img:0");
        assert_eq!(
            batches[1]
                .blobs
                .iter()
                .map(|row| row.item_id.as_str())
                .collect::<Vec<_>>(),
            vec!["t1:img:0", "t2:img:0"]
        );
        assert_eq!(trunks[0].summary.batches.len(), 2);
        assert_eq!(trunks[0].summary.batches[1].text, "2 张图片");
    }

    #[test]
    fn read_images_stay_in_the_tool_batch() {
        let items = vec![produced("t1", "Read", "assets/logo.png")];
        let batches = &trunks_from_items(&items)[0].batches;
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].blobs.len(), 2);
        assert_eq!(batches[0].blobs[1].kind, BlobKind::Image);
        assert_eq!(batches[0].blobs[1].path.as_deref(), Some("assets/logo.png"));
    }

    #[test]
    fn a_later_monologue_keeps_the_image_batch_between_work_and_narration() {
        let items = vec![
            produced(
                "t1",
                "imageGeneration",
                ".genethub/sessions/s1/images/aa.png",
            ),
            TimelineItem::AssistantMessage {
                id: "a2".into(),
                text: "画好了。".into(),
                received_at_ms: None,
            },
        ];
        let batches = &trunks_from_items(&items)[0].batches;
        assert_eq!(batches.len(), 3);
        assert!(batches[0]
            .blobs
            .iter()
            .all(|row| row.kind == BlobKind::ToolCall));
        assert_eq!(batches[1].summary.text, "1 张图片");
        assert_eq!(batches[2].monologue.as_deref(), Some("画好了。"));
        assert!(batches[2].blobs.is_empty());
    }

    #[test]
    fn splitting_twice_is_idempotent() {
        let items = vec![produced(
            "t1",
            "imageGeneration",
            ".genethub/sessions/s1/images/aa.png",
        )];
        let first = trunks_from_items(&items)[0].batches.clone();
        let second = split_produced_image_batches(first.clone());
        assert_eq!(first, second);
    }
}
