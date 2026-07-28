# @genehub/proto

The client session protocol, defined once.

Rust is the source of truth (`src/`); the TypeScript in `bindings/` is generated
from it and **must not be edited by hand**. Writing the protocol twice is how
frontend and backend drift apart around the third field rename.

## Regenerating

```bash
cargo test -p genehub-proto
```

The generated files are committed so that a TypeScript-only checkout still
type-checks without a Rust toolchain. CI runs `npm run check`, which regenerates
and fails if the result differs from what is committed.

## What lives here

| Module | Contents |
|--------|----------|
| `timeline.rs` | `TimelineItem`, `ToolCallDetail` — the normalized view every adapter translates into |
| `event.rs` | `SessionEvent`, `SequencedEvent`, permissions, usage |
| `domain.rs` | Agents, workspaces, sessions, files, git |
| `rpc.rs` | The request/reply envelope and error codes |

## Conventions

- Wire format is camelCase; Rust stays snake_case.
- `Option` fields are omitted rather than sent as `null`.
- 64-bit integers are annotated `#[ts(type = "number")]`: `serde_json` writes
  them as plain JSON numbers, so mapping them to `bigint` would be wrong.
- `ToolCallDetail::Unknown` is load-bearing. An agent we have never seen must
  still render, so nothing is ever dropped for lack of a renderer.
