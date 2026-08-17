# daemon-platform

`genet-daemon-platform` is the small native trust and execution kernel for the signed daemon application.

It owns:

- signed artifact v2 verification and exact channel/ABI/revision identity;
- Wasmtime/WASI limits and application boot/health checks;
- one embedded baseline, one downloaded active artifact, a temporary candidate and one anti-replay high-water mark;
- prepare-then-activate cold replacement under an exclusive route lock.

It deliberately does not own business protocol parsing, product authorization, update URLs supplied by clients,
guest memory transfer, previous slots or rollback. The daemon-level UpdateGate must establish idle/force cleanup
before calling `prepare` / `activate`.

The Wasm ABI is `genet-daemon-logic-api::ABI_VERSION` (currently 19). `platformAbi` is the only compatibility gate;
business `protocolVersion` is opaque to this crate and is reported to Web after activation.

## Storage contract

Inside the Platform state directory:

```text
active.wasm
candidate.wasm
highest-revision
```

Every write is bounded and atomically renamed. The high-water mark advances before candidate publication, so a
crash can only leave a verifiable candidate at the same fenced revision. Recovery can finish that rename, discard
an invalid candidate, or start the embedded baseline without lowering the fence.

## Local development

Build a raw component and wrap it with the development root:

```bash
node scripts/daemon-logic.mjs
```

Exercise an isolated publication candidate without a tag, release or remote write:

```bash
node scripts/publish-daemon-logic.mjs --channel beta --discard-candidate
```

The runtime has no local install/rollback business RPC. Use the daemon's fixed `platform.patch` controller when
testing the product path.

## Tests

```bash
cargo test -p genet-daemon-platform
```

Integration coverage includes signature/channel/ABI/revision rejection, bounded files, candidate boot failure,
single-active commit, crash recovery, corrupted active fallback and replay refusal.
