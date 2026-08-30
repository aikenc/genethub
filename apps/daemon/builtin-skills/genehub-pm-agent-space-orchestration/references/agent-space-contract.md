# Agent Space contract

## Disk ownership

```text
<project-root>/
  spaces/<name>/                 outer management Git repository
    pipespace.json               human-owned source
    <name>.code-workspace        human-owned source; `.` first
    .pipebuilder/                local override, lock, cache, generated state
  skills/<space>/<skill>/        Git-managed Provider Skill source
  repositories/<repo>/           independent local business Git repository
  worktrees/<space>/<repo>/      isolated business worktree
```

The outer repository ignores `.genethub/`, `repositories/`, `worktrees/`, every Space `.pipebuilder/`, and generated Agent targets. Multiple Agent Spaces share this one outer repository; they are not independent management repositories.

## Runtime and session ownership

- The AgentSpace registry and dispatch pool belong to the project, not to one
  requirement Session. Sibling PM Sessions may reuse an active recorded Space
  through Coordinator allocation. The Session that first registered the
  Workspace retains rename/removal authority, so idempotent rediscovery never
  transfers destructive ownership.

- `pipespace.json.agents` means Builder targets, not a bound WorkAgent. The
  PipeBuilder v1 target ids are exactly `codex`, `cursor`, `codebuddy`, and
  `claude-code`; never put `opencode` or another daemon runtime id there. For
  an OpenCode WorkAgent, select the `codex` Builder target so the Space emits
  the runtime-neutral `AGENTS.md`, then still dispatch `--agent opencode` from
  the live daemon catalog.
- Select the runtime at dispatch from the daemon's live Agent catalog.
- A PM-bound CLI may create WorkSessions only in its registered Agent Spaces. Each recorded Space is explicitly `implementation` or review-only; this role belongs to the topology, not to the selected runtime.
- The daemon authorizes every new WorkSession against an active durable work
  package and fixes its cwd to that package's exact worktree. The package asks
  for semantic capabilities, while the Coordinator combines those tags with
  the Workflow node selector, atomically assigns the concrete Space, and
  derives `worktrees/<space>/<repository>` from the package repository. The PM
  creates that returned worktree and adds the exact path to the assigned
  Workspace before the Ready gate. A ready package starts only in that
  assigned implementation Space; a candidate starts only in a different
  review-only Space whose declared capability tags include the package tags
  and whose Workspace already contains that exact worktree.
- Users may read and fork WorkSessions and may open ordinary sessions in the same Agent Space. They cannot mutate the managed WorkSession or remove the Agent Space.
- A normal user session that changes a managed worktree is an external project change: pause affected packages, invalidate stale candidates/reviews, and rebaseline explicitly.

## Host process ownership

- Every WorkSession records the exact PID or process group and port for each host process it starts.
- A WorkSession may stop only an exact process it started and still owns. Never use `pkill`, `killall`, broad name/path matching, or a repository-wide cleanup command.
- When ownership cannot be proven, leave the process intact, select an unused port or other isolated resource, and report the conflict as evidence.
- The PM follows the same rule and must not instruct a WorkAgent to perform broad process cleanup. Project-owned shared and slice Skills must carry this constraint whenever their checks may launch a server, browser, watcher, or other persistent process.

## Safe evolution

Topology truth is the outer Git commit plus each Builder lock. Add, split, merge, or stop dispatching to nodes as the graph changes. MVP never physically deletes a registered Agent Space.

Once a WorkSession is dispatched, keep that Space's source commit, Builder
lock, workspace id, and worktree membership immutable through the package's
current evidence boundary. In particular, never rebuild or re-record a review
Space while one of its review sessions is running or its verdict has not yet
been recorded. Do not expose all sibling worktrees and all project Skills to
every implementation Space. Add a new review node for a new candidate unless
the stable review Space already contained that exact candidate worktree when
it was recorded. A deterministic pool bootstrap may pre-record a dedicated
review Space only when its future branch/worktree and capability are already
fixed; it must contain that one worktree, not a broad or speculative set.
