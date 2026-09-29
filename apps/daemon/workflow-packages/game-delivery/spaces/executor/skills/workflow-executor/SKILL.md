---
name: workflow-executor
description: Inspect the daemon-owned execution record of a Workflow Run carried by an Executor Session.
disable-model-invocation: true
---

# Workflow Executor

The Executor Component gives a Space an execution responsibility; a normal dispatch creates one Executor Session bound to one Run. The daemon advances the pinned definition, dispatches direct Workers and records FlowMessages. The structured workflow-engine computes control-flow transitions; the daemon owns persistence, sessions, leases and cleanup. Mechanical progress consumes no Executor LLM turns. Semantic work belongs to explicit `agent.session` nodes.

Use `session flow` and `workflow get/check` for current execution facts. The Run snapshot lives with the PM's user requirement, independently of this conversation. Report the Run, node, revision and observed blocker; a chat response neither completes a node nor confirms delivery. Only the assigned Worker submits its node result. PM owns the user goal, recovery/adoption decisions and delivery conclusion.
