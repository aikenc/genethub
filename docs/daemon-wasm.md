# GeneHub daemon Rust/Wasm architecture

Status: implemented vertical platform and product integration; business migration in progress  
Decision date: 2026-08-15

## Decision

GeneHub daemon uses native Rust plus a signed Rust/Wasm application:

- one native process and one Wasmtime `Engine`;
- initially one deployable `daemon-logic.wasm` (`K = 1`);
- any number of normally dependent safe-Rust source crates (`N`);
- one artifact built and signed on Linux, consumed byte-for-byte on every
  supported native platform;
- no native restart for logic replacement or rollback.

`crate`, `artifact` and `instance` are different units. `common`, `core` and
business crates are source boundaries and use ordinary Rust calls. They do not
become separate Wasm files. More artifacts are allowed only when a domain has
independent state, compatibility, update and rollback requirements and a narrow,
low-frequency boundary. Line count alone is not a reason to split.

Future game projects may use native Rust for the non-GC engine and TypeScript
for the GC/gameplay layer. That is a separate choice and does not add V8 or a
WebView dependency to daemon.

## Landed architecture

```text
signed daemon-logic.wasm (one physical file)
  └─ daemon-logic entry
       ├─ daemon-core
       ├─ daemon-common
       ├─ daemon-logic-api
       └─ genehub-proto
                 │ one bounded input + one bounded output per event
                 ▼
native LogicHost
  └─ daemon-platform
       ├─ artifact signature and canonical single-file parser
       ├─ Wasmtime/Winch engine and compiled-module cache
       ├─ memory, table, stack, message and fuel limits
       ├─ active/previous durable slots
       └─ candidate, snapshot/restore, switch and recovery
```

The application ABI uses fixed scalar Wasm exports plus linear-memory offsets.
Complex requests, replies and strings cross once as a bounded serialized batch;
there is no host function per string, field or business service. The current
guest is self-contained core Wasm with zero imports, so its Linux-built bytes
are independent of libc, Windows, macOS and CPU architecture.

The signed envelope is the final standard Wasm custom section. The result stays
a valid `.wasm`, while canonical decoding rejects missing, duplicate, reordered,
trailing or tampered metadata. Trust verification occurs before Wasmtime
compiles the candidate.

## Update transaction

Installation is loopback-only and follows one transaction:

1. read a bounded single-file artifact;
2. verify module identity, ABI, size, digest, trusted key and Ed25519 signature;
3. compile/instantiate the candidate beside the active instance;
4. initialize it and run health checks;
5. quiesce application calls briefly;
6. export the old opaque snapshot and restore it into the candidate;
7. health-check restored state;
8. durably commit active/previous slots;
9. atomically replace the in-memory route.

Any failure before step 9 leaves the old route active. A live trap discards the
instance, loads previous/fallback signed bytes, restores the last in-memory
checkpoint and switches without restarting the process. Explicit rollback uses
the same state-transfer path. The CLI exposes `status`, `install` and `rollback`.

The snapshot is currently a hot-replacement/recovery checkpoint, not the
business database. Durable session/workspace data remains in existing stores.
Before moving unique durable state into the guest, that state must continue to
use its own journal/store or gain an opaque durable snapshot protocol; relying
only on the in-memory VM checkpoint is forbidden.

## Release and cross-platform contract

CI and Release have a single Linux producer:

- compile `genet-daemon-logic` for `wasm32-unknown-unknown`;
- use the latency-oriented `daemon-logic-release` profile (`opt-level = 1`, no
  LTO), not the workspace's size-oriented full-LTO profile;
- sign once with the channel release key;
- upload one `daemon-logic.wasm` plus public trust metadata for native builders.

Windows installer and Linux tarball jobs download the exact artifact, compile
the native binary with its pinned public key, and place the file beside the
daemon executable. The standalone signed `.wasm` is also a release asset. The
Linux install script installs it beside `genet`. Official signing requires the
GitHub secret `GENET_DAEMON_LOGIC_SIGNING_KEY` and variable
`GENET_DAEMON_LOGIC_KEY_ID`; a tag build fails closed if either is absent.

The CI consumer matrix is Linux x64/ARM64, Windows x64 and macOS x64/ARM64. It
runs the exact Linux artifact through platform ABI/state tests, a real daemon
hot update and the public CLI contract. This repository configuration is the
cross-platform gate; local validation can only prove the current host.

## Measured current cost

Measurements on 2026-08-15 used Rust 1.95, a fresh target directory and the
actual `api → common → core → app` guest. They include `genehub-proto`, serde
and code generation, not a hello-world fixture.

| Profile | Cold | No-op | Edit in `daemon-core` | Raw Wasm |
| --- | ---: | ---: | ---: | ---: |
| `daemon-logic-dev` (`opt=0`) | 6.79 s | 0.07 s | 0.25 s | 1,145,569 B |
| `daemon-logic-release` (`opt=1`, no LTO) | 8.33 s | 0.08 s | 0.23 s | 716,110 B |

The signed files are 1,145,901 B (dev) and 716,449 B (release); the canonical
signature section therefore adds only a few hundred bytes. Current product startup with
the signed guest and Winch has been measured around 1.2–1.5 seconds in the
integration tests, including daemon initialization. These are single-machine
numbers, not universal SLOs.

The current native daemon contains 33,807 Rust lines. The landed portable guest
crates contain 409 Rust lines plus shared protocol code; therefore the table is
the real current guest cost, **not** a claim that all 33,807 lines already build
as Wasm. Synthetic earlier scaling runs suggested roughly 2.5 s incremental at
100k generated lines and 5.0 s at 200k with `opt=0`, but real proc macros,
generics and dependency changes can be slower. The project must remeasure at
25k, 50k, 100k and 200k of migrated real guest code.

Development always uses native unit tests first and `opt=0` Wasm for live
reload. Default published daemon logic uses `opt=1` without LTO because daemon
is not CPU-bound. High optimization/`wasm-opt` is an optional measured release
decision, never a default tax on iteration.

## Thin-platform invariant and current gap

`packages/daemon-platform/src` is 1,831 Rust lines and only implements trust,
VM, slots and recovery. It does not depend on `genehub-proto` or platform
business modules. That crate satisfies the thin-kernel rule.

The complete native process is **not thin yet**: `apps/daemon/src` is still
33,807 lines and owns PTY, processes, WebRTC, networking, persistence, sessions
and adapters. The router first asks Wasm and uses `ContinueNative` for unmigrated
requests. Today Wasm owns identity, update refusal policy and pure empty-send
validation; it does not yet own the whole daemon. This compatibility valve is a
migration mechanism and cannot be presented as the final split.

The final invariant is:

- native: startup, trust, VM/update kernel and irreducible raw OS resource
  drivers only;
- Wasm: product security, protocol, scheduling, persistence policy, session,
  adapters, networking state machines and update policy;
- PTY/process/WebRTC native code may hold opaque OS handles and move bytes, but
  command construction, lifecycle policy, protocol parsing and routing belong
  to Wasm;
- platform must not parse GeneHub business messages or expose chatty string
  calls.

## Migration gates

Migration proceeds by replacing direct OS calls with safe facades while keeping
one artifact:

1. move pure validation, routing and state machines into `daemon-core`;
2. define bounded capability batches for filesystem, network, persistence,
   clock/random, process/PTY and WebRTC raw drivers;
3. move session/adapters/security/update policy behind those facades;
4. delete each corresponding native business path and its `ContinueNative`
   arm;
5. reject release builds while any route unexpectedly falls back;
6. only then declare the whole platform thin.

Every capability needs native contract tests, guest tests and product E2E on
the supported OS matrix. PTY/process/WebRTC are not blockers to Wasm ownership:
the OS handle remains native, while Wasm owns the closed-loop behavior. They are
also not already migrated merely because the VM foundation exists.

## Acceptance evidence in this change

- real Rust guest, not a WAT fixture, loads and owns product routes;
- one signed file survives canonical parse and tamper tests;
- rejected signature/ABI/health candidates never change the active route;
- snapshot/restore works across instances;
- hot install and rollback keep daemon PID and port unchanged;
- active traps recover to a signed previous/fallback instance;
- public CLI drives the resident process end to end;
- Linux installer and desktop bundle stage the Wasm beside the executable;
- CI/Release use one Linux producer and native byte-for-byte consumers.

This is a complete runnable update foundation and migration seam. It is not yet
the completed migration of all daemon business code; that claim is reserved for
gate 6 above.
