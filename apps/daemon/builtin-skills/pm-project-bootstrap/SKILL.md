---
name: pm-project-bootstrap
description: Detect when a user wants GeneHub to take over an ordinary Workspace as a PM-managed project, safely request Human approval, apply a Bootstrap Pack, and continue the original goal. Use for project setup, team/AgentSpace setup, workflow/pipeline setup, a new game, a complex game feature, or requests for a PM-managed delivery team.
---

# PM project bootstrap

Use this Skill before giving generic process advice when the user asks to create or manage a project, build a team or pipeline, make a game, add a substantial feature, or otherwise expects PM-driven delivery.

The daemon is the authority. This Skill only discovers facts, asks the Human through GeneHub's existing Session approval interaction, and invokes typed CLI actions. Use exactly `$GENEHUB_CLI`; if it is unavailable, stop and explain that this Session has no GeneHub CLI binding. Do not depend on an Agent-specific question tool: some runtimes do not expose one to the Agent even when their transport can render questions.

First inspect the current Space and discover packs:

```text
"$GENEHUB_CLI" space inspect
"$GENEHUB_CLI" space bootstrap list
```

If the Space is already a healthy PM project with a Bootstrap Pack, read the installed Pack's `entrySkill` and continue the user's original goal. Do not bootstrap again.

If it is an ordinary Workspace and a discovered Pack clearly matches the intent, create a read-only plan. For a small game, larger game feature, or game workflow request, use the discovered `game-delivery-v1` Pack:

```text
"$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1
```

If the user has not supplied enough information to choose a Pack or identify the main deliverable, ask only the single most important clarification. The request “搭建一套管线，用于开发小游戏。你会这么做？” is a PM-project intent: inspect and plan or ask one focused gameplay question; never answer it with only generic CI advice.

For a non-current plan, parse its JSON result and find `approval.challengeId`. Present that exact daemon-authored challenge through the session-bound CLI:

```text
"$GENEHUB_CLI" space approval request --challenge <challengeId>
```

This command only submits a durable approval request. The daemon persists the request and stops this Agent turn before exposing the existing `PlanApproval` card. It does not wait for the Human; command success is not approval. Do not poll or keep a tool attached, and do not apply the plan in this turn. The command may be interrupted as the daemon closes the Agent process; the persisted Session card is authoritative.

Never call `session.respondPermission`, any permission response API, or a shell command that attempts to approve the request. Never interpret ordinary chat such as “yes” as authorization.

After the authenticated Human answers, GeneHub resumes this same Session in a new Agent turn with the durable decision. Only an approved continuation permits apply. Use the original plan's exact `planDigest` and `expectedRevision`, and the stable action ID supplied in the continuation for every retry:

```text
"$GENEHUB_CLI" space bootstrap apply --pack game-delivery-v1 --plan-digest <planDigest> --expected-revision <expectedRevision> --action-id <stableActionId>
```

Do not pass or search for a grant token. The CLI has none; the daemon finds the one-use Human grant from this authenticated Session and rejects stale, copied, forged, or replayed applies.

On success, report the Pack identity, bootstrap commit, Project → Executor → WorkflowManager/Coder/Reviewer tree, and health. Read the returned `entrySkill` immediately and continue the original user goal in this same Session. If the goal is sufficient, dispatch it; otherwise ask one blocking question. Do not implement, review, use `git add -A`, manually copy Pack files, guess a Pack id, or recreate the team yourself.

On rejection or cancellation, state that nothing changed. On failure, preserve the daemon's stable error code and recovery action; never claim takeover succeeded when the report or tree is incomplete.

## Changing an existing AgentSpace tree

When the user asks this Session to add, enable, disable or remove a Component, change a Worker role, set Parent, detach, or change lifecycle, do not call the mutating command directly. First inspect the target and create the corresponding read-only plan with its current revision:

```text
"$GENEHUB_CLI" space component set --workspace <id> --component <id> [--role <role>] [--disabled] --revision <n> --plan
"$GENEHUB_CLI" space component remove --workspace <id> --component <id> --revision <n> --plan
"$GENEHUB_CLI" space parent set --workspace <id> [--parent <id>] --revision <n> --plan
"$GENEHUB_CLI" space lifecycle set --workspace <id> --lifecycle <value> --revision <n> --plan
```

Pass the returned `approval.challengeId` through the same `space approval request` command described above. After GeneHub resumes this Session with an approved Human decision, repeat the exact command without `--plan` and add the returned `--plan-digest`, the same `--revision`, and one stable `--action-id`. Never change the operation between plan and apply. A copied command, an ordinary chat “yes”, or an apply from another Session has no authority. If the daemon reports an active Session, Run, lease, cycle, cross-project Parent or CAS conflict, report those structured conflict objects and stop; do not work around the guard.

This Skill only explains the safe protocol. Parent validity, Builder verification, active-resource guards, compare-and-set, and the one-use grant remain daemon decisions. A user clicking the same controls in Workspace details is already making an authenticated Human action and does not need a second chat approval.
