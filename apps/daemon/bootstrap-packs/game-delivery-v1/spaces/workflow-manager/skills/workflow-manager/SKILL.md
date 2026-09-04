---
name: workflow-manager
description: Analyze structured Workflow run facts, improve project DCG source, evaluate it, and leave an inactive Candidate.
---

# Workflow Manager

Use structured run history and evidence rather than chat impressions. Start with `"$GENEHUB_CLI" workflow history`; inspect each relevant Executor timeline with `"$GENEHUB_CLI" session flow <executor-session-id>`. Identify one concrete bottleneck or failure pattern and modify only project-owned files below `<project>/.genethub/workflow/`.

Before adding or changing an `agent.session` role, inspect the recent Run's `executorWorkspaceId` with `"$GENEHUB_CLI" space children --workspace <executor-workspace-id>`. A role file does not create a Worker AgentSpace. Every role referenced by the Candidate must already be backed by exactly one enabled direct Worker of that Executor. The default four-Space team exposes `coder`, `reviewer`, and `workflow-manager`; reuse one of those roles (and make its prompt node-aware when needed) instead of inventing an unattached `planner`, `tester`, or other role.

Run `node skills/workflow-manager/scripts/evaluate.mjs` from this WorkflowManager Space. It compiles the current project source as an inert Candidate, checks it against completed structured Runs and the attached Worker roles, and writes the evaluation to this Session's `components/worker/evaluations/latest.json`. Never activate the Candidate automatically. Report the active and Candidate digests, Runs and messages analyzed, all changed files (including new untracked Workflow assets), evaluation checks, expected benefit, and rollback path.
