//! The round ledger: `<session>/session.rounds.jsonl`, one `RoundRecord` per
//! settled round (`docs/agent-analysis-substrate-proposal.md` §3.2, §8 step 2).
//!
//! Deliberately narrower than the proposal's full shape: no `contended` or
//! `workspaceDelta` field, because nothing populates them yet (§8 step 5) —
//! an empty-looking field would be a false claim of completeness (rule D).

use serde::{Deserialize, Serialize};

use genehub_proto::{TimelineItem, TurnOutcome};

/// Bumped whenever `RoundRecord`'s on-disk shape changes in a way an old
/// reader could misread rather than merely ignore. A reader that meets a
/// version it does not know must fall back to a read-only, ledger-less view
/// of the session rather than guess at the new fields' meaning.
pub const SCHEMA_VERSION: u32 = 1;

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
    let mut segment: Vec<String> = Vec::new();
    for item in items {
        segment.push(item.id().to_string());
        if let TimelineItem::TurnSummary { stats, .. } = item {
            let outcome = match stats.outcome {
                TurnOutcome::Completed => RoundOutcome::Completed,
                TurnOutcome::Failed => RoundOutcome::Failed,
                TurnOutcome::Canceled => RoundOutcome::Canceled,
            };
            records.push(RoundRecord {
                schema_version: SCHEMA_VERSION,
                round_id: format!("legacy_r_{}", stats.turn_id),
                started_at_ms: stats.started_at_ms,
                ended_at_ms: stats.finished_at_ms,
                outcome,
                adapter_turn_ids: vec![stats.turn_id.clone()],
                item_ids: std::mem::take(&mut segment),
                blocked_ms: 0,
                synthesized: true,
            });
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
}
