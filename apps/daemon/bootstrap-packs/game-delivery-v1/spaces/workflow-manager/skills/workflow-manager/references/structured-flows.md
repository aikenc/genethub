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

`add` performs checked i64 addition; `append` adds one value to a bounded array;
`contains` tests exact JSON membership. Do not build a script language in prompts.
`sequence.output` optionally projects its completed result (an empty sequence can
return a value). `forEach.initial/update` reuse loop-local `vars`, require serial
concurrency, and return the final accumulator; update reads the completed item
value at `/results`. Nested loops own their vars; use `call.input` to bind an
outer value before entering a nested scope. Item bodies start with fresh results.

`{id: exit, type: break, value: <expression>}` exits the nearest lexical loop or
serial foreach. It skips remaining children and that iteration's update; return
the data to retain explicitly. It cannot cross call/parallel boundaries. System
failure, cancellation, timeout and exhausted budgets are not business break values.
Keep fixed control definitions with dynamic plan data; no runtime graph rewriting.

For structured Worker data, declare `completion.output` on the activity, then
submit `workflow complete --output '<JSON>'`. Tasks consume `/results/<step>/output`
(or `/results/output` when a task is the loop body). This is a bounded subset,
not a full JSON Schema evaluator. Prefer explicit `object.required: [names]` plus
`additionalProperties: false`; optional declared keys are checked when present.
Omitting both keywords preserves legacy all-required/closed `object.properties`;
specifying only one is an error. `array.items/minItems/maxItems`, `string.enum/minLength`,
`integer`, `boolean` and `null` are supported. Arrays require maxItems, at most 4096.
Data is limited to 256 KiB, depth 32 and 16384 values; schema depth/size is also
bounded. An omitted output remains compatible with old nodes; explicit null is
data. Evidence requirements remain separate. A completed assessment may return a
negative business verdict; inability to perform it uses a negative node outcome.

Iterate the frozen acceptance criteria, not a model's claimed checklist coverage.
Retain item identity, contract and actual result; re-review the same contract.
Keeping the baseline in Workflow/prompts includes it in the Candidate identity;
arbitrary external files or Space Skills are not silently snapshotted by this.
Structured coverage proves declarations, not that the reported checks ran.
`workflow get` exposes node output and `structure.outcome`; a Run ending without
publication must not be described as a successful business delivery.

Use `workflow inspect --candidate <digest>` when selecting a candidate: its
`selectedDigest`, default and catalog refer to that version. Candidate dispatch
uses the same selected catalog. This never activates it or changes default formal
routing, and existing isolated Executor/task-directory requirements still apply.

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
