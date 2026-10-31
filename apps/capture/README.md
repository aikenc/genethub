# GeneHub Capture

Independent desktop provider for existing Service Preview. The daemon handles
registration, the full-connection authentication and HTTP/WS transport. Capture owns
OS capture, H.264/Opus encoding, native WebRTC and input. No raw desktop frames
are sent through the daemon. One OS account, one Capture process, one display,
one viewer and one control lease are supported in this first implementation.

## Build a developer package

On the target machine, install Rust, Python 3 and CMake 3.20+. Windows also
needs VS 2022 C++ and Windows SDK; macOS needs Xcode and macOS SDK 15 or newer
(the app's runtime minimum is 12.3, with guarded newer APIs). From repo root:

```sh
python3 apps/capture/build.py --debug
```

The script downloads only hash-pinned source archives and builds the independent
app. It does not install or launch it, change the daemon or grant OS access.
Output is under `apps/capture/dist/<os>-<arch>/`; macOS includes an app bundle.
Windows/Linux produce unsigned development output. macOS requires a stable
certificate-backed identity; a linker/ad-hoc hash changes on rebuild and cannot
retain the old privacy grant. See [THIRD_PARTY.md](THIRD_PARTY.md).

For development on your own Mac, initialize its dedicated local signing identity
**once** (macOS may ask you to confirm its user-level, code-signing-only trust):

```sh
python3 apps/capture/macos_signing.py init-local
python3 apps/capture/build.py --debug --mac-local-signing
python3 apps/capture/macos_signing.py install \
  'apps/capture/dist/darwin-arm64/GeneHub Capture.app' \
  "$HOME/Applications/GeneHub Capture.app"
open "$HOME/Applications/GeneHub Capture.app" --args \
  --entry /absolute/workspace/review/index.html --daemon-root /actual/daemon/data
```

Grant macOS access to that installed app. Subsequent builds reuse the same
certificate and installed bundle path. Stop Capture, including its input guard,
before `install`; it verifies both bundles, evaluates their designated
requirements in both directions, and refuses incompatible or invalid updates.
The old installation survives packaging/signing failures. The key stays in a
dedicated, owner-only local keychain; never delete/recreate it for each build or
copy it into the source tree. `trust-local` completes an interrupted trust setup
without changing its signer. This does not change Screen Recording or
Accessibility choices. A move from the previous hash-bound ad-hoc build to this
identity may require one final legitimate grant; there is no permission migration
from arbitrary different code identities.

For an existing signing identity, use `--mac-sign-identity <certificate-sha1>`
and optionally `--mac-keychain <path>`. Signing occurs inside out (native dylib,
then app) and must pass deep, strict verification. Developer ID signing,
notarization, provisioning and Windows installers remain separate release work;
the local development certificate is not a distribution identity.

## Start for a workspace

Copy the four files from
`apps/daemon/builtin-skills/genehub-preview/assets/remote-desktop/` to a folder
in the user's workspace (the package also contains `client/`). Do not serve the
static files over HTTP. Obtain the actual daemon `dataDir` from the channel's
CLI status, then run the built executable beside its native engine:

```sh
genehub-capture --entry /absolute/workspace/review/index.html --daemon-root /actual/daemon/data
```

On macOS the executable is `GeneHub Capture.app/Contents/MacOS/genehub-capture`.
For an explicit macOS settings action, LaunchServices can start the same signed
app without its management window:

```sh
open -n -W "$HOME/Applications/GeneHub Capture.app" --args --request-permission screen
open -n -W "$HOME/Applications/GeneHub Capture.app" --args --request-permission input
```

Only these explicit actions request OS access. The response reports the requested
permission and whether it is currently allowed. The explicit CLI action keeps
its own AppKit event loop alive for up to 120 seconds while checking the result,
without a custom management window or repeated permission requests. Failure to
dispatch System Settings is an error; a pending or timed-out action is not a
completed grant. `--probe` remains read-only and cannot be combined with
a request. This is the native entry for a GeneHub settings integration; the
GeneHub settings/launcher connection is not yet implemented. Normal headless
capture never opens this management window or requests missing OS permissions.

The local window starts with sharing and control **off**. Choose `--display <id>`
from `--probe` before starting if the first display is not the intended target.
The display is fixed for this run; restart to switch targets. On macOS, the local
Screen/Input permission buttons request Screen Recording / Accessibility
separately, only when clicked;
grant them in System Settings and restart as instructed. Discovery and `--probe`
do not request permission. Grant Accessibility to the stable Capture app identity;
its input guard is a child of the same executable, not a daemon helper. macOS
15+ may also ask for Local Network access when connecting native media; the
developer bundle declares that purpose. Viewing does not require Accessibility.

Share the ordinary workspace HTML path in chat. Enable its registered service
in Preview, click Connect, then optionally allow this page to acquire control
in the outer toolbar. The source must also have allowed control. That toolbar
stays outside the editable H5. Clicking Stop Capture closes only Capture's
sessions, not Blender, UE, the game or the Agent.

`--headless` is explicit automation mode. `--share` and `--allow-control` are
explicit source opt-ins; neither is implied by merely starting the app. The
default profile is 1920×1080, 30 fps, 8 Mbit/s; flags allow adjustment. Linux
with no graphics backend may run status/registration checks but cannot stream.

On Windows, the read-only probe and connection preflight also check that the OS
session is active and unlocked. A locked, disconnected or unqueryable session
returns `desktop_unavailable`; having a desktop named `Default` or an initialized
encoder is insufficient. The independent input guard repeats this check through
its target-liveness check. This app does not unlock Windows or change sessions.
A transient lock is not cached as a permanent lack of encoder support.

## Trust and recovery

Existing `services` access is deliberately coarse. Once the source enables
sharing/control, other clients holding that access may request them. The outer
H5 button controls the current page; it is not a per-device security boundary.
No remote request can turn on either local switch. No automatic Agent pause is
implemented: coordinate with an Agent that also uses GUI input before control.

View and control have separate WS anchors. Control WS loss stops control without
stopping viewing; view loss closes the entire session. Source-generated, one-use
challenges expire in 3 seconds. An independent input guard also releases held
keys on EOF, parent freeze and loss of reliable held-state progress. Media currently needs
encoded-output and browser-presentation progress to allow control. Upstream
idle re-encodes count as output; this does not independently prove capture
health or valid desktop content. First-frame/capture-fault qualification is
still required before this can be treated as a complete remote-control product.
The input process also owns an OS account lock until its release/stop finishes,
so a parent restart cannot overlap an old guard with a new injector. Reconnecting
while a viewer is still closing returns busy instead of creating another guard.
These are failure boundaries, not a measured end-to-end latency promise. If
guard exit cannot confirm release, further control is blocked and the UI reports
that state; check the local machine and restart Capture rather than hiding it.

The app registers only an authenticated loopback endpoint, using owner-only
private Preview records. Graceful exit removes only the exact bytes it published,
not another provider that happens to reuse a run ID. While holding the existing
account instance lock, Capture records a private SHA-256 ownership receipt under
`GeneHubCapture/registrations/`. A hard-killed instance's unchanged entry can then
be reclaimed automatically; a new run starts with fresh identity and default-off
sharing/control. Modified or unrecognized records, including legacy entries
without a receipt, are preserved and explicitly refused. This is local lifecycle
evidence, not a new daemon protocol or network permission. The instance lock
remains held until registration cleanup has finished.

For media-backend diagnosis, explicitly set
`GENEHUB_CAPTURE_NATIVE_DIAGNOSTICS=1` before starting Capture. It writes at
most 64 selected backend/encoder/audio messages (768 bytes each) to stderr.
Keyboard/layout, input and window-title traces are excluded. It does not
change capture selection, permissions, lease timeouts or sharing policy.

## Verification boundary

Linux development checks prove compilation, the native ABI/probe, registration
and protocol paths only when their recorded tests ran. They do not prove Windows
DXGI/NVENC, macOS ScreenCaptureKit/VideoToolbox, sound, actual OS input, signed
permissions, game compatibility, hot-plug behavior or remote TURN performance.
Before release, run those on the target systems with a consenting local user:
real Blender editing, an unprotected Demo, view/control disconnects, parent
freeze while holding input, display changes, stop/reconnect and source shutdown.
Check actual decoded/presented frames and audio, selected candidate pair, resource
release and local key state. RTCP PLI/FIR and REMB are wired; a complete gaming
bandwidth estimator/pacer and weak-network qualification are not claimed.
