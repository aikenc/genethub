# Workflow authoring validation

The authored business method belongs to project/Pack YAML. The platform supplies one parser/compiler,
bounded JSON data and deterministic execution; it does not implement a game pipeline or ask an LLM to validate YAML.

## Two existing CLI surfaces

```sh
"$GENEHUB_CLI" schema workflow.definition
"$GENEHUB_CLI" workflow check --draft
```

`schema` returns `data.definition`, a Draft 2020-12 JSON Schema generated from the Rust deserialization
types, plus `x-genehub` capabilities and boundaries. It describes our v1/v2 syntax, **not** OWS/ASL
compatibility. No jq, JSONata, remote `$ref`, script runtime or standard-DSL migration is added.
The schema helps authoring; the production compiler remains authoritative for control flow and bounds.

`check --draft` uses the same bounded source loader and compiler as activation/dispatch. It does not
create/persist a Candidate, Run, lease, session, Worker, or change Active. Normal `check [--run]` retains
its runtime-check behavior. `--run` and `--draft` are mutually exclusive. Authorization and project
boundaries are unchanged. An older daemon omitting the draft report is an explicit capability error.

On success, `data.draft` contains `valid: true`, the exact source Candidate digest, default Workflow,
execution binding and **catalog-referenced** workflows/roles. These come from the final compiled snapshot,
not regexes or a scan of every YAML file in a directory. They do not prove carrier readiness.

On invalid source, the CLI exits nonzero with `error.code: workflowValidationFailed` and
`error.details.draft`: `valid: false`, no runnable metadata, and at most 64 diagnostics. Parsing a broken
project/catalog stops dependency traversal. Otherwise the first causal failure per catalog entry is
collected and duplicate diagnostics are suppressed. This is not an exhaustive error list inside each
malformed file; repair then rerun. `truncated` reports the output cap.

Each diagnostic has `phase`, `code`, `severity`, source-relative `file`, RFC 6901 `path`, `message` and
`hint`. `line`/`column` are 1-based only when supplied by the parser; compiler locations use pointers,
not invented YAML offsets. `expected`/`actual` describe known type mismatches, not raw user values.
Legacy semantic/dependency errors may locate the file root; their constraint remains in `message`.

For example, an `if` with `condition: {op: literal, value: "true"}` is rejected at its condition with
`WF_EXPRESSION_TYPE`, `expected: boolean`, `actual: string`. Use the boolean `true` without quotes.
Likewise, arithmetic/array/boolean operands with statically incompatible kinds are rejected. References
are not subject to speculative data-flow inference: missing fields and dynamic types fail at runtime.
Runtime expression failures retain the block path and a `condition.error` history event with the same
diagnostic fields. Cancel, timeout and permission failures retain their existing hard stop semantics.

## Closed result contracts

Prefer explicit JSON Schema-compatible object syntax:

```yaml
completion:
  output:
    type: object
    required: [decision]
    additionalProperties: false
    properties:
      decision: {type: string, enum: [go, noGo]}
      explanation: {type: string, minLength: 1}
```

Only `decision` is required here. Extra keys are rejected and present optional keys are validated.
The bounded subset also supports array/items/minItems/maxItems, string/enum/minLength, integer, boolean
and null. It is not a full JSON Schema evaluator. No open object, executable validator or remote schema.
For backward compatibility, omitting **both** object keywords preserves the original all-required,
closed-object shorthand. Supplying only one keyword is rejected. Existing snapshots/digests retain the
same serialization when both are omitted; old Runs are not rewritten.

## Budget observations and parallel reduction

`request.budget` is a host capability with no `with` or `completion` fields.
An ordinary task returns a persisted `output` containing `requestRunId`,
`observedAtMs`, `budget` (revision/maxRuns/deadlineMs/maxLlmRounds), `usedRuns`,
`observedLlmRounds`, `executionMs` and remainingRuns/remainingLlmRounds/remainingExecutionMs.
It reads only its own shared request using the same accounting as admission and
`workflow check`. The observation is neither a reservation nor authority to raise
limits. It survives restart unchanged; query again to observe a budget amendment
or subsequent usage. Thresholds and business exits belong to YAML; PM retains
budget authorization. The pure engine gains no clock, budget opcode or I/O.

`{op: entries, value: <object expression>}` returns `{key,value}` pairs in ascending
key order, with a 4096-entry cap. Empty objects return `[]`; non-objects fail with
the existing typed-expression diagnostic (at runtime for dynamic references).
Use it on a parallel foreach's keyed output, followed by a serial foreach fold.
Aggregation is pure data processing: no LLM, shared mutable accumulator or new
parallel break semantics. Bind artifact data using `call.input` to make shared
immutable inputs explicit. Serial fold item bodies have fresh results; non-fold
foreach items inherit a copy of the parent context. Completed negative business verdicts
are data; unaccepted host/Worker failures still stop the Run and await cleanup.

Only a wholly Human-waiting Run pauses the host execution-time budget; questions
stay visible when siblings are working. Current same-Run recovery continues the
original Worker Session after a daemon restart, keeps any write lease, and does
not replay completed nodes. It refuses continuation while the previous process
is still running and does not reconstruct project files.

## Join policy, task directories and the transition clock

A group's join policy is an expression, not an engine mode. `parallel` and `forEach`
both accept `completeWhen`, evaluated against the results that have arrived plus
`/group` counts (`total`, `arrived`, `succeeded`, `failed`, `running`, `remaining`).
When it holds, a `forEach` starts no further item and settles once its in-flight
items return; the engine never kills a Worker to satisfy it. When it holds and a
failure has already arrived, the group can no longer succeed, so the execution
stops instead of paying for results nobody can use — that case is what the removed
`failFast` policy used to cover, and omitting `completeWhen` keeps the previous
collect-everything behavior. Any-of, quorum and stop-on-first-failure are therefore
project-authored expressions. A definition pinned by an older host may still carry
the retired `failure: collect|failFast` enum; compilation translates it once into
the equivalent expression and never writes it back, so a Run already in flight and
an unmigrated project source both keep working without a second supported spelling
in the model.

`with.workspace` may be an expression over the node's own task input instead of a
fixed string, so sibling instances of one activity work in different directories.
The kernel gains no Git worktree, branch or checkout concept from this: write
leases stay keyed by (directory, target ref), which is what makes separate
directories on separate branches genuinely concurrent while one target ref stays
serialized. A pack that wants parallel branches creates those directories with an
ordinary node and returns the project-relative path in its `completion.output`.

Every node instance records when its state changed: `pendingSinceMs` (the instance
first existed, retained across attempts), `assignedAtMs` (the current attempt
started), `settledAtMs` (its result was accepted) and `lastActivityAtMs`, beside
`attempt`, `llmRounds`, `tokens` and `priorLlmRounds`. The Run additionally exposes
its `supervision` snapshot. These are transitions the host already performs. The
daemon computes no duration, ranking, critical path or utilization from them: a
reader that wants those derives them, so that what counts as healthy stays policy.

## Shared procedure libraries

A workflow may reuse `call` targets written in another file. `include: [<id>]`
names libraries at `procedures/<id>.yaml`, beside `workflows/`, each carrying
`procedures` plus the nodes they use and nothing else: no entry, no catalog
match and no `include` of its own, so one resolution step makes cycles
impossible instead of bounding them at runtime.

The include is resolved while the bundle loads, before any validation. The
pinned program is exactly what the same content written inline would produce,
so the engine, the Run record and recovery gain no notion of a sub-workflow,
and duplicate block IDs, unknown procedures or missing activities keep their
existing diagnostics. Procedure names, node IDs and block IDs must not collide
with the including workflow or another library; the loader refuses a collision
rather than choosing a winner. Library bytes are Candidate source, so editing a
library produces a new Candidate digest for every workflow that includes it —
one library serves several workflows without letting one of them drift onto
stale content. `schema workflow.definition` publishes the library schema beside
the definition schema.

## Agent repair and evidence boundaries

WM uses schema → edit → draft check → bounded correction → evaluation. The built-in Skill stops after
three unsuccessful repair passes and returns remaining evidence to PM; the platform runs no LLM or
repair loop. `evaluate.mjs` consumes compiled roles/execution and checks the digest again before evaluation.
Quoted values, inline mappings and uncataloged scratch files cannot falsify its role inventory.

PM uses the same minimal facts to correct its interpretation/delegation and routes method edits to WM.
The Executor still closes the complete configured workflow. No PM milestone scheduler or reflection
state machine is added. A successful shape check does not prove tests ran; compilation/evaluation does
not prove improvement. Real trials and independent WR evidence remain necessary when warranted.

Pack upgrades remain explicit and protect customizations. New installations get the updated instructions;
restarting a service does not overwrite an existing project's Pack assets.
