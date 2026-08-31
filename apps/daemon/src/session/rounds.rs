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

/// Once a batch has accumulated this many tool calls, the next reasoning block
/// is useful enough to become the title of a fresh semantic batch.
pub const BATCH_REASONING_TOOL_THRESHOLD: u32 = 16;
/// A tool-only run still needs a bounded fallback when the agent provides no
/// narration or reasoning boundary at all.
pub const BATCH_MAX_TOOL_CALLS: u32 = 64;
/// Reasoning is a blob too. Keep a wider storage safety bound so a malformed
/// or unusually chatty adapter cannot grow one batch without limit, while
/// leaving normal grouping driven by semantic tool boundaries.
pub const BATCH_MAX_BLOBS: u32 = 128;
/// Once a trunk has passed this many tool calls, its next semantic batch starts
/// a new trunk. This is deliberately a soft threshold: a batch is never cut in
/// half merely to make the number exact.
pub const TRUNK_TOOL_CALL_THRESHOLD: u32 = 100;

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

#[derive(Debug, Clone, Default)]
struct BatchBuilder {
    item_ids: Vec<String>,
    blob_count: u32,
    monologue_item_id: Option<String>,
    first_reasoning_item_id: Option<String>,
    tool_count: u32,
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
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClosedTrunk {
    pub first_item_id: String,
    pub blob_count: u32,
    pub first_monologue_item_id: Option<String>,
    pub batches: Vec<ClosedBatch>,
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
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TrunkBuilder {
    current_batch: BatchBuilder,
    closed_batches: Vec<ClosedBatch>,
    blob_count: u32,
    tool_count: u32,
    first_item_id: Option<String>,
    first_monologue_item_id: Option<String>,
}

impl TrunkBuilder {
    pub fn push(&mut self, item_id: &str, item: TrunkItem<'_>) -> Option<ClosedTrunk> {
        // A compaction cuts the batch short and then takes its own place in
        // the stream: a zero-blob marker batch whose first_item_id is the
        // compaction item itself, so every reader renders the marker at the
        // exact batch boundary where the context was squeezed.
        if let TrunkItem::Compaction(reason) = item {
            self.close_batch();
            if self.first_item_id.is_none() {
                self.first_item_id = Some(item_id.to_string());
            }
            self.closed_batches
                .push(ClosedBatch::marker(item_id, reason));
            return None;
        }
        let mut closed_trunk = None;
        let starts_semantic_batch = match item {
            TrunkItem::Monologue => !self.current_batch.item_ids.is_empty(),
            TrunkItem::Reasoning => self.current_batch.tool_count >= BATCH_REASONING_TOOL_THRESHOLD,
            TrunkItem::ToolCall(_) => false,
            TrunkItem::Compaction(_) => unreachable!("handled above"),
        };
        if starts_semantic_batch {
            self.close_batch();
        }
        // Batch boundaries are the only safe trunk boundaries. Crossing the
        // threshold marks the trunk ready to close; the item that begins the
        // next batch belongs wholly to the new trunk.
        if self.current_batch.item_ids.is_empty() && self.tool_count > TRUNK_TOOL_CALL_THRESHOLD {
            closed_trunk = self.close_finished();
        }

        if self.first_item_id.is_none() {
            self.first_item_id = Some(item_id.to_string());
        }
        if !self.current_batch.item_ids.iter().any(|id| id == item_id) {
            self.current_batch.item_ids.push(item_id.to_string());
        }
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
                self.tool_count += 1;
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

        if self.current_batch.tool_count >= BATCH_MAX_TOOL_CALLS
            || self.current_batch.blob_count >= BATCH_MAX_BLOBS
        {
            self.close_batch();
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
        self.closed_batches.push(ClosedBatch {
            first_item_id: batch.item_ids[0].clone(),
            blob_count: batch.blob_count,
            monologue_item_id: batch.monologue_item_id,
            first_reasoning_item_id: batch.first_reasoning_item_id,
            tool_count: batch.tool_count,
            marker: None,
        });
    }

    fn close_finished(&mut self) -> Option<ClosedTrunk> {
        if self.closed_batches.is_empty() {
            return None;
        }
        self.tool_count = 0;
        Some(ClosedTrunk {
            first_item_id: self.first_item_id.take().unwrap_or_default(),
            blob_count: std::mem::take(&mut self.blob_count),
            first_monologue_item_id: self.first_monologue_item_id.take(),
            batches: std::mem::take(&mut self.closed_batches),
        })
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

pub fn summarize_trunks(items: &[TimelineItem]) -> Vec<TrunkSummary> {
    let texts: HashMap<String, String> = items
        .iter()
        .filter_map(|item| match item {
            TimelineItem::AssistantMessage { id, text } | TimelineItem::Reasoning { id, text } => {
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
        if let Some(trunk) = builder.push(item.id(), kind) {
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
    let summaries = summarize_trunks(items);
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
    let (kind, overview) = match item {
        TimelineItem::Reasoning { text, .. } => (BlobKind::Reasoning, text.clone()),
        TimelineItem::ToolCall { name, detail, .. } => (
            BlobKind::ToolCall,
            match detail {
                ToolCallDetail::Overview { overview, .. } => overview.clone(),
                _ => name.clone(),
            },
        ),
        _ => return Vec::new(),
    };
    let mut rows = vec![BlobOverview {
        item_id: item.id().to_string(),
        kind,
        overview,
        blob: None,
        thumb: None,
        path: None,
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

    #[test]
    fn monologues_split_batches_but_not_trunks() {
        let mut builder = TrunkBuilder::default();
        builder.push("a1", TrunkItem::Monologue);
        builder.push("t1", TrunkItem::ToolCall("read"));
        builder.push("t2", TrunkItem::ToolCall("read"));
        assert!(
            builder.push("a2", TrunkItem::Monologue).is_none(),
            "a monologue starts a batch, not a new trunk"
        );
        builder.push("r1", TrunkItem::Reasoning);
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
        builder.push("r1", TrunkItem::Reasoning);
        builder.push("a1", TrunkItem::Monologue);
        builder.push("t1", TrunkItem::ToolCall("read"));
        builder.push("t2", TrunkItem::ToolCall("search"));
        builder.push("a2", TrunkItem::Monologue);
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
    fn a_tool_only_batch_closes_at_sixty_four_calls() {
        let mut builder = TrunkBuilder::default();
        for index in 0..BATCH_MAX_TOOL_CALLS + 1 {
            builder.push(&format!("t{index}"), TrunkItem::ToolCall("grep"));
        }
        let summary = builder.close().unwrap().into_summary(0, &HashMap::new());
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].blob_count, 64);
        assert_eq!(summary.batches[0].text, "调用了 64 次工具");
        assert_eq!(summary.batches[1].blob_count, 1);
    }

    #[test]
    fn reasoning_after_sixteen_tools_titles_a_fresh_batch() {
        let mut builder = TrunkBuilder::default();
        for index in 0..BATCH_REASONING_TOOL_THRESHOLD {
            builder.push(&format!("t{index}"), TrunkItem::ToolCall("grep"));
        }
        builder.push("r1", TrunkItem::Reasoning);
        builder.push("t16", TrunkItem::ToolCall("write"));
        let summary = builder
            .close()
            .unwrap()
            .into_summary(0, &texts(&[("r1", "开始修改并验证结果")]));

        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].blob_count, 16);
        assert_eq!(summary.batches[0].text, "调用了 16 次工具");
        assert_eq!(summary.batches[1].first_item_id, "r1");
        assert_eq!(summary.batches[1].blob_count, 2);
        assert_eq!(summary.batches[1].text, "开始修改并验证结果");
    }

    #[test]
    fn reasoning_before_sixteen_tools_stays_with_the_current_batch() {
        let mut builder = TrunkBuilder::default();
        for index in 0..BATCH_REASONING_TOOL_THRESHOLD - 1 {
            builder.push(&format!("t{index}"), TrunkItem::ToolCall("grep"));
        }
        builder.push("r1", TrunkItem::Reasoning);
        let summary = builder
            .close()
            .unwrap()
            .into_summary(0, &texts(&[("r1", "继续确认剩余入口")]));

        assert_eq!(summary.batches.len(), 1);
        assert_eq!(summary.batches[0].blob_count, 16);
        assert_eq!(summary.batches[0].text, "继续确认剩余入口");
    }

    #[test]
    fn the_blob_safety_limit_still_bounds_reasoning_only_batches() {
        let mut builder = TrunkBuilder::default();
        for index in 0..BATCH_MAX_BLOBS + 1 {
            builder.push(&format!("r{index}"), TrunkItem::Reasoning);
        }
        let summary = builder.close().unwrap().into_summary(0, &HashMap::new());
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].blob_count, BATCH_MAX_BLOBS);
        assert_eq!(summary.batches[1].blob_count, 1);
    }

    #[test]
    fn a_trunk_closes_on_the_batch_after_its_tool_call_threshold() {
        let mut builder = TrunkBuilder::default();
        let mut closed = None;
        for index in 0..129 {
            closed = builder.push(&format!("t{index}"), TrunkItem::ToolCall("grep"));
        }
        let summary = closed
            .expect("the first item after the threshold-crossing batch closes the trunk")
            .into_summary(0, &HashMap::new());
        assert_eq!(summary.blob_count, 128);
        assert_eq!(
            summary
                .batches
                .iter()
                .map(|batch| batch.blob_count)
                .sum::<u32>(),
            summary.blob_count,
            "every counted blob must belong to a listed batch, or the rows for \
             the trailing partial batch are written nowhere"
        );
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches.last().unwrap().blob_count, 64);
        assert_eq!(summary.title, "调用了 64 次工具");
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
        builder.push("r1", TrunkItem::Reasoning);
        builder.push("t1", TrunkItem::ToolCall("read"));
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
        builder.push("a1", TrunkItem::Monologue);
        builder.push("a2", TrunkItem::Monologue);
        let summary = builder
            .close()
            .unwrap()
            .into_summary(0, &texts(&[("a1", "第一句"), ("a2", "第二句")]));
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].text, "第一句");
        assert_eq!(summary.batches[1].text, "第二句");
    }

    #[test]
    fn a_compaction_stands_as_a_marker_batch_between_work_batches() {
        let mut builder = TrunkBuilder::default();
        builder.push("a1", TrunkItem::Monologue);
        builder.push("t1", TrunkItem::ToolCall("read"));
        builder.push("c1", TrunkItem::Compaction("auto"));
        builder.push("a2", TrunkItem::Monologue);
        builder.push("t2", TrunkItem::ToolCall("write"));
        let summary = builder
            .close()
            .unwrap()
            .into_summary(0, &texts(&[("a1", "先读取配置"), ("a2", "再写入修改")]));

        assert_eq!(summary.batches.len(), 3);
        assert_eq!(summary.batches[0].first_item_id, "a1");
        assert_eq!(summary.batches[0].marker, None);
        let marker = &summary.batches[1];
        assert_eq!(marker.first_item_id, "c1");
        assert_eq!(marker.blob_count, 0);
        assert_eq!(marker.marker.as_deref(), Some("auto"));
        assert_eq!(summary.batches[2].first_item_id, "a2");
        assert_eq!(summary.batches[2].marker, None);
        assert_eq!(summary.blob_count, 2, "a marker carries no blob");
        assert_eq!(summary.title, "先读取配置");
    }

    #[test]
    fn consecutive_compactions_each_stand_as_a_marker_batch() {
        let mut builder = TrunkBuilder::default();
        builder.push("t1", TrunkItem::ToolCall("read"));
        builder.push("c1", TrunkItem::Compaction("auto"));
        builder.push("c2", TrunkItem::Compaction("manual"));
        builder.push("t2", TrunkItem::ToolCall("write"));
        let summary = builder.close().unwrap().into_summary(0, &HashMap::new());

        assert_eq!(summary.batches.len(), 4);
        assert_eq!(summary.batches[1].first_item_id, "c1");
        assert_eq!(summary.batches[1].marker.as_deref(), Some("auto"));
        assert_eq!(summary.batches[2].first_item_id, "c2");
        assert_eq!(summary.batches[2].marker.as_deref(), Some("manual"));
        assert_eq!(summary.batches[3].first_item_id, "t2");
    }

    #[test]
    fn a_compaction_before_any_work_opens_the_trunk() {
        let mut builder = TrunkBuilder::default();
        builder.push("c1", TrunkItem::Compaction("auto"));
        builder.push("t1", TrunkItem::ToolCall("read"));
        let summary = builder.close().unwrap().into_summary(0, &HashMap::new());

        assert_eq!(summary.first_item_id, "c1");
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].marker.as_deref(), Some("auto"));
        assert_eq!(summary.batches[1].first_item_id, "t1");
        assert_eq!(
            summary.title, "调用了 1 次工具",
            "a leading marker batch must not become the trunk title"
        );
    }

    #[test]
    fn a_marker_batch_slices_out_exactly_the_compaction_item() {
        let items = vec![
            TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "先读取配置".into(),
            },
            TimelineItem::Compaction {
                id: "c1".into(),
                reason: "auto".into(),
            },
            TimelineItem::AssistantMessage {
                id: "a2".into(),
                text: "再写入修改".into(),
            },
        ];
        let trunks = trunks_from_items(&items);
        assert_eq!(trunks.len(), 1);
        let batches = &trunks[0].batches;
        assert_eq!(batches.len(), 3);
        let marker = &batches[1];
        assert_eq!(marker.summary.marker.as_deref(), Some("auto"));
        assert_eq!(marker.summary.first_item_id, "c1");
        assert!(
            marker.monologue.is_none() && marker.blobs.is_empty(),
            "the marker batch must not absorb neighbouring work"
        );
        assert_eq!(batches[0].monologue.as_deref(), Some("先读取配置"));
        assert_eq!(batches[2].monologue.as_deref(), Some("再写入修改"));
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
        }
    }

    #[test]
    fn produced_images_follow_the_tool_batch_as_one_gallery() {
        let items = vec![
            TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "开始画。".into(),
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
