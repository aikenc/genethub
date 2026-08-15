# Session history CLI

`genet session` is GeneHub's deterministic, read-only session analysis surface. It reads through the local daemon, never loads provider credentials and never calls an LLM. Agent-specific analysis belongs in a normal Agent session; the CLI supplies bounded facts and durable addresses.

## Commands

```bash
genet session inspect <session-id> [--through-round <round-id>]
genet session narrative <session-id> [--through-round <round-id>] [--item <item-id> | --cursor <cursor>] [--limit <n>]
genet session rounds <session-id> [--through-round <round-id>] [--cursor <cursor>] [--limit <n>]
genet session trunks <session-id> --round <round-id> [--cursor <cursor>] [--limit <n>]
genet session trunk <session-id> --round <round-id> --index <n>
genet session blob <session-id> --ref <opaque-ref>
genet session context <session-id> [--through-round <round-id>] [--budget-tokens <n>]
```

All results use the `genet.cli/v1` envelope. `genet schema session.context` and the other schema names are available without a running daemon; dynamic reads require the loopback daemon.

## Reading strategy

Start with `inspect`, then use `context` or a small narrative/round page. Follow `nextCursor` backward. Open a trunk only when process detail matters; resolve a blob only from an opaque `blobRefs[].ref` returned by `session trunk`. The CLI does not accept paths or caller-constructed blob offsets.

`--through-round` freezes a historical boundary. Each result identifies its source session, boundary, digest and untrusted status. Context projections carry `ghref:item:<session-id>:<item-id>` references; resolve one with:

```bash
genet session narrative <session-id> --item <item-id>
```

`coverage` distinguishes full history from a clipped/imported view and says whether omitted detail is available through GeneHub, an external source, only the native Agent, or nowhere. Callers must not infer unavailable detail.

## Built-in Agent integration

The built-in `genehub-session-history` Skill contains the analysis SOP and is exposed as `/skill:genehub-session-history`. The daemon supplies `GENEHUB_CLI` and `GENEHUB_SESSION_ID` to the Agent.

`/compact` is routed to the built-in Agent's compact control command. It obtains the same deterministic context projection, forces the Skill into a private `Session::in_memory` child run with tools disabled, and appends the resulting cited summary as a compaction entry. The child run creates no session file and never appears in GeneHub history. If model analysis is unavailable, the deterministic projection itself is retained as the fallback.
