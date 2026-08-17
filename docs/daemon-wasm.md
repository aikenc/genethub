# GeneHub daemon Platform / Wasm architecture

Status: implemented on the development branch (ABI 19). Release and operations are defined in
`genethub-cloud/docs/devops/remote-web-wasm-patch-*.md`.

## The boundary

GeneHub has one native daemon Platform and one active signed Wasm application:

```text
Web / CLI
  -> encrypted data-plane carrier
  -> native daemon: framing, identity, bounded streams, OS capabilities
  -> opaque business JSON bytes
  -> daemon-logic.wasm: protocol, authorization, routing and product behavior
```

Native code may understand stable carrier/control metadata, such as stream IDs, authenticated caller context,
workspace capability locators and `platform.patch`. It must not deserialize the business `Request`, `Reply` or
`ServerFrame` in the request path. `CarrierInput` / `CarrierOutput` carry bounded byte arrays; the Wasm converts
those bytes to the current business protocol.

The stable exception is lifecycle control. `platform.patch` cannot live in the Wasm that it replaces, so native
code owns only:

- `check` — inspect the fixed channel logic feed;
- `apply { requestId, terminateActivities }` — apply the candidate selected by native code.

Neither Web nor CLI can provide an artifact URL, file, key, channel, ABI or revision. Local business commands in
the CLI still travel through the daemon into the active Wasm. The CLI therefore reuses the Wasm product logic; it
does not contain a second router.

## Native and portable ownership

| Native Platform | Signed Wasm application |
| --- | --- |
| socket/WebSocket/WebRTC carrier and encryption | business request/reply/event schemas |
| caller authentication and bounded carrier context | product authorization and operation classification |
| filesystem/process/PTY/socket/RTC/speech drivers | workspace/session/config/Agent policy |
| artifact download, signature verification and ABI gate | Hub and product workflows through native capabilities |
| busy/force replacement lifecycle | business persistence and schema migration |

Native capabilities validate the concrete resource scope again when opening an OS resource. Opaque business
bytes therefore do not weaken the OS security boundary.

## Artifact identity

`daemon-logic.wasm` is one cross-platform signed file containing a component and an envelope. The signed payload
binds:

- module ID and channel;
- monotonically increasing `logicRevision`;
- exact `platformAbi` and reported `protocolVersion`;
- component SHA-256 and byte size;
- signing key ID.

Beta and Official use different trust roots. A development artifact uses the repository development key and is
never accepted as a release publication.

`platformAbi` is the only hot-compatibility decision. It covers the entire native/Wasm capability contract, not
only exported function shapes. A Wasm that requires new native semantics must bump the ABI and ship in an App
installation package.

`protocolVersion` is signed and reported to Web, but native Platform does not use it to accept or reject a patch.

## Single-active storage

The downloaded state is deliberately small:

```text
embedded baseline (inside the App)
active.wasm
candidate.wasm       # temporary during activation/crash recovery
highest-revision     # one monotonic anti-replay integer
```

There is no previous slot, version history, user rollback, trap rollback or guest state-transfer format.
`highest-revision` is not a version slot: it points to no artifact and exists only to prevent replay of an older,
still-valid signature after corruption or App recovery.

On startup, the embedded baseline raises the high-water mark when a new App carries a later baseline. An active
artifact is selected only when it verifies, matches the current ABI/channel, and matches the high-water revision.
Otherwise the daemon starts the embedded baseline without lowering the anti-replay fence.

## Cold patch activation

The normal path is:

```text
fixed manifest -> bounded download -> envelope/signature/identity check
  -> compile + boot + health-check candidate
  -> ask Wasm whether work is active
  -> idle: quiesce native resources
     busy: return blockers without changing anything
     force: Wasm terminates work, then native resources are drained
  -> exclusively stop old guest -> persist candidate as active -> route new guest
```

Candidate preparation happens before active work is stopped. A broken candidate therefore never changes durable
or routed state. Once a candidate is activated, a product defect is corrected by publishing a higher revision;
re-downloading the same bytes or switching to an older artifact is not recovery.

Busy blockers include active sessions, terminals and native resources. Web presents an in-place second
confirmation before `terminateActivities=true`. The daemon serializes mutations and caches completed request IDs,
so transport retries cannot apply the same operation twice with different options.

Business data survives because it is already durable and is reopened by the new guest. Live Agent/PTY/process
state does not cross an update. Domain names such as `SessionSnapshot` or a diagnostics snapshot are ordinary
business read models; they are unrelated to Wasm activation and are not component versions.

## Hosted discovery

`scripts/channel.mjs` stamps separate fixed arrays:

- `APP_MANIFEST_URLS` — human App installation discovery after an ABI mismatch;
- `LOGIC_MANIFEST_URLS` — signed Wasm discovery.

Manifest redirects stay on the stamped origin. Artifact redirects are accepted only on a stamped release origin
or the allowed GitHub release hosts. Downloads are HTTPS-only, bounded, and cross-checked against the signed
envelope before activation.

App/Beta/Official publishing rules live in the Cloud DevOps documents. A source-stamped `dev` binary has no
remote feed.

## Protocol compatibility

Business protocol v3 is independent of the binary data-plane version. Web chooses a codec from the active Wasm's
reported `protocolVersion`. Compatibility lives in `packages/web/src/protocol/` as pure adjacent adapters:

```text
wire v3 <-> v3-to-v4 <-> wire v4 <-> ... <-> latest canonical model
```

Only real published generations get modules. The current tree has v3 and no adapters. Web retains at most eight
real generations, composes adapters transitively, and only supports the expected skew direction: current Web to
an older Wasm. A newer Wasm asks an old page to reload; a Wasm older than the retained window requires an App or
Wasm update.

## User and developer controls

Production UI uses the fixed feed:

```text
Settings / update toast -> platform.patch check/apply
```

The local CLI exposes the same stable controller for diagnostics and headless use:

```bash
genet daemon patch check
genet daemon patch apply
genet daemon patch apply --force
```

There is no production `daemon logic install` or rollback RPC. Artifact construction is an offline build/publisher
operation through `genet-daemon-artifact` and `scripts/publish-daemon-logic.mjs`.

## Validation

The important branch checks are:

```bash
node scripts/daemon-logic.mjs
GENET_DAEMON_LOGIC_WASM="$PWD/target/daemon-logic.wasm" cargo test --workspace
cargo test -p genehub-testing --test supply_chain
node --test scripts/beta-promotion.test.mjs
```

The explicitly ignored cold-replacement application cases use the same `GENET_DAEMON_LOGIC_WASM` and are run by
CI after building the signed Rust guest. Release CI exercises that same identity embedded in native artifacts.
