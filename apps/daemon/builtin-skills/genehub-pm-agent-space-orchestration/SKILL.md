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

Merge nodes that need the same context and writable branch. Split nodes when they can progress independently, need different Skills, or require an independent reviewer. Never pre-create Gameplay/UI/Test roles merely because the project is a game.

## Build and register a Space

1. Run `"$GENEHUB_CLI" agent-space init <name>` to create or validate the two required PipeBuilder inputs. Then edit `spaces/<name>/pipespace.json`, `<name>.code-workspace`, optional role source, and Git-managed Provider Skills for the actual work package. Keep the Space root first in the workspace folder list.
2. Run, in order, with the exact injected CLI:

   ```text
   "$GENEHUB_CLI" agent-space check <space>
   "$GENEHUB_CLI" agent-space explain <space>
   "$GENEHUB_CLI" agent-space build <space> --dry-run --require-no-post-commands
   "$GENEHUB_CLI" agent-space build <space> --require-no-post-commands
   "$GENEHUB_CLI" agent-space verify <space>
   ```

3. Commit only human-owned Space and Provider sources in the outer Space-management repository. Builder output and `.pipebuilder/` state remain ignored.
4. Register the verified `.code-workspace` with `workspace register-agent-space`, then record its workspace id, source commit, and lock digest in PM state.

```text
"$GENEHUB_CLI" pm project space record --name <space-name> --purpose <contract> \
  --path spaces/<space-name> --workspace <workspace-id> --commit <full-space-source-commit> \
  --role implementation|review
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

Bind that real session before treating work as running:

```text
"$GENEHUB_CLI" pm project package transition --id <package-id> --to running \
  --session <work-session-id>
```

After binding every currently-ready independent package, report briefly and end the PM turn so the user can guide or question the manager. Never run `sleep`, a timer, a foreground or background wait, a polling loop, or repeated `session get` commands inside a PM turn. Do not keep the PM model turn open while a WorkAgent works.

The daemon supervisor—not the PM model—owns monitoring. It samples quiet running sessions with bounded 30s, 1m, 2m, then 5m backoff. Unchanged health only advances the next daemon check; material changes arriving close together share one persisted batch wake. If a PM wake reaches the model but fails, dispatch retries use a separate persistent 30s, 1m, 2m, then 5m backoff; daemon reload interruptions remain immediately recoverable. Waiting-for-user and terminal packages have no periodic wake. On a supervisor wake, read the durable projection once, process every actionable package in the batch, inspect only terminal/failed sessions, then finish the turn again. A user message always takes priority.

For candidate review, launch the same package id in a different, recorded `--role review` Agent Space only after the implementation package is in `candidate`. A review-only Space cannot own implementation packages. It must include the exact candidate worktree in its `.code-workspace`; the daemon fixes the reviewer cwd to that worktree and rejects review in every implementation Space.

Freeze a review Agent Space's source commit, Builder lock, workspace id, and
candidate worktree set from dispatch until its verdict is recorded. Never
rebuild or re-record that node to squeeze another candidate into an active
review. Prefer one stable review Space that includes every already-known
candidate worktree, or add a new per-candidate review node. Topology remains
dynamic by adding/replacing nodes between evidence boundaries, not by mutating
the identity underneath a running WorkSession.
