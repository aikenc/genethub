//! Portable round ledger and bounded trunk construction.

use std::collections::HashMap;

use genehub_proto::{
    BlobKind, BlobOverview, RoundBatch, RoundBatchSummary, RoundLayerOutcome, RoundSummary,
    RoundTrunk, RoundTrunkSummary, TimelineItem, ToolCallDetail,
};
use serde::{Deserialize, Serialize};

use super::overview;

pub const SCHEMA_VERSION: u32 = 4;
/// Once a batch has accumulated this many tool calls, the next reasoning block
/// starts a fresh semantic batch. This keeps the mainline grouping behavior;
/// reasoning is not merely another fixed-size blob boundary.
pub const BATCH_REASONING_TOOL_THRESHOLD: u32 = 16;
/// Tool-only work still needs a bounded batch when an Agent emits no
/// narration or reasoning boundary.
pub const BATCH_MAX_TOOL_CALLS: u32 = 64;
/// Safety bound for reasoning and tool blobs combined.
pub const BATCH_MAX_BLOBS: u32 = 128;
pub const TRUNK_TOOL_CALL_THRESHOLD: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoundOutcome {
    Completed,
    Failed,
    Canceled,
    Superseded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundRecord {
    pub schema_version: u32,
    pub round_id: String,
    pub ord: u32,
    #[serde(default)]
    pub user_item_id: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    #[serde(default)]
    pub outcome: Option<RoundOutcome>,
    #[serde(default)]
    pub adapter_turn_ids: Vec<String>,
    #[serde(default)]
    pub blocked_ms: i64,
    #[serde(default)]
    pub synthesized: bool,
    #[serde(default)]
    pub trunk_count: u32,
}

impl RoundRecord {
    pub fn summary(&self, running: bool) -> RoundSummary {
        RoundSummary {
            round_id: self.round_id.clone(),
            user_item_id: self.user_item_id.clone(),
            started_at_ms: self.started_at_ms,
            ended_at_ms: self.ended_at_ms,
            outcome: match self.outcome {
                Some(RoundOutcome::Completed) => RoundLayerOutcome::Completed,
                Some(RoundOutcome::Failed) => RoundLayerOutcome::Failed,
                Some(RoundOutcome::Canceled) => RoundLayerOutcome::Canceled,
                Some(RoundOutcome::Superseded) => RoundLayerOutcome::Superseded,
                None if running => RoundLayerOutcome::Running,
                // An unfinished record read after restart means execution was
                // interrupted by the old daemon rather than still running.
                None => RoundLayerOutcome::Failed,
            },
            trunk_count: self.trunk_count,
        }
    }
}

enum TrunkItem {
    Monologue,
    Reasoning,
    ToolCall,
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
struct ClosedBatch {
    first_item_id: String,
    blob_count: u32,
    monologue_item_id: Option<String>,
    first_reasoning_item_id: Option<String>,
    tool_count: u32,
}

#[derive(Debug, Clone)]
struct ClosedTrunk {
    first_item_id: String,
    blob_count: u32,
    first_monologue_item_id: Option<String>,
    batches: Vec<ClosedBatch>,
}

impl ClosedTrunk {
    fn into_summary(self, index: u32, texts: &HashMap<String, String>) -> RoundTrunkSummary {
        let batches = self
            .batches
            .into_iter()
            .enumerate()
            .map(|(index, batch)| {
                let text = batch
                    .monologue_item_id
                    .as_ref()
                    .and_then(|id| texts.get(id))
                    .map(|value| shorten(value, 100))
                    .filter(|value| !value.is_empty())
                    .or_else(|| {
                        batch
                            .first_reasoning_item_id
                            .as_ref()
                            .and_then(|id| texts.get(id))
                            .map(|value| shorten(value, 100))
                            .filter(|value| !value.is_empty())
                    })
                    .unwrap_or_else(|| format!("调用了 {} 次工具", batch.tool_count));
                RoundBatchSummary {
                    index: index as u32,
                    first_item_id: batch.first_item_id,
                    blob_count: batch.blob_count,
                    text,
                }
            })
            .collect::<Vec<_>>();
        let title = self
            .first_monologue_item_id
            .as_ref()
            .and_then(|id| texts.get(id))
            .map(|value| first_sentence(value))
            .filter(|value| !value.is_empty())
            .or_else(|| batches.first().map(|value| clip(&value.text, 32)))
            .unwrap_or_else(|| "工作过程".to_string());
        RoundTrunkSummary {
            index,
            first_item_id: self.first_item_id,
            blob_count: self.blob_count,
            title,
            batches,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct TrunkBuilder {
    current_batch: BatchBuilder,
    closed_batches: Vec<ClosedBatch>,
    blob_count: u32,
    tool_count: u32,
    first_item_id: Option<String>,
    first_monologue_item_id: Option<String>,
}

impl TrunkBuilder {
    fn push(&mut self, item_id: &str, item: TrunkItem) -> Option<ClosedTrunk> {
        let mut closed = None;
        let starts_semantic_batch = match item {
            TrunkItem::Monologue => !self.current_batch.item_ids.is_empty(),
            TrunkItem::Reasoning => self.current_batch.tool_count >= BATCH_REASONING_TOOL_THRESHOLD,
            TrunkItem::ToolCall => false,
        };
        if starts_semantic_batch {
            self.close_batch();
        }
        if self.current_batch.item_ids.is_empty() && self.tool_count > TRUNK_TOOL_CALL_THRESHOLD {
            closed = self.close_finished();
        }
        if self.first_item_id.is_none() {
            self.first_item_id = Some(item_id.to_string());
        }
        if !self.current_batch.item_ids.iter().any(|id| id == item_id) {
            self.current_batch.item_ids.push(item_id.to_string());
        }
        match item {
            TrunkItem::Monologue => {
                self.current_batch
                    .monologue_item_id
                    .get_or_insert_with(|| item_id.to_string());
                self.first_monologue_item_id
                    .get_or_insert_with(|| item_id.to_string());
            }
            TrunkItem::Reasoning => {
                self.current_batch.blob_count += 1;
                self.blob_count += 1;
                self.current_batch
                    .first_reasoning_item_id
                    .get_or_insert_with(|| item_id.to_string());
            }
            TrunkItem::ToolCall => {
                self.current_batch.blob_count += 1;
                self.current_batch.tool_count += 1;
                self.blob_count += 1;
                self.tool_count += 1;
            }
        }
        if self.current_batch.tool_count >= BATCH_MAX_TOOL_CALLS
            || self.current_batch.blob_count >= BATCH_MAX_BLOBS
        {
            self.close_batch();
        }
        closed
    }

    fn close(&mut self) -> Option<ClosedTrunk> {
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
        self.tool_count = 0;
        Some(ClosedTrunk {
            first_item_id: self.first_item_id.take().unwrap_or_default(),
            blob_count: std::mem::take(&mut self.blob_count),
            first_monologue_item_id: self.first_monologue_item_id.take(),
            batches: std::mem::take(&mut self.closed_batches),
        })
    }
}

pub fn trunks_from_items(items: &[TimelineItem], first_index: u32) -> Vec<RoundTrunk> {
    let texts = items
        .iter()
        .filter_map(|item| match item {
            TimelineItem::AssistantMessage { id, text } | TimelineItem::Reasoning { id, text } => {
                Some((id.clone(), text.clone()))
            }
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    let mut builder = TrunkBuilder::default();
    let mut closed = Vec::new();
    for item in items {
        let kind = match item {
            TimelineItem::AssistantMessage { .. } => TrunkItem::Monologue,
            TimelineItem::Reasoning { .. } => TrunkItem::Reasoning,
            TimelineItem::ToolCall { .. } => TrunkItem::ToolCall,
            _ => continue,
        };
        if let Some(trunk) = builder.push(item.id(), kind) {
            closed.push(trunk);
        }
    }
    if let Some(trunk) = builder.close() {
        closed.push(trunk);
    }
    let summaries = closed
        .into_iter()
        .enumerate()
        .map(|(index, trunk)| trunk.into_summary(first_index + index as u32, &texts))
        .collect::<Vec<_>>();
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
            batches.push(RoundBatch {
                summary: batch.clone(),
                monologue,
                blobs: slice.iter().filter_map(blob_overview).collect(),
            });
        }
        trunks.push(RoundTrunk {
            summary: summary.clone(),
            batches,
        });
    }
    trunks
}

fn blob_overview(item: &TimelineItem) -> Option<BlobOverview> {
    let condensed = overview::condense_item(item);
    let (kind, overview) = match &condensed {
        TimelineItem::Reasoning { text, .. } => (BlobKind::Reasoning, shorten(text, 240)),
        TimelineItem::ToolCall { name, detail, .. } => (
            BlobKind::ToolCall,
            match detail {
                ToolCallDetail::Overview { overview, .. } => shorten(overview, 240),
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
    clip(text[..end].trim(), 100)
}

fn shorten(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    clip(&text, max)
}

fn clip(text: &str, max: usize) -> String {
    let mut output = text.chars().take(max).collect::<String>();
    if text.chars().count() > max {
        output.push('…');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_only_items_follow_the_mainline_batch_and_trunk_thresholds() {
        let items = (0..113)
            .map(|index| TimelineItem::ToolCall {
                id: format!("t{index}"),
                name: "grep".to_string(),
                status: genehub_proto::ToolStatus::Ok,
                detail: ToolCallDetail::Unknown {
                    raw: serde_json::Value::Null,
                },
            })
            .collect::<Vec<_>>();
        let trunks = trunks_from_items(&items, 0);
        assert_eq!(trunks.len(), 1);
        assert_eq!(trunks[0].summary.blob_count, 113);
        assert_eq!(trunks[0].batches.len(), 2);
        assert_eq!(trunks[0].batches[0].summary.blob_count, 64);
        assert_eq!(trunks[0].batches[1].summary.blob_count, 49);
    }

    #[test]
    fn short_acknowledgement_is_not_the_whole_title() {
        assert_eq!(
            first_sentence("收到。我现在继续检查流式更新期间的页面稳定性。后续内容"),
            "收到。我现在继续检查流式更新期间的页面稳定性。"
        );
        assert_eq!(first_sentence("收到。"), "收到。");
    }

    #[test]
    fn running_and_recovered_rounds_are_distinguished() {
        let record = RoundRecord {
            schema_version: SCHEMA_VERSION,
            round_id: "r1".into(),
            ord: 0,
            user_item_id: None,
            started_at_ms: 1,
            ended_at_ms: 0,
            outcome: None,
            adapter_turn_ids: vec![],
            blocked_ms: 0,
            synthesized: false,
            trunk_count: 0,
        };
        assert_eq!(record.summary(true).outcome, RoundLayerOutcome::Running);
        assert_eq!(record.summary(false).outcome, RoundLayerOutcome::Failed);
    }
}

#[cfg(test)]
mod mainline_contract_tests {
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
        builder.push("t1", TrunkItem::ToolCall);
        builder.push("t2", TrunkItem::ToolCall);
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
        builder.push("t1", TrunkItem::ToolCall);
        builder.push("t2", TrunkItem::ToolCall);
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
            builder.push(&format!("t{index}"), TrunkItem::ToolCall);
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
            builder.push(&format!("t{index}"), TrunkItem::ToolCall);
        }
        builder.push("r1", TrunkItem::Reasoning);
        builder.push("t16", TrunkItem::ToolCall);
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
            builder.push(&format!("t{index}"), TrunkItem::ToolCall);
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
            closed = builder.push(&format!("t{index}"), TrunkItem::ToolCall);
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
        builder.push("t1", TrunkItem::ToolCall);
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
    fn closing_an_empty_builder_produces_nothing() {
        assert!(TrunkBuilder::default().close().is_none());
    }
}
