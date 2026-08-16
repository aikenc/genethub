# daemon-platform

`genet-daemon-platform` is the native trust, Wasmtime and activation kernel for
GeneHub's signed Rust/Wasm daemon application. It deliberately has no dependency
on `genehub-proto`, sessions, adapters, devices, PTY or networking policy.

It owns only:

- Ed25519 trust roots and verification before compilation;
- the bounded Wasmtime engine, module cache, stores and instances;
- one opaque byte-batch application ABI;
- side-by-side candidate initialization, snapshot/restore and health checks;
- durable active/previous artifact slots, atomic route replacement and recovery.

The distributed artifact is one valid Wasm file. Its final custom section,
`genehub.daemon.artifact.v1`, contains the signed canonical envelope; there is
no sidecar manifest to lose or mismatch. The signature binds module id, version,
ABI, byte length, SHA-256 and key id to the exact core-Wasm prefix.

## Source modules versus deployment files

The guest is a normal safe-Rust dependency graph:

```text
genehub-proto + daemon-logic-api
              │
daemon-common ├──> daemon-core ──> daemon-logic (cdylib entry)
```

Those crates call one another as ordinary Rust. They statically link into one
`daemon-logic.wasm`; they are not Wasm microservices and create no host calls.
Additional business crates should join this graph without increasing the
artifact count. A second deployable artifact requires a real independent state,
rollback and release domain.

## Local development

Build and development-sign the guest:

```sh
node scripts/daemon-logic.mjs
```

The result is `target/daemon-logic.wasm`. Run a source build against it with:

```sh
GENET_DAEMON_LOGIC_WASM="$PWD/target/daemon-logic.wasm" \
  cargo run -p genet-cli -- daemon run
```

Inspect or replace the live module without restarting the native daemon:

```sh
genet-dev daemon logic status
genet-dev daemon logic install /absolute/path/to/signed.wasm
genet-dev daemon logic rollback
```

Release signing never uses the development key. The public Linux release job
reads `GENET_DAEMON_LOGIC_SIGNING_KEY`, builds the guest once, appends the signed
section once, and hands those exact bytes to every native packager.

## Tests

```sh
cargo test -p genet-daemon-platform --all-targets

GENET_DAEMON_LOGIC_WASM="$PWD/target/daemon-logic.wasm" \
  cargo test -p genet-daemon-platform --test application_integration -- --ignored

GENET_DAEMON_LOGIC_WASM="$PWD/target/daemon-logic.wasm" \
  cargo test -p genet-daemon --test logic_update_integration -- --ignored

GENET_DAEMON_LOGIC_WASM="$PWD/target/daemon-logic.wasm" \
  cargo test -p genet-cli --test logic_update_contract -- --ignored
```

CI additionally downloads one Linux-built signed file on Linux x64/ARM64,
Windows x64 and macOS x64/ARM64 and runs the real VM, product-daemon and CLI
update tests. Consumer jobs never rebuild guest bytes.

The complete decision, implemented boundary, build measurements and validation
contract are in
[`docs/daemon-wasm.md`](../../docs/daemon-wasm.md).
