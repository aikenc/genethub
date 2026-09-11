# Structured Workflow definitions

`genehub.workflow.definition.v2` keeps `nodes` as activity definitions (roles,
write leases and completion evidence), and adds `structure.body`. Do not set
legacy `entry` or `on` edges in v2. A task references its activity through
`{id: review-step, type: task, activity: review}`. Execution node IDs are unique
instances: use the assignment's node identity, not the static activity ID.

Compose tasks with `sequence.steps`, `if.condition/then/else`,
`choice.branches/default`, `loop.condition/maxRounds/initial/body/update`,
`parallel.branches/failure`, `forEach.items/key/maxConcurrency/body/failure`, or
`call.procedure/input` with local `structure.procedures`. All block IDs in the
bundle are unique. Recursive calls and arbitrary cross-block edges are invalid.

A loop checks its condition before entering. It may execute zero times;
`maxRounds` is nonnegative. False after the last permitted round is success.
The loop body gets fresh `results` each round; only explicitly updated `vars`
carry over. Nested loops own separate rounds. Use the returned structure and
instance addresses in `workflow get`, not chat text, to identify a past round.

Conditions and mappings are JSON expressions: `{op: literal, value: ...}`,
`{op: ref, path: /vars/approved}`, `not`, `eq`, `lt`, `all`, `any`, `exists`,
and `object.fields`. Conditions must be boolean, not strings. A missing reference
is an error; use exists when absence is expected. No script or model call runs
inside expression evaluation.

For review loops, the review task explicitly accepts `[completed,
changesRequested]`. The host still verifies approved evidence for completed.
Use the review outcome to update approval, and carry the review report in vars
for the next Coder. Do not count a failed review as an incomplete Worker.
Unaccepted failures block. `collect` gathers branches; `failFast` stops remaining
execution and waits for host cleanup. It does not provide compensation.

For batches, freeze a finite item array and prefer an explicit unique key such
as `{op: ref, path: /item/id}`. Index identity is supported for an immutable
array; do not mutate its order during recovery. The scope concurrency and root
operation budget remain effective across loops and calls.

Compile an inactive Candidate and verify real outcomes before activation. The
engine does not manage Git, processes, permissions, external releases or disk.
Those remain host contracts. It cannot guarantee automatic retry of an action
whose external result cannot be confirmed. Never turn that uncertainty into a
new dispatch merely to unblock a diagram.
