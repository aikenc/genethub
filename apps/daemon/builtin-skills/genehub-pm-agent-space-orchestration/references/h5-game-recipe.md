# H5 game topology recipe

Use this only when the current Intent is an H5 light/medium game. Derive the final graph from coupling and risk; do not create every node by default.

## Small-model sizing

- Give one WorkAgent one observable vertical slice, one branch, one worktree, and a short acceptance command set. Avoid a repository-wide “finish the game” prompt.
- Establish a thin playable foundation first when later slices need shared contracts. Accept that candidate before branching dependent worktrees from its exact commit.
- After the foundation, split only genuinely independent slices. A typical 50k-line game can justify concurrent gameplay, presentation, and verification/content slices; a smaller game may need only two.
- Add an integration package that depends on all parallel candidates and owns conflict resolution, full build, browser smoke, asset/license inventory, and the final playable artifact.
- Merge accepted slice candidates into the shared baseline and require its full gate to pass before branching any later content or integration package. When individually green slices break the merged baseline, insert a small seam-fix package with its own candidate and review evidence.
- Always commission final independent review in a different Agent Space. The reviewer must not edit the candidate and must confirm the Git worktree is still clean afterward.

When Intent includes an effective-source-size range, treat it as an aggregate planning constraint, not as permission to add bulk:

- map the range to user-visible systems, reusable content/data, boundary adapters, and risk-driven tests before dispatch;
- put an estimated contribution envelope and concrete behavioral/content outcomes in each slice contract, while keeping acceptance based on useful behavior and evidence rather than a line quota alone;
- recompute the projected repository total as slice candidates arrive. If accepted candidates leave a material gap, extend or rebalance the graph with genuinely independent outcomes before starting integration, and run those packages concurrently when their write sets permit;
- never leave a known multi-thousand-line scale gap for the serial integration package. Integration should merge, adapt, remove duplication, and run full gates—not invent most of the missing product;
- require an effective-line counter that excludes generated/vendor/build output, dead code, and repetition. A data table or matrix counts only when the product or a meaningful test consumes distinct entries.

## Small-model turn budget

Assume a third-party Coding Agent may have a short turn cap even though the WorkSession survives it:

- give the first turn the whole outcome-sized package contract through a clean candidate. Let the WorkAgent choose and commit internal checkpoints without PM approval between them;
- preserve and resume the same WorkSession after a cap, using its Git status and last concrete finding as the handoff. A continuation restates the remaining acceptance gap, not one file or one command unless a repeated failure has narrowed the diagnosis there;
- run focused checks while implementing and reserve the full repository gate for candidate formation;
- do not wake the PM for successful internal checkpoints. Wake on candidate, concrete block, terminal failure, or two capped turns without a new commit/diagnosis;
- after two capped turns on the same failure, stop repeating a broad “continue” prompt. Narrow the diagnosis, split the remaining outcome, or add a specialist Space when the write sets can be separated;
- keep long simulation/browser suites within a stated test budget so a WorkAgent can diagnose, fix, and checkpoint inside one turn.

## Possible graph, not a template to copy blindly

```text
foundation
   ├── gameplay ─────┐
   ├── experience ───┼── integration ── independent-review
   └── verification ─┘
```

Merge `experience` into `gameplay` when their files or feedback loop overlap. Split a slice further only after evidence shows one WorkAgent cannot keep its contract in context. The Agent Space topology may therefore grow or shrink between deliveries.

## Space Skill contracts

Generate project-owned Provider Skills under `skills/` and select only the ones each Space needs:

- a shared project contract: commands, architecture boundaries, acceptance criteria, effective-line-count rules, asset/license policy, and exact engine version;
- a slice Skill: owned modules, prohibited modules, input commit, output/API contract, local checks, and commit requirements;
- an integration Skill: dependency candidate identities, merge order, conflict policy, full checks, and artifact production;
- a review Skill: read-only review instructions, risk checklist, candidate identity checks, Demo exercise, and structured pass/fail output.

Do not place PM control commands or daemon state knowledge in WorkAgent Skills. Rebuild and verify every affected Agent Space after changing a Provider Skill.

## Journey-specific cautions

- Initial Three.js delivery: pin dependencies, keep simulation/domain logic outside renderer adapters, provide deterministic tests, and produce a directly launchable H5 entry point.
- Daily-challenge feature: branch from the latest accepted integrated commit, preserve existing saves, make date/seed behavior testable, and require regression evidence before integration.
- COCOS 4 migration: pin the explicitly approved COCOS 4 artifact (the MVP baseline is `4.0.0-alpha.30`), record that it is Alpha, preserve user-visible behavior and save compatibility, remove runtime Three.js usage, and compare the same Demo acceptance suite before and after migration. Never substitute Cocos Creator 3.x while claiming COCOS 4.

Count effective project-owned source only. Exclude dependencies, generated code, vendored engine code, lock files, build output, dead code, and repetition added only to reach a number.
