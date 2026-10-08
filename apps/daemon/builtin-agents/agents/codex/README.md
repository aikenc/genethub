# Codex script Agent

Drives the OpenAI Codex CLI through its own `codex app-server` JSON-RPC
protocol. Wire protocol to the daemon: `docs/agent-serve-protocol.md`; SDK:
`<sdk>/genehub_agent/`. Python ≥ 3.9, standard library only, asyncio
everywhere (one process hosts every session — never block the loop, never
print to stdout).

## Files

| file | what it does |
|---|---|
| `agent.toml` | manifest (`protocol = 1`, label, entry) |
| `agent.py` | `CodexAgent`: state (`refresh`), actions `install` / `login` / `login-api-key` / `logout` / `update`, auth-file watcher, daily update check, `import.list` / `import.show`, and `replay()` for the offline tests |
| `lib/codex_appserver.py` | spawning `codex app-server`, the JSON-RPC client (`AppServer`), modes → `approvalPolicy` / `sandbox(Policy)`, `model/list` parsing, one-shot queries (catalog, import) |
| `lib/codex_translate.py` | pure frame → `SessionEvent` translation: `Translator` (turn state, items, deltas, usage, plan, compaction, thread/turn filtering against sub-agent threads) and `AskBook` (approvals and questions from the CLI, and the replies they need) |
| `lib/codex_session.py` | `CodexSession`: one conversation on one app-server; thread start/resume/unarchive/fork, `turn/start`, interrupt (incl. the rotated-turn retry), attachments → `localImage`, restart + `thread/resume` at the next turn boundary |
| `lib/codex_login.py` | device-code login (browser fallback with paste-back of the callback address), API-key login; all through Agent-level requests |
| `lib/codex_usage.py` | token / TTFT / output-rate accounting for one turn |
| `tests/*.json` | recorded app-server frame sequences and the events they must produce |

State kept in the Agent's state dir: `catalog.json` (last good state, pushed
at start before probing), `update-check.json` (last npm version check),
`npm/` (GeneHub's own npm prefix; a codex there wins over `PATH`).

## Behaviour worth knowing before changing things

- Background updates only apply to a codex GeneHub installed (under `npm/`);
  one the user installed elsewhere is only updated by the explicit `update`
  action. On Windows the background update is skipped while sessions are live.
- Every `turn/start` carries model, effort, approval policy and sandbox, so
  `set_model` / `set_mode` / `set_effort` only record the choice. The kernel
  passes stored selections through unchecked: a model / mode / effort the
  current catalog does not list falls back to the catalog default and the
  agent emits `modelChanged` / `modeChanged` / `effortChanged` (at session
  start and in `set_model` / `set_effort`). Persist values never carry
  `"resumable": false` — every Codex thread handle resumes natively.
- Notifications are matched against this session's `threadId` **and** the
  bound upstream turn; a sub-agent thread must never write to the root turn.
- Every request from the CLI gets a reply. Unrenderable ones (MCP
  elicitation, questions we cannot show, foreign/stale turns) get the
  least-authority answer.
- Not logged in does not fail a Codex turn, it hangs; hence `codex login
  status` in `refresh`, and `send` fails fast with `missingCredentials` when
  the last status said logged out.
- A long-running app-server keeps the token it started with. When
  `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) changes, or app-server
  stderr says `token_revoked` / `401 Unauthorized`, sessions are marked stale
  and restart + `thread/resume` at their next turn.
- Never log login output, links, codes or keys.

## Testing

```sh
genet agent test codex            # offline: manifest, import, tests/*.json via replay()
genet agent test codex --live     # also probes the real CLI and prints the state
genet agent reload codex          # pick up edits under user/codex
```

Without the CLI wrapper:
`GENEHUB_AGENT_STATE=$(mktemp -d) python3 -I <sdk>/boot.py <this dir> test`.

A test case is `{"thread", "steps": [...], "events": [...], "replies"?,
"state"?, "ignoreTypes"?}`. Steps: `{"begin": turnId}`, `{"frame": <raw
app-server frame>}` (a frame with `id` is a request from the CLI),
`{"turnStartResponse": {...}, "turnId"}`, `{"interrupt": true}`,
`{"respond": {"requestId", "outcome"}}`, `{"crash": message}`. Volatile
fields (`receivedAtMs`, TTFT / rate) are ignored. `"kind": "catalog"` and
`"kind": "turnInput"` cases test `model/list` parsing and attachment input.

Integration tests use the fake CLI `testing/infrastructure/agents/scripted-codex.mjs`.
