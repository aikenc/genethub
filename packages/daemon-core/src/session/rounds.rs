//! Portable round ledger and bounded trunk construction.

use std::collections::HashMap;

use genehub_proto::{
    BlobKind, BlobOverview, RoundBatch, RoundBatchSummary, RoundLayerOutcome, RoundSummary,
    RoundTrunk, RoundTrunkSummary, TimelineItem, ToolCallDetail,
};
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 4;
pub const BATCH_MAX_BLOBS: u32 = 16;
pub const TRUNK_MAX_BLOBS: u32 = 100;

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

#[derive(Default)]
struct BatchBuilder {
    item_ids: Vec<String>,
    blob_count: u32,
    monologue_item_id: Option<String>,
    first_reasoning_item_id: Option<String>,
    tool_count: u32,
}

struct ClosedBatch {
    first_item_id: String,
    blob_count: u32,
    monologue_item_id: Option<String>,
    first_reasoning_item_id: Option<String>,
    tool_count: u32,
}

struct ClosedTrunk {
    first_item_id: String,
    blob_count: u32,
    first_monologue_item_id: Option<String>,
    batches: Vec<ClosedBatch>,
}

impl ClosedTrunk {
    fn summary(self, index: u32, texts: &HashMap<String, String>) -> RoundTrunkSummary {
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

#[derive(Default)]
struct TrunkBuilder {
    current_batch: BatchBuilder,
    closed_batches: Vec<ClosedBatch>,
    blob_count: u32,
    first_item_id: Option<String>,
    first_monologue_item_id: Option<String>,
}

impl TrunkBuilder {
    fn push(&mut self, item_id: &str, item: TrunkItem) -> Option<ClosedTrunk> {
        let mut closed = None;
        if matches!(item, TrunkItem::Monologue)
            && self.current_batch.monologue_item_id.is_some()
            && self.current_batch.blob_count > 0
        {
            self.close_batch();
            if self.blob_count >= TRUNK_MAX_BLOBS {
                closed = self.close_finished();
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
            }
        }
        if self.current_batch.blob_count >= BATCH_MAX_BLOBS {
            self.close_batch();
        }
        if self.blob_count >= TRUNK_MAX_BLOBS {
            self.close_batch();
            return self.close_finished().or(closed);
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
        .map(|(index, trunk)| trunk.summary(first_index + index as u32, &texts))
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
    let (kind, overview) = match item {
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
    let end = text
        .char_indices()
        .find_map(|(index, character)| {
            matches!(character, '。' | '！' | '？' | '.' | '!' | '?' | '\n')
                .then_some(index + character.len_utf8())
        })
        .unwrap_or(text.len());
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
    fn trunks_and_batches_remain_bounded() {
        let items = (0..205)
            .map(|index| TimelineItem::Reasoning {
                id: format!("r{index}"),
                text: format!("reason {index}"),
            })
            .collect::<Vec<_>>();
        let trunks = trunks_from_items(&items, 7);
        assert_eq!(trunks.len(), 3);
        assert_eq!(trunks[0].summary.index, 7);
        assert!(trunks.iter().all(|trunk| trunk.summary.blob_count <= 100));
        assert!(trunks
            .iter()
            .flat_map(|trunk| &trunk.batches)
            .all(|batch| batch.summary.blob_count <= 16));
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
