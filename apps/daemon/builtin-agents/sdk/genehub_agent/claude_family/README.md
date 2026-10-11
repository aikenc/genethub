# claude_family

Everything two Agents share because their CLIs speak the same protocol: Claude Code's `--print --input-format stream-json
--output-format stream-json` (CodeBuddy's `cbc` implements it too). The Agent directories (`agents/claude`,
`agents/codebuddy`) only say what differs: a `Flavor` (binary names, npm package, config directory, flags), how to tell
whether the CLI is logged in, and how to log in and out.

| file | what lives there |
|---|---|
| `flavor.py` | `Flavor`: the differences as data (binaries, npm package, config dir and its variable, bypass flag, permission-prompt tool, sandbox variable, project-key encoding) |
| `catalog.py` | `initialize` control request against a throwaway process (models, commands, current model, account), permission modes read from `--help`, handshake args |
| `translate.py` | frames → `SessionEvent`s: streamed text and thinking (items open lazily), tool cards and their details, TodoWrite, sub-agent folding, compaction, usage and errors, permission and AskUserQuestion requests |
| `session.py` | `FamilySession`: one process per session, started with the first prompt, relaunched with `--resume` after it dies; controls (`set_model`, `set_permission_mode`, `interrupt`) with timeouts; the interrupt watchdog; permission replies in both CLIs' spelling |
| `history.py` | the CLIs' own session files: project keys exactly as each CLI makes them, list and import |
| `agent.py` | `FamilyAgent`: state/refresh, catalog cache, install, update (own copy, rollback), login/API-key/logout actions around the hooks an Agent supplies |
| `replay.py`, `fakecli.py` | the offline test runner and a scripted stand-in for the CLI (turns, permissions, crashes, `auth login`, `--acp`, logout) |

Tests live with each Agent (`agents/<id>/tests/*.json`); the case kinds are listed at the top of `replay.py`.
