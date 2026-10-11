# CodeBuddy script Agent

Drives Tencent's CodeBuddy CLI (`cbc`) for GeneHub. The protocol work is the SDK's shared
`genehub_agent.claude_family` (CodeBuddy speaks Claude Code's stream-json protocol); see its README. This directory
holds what is CodeBuddy's own.

| file | what lives there |
|---|---|
| `spec.py` | the `Flavor`, the ACP login script and the two pure helpers around it (`verdict_from_line`, `redact_line`) |
| `agent.py` | `CodeBuddyAgent`: login state, account login over ACP, API key with a service choice, logout |
| `replay.py`, `tests/*.json` | offline acceptance run by `boot.py <dir> test` |

## Behaviour that matters

- Same session shape as Claude, with three CodeBuddy differences: no `--permission-prompt-tool` (it asks through
  `can_use_tool` anyway), tool permission replies are read from `allowed` (we send both spellings), and the models and
  commands in `initialize` are `id`/`name` and carry a leading slash (stripped).
- Logged in means: `CODEBUDDY_API_KEY` is set, or the `initialize` answer has an account. That answer holds a bearer
  token, so only whether it exists is kept.
- Account login: a durable card asks the account type (Google/GitHub, WeChat, iOA), then `cbc --acp` runs under the Agent
  and is sent `initialize` + `authenticate`. The link arrives in the `_codebuddy.ai/authUrl` notification and is shown on
  a live card; the answer to `authenticate` is the verdict, so the card turns into logged in by itself when the person
  authorizes. Only fixed summaries of the protocol lines reach the log; nothing that could carry a credential does.
- API-key login is a password box plus a service choice (default, China, iOA); the key is exported as
  `CODEBUDDY_API_KEY`, the choice as `CODEBUDDY_INTERNET_ENVIRONMENT`.
- Logout is the stream-json `logout` control request (CodeBuddy has no logout subcommand).

## Checking a change

```sh
GENEHUB_AGENT_STATE=$(mktemp -d) python3 -I <sdk>/boot.py <this dir> test          # offline, against a scripted fake CLI
GENEHUB_AGENT_STATE=$(mktemp -d) python3 -I <sdk>/boot.py <this dir> test --live   # also probes the real CLI (read-only)
```
