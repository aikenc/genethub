//! The round ledger: `<session>/session.rounds.jsonl`, one `RoundRecord` per
//! settled round (`docs/agent-analysis-substrate-proposal.md` §3.2, §8 step 2).
//!
//! Deliberately narrower than the proposal's full shape: no `contended` or
//! `workspaceDelta` field, because nothing populates them yet (§8 step 5) —
//! an empty-looking field would be a false claim of completeness (rule D).

use serde::{Deserialize, Serialize};

use genehub_proto::{TimelineItem, TurnOutcome};

use super::overview;

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

/// One trunk: a bounded slice of a round's tool-call-and-thinking stream,
/// closed either at a monologue boundary or at [`TRUNK_MAX_ITEMS`] — see
/// `SessionManager`'s `record_trunk_item`/`close_current_trunk` for the
/// state machine that produces these. Small and paginable by design: a round
/// with thousands of items still produces one small record per trunk, not
/// one record whose size scales with the round.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrunkSummary {
    /// Position of this trunk within the round, starting at 0.
    pub index: u32,
    /// Id of this trunk's first item — enough to locate it in the round's
    /// `item_ids` without duplicating them here.
    pub first_item_id: String,
    /// How many `ToolCall`/`Reasoning` items this trunk holds. A leading
    /// monologue is not counted, since it is what `overview` already shows.
    pub item_count: u32,
    /// The trunk's headline: its first monologue's text if it opened with
    /// one, else a deterministic summary synthesized from the tool calls it
    /// contains — never blank, never a guess dressed up as agent prose
    /// (rule D).
    pub overview: String,
}

/// Trunks close at a monologue boundary or here, whichever comes first — a
/// hard cap so an agent that never narrates still produces bounded trunks
/// (§3.2 direction three).
pub const TRUNK_MAX_ITEMS: u32 = 32;

/// The three item kinds that participate in trunk boundaries. Every other
/// `TimelineItem` variant (user messages, permission requests, plans, turn
/// summaries, …) is invisible to `TrunkBuilder` — trunks paginate the
/// tool-call-and-thinking stream, not the round's other item types.
pub enum TrunkItem<'a> {
    /// An `AssistantMessage`. Closes the trunk being built if it already
    /// holds at least one tool call or reasoning block; otherwise merges
    /// into it, so a run of consecutive monologues does not spray a string
    /// of empty trunks. Carries no text: a streamed `AssistantMessage`
    /// typically still holds an empty string the moment its `Item` event
    /// first arrives (deltas fill it in afterward), so `TrunkBuilder` only
    /// remembers *which* item opened the trunk — resolving its text is
    /// `Live::resolve_monologue_text`'s job, done once the boundary is
    /// known, against the item's current (by-then-final) state.
    Monologue,
    /// A `Reasoning` block. Counts toward the 32-item cap.
    Reasoning,
    /// A `ToolCall`, carrying its tool name for the synthesized fallback
    /// overview. Counts toward the 32-item cap.
    ToolCall(&'a str),
}

/// A trunk that just closed its boundary bookkeeping, with everything
/// needed to build a [`TrunkSummary`] except the resolved overview text and
/// its index. Deliberately stops short of resolving the overview itself:
/// that needs a live look at the monologue item's *current* text, which
/// only the caller holding the session's item store can provide (see
/// `into_summary`).
#[derive(Debug, Clone)]
pub struct ClosedTrunk {
    pub first_item_id: String,
    pub item_count: u32,
    /// Id of the trunk's opening monologue, if it had one — look this item
    /// up for its current text to get the overview.
    pub monologue_item_id: Option<String>,
    /// Tool names seen, first-seen order, deduplicated — used only for the
    /// synthesized fallback overview when this trunk had no monologue.
    pub tool_names: Vec<String>,
}

impl ClosedTrunk {
    /// Produces the persisted summary. `monologue_text` is the opening
    /// monologue's current text (`None` if this trunk had none, or if it
    /// could not be found — treated the same as "no monologue" rather than
    /// panicking, since a missing item is a should-not-happen, not an
    /// invariant worth crashing over). An empty string is also treated as
    /// absent: a monologue that somehow never got any text is no better
    /// than not having one.
    pub fn into_summary(self, index: u32, monologue_text: Option<&str>) -> TrunkSummary {
        let overview = monologue_text
            .map(|text| overview::shorten(text, overview::SUMMARY_CHARS))
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| synthesized_overview(&self.tool_names, self.item_count));
        TrunkSummary {
            index,
            first_item_id: self.first_item_id,
            item_count: self.item_count,
            overview,
        }
    }
}

/// Accumulates one round's still-open trunk, one item at a time, in round
/// order. Pure and daemon-state-free by design: `SessionManager` owns *when*
/// each item arrives and *whether* a round is even open, and resolves the
/// monologue's text once a boundary is known; this only owns the boundary
/// arithmetic, so the boundary rules can be unit-tested without any of the
/// `Live`/`Mutex` machinery around them.
#[derive(Debug, Clone, Default)]
pub struct TrunkBuilder {
    item_ids: Vec<String>,
    work_count: u32,
    monologue_item_id: Option<String>,
    tool_names: Vec<String>,
}

impl TrunkBuilder {
    /// Feeds one item into the trunk. Returns the just-closed trunk when
    /// this item crossed a boundary — either because it is a monologue
    /// arriving after at least one tool call/reasoning block, or because it
    /// is the item that pushed the tool-call/reasoning count to
    /// [`TRUNK_MAX_ITEMS`]. Both cannot happen from the same call: a
    /// monologue never counts toward the cap, so an item cannot be both the
    /// thing that opens a new trunk and the thing that caps it.
    pub fn push(&mut self, item_id: &str, item: TrunkItem<'_>) -> Option<ClosedTrunk> {
        let opens_new_trunk = matches!(item, TrunkItem::Monologue) && self.work_count > 0;
        let closed_by_boundary = if opens_new_trunk { self.close() } else { None };

        match item {
            TrunkItem::Monologue => {
                if self.monologue_item_id.is_none() {
                    self.monologue_item_id = Some(item_id.to_string());
                }
            }
            TrunkItem::ToolCall(name) => {
                self.work_count += 1;
                if !self.tool_names.iter().any(|seen| seen == name) {
                    self.tool_names.push(name.to_string());
                }
            }
            TrunkItem::Reasoning => {
                self.work_count += 1;
            }
        }
        self.item_ids.push(item_id.to_string());

        if closed_by_boundary.is_some() {
            return closed_by_boundary;
        }
        if self.work_count >= TRUNK_MAX_ITEMS {
            return self.close();
        }
        None
    }

    /// Closes the trunk being built, if it holds anything, and resets the
    /// builder for the next one. Called both mid-round (a boundary crossed)
    /// and when the round itself settles — a round ending mid-trunk must
    /// not silently drop what it had accumulated since the last boundary.
    pub fn close(&mut self) -> Option<ClosedTrunk> {
        if self.item_ids.is_empty() {
            return None;
        }
        let item_ids = std::mem::take(&mut self.item_ids);
        let work_count = std::mem::take(&mut self.work_count);
        let monologue_item_id = self.monologue_item_id.take();
        let tool_names = std::mem::take(&mut self.tool_names);
        Some(ClosedTrunk {
            first_item_id: item_ids[0].clone(),
            item_count: work_count,
            monologue_item_id,
            tool_names,
        })
    }
}

/// The overview a trunk gets when it closes with no monologue at all —
/// deterministic and derived only from what actually ran, never a guess
/// dressed up as agent prose (rule D).
fn synthesized_overview(tool_names: &[String], work_count: u32) -> String {
    if tool_names.is_empty() {
        format!("记录了 {work_count} 次思考")
    } else {
        format!(
            "运行了 {work_count} 次工具（{}）",
            overview::clip(&tool_names.join(", "), overview::SUMMARY_CHARS)
        )
    }
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
                // Which items shared a trunk was never recorded before this
                // field existed — an empty list is the honest answer, not a
                // guessed-at reconstruction (rule D).
                trunk_summaries: Vec::new(),
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

    #[test]
    fn a_monologue_followed_by_work_stays_open_until_the_next_monologue() {
        let mut trunk = TrunkBuilder::default();
        assert!(trunk.push("a1", TrunkItem::Monologue).is_none());
        assert!(trunk.push("t1", TrunkItem::ToolCall("read_file")).is_none());
        assert!(trunk.push("t2", TrunkItem::ToolCall("read_file")).is_none());
        let closed = trunk
            .push("a2", TrunkItem::Monologue)
            .expect("a monologue after work closes the previous trunk");
        assert_eq!(closed.first_item_id, "a1");
        assert_eq!(
            closed.item_count, 2,
            "the opening monologue itself is not counted"
        );
        assert_eq!(closed.monologue_item_id, Some("a1".to_string()));
        assert_eq!(
            closed.into_summary(0, Some("planning the fix")).overview,
            "planning the fix"
        );
    }

    #[test]
    fn consecutive_monologues_with_no_work_between_them_merge_into_one_trunk() {
        let mut trunk = TrunkBuilder::default();
        assert!(trunk.push("a1", TrunkItem::Monologue).is_none());
        assert!(
            trunk.push("a2", TrunkItem::Monologue).is_none(),
            "no work item happened between the two monologues, so this must not close a trunk"
        );
        let closed = trunk
            .push("t1", TrunkItem::ToolCall("run"))
            .or_else(|| trunk.close())
            .unwrap_or_else(|| panic!("expected a trunk to close"));
        assert_eq!(
            closed.monologue_item_id,
            Some("a1".to_string()),
            "the trunk remembers the first monologue seen, not the most recent one"
        );
    }

    #[test]
    fn a_pure_tool_stream_with_no_monologue_closes_at_the_32_item_cap() {
        let mut trunk = TrunkBuilder::default();
        let mut closed = None;
        for i in 0..TRUNK_MAX_ITEMS {
            let id = format!("t{i}");
            closed = trunk.push(&id, TrunkItem::ToolCall("grep"));
        }
        let closed = closed.expect("the 32nd tool call must close the trunk on its own");
        assert_eq!(closed.item_count, TRUNK_MAX_ITEMS);
        assert_eq!(closed.first_item_id, "t0");
        assert!(closed.monologue_item_id.is_none());
        assert_eq!(
            closed.into_summary(0, None).overview,
            "运行了 32 次工具（grep）",
            "no monologue arrived, so the overview is synthesized from the tool names"
        );
    }

    #[test]
    fn a_pure_reasoning_stream_synthesizes_a_thinking_overview() {
        let mut trunk = TrunkBuilder::default();
        for i in 0..TRUNK_MAX_ITEMS - 1 {
            assert!(trunk.push(&format!("r{i}"), TrunkItem::Reasoning).is_none());
        }
        let closed = trunk
            .push("r31", TrunkItem::Reasoning)
            .expect("the 32nd item closes the trunk");
        assert_eq!(closed.into_summary(0, None).overview, "记录了 32 次思考");
    }

    #[test]
    fn distinct_tool_names_are_deduplicated_in_the_synthesized_overview() {
        let mut trunk = TrunkBuilder::default();
        trunk.push("t1", TrunkItem::ToolCall("grep"));
        trunk.push("t2", TrunkItem::ToolCall("read_file"));
        let closed = trunk
            .push("t3", TrunkItem::ToolCall("grep"))
            .or_else(|| trunk.close());
        assert_eq!(
            closed.unwrap().into_summary(0, None).overview,
            "运行了 3 次工具（grep, read_file）"
        );
    }

    #[test]
    fn closing_an_empty_builder_produces_nothing() {
        assert!(TrunkBuilder::default().close().is_none());
    }

    #[test]
    fn a_lone_monologue_with_no_work_at_all_still_closes_into_a_trunk() {
        let mut trunk = TrunkBuilder::default();
        trunk.push("a1", TrunkItem::Monologue);
        let closed = trunk.close().expect("a monologue alone is still a trunk");
        assert_eq!(closed.item_count, 0);
        assert_eq!(
            closed
                .into_summary(0, Some("just thinking out loud"))
                .overview,
            "just thinking out loud"
        );
    }

    #[test]
    fn a_monologue_resolved_to_an_empty_string_falls_back_to_the_synthesized_overview() {
        // The pathological case `into_summary`'s doc comment calls out: a
        // monologue item id was captured, but by resolution time its text
        // is (still, or again) empty. Rather than ship a blank overview,
        // this must fall back exactly as if there had been no monologue.
        let mut trunk = TrunkBuilder::default();
        trunk.push("a1", TrunkItem::Monologue);
        trunk.push("t1", TrunkItem::ToolCall("grep"));
        let closed = trunk.close().unwrap();
        assert_eq!(
            closed.into_summary(0, Some("")).overview,
            "运行了 1 次工具（grep）"
        );
    }

    #[test]
    fn a_monologue_item_that_cannot_be_found_falls_back_to_the_synthesized_overview() {
        let mut trunk = TrunkBuilder::default();
        trunk.push("a1", TrunkItem::Monologue);
        trunk.push("t1", TrunkItem::ToolCall("grep"));
        let closed = trunk.close().unwrap();
        assert_eq!(
            closed.into_summary(0, None).overview,
            "运行了 1 次工具（grep）",
            "a monologue id with no resolvable text must not produce a blank overview"
        );
    }
}
