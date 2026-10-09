# Script Agent `serve` protocol (protocol 1)

Design and rationale: [agent-script-adapters-proposal.md](./agent-script-adapters-proposal.md).
This file is the wire reference. The Python SDK (`genehub_agent`, shipped in
`<data>/agents/sdk/`) implements all of it; an Agent author normally only
subclasses `Agent` / `Session`.

## 1. Directories

```
<channel data dir>/agents/
  builtin/<id>/   shipped with the daemon, rewritten on every start
  user/<id>/      user or Agent edits; replaces builtin/<id> as a whole
  state/<id>/     the script's own state; owner-only; survives reset
  sdk/            boot.py + genehub_agent/
  runtime/        the platform Python the installer put there, recorded in python.json
```

`<id>` matches `^[a-z][a-z0-9-]{1,31}$`. A directory is an Agent when it has
`agent.toml`:

```toml
protocol    = 1                  # required; also the SDK major version
label       = "Codex"            # required
description = "OpenAI Codex CLI" # optional
entry       = "agent.py"         # optional, default agent.py
icon        = "icon.svg"         # optional; svg or png inside the directory, at most 32 KiB
```

Edits under `user/` take effect only on `genet agent reload <id>`.
`genet agent reset <id>` deletes `user/<id>`.

## 2. Process

```
<python> -I -X utf8 <sdk>/boot.py <agent-dir> serve
```

- cwd: `state/<id>`. Environment: the daemon's, plus `GENEHUB_AGENT_ID`,
  `GENEHUB_AGENT_STATE`, and `GENEHUB_CLI` when bound.
- stdin/stdout: JSON-RPC 2.0, one object per `\n`. stderr: log
  (`genet agent logs <id>`). `boot.py` moves the pipes off fds 0/1 before
  Agent code runs, so stray prints and child processes cannot corrupt them.
- One process per Agent hosts every session of that Agent. Processes start
  the first time anyone asks for the Agent list or uses an Agent, not when
  the daemon starts: an unwatched daemon runs no Agent processes.
- The daemon only sends requests; the script only replies and notifies.
- Every request has a deadline. A missed deadline, an exit or a broken pipe
  is handled the same way: controlled restart, then `session.start` again for
  every live session with its last `resume` value. A turn in flight at that
  moment fails with `agentCrashed`.
- Repeated crashes of a `user/` override fall back to `builtin/`.
- The daemon ends the process with SIGTERM, then SIGKILL. Processes an Agent
  starts through `genehub_agent.process.spawn` belong to the session whose
  request started them: they are ended on `session.close`, and on SIGTERM or
  exit of the script.
- A `session.start` the caller gave up on (the user stopped while the CLI was
  starting) is followed at once by `session.close`; the SDK cancels the
  pending start.

## 3. Daemon → script requests

| method | params | result | deadline |
|---|---|---|---|
| `initialize` | `{protocol, agentId, channel, os, arch, agentDir, sdkDir, stateDir, frontDoorCli?}` | `{protocol: 1}` | 30 s |
| `refresh` | `{}` | `{}` (state follows as a notification) | 10 s |
| `action.run` | `{action}` | `{job}` (progress follows) | 10 s |
| `action.resume` | `{job, action, step, outcome, secretIds}` | `{job}`; starts a fresh job execution | 10 s |
| `request.prepared` | `{id, error?}`; acknowledgment of committed preparation | `{}` | 10 s |
| `request.answer` | `{id, outcome}` | `{}` | 10 s |
| `session.start` | `{sessionId, config}` | `{}` | 120 s |
| `session.send` | `{sessionId, turnId, text, attachments}` | `{}` | 30 s |
| `session.interrupt` / `session.close` | `{sessionId}` | `{}` | 15 s |
| `session.setModel` | `{sessionId, modelId}` | `{}` | 15 s |
| `session.setMode` | `{sessionId, modeId}` | `{}` | 15 s |
| `session.setEffort` | `{sessionId, effortId}` | `{}` | 15 s |
| `session.setFast` | `{sessionId, fast}` | `{}` | 15 s |
| `session.setRuntimeAxis` | `{sessionId, axisId, valueId}` | `{}` | 15 s |
| `session.respond` | `{sessionId, requestId, outcome}` | `{}` | 15 s |
| `session.fork` | `{sessionId, checkpoint}` | `{persist}` | 60 s |
| `import.list` | `{cwd, limit}` | `{candidates: [...] \| null}` | 15 s |
| `import.show` | `{cwd, sourceId}` | `ImportedHistory` | 120 s |
| `shutdown` | `{}` | `{}`, then exit | 3 s |

`session.start.config` (all paths absolute, host form):
`{cwd, scratchDir, modelId?, modeId?, effortId?, fast?, runtimeValues, additionalSystemPrompt?, skillsDir?, frontDoorCli?, controllerToken?, resume?}`.

`session.send`: the daemon has already emitted `turnStarted{turnId}`. The
script emits the turn's items and exactly one of `turnCompleted`,
`turnFailed`, `turnCanceled` for that `turnId`. `attachments` are
`Attachment` objects (`{name, mime, dataBase64?, path?}`).

Stored runtime choices are passed through unchanged: the daemon does not
replace a `modelId` / `modeId` / `effortId` / runtime value the current
catalog no longer lists. The script migrates or falls back itself and emits
`modelChanged` / `modeChanged` / `effortChanged` / `fastChanged` /
`runtimeAxisChanged` so the session's record follows.

A `resume` (persist) value carrying `"resumable": false` is one the script
cannot continue natively (for example an imported history). The daemon then
seeds GeneHub's own log into the first prompt instead.

`session.respond.outcome` is a `PermissionOutcome`
(`{"outcome":"selected","optionId"}` / `{"outcome":"answered","answers":[...]}` / `{"outcome":"canceled"}`).

`import.list` candidates: `{sourceId, title, preview, updatedAtMs, continuation: "native"|"readOnly"}`.
`import.show` result: `{title?, createdAtMs, updatedAtMs, items: TimelineItem[], persist?, continuation, warnings: string[]}`.

`request.answer.outcome`: `{"type":"answered","optionId","answers":[{questionId, selectedOptionIds, freeformText?}]}` or `{"type":"canceled"}`.

## 4. Script → daemon notifications

| method | params |
|---|---|
| `state` | `{ready, message?, version?, actions: [{id, label, primary?}], capabilities: Capabilities, catalog: Catalog}` |
| `job.progress` | `{job, action?, phase?, percent?, message?, log?, done?, error?}` |
| `request.open` | `{id, title, detail?, display: [{kind: link\|code, value, label?, render?}], questions: [{id, prompt, options?, allowMultiple?, input?: text\|secret}], options: [{id, label}]}` |
| `request.close` | `{id}`; closes legacy ephemeral requests only |
| `request.prepare` | `{request: AgentUserRequest (no display), job, action, step}`; saves a stopped:false obligation before unwinding |
| `request.suspend` | `{request: AgentUserRequest (no display), job, action, step}`; action has unwound and owned children have stopped |
| `session.event` | `{sessionId, event: SessionEvent}` |
| `session.persist` | `{sessionId, value}` — returned later as `config.resume` |
| `session.pid` | `{sessionId, pid \| null}` — the CLI's native pid |

`Capabilities`, `Catalog`, `SessionEvent` are exactly the types in
`packages/proto` (`bindings/index.ts`). The daemon deserializes every event;
one that does not fit is dropped and logged.

Only `ready: true` Agents can be picked or routed to. When not ready, the
action marked `primary` is offered next to `message`. The platform knows no
action names — install, update and login are all ordinary actions.

## 5. Agent-level requests

`request.suspend` is the durable Agent-action path. The SDK's `ctx.ask(job,
step, ...)` first sends `request.prepare` and waits at most ten seconds for the
daemon's `request.prepared` persistence acknowledgment. It then exits the action
at a checkpoint, unwinds its `finally` blocks and verifies its owned process
groups (including surviving grandchildren) have stopped before sending
`request.suspend`. Only this final confirmation publishes the Human card.
The shared serve process can continue to serve other sessions, but no job
coroutine, login CLI or waiting RPC keeps the question alive.

The daemon atomically saves the non-secret request, stable job/action/step,
`stopped`, the loaded adapter/SDK byte revision and consumption state in `agents/pending/<agent-id>.json` before showing the card.
A script crash or daemon restart preserves a confirmed unanswered request with
the same ID. A crash during preparation/cleanup preserves `stopped:false`, reports
unknown stop and does not show a waiting card or automatically repeat the action.
The process/state must be inspected before retiring or repairing that record. The job has `phase: "waiting"`, `done: false`; this denotes a stopped
obligation, not an active execution or deadline to answer.

The first authorized answer is validated against the saved question and current
code revision, then marked consumed on disk before
`action.resume` is dispatched. Ordinary answers are retained; secret answers
are omitted from that record and passed only to the new script execution.
A duplicate or late answer is rejected. Changed adapter/SDK code cannot consume
an old approval or secret; the old card stays available for cancellation and
requires a fresh confirmation for the new revision. Stale cancellation retires
the obligation without executing changed code. An unknown external result is retained
as `phase: "unknown"` and never automatically replayed. A corrupt record is
preserved, blocks new actions and can be repaired through reload. Successful
completion removes the consumed continuation. Multistep scripts override
`resume_action` to jump to the saved step; they must not repeat earlier effects.

Suspended requests cannot contain temporary authorization links/codes or other
`display` material. Static question text and recovery metadata must not carry
credentials. No model, timeline, log or CLI command receives the answer.

`request.open`/`request.answer` and `ctx.request` remain compatible protocol-1
**ephemeral** interfaces. They keep an in-memory Future and do not satisfy the
long Human-pause contract. Custom scripts need to migrate to `ctx.ask` before
claiming durable interaction support. Built-in installation confirmation and
Codex API-key entry now use that durable path. Account OAuth/device login in
current Codex/Cursor cannot resume a stopped upstream CLI: the card explicitly
reports that workbench account login is unsupported, and offers cancellation
or a recheck of externally obtained local credentials. It never retains a login
CLI and does not introduce a terminal-login fallback. This is a capability gap,
not a passed account-authorization journey.

Who may do what: `agent.logs`, `agent.test` and `agent.reload` need the
Session capability. Agent-list replies and pushes to Read-only peers omit CLI
log tails, job messages/errors and private probe reasons. The built-in Agent can repair a script Agent from a
session. `agent.action`, `agent.reset`, `agent.requests` and
`agent.requestAnswer` need Settings; a session-bound caller is always refused
the two request verbs. The daemon refuses requests over its size bounds (title
and labels 200 bytes, text 2 KB, QR values 1 KB, at most 8 display items,
questions or options, at most 8 open requests per Agent).

Requests inside a conversation (tool approval, a question) are ordinary
`permissionRequested` session events and keep the existing pause/resume
behaviour in [architecture.md](./architecture.md) §3.4: the daemon persists the
request and native resume handle, interrupts and closes the session execution,
then exposes the pending request. The same logical Session / user round remains
waiting without a pending RPC, session CLI, or client connection. A Human answer
is saved before acknowledgement and starts a new execution from that durable
state. The `session.respond` method does not require retaining the original
upstream request while waiting for a person. Normal daemon shutdown preserves
the pending decision; explicit cancellation or session closure ends the
continuation obligation.

## 6. Python runtime

The daemon never installs Python. The installers and the dev tooling run
`scripts/python-runtime/install-python.sh` (`install-python.ps1` on Windows),
which unpacks the pinned build under `<data>/agents/runtime/` and records the
interpreter in `<data>/agents/runtime/python.json` as `{"python": "<absolute
path>"}`. Before every start the daemon reads that file and starts the script
as `<python> -I -X utf8 sdk/boot.py <agent> serve`. When the file or the
interpreter it names is missing, the Agent is unavailable with the reason
"Python 运行时未安装" and nothing is downloaded. The version and SHA-256 are
pinned in `scripts/python-runtime/python.pin`; see
[python-runtime.md](./python-runtime.md).

## 7. Public conversation question entry

`genet session ask <id> --request-id <stable-id> --question <text>
[--choice <label>]... [--title <text>] [--no-text]` calls `session.ask` with
`{sessionId, requestId, title, questions: InteractionQuestion[]}`. Text is enabled
by default. A session controller can ask only in its own active Session. It
cannot answer a question or approve a plan on Human's behalf. Read-only Workflow
child Sessions keep their existing Workflow Human exit.

The daemon uses the existing durable Session interaction path: save the request
and continuation, stop current execution and children, then publish the card.
Native Codex request IDs are scoped to a fresh CLI generation so its reused
upstream RPC counter cannot revive an old timeline card. The original caller
may be stopped before receiving its RPC acknowledgment;
inspect `session.get` for the durable question instead of retrying with a new
ID or polling for Human's answer. Reusing an ID requires the identical payload.
The Human answer starts a fresh execution in the same Session without changing
its mode/authority. Explicit close/cancel retires the obligation; daemon shutdown
preserves it. Secret credentials belong to Agent settings, never this interface.

Codex enables its real Default-mode `request_user_input` capability and its
experimental app-server interface; the platform guidance names the native tool
and CLI fallback. A real-model canary separately verifies natural-language
discovery. Forced mock function calls establish mechanism only.
