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

/// A semantic batch never exposes more than sixteen blobs at once.
pub const BATCH_MAX_BLOBS: u32 = 16;
/// A visible trunk holds at most a hundred blobs — six full batches and part
/// of a seventh. The cap is what keeps one trunk request bounded no matter how
/// long its round ran.
pub const TRUNK_MAX_BLOBS: u32 = 100;

pub enum TrunkItem<'a> {
    Monologue,
    Reasoning,
    ToolCall(&'a str),
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
                let text = batch
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
                    .unwrap_or_else(|| format!("调用了 {} 次工具", batch.tool_count));
                BatchSummary {
                    index: batch_index as u32,
                    first_item_id: batch.first_item_id,
                    blob_count: batch.blob_count,
                    text,
                }
            })
            .collect();
        let title = self
            .first_monologue_item_id
            .as_ref()
            .and_then(|id| texts.get(id))
            .map(|text| first_sentence(text))
            .filter(|text| !text.is_empty())
            .or_else(|| batches.first().map(|batch| overview::clip(&batch.text, 32)))
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
    first_item_id: Option<String>,
    first_monologue_item_id: Option<String>,
}

impl TrunkBuilder {
    pub fn push(&mut self, item_id: &str, item: TrunkItem<'_>) -> Option<ClosedTrunk> {
        let mut closed_trunk = None;
        if matches!(item, TrunkItem::Monologue)
            && self.current_batch.monologue_item_id.is_some()
            && self.current_batch.blob_count > 0
        {
            self.close_batch();
            if self.blob_count >= TRUNK_MAX_BLOBS {
                closed_trunk = self.close_finished();
            }
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
            }
            TrunkItem::Reasoning => {
                self.current_batch.blob_count += 1;
                self.blob_count += 1;
                if self.current_batch.first_reasoning_item_id.is_none() {
                    self.current_batch.first_reasoning_item_id = Some(item_id.to_string());
                }
            }
        }

        if self.current_batch.blob_count >= BATCH_MAX_BLOBS {
            self.close_batch();
        }
        if self.blob_count >= TRUNK_MAX_BLOBS {
            // The cap is not a multiple of the batch size, so the trunk
            // usually fills mid-batch. Closing that batch here is what keeps
            // its blobs inside the trunk rather than counted-but-unlisted.
            self.close_batch();
            return self.close_finished().or(closed_trunk);
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
        });
    }

    fn close_finished(&mut self) -> Option<ClosedTrunk> {
        if self.closed_batches.is_empty() {
            return None;
        }
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
    let end = text
        .char_indices()
        .find_map(|(index, character)| {
            matches!(character, '。' | '！' | '？' | '.' | '!' | '?' | '\n')
                .then_some(index + character.len_utf8())
        })
        .unwrap_or(text.len());
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
            let blobs = slice.iter().filter_map(blob_overview).collect();
            batches.push(RoundBatch {
                summary: batch.clone(),
                monologue,
                blobs,
            });
        }
        trunks.push(RoundTrunk {
            summary: summary.clone(),
            batches,
        });
    }
    trunks
}

/// The compact row for one work item, or `None` for anything that is not work.
pub fn blob_overview(item: &TimelineItem) -> Option<BlobOverview> {
    let (kind, overview) = match item {
        TimelineItem::Reasoning { text, .. } => (BlobKind::Reasoning, text.clone()),
        TimelineItem::ToolCall { name, detail, .. } => (
            BlobKind::ToolCall,
            match detail {
                ToolCallDetail::Overview { overview, .. } => overview.clone(),
                _ => name.clone(),
            },
        ),
        _ => return None,
    };
    Some(BlobOverview {
        item_id: item.id().to_string(),
        kind,
        overview,
        blob: None,
    })
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
        assert_eq!(summary.title, "先读取配置。");
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].blob_count, 2);
        assert_eq!(summary.batches[0].text, "先读取配置。再检查环境");
        assert_eq!(summary.batches[1].text, "开始修改");
    }

    #[test]
    fn leading_reasoning_joins_the_monologue_and_work_that_follow() {
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

        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].first_item_id, "r1");
        assert_eq!(summary.batches[0].blob_count, 3);
        assert_eq!(summary.batches[0].text, "开始核对网络边界");
        assert_eq!(summary.batches[1].first_item_id, "a2");
        assert_eq!(summary.batches[1].blob_count, 0);
    }

    #[test]
    fn a_batch_closes_at_sixteen_blobs_without_a_monologue() {
        let mut builder = TrunkBuilder::default();
        for index in 0..BATCH_MAX_BLOBS + 1 {
            builder.push(&format!("t{index}"), TrunkItem::ToolCall("grep"));
        }
        let summary = builder.close().unwrap().into_summary(0, &HashMap::new());
        assert_eq!(summary.batches.len(), 2);
        assert_eq!(summary.batches[0].blob_count, 16);
        assert_eq!(summary.batches[0].text, "调用了 16 次工具");
        assert_eq!(summary.batches[1].blob_count, 1);
    }

    #[test]
    fn a_trunk_closes_at_its_blob_cap_without_stranding_the_open_batch() {
        let mut builder = TrunkBuilder::default();
        let mut closed = None;
        for index in 0..TRUNK_MAX_BLOBS {
            closed = builder.push(&format!("t{index}"), TrunkItem::ToolCall("grep"));
        }
        let summary = closed
            .expect("the hundredth blob closes the trunk")
            .into_summary(0, &HashMap::new());
        assert_eq!(summary.blob_count, 100);
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
        assert_eq!(summary.batches.len(), 7);
        assert_eq!(summary.batches.last().unwrap().blob_count, 4);
        assert_eq!(summary.title, "调用了 16 次工具");
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
    fn consecutive_monologues_without_work_share_one_batch() {
        let mut builder = TrunkBuilder::default();
        builder.push("a1", TrunkItem::Monologue);
        builder.push("a2", TrunkItem::Monologue);
        let summary = builder
            .close()
            .unwrap()
            .into_summary(0, &texts(&[("a1", "第一句"), ("a2", "第二句")]));
        assert_eq!(summary.batches.len(), 1);
        assert_eq!(summary.batches[0].text, "第一句");
    }

    #[test]
    fn closing_an_empty_builder_produces_nothing() {
        assert!(TrunkBuilder::default().close().is_none());
    }
}
