# GeneHub daemon Rust/Wasm architecture

Status: implemented on `release/v0.5.1`

Decision date: 2026-08-15

Application ABI: 18

Snapshot format: 4

## Decision

The daemon is one native Rust process running one signed Rust/Wasm application.
The default deployment model is deliberately simple:

```text
1 native daemon process
1 Wasmtime Engine
1 active daemon-logic.wasm instance
N normally dependent safe-Rust source crates
```

Source crates are not Wasm services. `daemon-common`, `daemon-logic-api`,
`daemon-core`, `genehub-proto` and the small `daemon-logic` entry crate use
ordinary checked Rust calls and statically link into one artifact. This keeps
ownership, visibility, borrowing and type checking inside the application and
creates only one native/Wasm boundary.

The daemon does not use Go, C#, V8 or a system WebView as its application
runtime. The separate game-engine direction remains native Rust for the
non-GC/high-frequency layer and TypeScript/JavaScript for the GC/browser layer;
daemon measurements must not be used as game-loop measurements.

## Implemented 1 + N graph

```text
genehub-proto ───────────┐
daemon-common ───────────┼──> daemon-core ──> daemon-logic (cdylib)
daemon-logic-api ────────┘             │
                                       └── one daemon-logic.wasm
```

| Crate/tier | Implemented responsibility |
| --- | --- |
| `daemon-common` | portable bounded codecs and shared guest helpers |
| `daemon-logic-api` | ABI 18, boot/input/output, capability batches, events and snapshot contract |
| `daemon-core` | every RPC policy path, sessions, five Agent adapters, workspaces/files/git, providers, devices, terminals, persistence and update coordination |
| `daemon-logic` | small `wasm32-wasip1` allocation and exported-call adapter |
| `daemon-platform` | native artifact trust, Wasmtime, limits, active/previous slots, activation and recovery |
| `daemon-system` | policy-free native filesystem, process, PTY, HTTP, WebSocket, WebRTC, clock/random and secure-storage drivers |
| native daemon shell | startup, local/Fabric transports, AEAD records, Hub/relay carrier ownership, file streaming and the one VM/capability bridge |

`LogicOutcome` has only `Reply` and `Error`. There is no `ContinueNative`, no
second native business router and no native session/adapter/provider/workspace
implementation. A real daemon without a verified artifact fails before opening
its listener.

The current guest-owned crates have 25,097 Rust source lines; the shared
`genehub-proto` dependency adds 4,015, for 29,112 lines in the complete guest
compile graph. Business domains remain modules inside `daemon-core` at this
size. When real guest code reaches roughly 40–60k lines, coherent domains may
become normal library crates to improve parallel and incremental compilation.
They still link into the same artifact. Dependencies between those crates are
expected and are how Rust propagates memory-safety and API changes.

## What stays native, and why

Thin means “no replaceable product implementation or duplicate policy”, not
“fewest possible lines”. Three native layers remain:

| Native code | Lines at this checkpoint | Why it cannot live entirely in core Wasm |
| --- | ---: | --- |
| `packages/daemon-platform/src` | 2,093 | trust roots, Wasmtime objects, executable-memory policy, durable slots and atomic route replacement |
| `packages/daemon-system/src` | 3,921 | OS file handles/locks, child processes, PTYs, sockets, HTTP client, WebRTC peers and secure randomness |
| `apps/daemon/src` | 15,663 | process bootstrap plus long-lived local/Fabric/Hub/relay/speech carriers and platform integration |

The 15.7k-line shell is not all VM code. Its largest files are transport,
speech-runtime and third-party carrier implementations. They own Tokio tasks,
sockets, WebRTC objects, machine enrollment credentials, native audio and file
streaming. The guest
owns which RPC is allowed, device/invite authentication, workspace catalogue,
session and Agent state machines, command construction, provider credential
policy, persistence schema, replay window and update policy. Native transport
asks the guest for security and path decisions through the same bounded ABI.

Process, PTY, sockets and WebRTC are opaque resource tables. The guest sends a
bounded operation and receives an integer resource id; output returns as ordered
capability events. Handles survive a guest hot replacement, while stale events
are harmless. This keeps the high-frequency protocol loop in Wasm without
pretending that WebAssembly can directly own an OS process or WebRTC object.

Hub/relay attachment is intentionally a coarse carrier capability rather than
dozens of HTTP/string calls. It is native because it owns resident uplinks and
serves inbound transports back into the daemon. Product request routing and
authorization are still guest-owned; there is no native fallback path.

## Boundary and complex values

The core application ABI uses scalar exports and linear-memory offsets:

```text
genehub_initialize(bytes)
genehub_handle(bytes) -> bytes
genehub_snapshot() -> bytes
genehub_restore(bytes)
genehub_platform::genehub_capability(bytes) -> bytes
```

The byte payload is bounded MessagePack. A client request, capability batch,
capability result or resource event crosses as one complete buffer. Strings,
vectors and business structs do not become individual host calls. Current
limits include:

- 4 MiB application input/output buffers;
- at most 64 calls in one capability batch;
- 3 MiB maximum capability chunk;
- explicit per-driver response, process, socket and RTC limits;
- Wasmtime memory, table, stack and fuel limits.

The guest target is `wasm32-wasip1`. It imports the one GeneHub batch function
plus the small WASIp1 surface needed by Rust's runtime. It inherits no host
environment, stdio, socket namespace or ambient filesystem. Only the log
directory is preopened, read-only; all other access goes through rooted
capabilities. WASIp1 is implemented by Wasmtime on each host and does not make
the artifact dependent on Linux libc or a Linux CPU.

## One Linux-built cross-platform file

The release artifact is one valid `.wasm` file. Its final custom section,
`genehub.daemon.artifact.v1`, contains the canonical signed envelope: module
id, version, ABI, raw byte length, SHA-256, signing key id and Ed25519 signature.
There is no sidecar manifest that can drift from the module.

CI builds and signs the application once on Linux. Linux x64/ARM64, Windows
x64 and macOS x64/ARM64 consumer jobs download the exact same bytes and run:

- artifact verification and durable-slot tests;
- the real application ABI and snapshot/restore tests;
- a real daemon hot install/rollback without restart;
- the public CLI update contract;
- install, call and reopen of the Linux-produced file.

Windows and macOS never compile the Wasm application. Native package jobs place
the same file beside the daemon executable. This is the portability contract;
only a public matrix run can provide cross-OS evidence, while local tests prove
the Linux consumer.

## Signed hot update without process restart

Installation is allowed only over loopback and follows one transaction:

1. read a size-bounded single-file candidate;
2. verify canonical form, module id, ABI, hash, key id and Ed25519 signature;
3. compile and initialize a side-by-side candidate;
4. run its self-check;
5. briefly serialize application calls;
6. snapshot the active guest and restore the candidate;
7. health-check the restored candidate;
8. durably commit active/previous slots;
9. atomically switch the in-memory route.

Failures before the final switch leave the old route active. Explicit rollback
uses the same side-by-side state-transfer path. A live trap discards the failed
instance and recreates a signed previous/fallback instance; a trapped instance
is never reused. PID, listener port, native resource tables and carrier tasks do
not restart.

The guest snapshot transfers in-memory coordination state. Durable provider,
device, workspace, session, round and Agent data is written through secure or
workspace-rooted stores and therefore also survives process restart.

## Main integration impact and the apparent line reduction

The merge diff deletes whole native business files, so a file list looks like a
large code reduction even when the replacement is present elsewhere. Against
the mainline tree used for the integration audit, the architecture change has
35,475 added lines and 32,434 deleted lines after including the new portable
artifact-guidance module: net **+3,041**. On a daemon-focused, like-for-like
Rust scope (native daemon plus guest/platform/system source and tests), mainline
has 48,217 lines and the integrated tree has 48,972: net **+755**. It is a move
and consolidation, not a 32k-line feature deletion.

The largest deletion/replacement groups are:

| Deleted native implementation | Old lines | Replacement and effect |
| --- | ---: | --- |
| five Agent adapters plus registry/shared adapter plumbing | 12,298 | 6,245 lines of portable catalog/driver code plus one shared serialized process/session loop; per-Agent Tokio/server boilerplate is no longer repeated |
| session manager/store/artifacts/context/round builders | 10,994 | 9,295 portable session-core lines plus 5,355 adapter-driver lines; state, replay, fork/import, permissions and persistence now share one durable model |
| workspace/device/provider/git/PTY/process/update/speech policy files | 6,262 | 4,108 portable domain lines plus policy-free `daemon-system` capabilities; the old automatic-update downloader was already unreachable because the public router returned `Unsupported` |

Line count alone is not a parity argument. The pre-merge audit therefore also
checks the following behavior boundaries:

| Product surface | Integrated behavior/evidence |
| --- | --- |
| all RPCs | the current `Request` enum is exhaustively matched in `daemon-core`; the native router has no business fallback |
| workspace/files/git/providers/devices | durable rename/remove/reopen, multi-root/future-format data, path confinement, TLS and grant validation are exercised through real capabilities |
| sessions | create/send/replay, round batching, fork/import, artifact upload, process ownership and delete/tombstone behavior execute in the portable application |
| Agent protocols | Genet, ACP/Cursor, Claude, Codex and OpenCode have protocol-contract tests; dynamic installed-version catalog/login probing is guest-owned |
| interactions | permission/question/plan requests stop the Agent only after durable persistence; approval resumes the native Agent session, rejection does not; both Wasm hot replacement and a complete daemon/VM cold restart are covered |
| VM/update | signature, ABI/hash/size, malformed module, limits, side-by-side restore, rollback, torn state, concurrent calls and trap fallback are covered without PID/listener restart |
| OS resources | rooted files/locks, process streams/dialogue, PTY, HTTP/WebSocket and WebRTC resource lifecycles are covered in `daemon-system` integration tests |

The old daemon had 458 test functions under `apps/daemon/src`; the corresponding
integrated native/guest/platform/system scope currently has 251 test functions.
That number dropped because many table-like assertions were consolidated into
protocol and real-capability scenarios, but it is still a review signal rather
than an automatic improvement. Merge readiness requires the workspace suites,
the signed-artifact journeys and the ignored real update/handoff gates below;
unavailable third-party CLI binaries remain explicitly reported as an external
coverage limitation.

## Current build cost

Measured on 2026-08-15 with Rust 1.95.0, Linux x64 and 96 logical CPUs against
the final 29,112-line guest compile graph. Both runnable profiles deliberately
use `opt-level = 1`; an
`opt=0` full guest exhausted the 500-million-instruction request budget and is
not a viable live-reload artifact.

| Build | Wall time | Peak RSS | Raw Wasm | Signed single file |
| --- | ---: | ---: | ---: | ---: |
| guest-wide dev rebuild + signing | 27.18 s | 1,077 MiB | 10,110,589 B | 10,110,923 B |
| guest-wide release rebuild | 33.69 s | 1,093 MiB | 9,604,944 B | 9,605,289 B measurement version |
| small real `daemon-core` edit + dev signing | 3.40 s | 348 MiB | 10,110,589 B | 10,110,923 B |
| no-op dev build + dev signing | 0.98 s | 87 MiB | 10,110,589 B | 10,110,923 B |

The signed-section overhead is 334 bytes for the current dev version; it varies
by the embedded version string (345 bytes in the release measurement above).
Release intentionally uses `opt-level = 1`, no LTO and 16
codegen units. The daemon is not CPU-bound, so high optimization and `wasm-opt`
are not default release taxes. Larger shared-crate edits observed during the
migration took roughly 10.5–15.4 seconds to a runnable signed dev file.

For a future 100–200k-line guest, the correct structure is 8–15 cohesive
library crates plus one entry crate, still one artifact. Current evidence gives
this capacity-planning range, not a benchmark guarantee:

- ordinary leaf-domain edit: roughly 5–20 seconds to a runnable signed dev file;
- shared `core/common/proto` or snapshot-shape edit: roughly 20–60 seconds;
- clean build on a high-core CI worker: roughly 30–90 seconds.

Those ranges combine the measured 6.4–15.4-second real edit spread with Cargo
crate invalidation and parallel compilation; line count alone is not predictive.
The project must remeasure at 25k, 50k, 100k and 200k real lines. If a leaf edit
misses 20 seconds, split source crates before considering a second artifact.

## Artifact-count rule

Default `K = 1`. Multiple source crates provide compile boundaries without ABI
or distribution boundaries. Add another Wasm artifact only when a domain has
all of the following:

- genuinely independent state and lifecycle;
- independent compatibility, release and rollback requirements;
- a narrow, low-frequency, batchable interface;
- no complex shared mutable object graph;
- measured download/update benefit larger than orchestration cost.

A second artifact may run under the same host and Engine; it does not require a
second process. It also cannot exchange Rust references with the first
artifact, so the default response to a cross-artifact safety problem is to keep
the code in one artifact. Ordinary patches therefore update one file.

## Validation

The landed suites cover:

- canonical artifact parsing, signatures, tamper, wrong key/hash/ABI and size;
- malformed modules/imports, WASI policy, memory/stack/table/fuel and traps;
- concurrent calls/installs, torn durable state, restart, rollback and key rotation;
- rooted/atomic private and workspace files, symlink escape and kernel locks;
- random/clock batching, process streams, PTY lifecycle, bounded HTTP/WebSocket
  messages and WebRTC resource lifecycle;
- native guest tests for all five Agent protocols, sessions, persistence,
  devices, provider TLS policy, workspaces, logs and replay;
- real signed guest workspace/file/provider/device/PTY/catalog behavior;
- state survival across live guest replacement, tamper rejection and rollback;
- public CLI update/rollback with unchanged PID and port;
- real journey fixtures that can no longer start without the signed guest.

The final counts for this main-integration candidate are recorded only after the
post-merge workspace run. Before that final gate, the focused audit has passed
108 `daemon-core` tests plus 137 native daemon/platform/system tests (six more
are explicitly ignored real-environment gates). The required final gate is
`cargo test --workspace --no-fail-fast` with the signed artifact, followed by
every ignored application/update/CLI/handoff test, Relay/Web/Desktop checks,
formatting and workspace/all-target Clippy with warnings denied. The five-OS
GitHub matrix is configured to consume the exact Linux-produced bytes; only
that public run can supply evidence from non-Linux kernels.

Local development:

```sh
node scripts/daemon-logic.mjs

GENET_DAEMON_LOGIC_WASM="$PWD/target/daemon-logic.wasm" \
  cargo run -p genet-cli -- daemon run

genet-dev daemon logic status
genet-dev daemon logic install /absolute/path/to/signed.wasm
genet-dev daemon logic rollback
```

The native and portable halves are one product: workspace CI now builds the
signed dev artifact before mandatory real-process journeys, so deleted native
business behavior cannot silently keep tests green.
