# PM input and workflow control

A Session describes the PM's own execution. `workSummary` derives task state from
its original requests and related Runs. An idle PM with a running Worker remains
an active task; user questions start or continue only the PM. Lists, filters and
task cards use the same summary. The normal list refresh is at most ten seconds;
a disconnected or failed projection is shown as needing reconciliation.

## Durable input

Clients negotiate `session.input.v1` before adding `messageId` to `session.send`.
The daemon stores the original text, attachments and receipt before ACK. The ID
is unique within the Session; changing its body, source or task reference is an
error. The optional `taskRunId` must belong to that PM. Fieldless requests retain
the original single-turn contract. CLI `--message-id` returns acceptance, never
an answer or a running claim.

The existing Session meta holds bounded receipts and references the original
chat body. Receiving, queued, possibly sent and handled are internal delivery
facts. Concurrent clients and retries reconcile by ID. At most 32 inputs may
remain pending, with 4096 receipts per Session, 64 KiB text and 16 attachments per
input. The existing transport also bounds attachment payloads. Browser receipts
survive refresh; if an attachment was never accepted and its local bytes are
gone, the UI asks for reselection instead of silently resending text alone.

One execution owns PM handover, running, shutdown and final persistence.
Adapters declaring both interrupt and native resume can continue a busy PM;
other adapters wait for its execution boundary. Missing native continuation
fails visibly and retains responsibility. A possibly executed action is
reconciled against native context and its original Run/action key. There is no
exactly-once guarantee for third-party side effects.

An unanswered Human request remains a separate request with the same ID. A
consultation cannot replace, answer or approve it, or use project authority to
bypass its decision. An explicitly submitted decision is persisted and can join
the next input batch; completion is bound to the execution that carried it.
“停止 PM 本轮” pauses automatic continuation until new user input. It leaves the
squad running. Workflow notices use the same durable queue and never preempt
user input. A terminal Run retains its notice until PM handling is recorded.

## Results, cancellation and recovery

`workflow.control.v1` adds `workflow.cancel` and read-only `workflow.check`.
A Reviewer can finish with `changesRequested`, `failed` or `blocked`, a reason
and bounded evidence. Missing negative edges use a default blocked exit.
Positive completion still validates the graph's evidence. DAG validation
remains; repair creates a related Run instead of an unbounded back edge.

The task button calls cancellation directly. PM can invoke the same command.
The original-request fence is persisted first; dispatch, completion and recovery
check it. Related Workers, Executor and diagnostic Sessions are fenced, stopped,
and their known descendant processes and ref leases reclaimed. Only confirmed
cleanup yields `cancelled`; errors remain `cancelling` with a concrete reason.
Bounded process observations are persisted before shutdown and checked afterward,
including after a daemon restart. If the operating system cannot provide those
facts, the adapter is still stopped and cleanup remains explicitly unconfirmed.
Cancelled Session execution cannot reopen after reload. Artifact and evidence
history remains accessible, including for older/broken Pack installations.

`taskId` is still the dispatch idempotency key. `--retry-of` associates repair
with the original user request. Its Runs share a maximum of three attempts,
two hours excluding recorded Human waits, and 256 **observed** LLM calls,
including diagnosis. Changing dispatch keys does not reset these bounds.
Unavailable token accounting stays unknown. Explicit recovery of a cancelled
request requires both user input received after the cancellation fence and
`--resume-cancelled`. A delayed reply to an earlier PM question cannot reopen it.

## Mechanical supervision and project management

A daemon controller checks unfinished Runs and each Worker attempt. At 180
seconds without changing LLM/tool activity it records a silence episode and,
when configured, starts a fresh evidence-only diagnostic Session. Heartbeats,
PM questions and another Worker's activity cannot reset the stalled attempt.
Human waits are excluded. Silence triggers diagnosis, not cancellation of a
long operation. An idle Worker without a result is reconciled after a brief
launch grace period.

Waiting questions retain their original Session/request IDs. Task cards expose
the waiting reason and a link to the original interaction. Each request queues
one decision-needed PM notice, within the bounded notice budget; repeated checks
do not repeat the wakeup. Original interaction permissions remain in effect and
the PM cannot supply a Human approval merely through project management authority.

Normal progress uses no automatic WR calls. One diagnosis can run at a time;
there are at most two per original request, each limited to 180 seconds/eight
observed calls. Trigger identity survives restart. Missing/failed/exhausted WR
retains a mechanical finding and a bounded PM notice; WR cannot recursively
dispatch another diagnostic graph. `workflow.check` exposes outcomes, evidence
gaps, execution inconsistencies, activity timestamps and diagnosis Sessions.

The Pack's WR Skill consumes the restricted checker. The engineering Reviewer
also has `check-playability.mjs`: an entry digest plus a read-only
`gameTestSnapshot()` contract lets Chromium check start, movement and firing.
Level/Boss/item progression needs project-specific behavioral evidence.
Unavailable observation is explicitly unverifiable.

An existing ProjectControlBinding permits routine PM management in that
project. Exact plan digest, action ID, revision and scope checks still apply;
initial takeover requires its original Human decision. Bootstrap plans expose
conflicting Runs and cancellation actions. Applying shared Pack resources
rechecks quiescence under the same project lock used by dispatch. Pure DCG
activation affects new Runs; older Runs retain immutable snapshots. Pack v3
recognizes both v1 and v2 upgrade sources and retains the existing rollback
path and user customization checks.

Session format 9 and Run/index envelopes v2 protect new durable obligations.
Older readers/writers must fail closed instead of dropping input or
cancellation responsibility. No new Task CRUD service, Hub scheduler, native
steering protocol or in-place workflow mutation is introduced.
