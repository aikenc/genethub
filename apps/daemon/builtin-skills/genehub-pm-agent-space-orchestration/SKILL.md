---
name: genehub-pm-agent-space-orchestration
description: Create and evolve a minimal dynamic Agent Space topology, local Git branches/worktrees, Agent Space Skills, and PM-controlled third-party WorkAgent sessions through GeneHub's public CLI. Use in a PM session when initializing spaces, dispatching or resuming work, adding parallel or review roles, choosing an installed Coding Agent, or recovering stalled work.
---

# Orchestrate Agent Spaces and WorkAgents

Agent Space is a user-visible Workspace role, not an Agent runtime and not a fixed team slot. Generate the smallest topology that satisfies the current task graph and risk.

Read [references/agent-space-contract.md](references/agent-space-contract.md) before creating or changing a Space.
For an H5 game delivery or engine migration, also use the small-model decomposition heuristics in [references/h5-game-recipe.md](references/h5-game-recipe.md). It is a starting pattern, never a fixed topology.

## Design the topology

For every proposed node, name:

- responsibility and explicit non-responsibilities;
- input commits/artifacts and output contract;
- repository, branch, and isolated writable worktree;
- Agent Space Skills needed for that responsibility;
- upstream dependencies and downstream consumer;
- completion and review gate.

Give every Space explicit capability tags when its responsibility is narrower
than the Workflow node's base selector. Keep each Space's Skills and workspace
folders limited to that capability and its exact package worktree; do not make
all implementation Spaces general-purpose just to let the PM choose among
them. A fanout package requests its capability with `package put --space-tag
<capability>`, and the Coordinator chooses the concrete idle Space.
The package names only its business repository and branch. After `package put`
returns the Coordinator-selected `agentSpace` and derived `worktree`, create the
Git worktree at that exact path before moving the package to `ready`. This
allocation-first sequence prevents the PM from guessing a physical Space and
prevents another Session from claiming the same Space between planning and
dispatch.

Merge nodes that need the same context and writable branch. Split nodes when they can progress independently, need different Skills, or require an independent reviewer. Never pre-create Gameplay/UI/Test roles merely because the project is a game.

Before fixing the number of parallel workstreams, read the selected Run's
`resourceCapacities` from one `pm project workflow status`. For each WorkAgent node,
`availableSlots` is the number of base-capability packages that the Coordinator
can allocate now after fanout and cross-Session exclusions; package-specific
`--space-tag` requirements may reduce it further. If the desired fanout exceeds
that value, either build and record the missing specialized Spaces first or
reduce the current cohort. Never probe capacity by repeatedly issuing failing
`package put` commands, and never treat `maxItems` as guaranteed capacity.

Also read the Run's immutable execution budget before dispatch. The
Coordinator enforces both total and concurrently active WorkSession counts.
Each dispatch reservation consumes one total slot even if provider/session
creation later fails; clearing a binding or retrying never refunds that slot.
Prefer independent, result-sized packages that can finish inside the remaining
wall-clock window; do not split a bounded task into checkpoint-sized sessions.
When the Run enters budget exhaustion, stop planning and let the Coordinator
interrupt exact owned sessions and settle their Space leases.

## Build and register a Space

The registered AgentSpace pool is project-scoped. Before building or
registering anything, read `pm project show`: a sibling PM Session must reuse
an existing compatible recorded Space and its workspace id. Re-running
`workspace register-agent-space` for the same active source is only an
idempotent rediscovery; it does not transfer rename/removal ownership. Do not
rebuild, re-register, or re-record shared Spaces merely because the current
requirement has a different PM Session id.

### Pool-only bootstrap fast path

When the user explicitly asks only for a shared pool scaffold and supplies the
final Space names, roles, capability tags, repository, branches, and worktree
paths, treat that mapping as the complete topology contract for this step:

- do not inspect business source files, infer architecture, or create
  speculative project/Provider Skills;
- capability tags are Coordinator registration metadata and do not require a
  same-named Skill; use the minimal `agent-space init` inputs unless the user
  explicitly supplies a package-specific Skill;
- create each supplied local Git branch/worktree first, then place only that
  exact worktree beside the Space root in the corresponding
  `.code-workspace`;
- a pre-provisioned review Space is allowed only when it declares the same
  capability tag as one implementation Space and contains only that exact
  implementation worktree; never place all sibling worktrees in one reviewer;
- batch homologous init, check, dry-build, build, verify, register, and record
  operations. Read a documented command contract once and do not spend model
  turns probing invalid flag combinations;
- treat the command forms and ignore list below as authoritative. Never
  recursively scan product source, build output, dependency trees, or the
  installation directory to rediscover them.

This fast path creates deterministic capacity, not permission to dispatch
underspecified work. Before execution, every WorkPackage still needs a
self-contained contract and must pass the normal package, worktree, lease,
candidate, and review gates. If branch/worktree identity is not known, use the
normal allocation-first flow below instead of inventing speculative paths.

1. Run `"$GENEHUB_CLI" agent-space init <name>` to create or validate the two required PipeBuilder inputs. Then edit `spaces/<name>/pipespace.json`, `<name>.code-workspace`, optional role source, and Git-managed Provider Skills for the actual work package. Keep the Space root first in the workspace folder list.
2. Run, in order, with the exact injected CLI:

   ```text
   "$GENEHUB_CLI" agent-space check <space>
   "$GENEHUB_CLI" agent-space explain <space>
   "$GENEHUB_CLI" agent-space build <space> --dry-run --require-no-post-commands
   "$GENEHUB_CLI" agent-space build <space> --require-no-post-commands
   "$GENEHUB_CLI" agent-space verify <space>
   ```

3. Before the first pool commit, keep the outer repository's existing entries
   and ensure these generated/runtime paths are ignored exactly once:

   ```gitignore
   .genethub/
   repositories/
   worktrees/
   spaces/*/.pipebuilder/
   spaces/*/.agents/
   spaces/*/.claude/
   spaces/*/.codebuddy/
   spaces/*/.cursor/
   spaces/*/AGENTS.md
   ```

   Commit only human-owned Space and Provider sources in the outer
   Space-management repository. Do not recursively search another repository
   for an ignore template.
4. Register each verified Workspace with this exact public command, relative
   to the project root, then record its workspace id, source commit, and lock
   digest in PM state:

   ```text
   "$GENEHUB_CLI" workspace register-agent-space "spaces/<name>/<name>.code-workspace"
   ```

```text
"$GENEHUB_CLI" pm project space record --name <space-name> --purpose <contract> \
  --path spaces/<space-name> --workspace <workspace-id> --commit <full-space-source-commit> \
  --role implementation|review [--tag <capability>...]
```

Builder does not create Git repositories, branches, worktrees, or commits. Use ordinary Git for those responsibilities and verify every target path before mutation.

## Select and drive a WorkAgent

Read `agent list`; choose a ready third-party Coding Agent and an allowed efficiency-tier model for this package. If none is ready, preserve the package and guide installation/login, refresh the catalog, then resume it.

Create the managed session only through the public CLI:

```text
"$GENEHUB_CLI" pm project package transition --id <package-id> --to ready
"$GENEHUB_CLI" agent run --agent <id> --model <model> \
  --workspace <agent-space-id> --work-package <package-id> --no-wait "<work contract>"
```

The quoted argument form is only for a short prompt with no shell
metacharacters. For every multiline contract, or any prompt containing
backticks, `$`, quotes, or shell syntax, use explicit stdin and a single-quoted
heredoc delimiter:

```text
"$GENEHUB_CLI" agent run --agent <id> --model <model> \
  --workspace <agent-space-id> --work-package <package-id> --no-wait \
  --message - <<'GENEHUB_PROMPT'
<literal work contract, including `commands` and $VARIABLE names>
GENEHUB_PROMPT
```

Never interpolate a WorkAgent contract into a double-quoted shell argument.
Do not pipe the heredoc; `--message -` is the explicit public-CLI stdin
contract.

The daemon resolves the session cwd from the package's exact registered worktree; never try to redirect it with `--cwd`. Save the returned session id before doing anything else. Continue the same execution only with a top-level non-blocking command:

```text
"$GENEHUB_CLI" session send <work-session-id> --no-wait "<next checkpoint>"
```

Apply the same `--message - <<'GENEHUB_PROMPT'` form to a multiline or
shell-sensitive continuation.

The initial contract owns the complete outcome through a clean immutable
candidate, not one tiny checkpoint. It must name the owned paths, frozen
interfaces, observable acceptance checks, exact candidate gate, and evidence
bundle. The WorkAgent may create internal checkpoint commits, but those are
recovery details: do not wake or continue it merely because a checkpoint
appeared. A normal implementation session should return only when it has one
of these package-level outcomes:

- `candidate`: clean HEAD/tree plus the requested gate and artifact evidence;
- `blocked`: a concrete external/contract decision it cannot safely make;
- `failed`: a terminal runtime/tool failure with the last recoverable commit.

If the runtime turn cap ends a non-terminal attempt, resume the same
WorkSession with its original whole-package contract and latest Git facts. Do
not turn every remaining file, test command, or commit into a new PM-managed
round. After two capped continuations without a new committed checkpoint or a
changed diagnosis, stop repeating the contract and split or re-plan the
package.

Never omit `--no-wait`, and never wrap this command in `timeout`, a pipe, command substitution, a background job, or another waiting construct. Inspect a session with one bounded `session get` or history command when reconciling evidence. Never use a hidden prompt queue, write an Agent's private session files, or let two PM packages share a writable worktree.

A successful top-level `agent run --work-package` atomically binds that
WorkSession to its reserved package before returning: a `ready` implementation
package enters `running`, while a `candidate` package enters `review` with its
exact immutable commit/tree and Review WorkSession identity. The leased Agent
Space enters `working` in the same Project State mutation. Do not issue a
second package transition merely to bind the returned session id. If session
creation fails, the reservation is cancelled and the package remains eligible
for a later dispatch.

After binding every currently-ready independent package, report briefly and end the PM turn so the user can guide or question the manager. Never run `sleep`, a timer, a foreground or background wait, a polling loop, or repeated `session get` commands inside a PM turn. Do not keep the PM model turn open while a WorkAgent works.

The daemon supervisor—not the PM model—owns monitoring. It samples quiet running sessions with bounded 30s, 1m, 2m, then 5m backoff. Unchanged health and material-but-non-actionable changes (for example a just-bound WorkSession that is still Running) only advance the observation baseline; candidate, block, failure, terminal, integration, or user-decision facts arriving close together share one persisted batch wake. If a PM wake reaches the model but fails, dispatch retries use a separate persistent 30s, 1m, 2m, then 5m backoff; daemon reload interruptions remain immediately recoverable. Waiting-for-user and terminal packages have no periodic wake. On a supervisor wake, read the durable projection once, process every actionable package in the batch, inspect only terminal/failed sessions, then finish the turn again. A user message always takes priority.

For candidate review, use a different, recorded `--role review` Agent Space
after the implementation package is in `candidate` and its implementation
lease has returned. A review-only Space cannot own implementation packages.
It must declare every capability tag requested by that package and include the
exact candidate worktree in its `.code-workspace`; the daemon fixes the
reviewer cwd to that worktree, matches package capabilities again, and rejects
review in every implementation or generic non-matching review Space.

Normally create or freeze the reviewer only after the candidate exists. The
pool-only fast path may pre-register a reviewer when its exact future
repository, branch, worktree, and capability are supplied and immutable. This
is a dedicated pre-bound reviewer, not a broad speculative review pool: do not
include sibling worktrees or omit the matching capability tag.

Freeze a review Agent Space's source commit, Builder lock, workspace id, and
candidate worktree set from dispatch until its verdict is recorded. Never
rebuild or re-record that node to squeeze another candidate into an active
review. Reuse it only when the exact candidate worktree was already present at
the evidence boundary; otherwise add a per-candidate review node. Topology
remains dynamic by adding/replacing nodes between evidence boundaries, not by
mutating the identity underneath a running WorkSession.
