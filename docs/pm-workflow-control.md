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
The composer keeps its own send/sending/stop states. Stop pauses this Agent's automatic continuation until new user input and leaves the squad running. While busy, entering text exposes Send supplement; receipts remain beside the conversation. The header panel owns squad progress and cancellation. Workflow notices use the same durable queue and never preempt
user input. Completion and decision-needed notices remain until handled. Cancellation never creates a PM wakeup; obsolete workflow receipts are retired without dropping user input or interrupting an existing PM turn.

## Results, cancellation and recovery

`workflow.control.v1` adds `workflow.cancel` and read-only `workflow.check`.
A Reviewer can finish with `changesRequested`, `failed` or `blocked`, a reason
and bounded evidence. Missing negative edges use a default blocked exit.
Positive completion still validates the graph's evidence. The default game
DAGs explicitly unroll one repair: implement → review; approval → publish,
changesRequested → repair → review-after-repair → publish-repaired. A second
rejection uses the blocked exit. Unselected branches become unreached, and
separate publish nodes avoid introducing joins. Projects may edit these paths;
the daemon does not recognize repair node names or prescribe another PM Run.

Accepted node results enter finishing. The executor reconciler fences and
closes that node, verifies known process cleanup, then activates its declared
successors. This is durable across restart; cancellation wins before successor
activation. Ref reservation stays with the Run throughout review. Each serial
writer gets a fresh commit baseline after previous writers close. Activation
rollback cannot release the existing Run reservation; concurrent writers are
refused. If a crash occurs after an assignment is stored but before its initial
send, the existing orphan check yields a blocked exit instead of replaying a
possibly executed assignment.

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

`taskId` is still the dispatch idempotency key. `--retry-of` associates an explicit recovery
with the original user request. Its Runs share a maximum of three attempts,
two hours of accumulated execution excluding recorded Human waits and time in
terminal states, and 256 **observed** LLM calls,
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

Exception recovery is derived from daemon-owned Run facts, never from an Agent
claim that something failed. An unresolved request with a blocked/failed Run,
cleanup error, missing WR after a detected stall, or failed/limited/unknown WR diagnostic grants ordinary PM Sessions
in that project recovery authority. It remains available while a successor is
repairing the request; a completed or cancelled latest Run removes that exception.
Unrelated projects, managed Workers and consultation around a pending Human
request do not gain this authority.

During that exception, a project PM can activate workflows, manage project
experts through exact change plans, control the project's managed Sessions,
cancel work and retry a Run owned by another PM. The original request lineage,
cancellation fence, execution budget and Human approval boundary remain in force.
The execution deadline accumulates actual Run execution/cleanup time, subtracting
Human waiting. Time after a Run is blocked or otherwise terminal does not spend
that budget; retry still shares the original Run and LLM-call limits.
A recovery or Pack upgrade does not transfer the persistent PM binding. Routine
permissions return after resolution, without a second permission store or timer.

WR automatic diagnosis has its own read-only instructions and supplied mechanical
facts; it is not a graph node and does not submit `workflow complete`. A failed or
budget-exhausted diagnosis is reported as such, with partial records clearly
separated from a completed reply. OpenAI-compatible streams retain the initial
nonempty tool ID when later argument chunks contain an empty ID.

An existing ProjectControlBinding permits routine PM management in that
project. Exact plan digest, action ID, revision and scope checks still apply;
initial takeover requires its original Human decision. Bootstrap plans expose
conflicting Runs and cancellation actions. Applying shared Pack resources
rechecks quiescence under the same project lock used by dispatch. Pure DCG
activation affects new Runs; older Runs retain immutable snapshots. Pack v4
recognizes v1, v2 and v3 upgrade sources and retains the existing rollback
path and user customization checks.

Session format 9, Run envelope v3 and index envelope v2 protect durable obligations. The current reader accepts v2 Runs; older daemons reject v3 before they can discard node retirement.
Older readers/writers must fail closed instead of dropping input or
cancellation responsibility. No new Task CRUD service, Hub scheduler, native
steering protocol or in-place workflow mutation is introduced.

## Shared implementation boundaries

The Session dispatcher owns both accepted chat input and durable Human decisions.
It scans persisted metadata once at startup and schedules independent per-Session
handoffs; a slow adapter does not block another Session. Input admission, the
interaction lock, explicit-stop fence and recorded Human authority remain distinct.

The Run snapshot is the authority for node state and FlowMessages. `session.flow`
reads that snapshot directly. The daemon no longer rewrites component-local
`manifest.json`, `inbox.jsonl`, `outbox.jsonl` or `journal.jsonl` on every Run save.
Older observation files are left untouched and are not recovery inputs. Use
`session flow` or `workflow get` for current facts; the private Run index remains
only a locator. CLI waiting follows the Run through cleanup until a terminal state
or its explicit timeout, rather than inferring completion from a Worker turn.

The legacy direct-workflow initializer and team Bootstrap Packs share the same
no-overwrite asset writer. The legacy source lives in
`apps/daemon/workflow-templates/direct-change/`; its file order, bytes and digest
remain compatible. It still initializes a direct workflow without taking over the
project or creating a PM team. Team topology and Pack upgrades remain explicit.

## Business delegation and configuration control

A project with an existing takeover binding allows its ordinary root PM conversations to dispatch work. The runtime still rejects managed/cross-project callers and preserves per-request ownership, cancellation fences and budgets. Delegating work does not transfer the configuration controller or grant Builder/upgrade/component authority; those retain controller and exceptional-recovery checks.

Game Pack v5 routes `game/assessment` and `game/review` to Game Reviewer, returning reports without implementing changes. `workflow/review` remains process diagnosis/evaluation. Old projects use the standard digest-checked Pack upgrade; in-flight Run definitions are retained.
