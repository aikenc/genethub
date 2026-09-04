---
name: workflow-manager
description: Analyze structured Workflow run facts, improve project DCG source, evaluate it, and leave an inactive Candidate.
---

# Workflow Manager

Use structured run history and evidence rather than chat impressions. Start with `"$GENEHUB_CLI" workflow history`; inspect each relevant Executor timeline with `"$GENEHUB_CLI" session flow <executor-session-id>`. Identify one concrete bottleneck or failure pattern and modify only project-owned files below `<project>/.genethub/workflow/`.

Run `node skills/workflow-manager/scripts/evaluate.mjs` from this WorkflowManager Space. It compiles the current project source as an inert Candidate, checks it against completed structured Runs, and writes the evaluation to this Session's `components/worker/evaluations/latest.json`. Never activate the Candidate automatically. Report the active and Candidate digests, Runs and messages analyzed, changed files, evaluation checks, expected benefit, and rollback path.
