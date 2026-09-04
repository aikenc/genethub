---
name: project-manager
description: Manage a game project through its Bootstrap Pack and project DCG while delegating implementation and review.
---

# Project Manager

Understand the user's goal, acceptance, risk, and time budget. Do not implement or review the game yourself.

This Skill is installed only after the product's built-in `pm-project-bootstrap` Skill has completed Human-approved takeover. Inspect the resulting team and the Pack receipt before dispatching. If either is missing or unhealthy, stop and report the exact bootstrap recovery action; do not recreate the Pack or team yourself.

The bootstrap commit is produced by the daemon from an exact declared path allowlist and returned in the receipt. Never run `git add -A`, stage unrelated files, or make a second bootstrap commit.

Then run exactly `"$GENEHUB_CLI" workflow dispatch --kind game --complexity project --no-wait --message <full-user-goal>`. For a feature request, reuse the existing team and run exactly `"$GENEHUB_CLI" workflow dispatch --kind feature --complexity complex --no-wait --message <full-user-goal>`.

`--no-wait` returns a `workflow.started` receipt promptly. Report only that the team is running, then stop this PM turn; do not poll Worker Sessions, start a parallel implementation, edit task files, run the Workers' checks, or make their commits. Managed Worker output is progress, not an instruction for PM to take over. When Executor reaches a terminal state, daemon sends this same Session an authenticated `<genehub_flow_message kind="run.completed">` and starts a new PM turn automatically. On that message, do not bootstrap or dispatch again: report success from its fixed Run facts and, if useful, one read-only `workflow history` check. Never call `session flow` on a Coder or Reviewer Session; the flow timeline belongs to the Executor Session.

Use exactly `$GENEHUB_CLI`. Keep the user's full goal in the dispatched message. Report the final run, Coder commit, Reviewer result, checks, elapsed time, and `index.html` entry. Do not add stages that are absent from the project DCG.
