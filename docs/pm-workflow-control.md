# PM input and workflow control

The domain model and the distinction between Workflow definitions, Executor
carriers and test projects are documented in
[Workflow and Executor](./workflow-executor-model.md).

The business term is **user requirement** (用户需求): the goal and constraints
entrusted to PM, potentially spanning multiple Runs. Existing identifiers such
as `requestRunId`, the `request.budget` capability and `requests/` storage retain
their technical names. Transport requests and Human interaction requests are
separate concepts.

A Session describes the PM's own execution. `workSummary` derives task state from
its user requirements and related Runs. An idle PM with a running Worker remains
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
A Workflow may also declare its own outcomes beyond the four built-in names
(`outcomes: <name>: {success: <bool>}`); the kernel judges only the declared
success bit, while `on` edges and structured `accept` lists route by any
declared name, so a reviewer no longer has to compress a project-specific
judgment into `blocked`.

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
The user-requirement cancellation fence is persisted first; dispatch, completion and recovery
check it. Related Workers, Executor and diagnostic Sessions are fenced, stopped,
and their known descendant processes and ref leases reclaimed. Only confirmed
cleanup yields `cancelled`; errors remain `cancelling` with a concrete reason.
Bounded process observations are persisted before shutdown and checked afterward,
including after a daemon restart. If the operating system cannot provide those
facts, the adapter is still stopped and cleanup remains explicitly unconfirmed.
Cancelled Session execution cannot reopen after reload. Artifact and evidence
history remains accessible, including for older/broken Pack installations.

`taskId` is still the dispatch idempotency key. `--retry-of` associates an explicit recovery
with the original user requirement. Its Runs share a maximum of three attempts,
two hours of accumulated execution excluding recorded Human waits and time in
terminal states, and 256 **observed** LLM calls,
including diagnosis. Changing dispatch keys does not reset these bounds.
Unavailable token accounting stays unknown. Explicit recovery of a cancelled
user requirement requires both user input received after the cancellation fence and
`--resume-cancelled`. A delayed reply to an earlier PM question cannot reopen it.

## Mechanical supervision and project management

The daemon patrol runs every five seconds. It enumerates requirement records,
skips Run snapshots for groups with a valid `settled` marker, and reconciles the
remaining execution, cleanup, routes, Human interactions and PM notices. This
is a programmatic check; it does not call an LLM for every Session or historical
Run. Directory and marker reads still incur cost for settled history.

For a running Run, supervision records each node Session's changing output,
observed LLM calls/tokens and tool facts through `execution_activity`. It also
observes Session status and actual pending Human questions. An undispatched
running node without a Session, or a Run with no Worker taking over, can reach
the 180-second progress deadline. A live Agent may legitimately spend minutes
inside a tool call; elapsed silence alone does not stop it. Budget enforcement
and declared execution limits remain separate checks. Lost Worker attempts and
cleanup are reconciled by the control layer.

Patrol considers every unfinished user requirement, including a completed
assessment or budget/route block with no active successor. A missing or idle PM
has a 180-second handoff window; a PM actively processing this requirement has
30 minutes. The clock belongs to the requirement and does not reset on chat,
heartbeats or another requirement's work. A valid unanswered Human card retains
its responsibility, uses a 60-second audit interval and wakes on answer.
The package-selected recovery Workflow remains customizable, with the built-in
flow as default. Its independent default bounds are three Runs, 200 observed
LLM calls and one hour; expansion requires Human exit c. Business quota
exhaustion does not exclude independent recovery. Repeated patrol errors are
visible in the requirement projection, with slower retries after three errors;
write failures also have a bounded local diagnostic fallback.

PM notices use stable IDs and the existing durable inbox. `accepted` records
receipt; `handled` records input processing. Neither proves the requirement was
delivered. Human questions preserve their interaction IDs and permissions;
PM cannot supply a Human approval using project management authority.
`workflow.check` exposes mechanical execution facts and declared evidence gaps,
not a proof of business quality.

User requirements have `in_progress`, `completing`, `completed` and `cancelled`
states. Run `completed` records execution completion only. PM uses
`workflow deliver --run <id> --revision <requirement.revision> --reason <conclusion>
--evidence delivery=<reference>` to confirm delivery. The advertised
`workflow.requirement.v1` capability includes the authenticated
`workflow.requirement.complete` RPC. The platform checks PM authority, revision,
active execution/cleanup and unanswered decisions; PM and business Reviewers
judge acceptance and references. A repeated identical decision is idempotent.

Patrol observes PM status, changing execution activity, inbox Run references and
the requirement decision clock. Input `handled` without a decision remains
unfinished. Only a user cancellation withdraws the goal; an Agent stopping its
execution leaves PM responsible. Settlement and writer release require a
terminal requirement, quiescent execution and handled notices. This prevents a
terminal Run save from releasing the writer between notice delivery and its
receipt commit. Completed requirements leave high-frequency Run reconciliation
without asking the platform to interpret industry acceptance contracts.

Current exception-recovery authority is derived from daemon-owned Run facts,
not an Agent's claim. It permits project PMs to manage workflows, experts and
related Sessions while an unresolved failure is present. Requirement completion, recovery admission, task projections and
settlement share the requirement-level conclusion.

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

A project becomes Workflow-enabled by cloning a package under
`.genethub/workflows/`, not by an initializer that writes assets into it.
`workflow list` reports what a project has cloned and `workflow build`
materializes one package's Spaces through the same no-overwrite writer. Neither
takes over the project: materializing Spaces and upgrading a package stay
explicit, approved actions.

## Business delegation and configuration control

A project with an existing takeover binding allows its ordinary root PM conversations to dispatch work. The runtime still rejects managed/cross-project callers and preserves per-requirement ownership, cancellation fences and budgets. Delegating work does not transfer the configuration controller or grant Builder/upgrade/component authority; those retain controller and exceptional-recovery checks.

Game Pack v5 routes `game/assessment` and `game/review` to Game Reviewer, returning reports without implementing changes. `workflow/review` remains process diagnosis/evaluation. Old projects use the standard digest-checked Pack upgrade; in-flight Run definitions are retained.
## Preparing another Executor

The built-in PM Skill prepares a candidate carrier through the existing Space
commands. `space open <absolute-directory-or-code-workspace>` exposes the existing
Workspace registration operation without creating a Session. A project's bound
ordinary PM may attach a newly built, uncomposed direct `spaces/` child to its
project tree, then configure its components with the existing revision plans.

For Builder writes, obtain `space builder build --name <space>
--require-no-post-commands --plan`, inspect `managementPlan`, then apply with
`--plan-digest`, `--expected-revision` and a stable `--action-id`. The plan binds
the project revision, target identity and planned source/output digests. Changed
facts require a new plan; replaying a completed action returns its recorded
report. Existing project management authority covers this build, while unbound
PM and managed Workers remain unable to use it. Active executions prevent
rebuilding their registered sources. Check/explain/verify remain inspection
operations; initialization and cleanup retain their existing authority rules.
To build a registered target such as the project PM itself, add
`--target-workspace <id>` and use that target's manifest name with `--name`.
This selects the existing Builder target field and grants no additional authority.
The RPC capability gate recognizes these narrowly scoped project management
operations. A bound PM can register a Builder-verified direct `spaces/` child;
it does not gain machine-wide Settings authority or access to unrelated roots.

Pack version 8 unifies default development into project-owned `game-dev`: a
single Executor Run reviews requirements, consumes a finite milestone plan,
implements and checks each fixed criterion, and carries accepted results through
bounded repair/replanning. The kernel contains no game or milestone rules. PM
delegates Workflow requirements to WM, aligns goals and budget, samples facts,
and corrects its own decisions and methods using existing history, get/check and
Builder/Space facilities. No additional PM state machine or ledger is required.
No-go/missing authorization can complete an assessment without publication;
PM must inspect `structure.outcome.value.done` before claiming delivery.
Budget amendments retain a terminal Run's execution cutoff; stopped waiting
does not become execution cost. The budget control message keeps its own time.

Graph-local awareness uses the readonly `request.budget` host capability, not a
new PM command or live engine variable. Its ordinary output records shared
limits/revision, observed calls, execution time, remaining bounds and observation
time. Admission, this query and `workflow check` use the same accounting. Once
committed the observation survives restart unchanged; a later task re-queries.
It does not reserve future calls or authorize budget expansion. Questions remain
visible with concurrent work; only all-active-Workers waiting with no pending
dispatch, cleanup or diagnostic work excludes the interval from execution time.
Independent acceptance checks and their concurrency/minimum-budget policy live
in Pack YAML; `entries` and serial folds aggregate results without an LLM. Current
same-Run recovery continues the original Worker Session after a daemon restart,
keeps any write lease, and does not replay completed nodes. It refuses to
continue while the previous Worker process is still running and does not
reconstruct project files.

The independent
`game-review-and-improve` Workflow starts with review and allows two repair and
re-review rounds. The report checker validates declared coverage and versions;
it does not attest execution of the referenced checks. See the installed PM and
Reviewer Skill references for their report and preparation contracts.

Upgrade uses versioned file digests, protects customizations and in-flight Runs,
and preserves old Run snapshots. Version 7 is an explicit upgrade source. Legacy
unreferenced YAML files in an upgraded project may remain for recovery; only
`game-dev` is the new default catalog entry. Installing a new daemon does not
rewrite a project's installed Skill or activate its customized candidate.
