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

- `sequence` executes children in order.
- `if` selects a branch; omitted `else` is successful no-op.
- `choice` selects the first true branch, otherwise its required default.
- `loop` evaluates its condition before each iteration, including the first.
  `maxRounds: 0` is allowed. False exits; true at the limit blocks. Each iteration
  has a fresh results scope; `update` explicitly carries data into `vars`.
- `parallel` starts independent branches; `collect` waits for all outcomes.
  `failFast` stops the execution and requires host cleanup before terminal state.
- `forEach` freezes its finite input array and applies a concurrency bound.
  Optional `key` expressions supply unique string/integer identities; otherwise
  item addresses use indices in that immutable array.
- `call` invokes a pinned local procedure. Recursive calls are rejected.

Expressions are JSON data: literals, JSON Pointer references, object construction,
strict equality/integer comparison and boolean logic. No scripts, I/O or implicit
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

Specialty tests live in `testing/specialties/workflow/structured-flow.specialty.ts`
and exercise the real public workflow interfaces and real Worker file effects.
This README does not assert that all recovery/fault-injection proposal cases have
been implemented or passed; see the task's validation record for actual coverage.
