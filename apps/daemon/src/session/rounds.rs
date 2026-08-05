//! The round ledger: `<session>/session.rounds.jsonl`, one `RoundRecord` per
//! settled round (`docs/agent-analysis-substrate-proposal.md` §3.2, §8 step 2).
//!
//! Deliberately narrower than the proposal's full shape: no `contended` or
//! `workspaceDelta` field, because nothing populates them yet (§8 step 5) —
//! an empty-looking field would be a false claim of completeness (rule D).

use std::collections::HashMap;

use genehub_proto::{RoundBatchSummary, RoundTrunkSummary, TimelineItem, TurnOutcome};
use serde::{Deserialize, Serialize};

use super::overview;

/// Bumped whenever `RoundRecord`'s on-disk shape changes in a way an old
/// reader could misread rather than merely ignore. A reader that meets a
/// version it does not know must fall back to a read-only, ledger-less view
/// of the session rather than guess at the new fields' meaning.
pub const SCHEMA_VERSION: u32 = 2;

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

/// One settled round: the durable, referenceable unit of "what happened for
/// one user request" (G8). Never rewritten once appended — a round that gets
/// superseded or fails still keeps its record, `outcome` just says which.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundRecord {
    pub schema_version: u32,
    pub round_id: String,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub outcome: RoundOutcome,
    /// Upstream adapter turn ids folded into this round, in order.
    pub adapter_turn_ids: Vec<String>,
    /// Ids of items already on `session.jsonl` that belong to this round —
    /// referenced, not duplicated, so recording a round never means
    /// rewriting an existing item line (§3.2 direction two).
    pub item_ids: Vec<String>,
    /// Time this round spent waiting on a human, across every pause. Not
    /// counted as the agent's own working time.
    pub blocked_ms: i64,
    /// `true` for a record backfilled from a session that predates the round
    /// ledger, where one adapter turn is treated as one round because the
    /// real stitching (approvals, guidance, `continuesRound`) was never
    /// recorded. A round settled live by the daemon always reports `false`.
    #[serde(default)]
    pub synthesized: bool,
    /// This round's tool-call-and-thinking stream, paginated into trunks
    /// (`docs/agent-analysis-substrate-proposal.md` §3.2 direction three, §8
    /// step 3) — a round can run long enough that "every item gets an
    /// overview" alone re-blows the byte budget the ledger itself exists to
    /// avoid. Empty for records predating this field (old on-disk lines and
    /// `migrate_legacy` output): there is nothing honest to backfill it
    /// with, since which items shared a trunk was never recorded before.
    #[serde(default)]
    pub trunk_summaries: Vec<TrunkSummary>,
}

pub type TrunkSummary = RoundTrunkSummary;
pub type BatchSummary = RoundBatchSummary;

/// A semantic batch never exposes more than sixteen blobs at once.
pub const BATCH_MAX_BLOBS: u32 = 16;
/// A visible trunk contains at most four full batches.
pub const TRUNK_MAX_BLOBS: u32 = 64;

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
        if matches!(item, TrunkItem::Monologue) && self.current_batch.blob_count > 0 {
            self.close_batch();
            if self.blob_count >= TRUNK_MAX_BLOBS {
                closed_trunk = self.close_finished();
            }
        }

        if self.first_item_id.is_none() {
            self.first_item_id = Some(item_id.to_string());
        }
        if self.current_batch.item_ids.is_empty() {
            self.current_batch.item_ids.push(item_id.to_string());
        } else if !self.current_batch.item_ids.iter().any(|id| id == item_id) {
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

/// Best-effort round ledger for a session written before the round ledger
/// existed. Run once per session, the first time it is opened after this
/// upgrade (`SessionManager::live`, guarded by the ledger file's presence —
/// see `Store::ensure_rounds_migrated`).
///
/// One adapter turn becomes one round — the only grouping this data still
/// supports, since which turns were auto-stitched or client-continued was
/// never recorded before `ActiveRound` (§8 step 1). A trailing run of items
/// with no `TurnSummary` — a turn that never reached a terminal event before
/// this session predated that fallback — is left out rather than guessed at;
/// it is still visible in the ordinary timeline view, just not round-addressable.
pub fn migrate_legacy(items: &[TimelineItem]) -> Vec<RoundRecord> {
    let mut records = Vec::new();
    let mut segment: Vec<TimelineItem> = Vec::new();
    for item in items {
        segment.push(item.clone());
        if let TimelineItem::TurnSummary { stats, .. } = item {
            let outcome = match stats.outcome {
                TurnOutcome::Completed => RoundOutcome::Completed,
                TurnOutcome::Failed => RoundOutcome::Failed,
                TurnOutcome::Canceled => RoundOutcome::Canceled,
            };
            let trunk_summaries = summarize_trunks(&segment);
            let item_ids = segment.iter().map(|item| item.id().to_string()).collect();
            records.push(RoundRecord {
                schema_version: SCHEMA_VERSION,
                round_id: format!("legacy_r_{}", stats.turn_id),
                started_at_ms: stats.started_at_ms,
                ended_at_ms: stats.finished_at_ms,
                outcome,
                adapter_turn_ids: vec![stats.turn_id.clone()],
                item_ids,
                blocked_ms: 0,
                synthesized: true,
                trunk_summaries,
            });
            segment.clear();
        }
    }
    records
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{TurnStats, Usage};

    fn turn_summary(turn_id: &str, outcome: TurnOutcome) -> TimelineItem {
        TimelineItem::TurnSummary {
            id: format!("turn-summary-{turn_id}"),
            stats: TurnStats {
                turn_id: turn_id.to_string(),
                outcome,
                started_at_ms: 1,
                finished_at_ms: 2,
                duration_ms: 1,
                usage: Usage::default(),
                tool_calls: 0,
                fork_checkpoint: None,
            },
        }
    }

    fn user_message(id: &str) -> TimelineItem {
        TimelineItem::UserMessage {
            id: id.into(),
            text: "hi".into(),
            attachments: vec![],
        }
    }

    #[test]
    fn one_adapter_turn_becomes_one_synthesized_round() {
        let items = vec![
            user_message("u1"),
            TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "hello".into(),
            },
            turn_summary("t1", TurnOutcome::Completed),
        ];
        let records = migrate_legacy(&items);
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert!(record.synthesized);
        assert_eq!(record.round_id, "legacy_r_t1");
        assert_eq!(record.outcome, RoundOutcome::Completed);
        assert_eq!(record.adapter_turn_ids, vec!["t1".to_string()]);
        assert_eq!(
            record.item_ids,
            vec![
                "u1".to_string(),
                "a1".to_string(),
                "turn-summary-t1".to_string()
            ]
        );
    }

    #[test]
    fn multiple_turns_become_multiple_rounds_split_at_each_turn_summary() {
        let items = vec![
            user_message("u1"),
            turn_summary("t1", TurnOutcome::Completed),
            user_message("u2"),
            turn_summary("t2", TurnOutcome::Failed),
        ];
        let records = migrate_legacy(&items);
        assert_eq!(records.len(), 2);
        assert_eq!(
            records[0].item_ids,
            vec!["u1".to_string(), "turn-summary-t1".to_string()]
        );
        assert_eq!(records[1].outcome, RoundOutcome::Failed);
        assert_eq!(
            records[1].item_ids,
            vec!["u2".to_string(), "turn-summary-t2".to_string()]
        );
    }

    #[test]
    fn a_trailing_turn_with_no_summary_is_left_out_of_the_ledger() {
        let items = vec![
            user_message("u1"),
            turn_summary("t1", TurnOutcome::Completed),
            user_message("u2"),
        ];
        let records = migrate_legacy(&items);
        assert_eq!(
            records.len(),
            1,
            "the dangling tail after the last summary has no outcome to report"
        );
    }

    #[test]
    fn no_turn_summaries_at_all_produces_an_empty_but_valid_ledger() {
        assert!(migrate_legacy(&[user_message("u1")]).is_empty());
    }

    #[test]
    fn an_empty_session_produces_an_empty_ledger() {
        assert!(migrate_legacy(&[]).is_empty());
    }

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
    fn a_trunk_closes_at_sixty_four_blobs() {
        let mut builder = TrunkBuilder::default();
        let mut closed = None;
        for index in 0..TRUNK_MAX_BLOBS {
            closed = builder.push(&format!("t{index}"), TrunkItem::ToolCall("grep"));
        }
        let summary = closed
            .expect("the 64th blob closes the trunk")
            .into_summary(0, &HashMap::new());
        assert_eq!(summary.blob_count, 64);
        assert_eq!(summary.batches.len(), 4);
        assert!(summary.batches.iter().all(|batch| batch.blob_count == 16));
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
