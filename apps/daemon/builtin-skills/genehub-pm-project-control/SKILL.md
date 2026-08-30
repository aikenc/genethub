---
name: genehub-pm-project-control
description: Align a GeneHub PM project with the user's real outcome and maintain its intent, acceptance criteria, dependency graph, milestones, scope changes, pauses, and recoverable state. Use in a PM session when starting or resuming a project, decomposing work, answering project-status questions, handling new guidance, or deciding what may run next.
---

# Control a PM project

Stay on the user's side. Manage outcomes and evidence; do not replace a failed WorkAgent by writing business code yourself.

## Reconstruct before acting

1. Read the latest user message and the durable project state with `"$GENEHUB_CLI" pm project show`.
2. Inspect referenced WorkSessions and Git facts. A WorkAgent's claim is not a project fact until its artifact, commit, test, or review evidence exists.
3. State the current outcome, constraints, unresolved decisions, acceptance criteria, and active work packages in your own reasoning.
4. If durable state and disk disagree, pause affected packages and reconcile the discrepancy before dispatching more work.

If the retained project is `completed` and the user explicitly asks for a new feature, migration, or other new delivery, reopen it with `lifecycle --to active`, record a new Intent revision, and extend the existing graph. `completed` is a delivery boundary; `cancelled` remains terminal.

For a new project, read [references/project-lifecycle.md](references/project-lifecycle.md) and follow the fail-closed initialization stages. Never initialize a non-empty unfamiliar directory.

Project phase and lifecycle are separate shared fields for every PM Session
attached to the Folder. One initialization Session advances the phase through
`ProjectPhase.active` after the topology is registered. Do that with
`pm project advance --to active`; `pm project lifecycle --to active` changes
only `ProjectLifecycle` and cannot finish project initialization. A requirement
Session joining a project whose phase is already `active` must not repeat
`pm project init`, phase advancement, or lifecycle transitions merely to start
its own Workflow Run; it records only its own Intent, graph, and WorkPackages.

Use only the authenticated control commands below; never edit daemon PM state files:

```text
"$GENEHUB_CLI" pm project init
"$GENEHUB_CLI" pm project show
"$GENEHUB_CLI" pm project intent set --outcome <outcome> \
  --acceptance <observable-check> [--acceptance <check>...] \
  [--constraint <constraint>...] [--out-of-scope <item>...] [--affects <package-id>...]
"$GENEHUB_CLI" pm project package put --id <id> --title <title> --outcome <outcome> \
  --space-tag <capability> --repository <repository-name> --branch <branch> --node <node-id> \
  [--depends-on <package-id>...]
"$GENEHUB_CLI" pm project package transition --id <id> --to <status> [...evidence]
"$GENEHUB_CLI" pm project advance --to <next-phase>
"$GENEHUB_CLI" pm project lifecycle --to active|waiting-user|completed|cancelled
```

Every command derives project root and controller from this PM session. Treat a refusal as a failed transition, inspect `pm project show`, and correct the evidence rather than writing around the gate.

## Maintain intent and the task graph

- Translate the request into observable acceptance criteria, not implementation wishes.
- Keep work packages outcome-sized: one owner, inputs, output, dependencies, writable branch/worktree, completion gate, and risk.
- Treat the selected Workflow Run's `budget` as a hard execution envelope.
  `remainingMs`, `maxWorkSessions`, and `maxConcurrentWorkSessions` are
  Coordinator facts. Select the graph promptly, keep one bounded result per
  WorkSession, and never attempt to extend the deadline or dispatch after
  `budgetExhausting`/`budgetExhausted`. Budget exhaustion is a failed-closed
  outcome, never delivery.
  A WorkSession dispatch reservation consumes one total slot permanently;
  provider/session creation failure, package rebinding, and retry do not refund
  it. Use the persisted counter instead of estimating from visible sessions.
- Before fixing a fanout cohort, read the selected Run's `resourceCapacities`.
  `availableSlots` is current base-capability capacity after cross-Session
  exclusions; it may be lower than `maxItems`, and package-specific tags may
  reduce it further. Add verified Spaces first or reduce the cohort instead of
  probing capacity with failed package writes.
- Ask for semantic Space capabilities with repeatable `--space-tag`; never select
  a concrete Agent Space name. The Coordinator combines these tags with the
  active Workflow node selector and deterministically assigns a compatible
  idle Space. `package put` atomically binds that Space and returns both
  `agentSpace` and the derived `worktree` path. Create the named branch/worktree
  at that exact returned path, then transition the package to `ready`; the Ready
  gate verifies the repository, branch, and worktree binding. Never pass the
  removed `--space` or `--worktree` flags and never infer allocation from an
  error message.
- Size each package so one WorkSession can autonomously reach a candidate in a
  small number of runtime turns. Do not convert its internal file order,
  checkpoint commits, or individual gate commands into PM graph nodes.
- Represent real ordering as dependencies. Run independent packages concurrently only when their writable worktrees do not overlap.
- Keep integration and independent review separate from implementation.
- Record every accepted scope or acceptance change through the PM project CLI before continuing affected WorkAgents.

Once dispatched, manage a package by terminal facts rather than narration.
Checkpoint commits are recoverability evidence, not a reason to wake the PM or
rewrite the plan. Re-enter only for a candidate, a concrete block, a terminal
failure, two capped continuations without progress, or a user/contract change.
When several WorkSessions settle together, process the entire supervisor batch
before ending the PM turn.

Do not force a fixed team topology. The graph determines which Agent Spaces are needed; project type Skills may suggest recipes but never override current evidence.

## Handle user guidance at any time

Treat a user message as an event even while WorkAgents run:

1. Answer direct questions immediately from verified state.
2. Classify the change as clarification, reprioritization, acceptance change, pause, cancellation, or new scope.
3. Identify affected packages, candidates, reviews, Skills, and milestones.
4. Pause or invalidate only the affected lineage; keep unrelated work running.
5. Update durable intent/graph state, then continue existing WorkSessions where safe or create replacements with explicit lineage.

When a decision truly needs the user, record `waiting-user` and ask one concrete question. Do not spend periodic model turns re-asking it.

## Close a milestone

Require the quality gates from `genehub-pm-quality-governance`. Report what is usable, the exact candidate and evidence, known limitations, and what remains. Mark a package or project complete only after its acceptance criteria and independent review are bound to the same candidate.
