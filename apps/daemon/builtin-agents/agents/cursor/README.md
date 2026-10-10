# Cursor script Agent

Drives Cursor's CLI (`cursor-agent`) for GeneHub over the serve protocol
(`docs/agent-serve-protocol.md`). Python ≥ 3.9, standard library only, async
everywhere; never print to stdout (use `ctx.log`).

| file | what lives there |
|---|---|
| `agent.py` | `CursorAgent`: state/refresh, catalog cache, actions (install, login, logout, update), background update check, sessions, import, `replay` hook |
| `cursor_print.py` | one print-mode process per turn: flags, prompt composition, attachments, stream-json → `SessionEvent`, interrupt note, `~/.cursor/cli-config.json` model guard, `CursorSession` |
| `models.py` | `--list-models` parsing, grouping into base model + efforts + Fast, `launch_slug`, legacy model id mapping |
| `usage.py` | token/TTFT/output-rate accounting (port of the daemon's `usage.rs` subset) |
| `lifecycle.py` | binary discovery, `status` login check, version/help probes, bounded streamed commands, login URL parsing |
| `acp_import.py` | minimal ACP client (`initialize`, `session/list`, `session/load|resume`) used only for history import |
| `replay.py`, `tests/*.json` | offline acceptance run by `boot.py <dir> test` |

## Behaviour that matters

- Each turn runs `cursor-agent --print --single-turn --output-format stream-json --stream-partial-output --force --sandbox disabled --trust --approve-mcps [--model <slug>] [--resume <chatId>] [--mode plan|ask]` with the prompt on stdin.
- Persist value is `{"chatId": "..."}`. Imported ACP handles are `{"sessionId", "resumable": false}`: the kernel then seeds the first prompt from GeneHub's own log, and the session starts a fresh chat. Never report `resumable: false` for a real chat.
- The picker shows base models; `launch_slug` maps model + effort + Fast back to an exact listed slug.
- The kernel passes saved selections through unchanged. `CursorSession._normalize_selection` migrates ids saved by the old ACP adapter (`grok-4.7[effort=high,fast=true]`, raw slugs), replaces unknown models/modes with the defaults, drops efforts and Fast the model lacks, and reports each change as `modelChanged`/`modeChanged`/`effortChanged`/`fastChanged` right after `session.start`.
- A canceled run is not in Cursor's history, so the next prompt carries an `<genehub_interrupted_turn>` note.
- The whole process group of a run is ended when the turn ends; a run still holding stdout 5 s after its `result` is ended too.
- Login links go only into the request card (`render="qr"`), never into job or stderr logs.
- Background updates only apply to a cursor-agent GeneHub installed; one the user installed is only updated by the explicit `update` action.
- `state.json` in the state directory holds the found program path, the last state, the last update check and `installedByGenehub` (set by the install action; only such a CLI is updated in the background — one the user installed is never auto-updated); `catalog.json` the last good model list.

## Checking a change

```sh
GENEHUB_AGENT_STATE=$(mktemp -d) python3 -I <sdk>/boot.py <this dir> test          # offline
GENEHUB_AGENT_STATE=$(mktemp -d) python3 -I <sdk>/boot.py <this dir> test --live   # also probes the real CLI (read-only)
```

Add a `tests/*.json` case (`kind`: `translate`, `models` or `helpers`; see
`replay.py`) for every stream-json shape you start handling.
