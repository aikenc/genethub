# workflow-engine

Pure structured control flow for GeneHub. The crate does not open files, create
sessions, take leases, send messages, read clocks, or publish artifacts.

`compile(definition)` validates a fixed program and returns its digest.
`start(program, request)` creates the first transition.
`advance(program, state, input)` applies a revision-checked event and bounded
mechanical progress. `pending(state)` lists stable activity operations.
`inspect(program, state)` returns the current structural frontier;
`ancestry(program, state, frame)` captures an activity's structural address.

A host must persist the returned state before dispatching any pending operation.
Restart loads the same definition and state and reconciles the same operation
identities. An activity `Settled` event means its evidence is verified **and** its
process/resources are retired. A tool result alone is insufficient. Repeated or
late updates cannot finish a different activity. Per-operation `updateSeq` is
monotone; `expectedRevision` fences concurrent state writers.

The serialized snapshot is authoritative. History entries are observational
outputs, not input required to reconstruct progress. The host owns atomic save,
locking, delivery reconciliation, external-result uncertainty and retention.
GeneHub stores the snapshot in its private Run envelope and retains activity
addresses alongside the existing node evidence records.

## Control language

- `sequence` executes children in order and returns their named results. Optional
  `output` evaluates an expression after normal completion (also useful for a
  zero-step value block); it never runs after a failed child or `break`.
- `if` selects a branch; omitted `else` is successful no-op.
- `choice` selects the first true branch, otherwise its required default.
- `loop` evaluates its condition before each iteration, including the first.
  `maxRounds: 0` is allowed. False exits; true at the limit blocks. Each iteration
  has a fresh results scope; `update` explicitly carries data into `vars`.
- `parallel` starts independent branches and waits for every outcome. A failed
  branch makes the group's own outcome unsuccessful, which its parent propagates.
- `forEach` freezes its finite input array and applies a concurrency bound.
- Both groups take an optional `completeWhen`: the join policy as data instead of
  a fixed enum. It is evaluated against the results that have already arrived,
  plus `/group` counts (`total`, `arrived`, `succeeded`, `failed`, `running`,
  `remaining`). When it holds, a `forEach` starts no further item and settles
  once its in-flight items return; items already running are never abandoned,
  because their host resources are retired only through the ordinary settle path.
  When it holds and a failure has already arrived, the group can no longer
  succeed, so the execution stops rather than buying a result that cannot change
  the verdict. Absent means every item runs and every branch is awaited. Any-of,
  quorum and stop-on-first-failure are therefore expressions, not engine-owned
  modes. On a `parallel` block every branch has already started, so its
  `completeWhen` can only cut short a group whose verdict is already negative.
  A definition pinned before `completeWhen` may still carry the retired
  `failure: collect|failFast` enum; compilation translates it once into the
  equivalent expression and never writes it back, so in-flight Runs keep the
  behavior they started with.
  Optional `key` expressions supply unique string/integer identities; otherwise
  item addresses use indices in that immutable array. Optional `initial` and
  `update` must be supplied together with `maxConcurrency: 1`: `vars` is the
  accumulator, `update` sees the completed item's value in `results` and the
  current `item`, and normal completion returns the accumulator. Without these
  fields the existing keyed-results behavior is unchanged.
- `break` returns its `value` from the nearest lexical `loop` or serial `forEach`.
  Intermediate sequence/choice/if blocks do not execute their remaining work.
  A break may not cross a procedure or parallel boundary; nested local loops
  inside those boundaries can still break. It is internal control, not an
  activity outcome that a Worker can forge. The iteration's `update` does not
  run on break; include the desired accumulated data in the explicit value.
- `call` invokes a pinned local procedure. Recursive calls are rejected.

Expressions are JSON data: literals, JSON Pointer references, object construction,
strict equality/integer comparison/addition, array append/membership and boolean
logic. `entries` maps an object to at most 4096 `{key,value}` pairs in ascending
key order (empty object → empty array); non-objects fail. A parallel foreach's
keyed results can therefore feed a serial fold without a shared accumulator or
LLM aggregation. `add` rejects i64 overflow; `append` is bounded to 4096 items. No scripts, I/O or implicit
truth conversion. Missing/type-invalid conditions block rather than choosing a
business fallback. Loop limits, total operation limits, frontier size, call depth
and per-transition fuel bound progress. A total control-step cap also bounds
workflows composed only of control blocks. Fuel exhaustion requests another Drive;
waiting activities do not consume runnable fuel.

Host-provided logical time drives deadlines. Root deadlines survive restart;
activity timeouts start at durable `Accepted`, after resource admission, and are
not reset by recovery. `pending().wake_at` exposes the next deadline.

## Current integration boundary

Definition v2 places the structure beside existing activity definitions. All
roles, evidence checks, write leases, PM permissions and cancellation remain host
capabilities. Legacy v1 DAG Runs continue on their original path. `result.publish`
currently publishes the local Run result; it is not a network release adapter.
No automatic retry of uncertain external side effects is provided.

The host's `request.budget` capability returns an immutable current-request budget
observation as ordinary activity output. The engine knows no budget fields or
admission policy. Queries, enforcement and CLI checks share host accounting;
the host persists observations before advancing and reuses committed values after
restart. A fresh task can observe new usage/limits; remaining capacity is not a
reservation for concurrent work.

Workers submit JSON business data through the existing `workflow complete
--output <json>` command. The host validates bounds and an optional
`completion.output` data shape, persists the output with the node, then retires
resources before feeding `{outcome, evidence, reason, output}` to the engine.
Legacy nodes omit output. `workflow get` and Executor Flow expose the same data.
Objects, finite arrays, string enums, integers, booleans and null are the closed
shape vocabulary; this is not full JSON Schema, a scripting validator, or proof
that the Worker actually ran its reported checks. Business meanings and acceptance
policies belong to the project Workflow/Pack.

Absent new fields are omitted from serialized definitions and state, preserving
the digests of old programs. New control syntax requires an updated daemon;
older engines reject unknown blocks rather than silently executing a different
flow. Cancellation, deadlines and host aborts still take priority over local exits.

Specialty tests live in `testing/specialties/workflow/structured-flow.specialty.ts`
and exercise the real public workflow interfaces and real Worker file effects.
This README does not assert that all recovery/fault-injection proposal cases have
been implemented or passed; see the task's validation record for actual coverage.
