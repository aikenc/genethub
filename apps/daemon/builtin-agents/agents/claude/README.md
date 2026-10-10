# Claude Code script Agent

Drives Anthropic's Claude Code CLI (`claude`) for GeneHub. The protocol work (sessions, translation, history, install,
update) is the SDK's shared `genehub_agent.claude_family`; see its README. This directory holds what is Claude's own.

| file | what lives there |
|---|---|
| `spec.py` | the `Flavor` (flags, config dir, sandbox variable) and how `claude auth status --json` is read |
| `agent.py` | `ClaudeAgent`: login state, account login, logout |
| `replay.py`, `tests/*.json` | offline acceptance run by `boot.py <dir> test` |

## Behaviour that matters

- One long-lived `claude --print --input-format stream-json ...` per session, started with the first prompt.
- Default permission mode is bypass (`--allow-dangerously-skip-permissions` with `IS_SANDBOX=1`, the CLI sandbox switched
  off by `--settings`); the person can switch to the ask mode, accept edits or plan. Tool prompts arrive as
  `can_use_tool` and reach the person; `AskUserQuestion` is always shown as a question.
- Logged in means: one of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` is set, or
  `claude auth status --json` says `loggedIn`.
- Account login: a durable card asks Claude subscription vs Console, then `claude auth login --claudeai|--console` runs
  under the Agent while a live card shows the link and a box for the code the page gives back. The code reaches the CLI
  only through its stdin. Cancel, 10 minutes or a daemon restart end the one login process.
- API-key login is a password box; the key is saved owner-only in the Agent's state dir, exported as `ANTHROPIC_API_KEY`,
  and forgotten by logout (which also runs `claude auth logout`).
- Install and update use npm (`@anthropic-ai/claude-code`) into GeneHub's own prefix; a CLI GeneHub did not install is
  replaced only after the person confirms.

## Checking a change

```sh
GENEHUB_AGENT_STATE=$(mktemp -d) python3 -I <sdk>/boot.py <this dir> test          # offline, against a scripted fake CLI
GENEHUB_AGENT_STATE=$(mktemp -d) python3 -I <sdk>/boot.py <this dir> test --live   # also probes the real CLI (read-only)
```
