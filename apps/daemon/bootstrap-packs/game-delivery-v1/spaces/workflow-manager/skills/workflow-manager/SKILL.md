---
name: workflow-manager
description: Create or improve a Workflow from PM's intent and execution evidence; return an inactive Candidate and its carrier preparation plan.
---

# Workflow Manager

Start from PM's full user intent, acceptance, constraints and budget. Create a new Workflow or improve an existing one; the Executor and its configuration carry that Workflow, while test projects validate it. Use `"$GENEHUB_CLI" workflow history` and relevant Executor timelines from `session flow` as evidence. A new Workflow may have no historical Run; disclose that gap rather than inventing a bottleneck. Modify project-owned definitions below `<project>/.genethub/workflow/`; return proposed carrier/Skill/role changes to PM as a concrete preparation plan.

Before changing `agent.session` roles, inspect the Candidate's selected Executor and its direct Workers with `"$GENEHUB_CLI" space children --workspace <executor-workspace-id>`. Historical Executors describe historical Runs and are not the new Candidate's role inventory. A role file does not create a Worker. Exactly one enabled direct Worker per referenced role is needed before dispatch, but a preparation plan may request new roles that PM has yet to create. Reuse appropriate existing roles; name and describe any new Worker, Skill, model and permission requirement explicitly.

Run `node skills/workflow-manager/scripts/evaluate.mjs [proposal.json]` from this Space. The optional JSON supplies your actual `hypothesis` and `comparisonPlan`. The report enumerates source, available timelines and the selected carrier's roles in this Session's `components/worker/evaluations/latest.json`. `status: passed` has `scope: structure`; `improvementVerdict: unproven` remains until trial and independent review. Missing baselines or unprepared roles are explicit evidence gaps, not proof of failure or benefit. Never activate automatically. Report active/Candidate digests, analyzed Runs, changed Workflow files, preparation gaps, expected benefit and rollback.

When delegated by PM, follow its requested scope and return your report through the managed completion contract. A reasoned no-change or unsupported result is valid: state the observed facts, limitation, alternative and reconsideration condition. Do not force an edit just to produce a Candidate. For complex changes, return an experiment plan with baseline, candidate/team/environment binding, comparison criteria, budget and stop conditions; never activate first to test later. Compilation checks are structural evidence, not an independent quality verdict.

For complex changes, read [experiment execution](references/experiments.md) for the actual candidate/team/environment binding and supported trial/adoption commands.

For control-flow edits, read [structured workflow definitions](references/structured-flows.md). Use the current v2 structured language for loops and parallel composition; preserve v1 definitions on existing Runs.
