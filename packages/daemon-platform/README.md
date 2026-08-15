# daemon-platform foundation

`genet-daemon-platform` is the native trust and lifecycle kernel for an
updatable Rust/Wasm daemon application. It is intentionally not a second copy
of daemon business logic.

This first migration increment is isolated from the existing daemon startup so
the current product remains usable while the boundary is proven. It owns only:

- trusted release keys and signed artifact verification;
- Wasmtime core-Wasm configuration, resource limits, compilation and instances;
- side-by-side candidate health checks and atomic route replacement;
- durable active/previous slots, rollback and embedded fallback recovery.

Session, adapter, protocol, scheduling, networking, PTY and process policy stay
out of this crate. Future native system ports must be narrow capabilities, and
each port needs contract tests before application logic is moved behind it.

## Artifact and activation model

A signed envelope covers the module ID, semantic version, ABI version, byte
length, component SHA-256 and signing key ID. Two identities are retained:

- the component digest deduplicates identical Wasm bytes;
- the signed artifact ID distinguishes releases and signing-key rotations even
  when their component bytes are identical.

Artifacts and envelopes are content addressed. Slot state is append-only and
generation numbered. An installation follows this order:

1. verify signature, module, ABI, length and digest;
2. compile, instantiate and run the guest self-check beside the live instance;
3. durably persist the component and signed envelope;
4. durably append the new active/previous slot generation;
5. replace the in-memory route under a short write lock.

A failure before step 5 leaves the old route serving. A runtime trap poisons
that instance and attempts to route to the immediate previous artifact, then
the embedded artifact. Corrupted content-addressed files are repaired from
verified bytes; torn state generations are ignored during recovery.

## Integration-test contract

The integration suite executes real Wasmtime modules and covers:

- typed load/call, malformed modules, imports, missing or wrong exports;
- ABI and self-check rejection, initialization and call fuel exhaustion;
- memory limits, traps and permanent instance poisoning;
- trusted signatures, tampering, metadata, key, module, ABI and size policy;
- same-byte releases and signing-key rotation without component duplication;
- first boot, installation, restart, explicit and automatic rollback;
- rejected candidates, torn state, corrupt artifacts and embedded repair;
- concurrent calls during replacement and concurrent installer linearization.

Run locally with:

```sh
cargo test -p genet-daemon-platform --all-targets
```

CI runs this suite natively on Linux, Windows and macOS so filesystem durability
and atomic replacement paths are exercised on every supported desktop family.
The release portability gate compiles one real Rust `wasm32-unknown-unknown`
guest on Linux, signs it once, then hands those exact bytes to Linux x64/ARM64,
Windows x64, and macOS x64/ARM64 runners for verification, installation, calls
and restart recovery. Consumer jobs never rebuild the guest.
