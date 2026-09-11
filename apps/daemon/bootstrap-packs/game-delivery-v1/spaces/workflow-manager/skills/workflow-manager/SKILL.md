---
name: workflow-manager
description: Analyze structured Workflow run facts, improve project DCG source, evaluate it, and leave an inactive Candidate.
---

# Workflow Manager

Use structured run history and evidence rather than chat impressions. Start with `"$GENEHUB_CLI" workflow history`; inspect each relevant Executor timeline with `"$GENEHUB_CLI" session flow <executor-session-id>`. Identify one concrete bottleneck or failure pattern and modify only project-owned files below `<project>/.genethub/workflow/`.

Before adding or changing an `agent.session` role, inspect the recent Run's `executorWorkspaceId` with `"$GENEHUB_CLI" space children --workspace <executor-workspace-id>`. A role file does not create a Worker AgentSpace. Every role referenced by the Candidate must already be backed by exactly one enabled direct Worker of that Executor. The default team exposes `coder`, `reviewer`, `workflow-manager`, and `workflow-reviewer`; reuse one of those roles (and make its prompt node-aware when needed) instead of inventing an unattached `planner`, `tester`, or other role.

Run `node skills/workflow-manager/scripts/evaluate.mjs` from this WorkflowManager Space. It compiles the current project source as an inert Candidate, checks it against completed structured Runs and the attached Worker roles, and writes the evaluation to this Session's `components/worker/evaluations/latest.json`. Never activate the Candidate automatically. Report the active and Candidate digests, Runs and messages analyzed, all changed files (including new untracked Workflow assets), evaluation checks, expected benefit, and rollback path.

When delegated by PM, follow its requested scope and return your report through the managed completion contract. A reasoned no-change or unsupported result is valid: state the observed facts, limitation, alternative and reconsideration condition. Do not force an edit just to produce a Candidate. For complex changes, return an experiment plan with baseline, candidate/team/environment binding, comparison criteria, budget and stop conditions; never activate first to test later. Compilation checks are structural evidence, not an independent quality verdict.

For complex changes, read [experiment execution](references/experiments.md) for the actual candidate/team/environment binding and supported trial/adoption commands.

For control-flow edits, read [structured workflow definitions](references/structured-flows.md). Use the current v2 structured language for loops and parallel composition; preserve v1 definitions on existing Runs.
