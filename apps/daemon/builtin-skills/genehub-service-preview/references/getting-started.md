# Start and share a registered service

## Locate the runtime and source

This built-in Skill and its references ship in the guest component. The runner, Node dependencies, Python environment, model weights, and UE are not bundled in this Skill. Do not look for `scripts/run.mjs` beside it.

Use an existing compatible GeneHub source checkout if available. Otherwise obtain the official [GeneHub source](https://github.com/aikenc/genethub) at a release/tag or commit compatible with the target installation as part of the authorized setup; record the revision. Do not blindly substitute the latest main for an older installation. Verify these paths in that checkout:

- `packages/service-preview/run.mjs` and `package-lock.json` — runner and dependency lock.
- `examples/service-preview/application.json`, `index.html`, `backend.mjs` — HTTP/WS baseline.
- `examples/service-preview/media-application.json`, `media.py`, `requirements.txt` — native media baseline.
- `docs/service-preview.md` — maintainer architecture and validation notes.

These are **source-root paths**, not paths relative to the installed Skill. Missing files or an incompatible daemon/host/Workbench are a runtime prerequisite gap, not a model failure. Resolve that gap without copying private data or overwriting the user's installation.

Determine the target Channel's actual daemon data directory from its launch configuration or installation. If CLI inspection is needed, use the exact CLI binding in the built-in catalog / `GENEHUB_CLI` and inspect its help. Do not guess a channel executable, data directory, or `preview register` subcommand. Registration currently happens through the runner.

## Baseline

Requires Node.js 22+. From the verified source root, install the runner's locked dependencies:

```sh
npm --prefix packages/service-preview ci
```

Copy the HTTP/WS example's `index.html` and `application.json` into a folder inside the user's source-machine workspace. In the copied config, set the backend `command` to `["node", "/absolute/source/examples/service-preview/backend.mjs"]`, using the verified source path. Keep that backend in its source tree: it resolves `ws` through `../../packages/service-preview/package.json`, so copying the script alone breaks dependency resolution. The entry must exist before startup. Start from the source checkout with the application's absolute config path and the observed absolute data directory:

```text
node packages/service-preview/run.mjs --config /absolute/workspace/demo/application.json --daemon-root /absolute/target-channel-data
```

Replace those placeholders with observed paths. Keep the runner foreground in a managed terminal/process handle so it can be stopped. This does not require a static-file server. For media, copy `media-application.json` beside the entry; install the source example's requirements in an isolated Python 3.10+ environment and set the config command to that interpreter plus the absolute source path to `media.py`. A model pipeline may need a different environment.

Open the copied entry through GeneHub. Click “允许本次预览访问登记服务” in the trusted toolbar, then exercise the example's HTTP, streaming, and WebSocket buttons. For a media run use the trusted “连接音视频” button; only use “启用麦克风并连接” when testing microphone input with the user. The HTTP and media configs are alternative runs for the same entry: stop the first before starting the second. The copied example page's HTTP demo buttons still target `/api/demo/`; a media-only config does not register that route. Use the trusted media panel for that baseline or adjust the application page to its declared routes.

## Application config

A minimal media application can use this shape once `index.html` and `backend.py` exist and the backend implements the media contract:

```json
{
  "name": "My media application",
  "entry": "index.html",
  "dataPolicy": "auto",
  "backends": [{
    "origin": "http://127.0.0.1:18011",
    "command": ["/absolute/venv/bin/python", "backend.py"],
    "cwd": ".",
    "health": "/health",
    "routes": [{"prefix": "/api/media/", "websocket": false}]
  }],
  "media": {
    "offerPath": "/api/media/offer",
    "stopPath": "/api/media/stop",
    "microphone": "none"
  }
}
```

Use the platform's actual interpreter path (Windows environments use a different path). This is a configuration example, not a supplied model/backend.

- `entry` and each backend `cwd` resolve relative to the config file. `command` is argv, not a shell string; use `env` for backend-specific environment variables and keep secrets out of versioned config.
- There must be 1–8 backends. Each origin is exactly an `http://127.0.0.1:port` origin. Backends must obey it and remain foreground. Occupied ports are refused; do not kill an unrelated listener to proceed.
- `health` stays on that origin and must return a successful HTTP status without redirection. Readiness defaults to 120 seconds; `readyTimeoutMs` can increase it to at most 300 seconds. A model taking longer needs an explicit application startup design, not a fake healthy response.
- Route prefixes are unique lowercase `/api/.../` prefixes ending in `/`. Use non-overlapping prefixes for clarity. `/api/media/offer` reaches the backend's `/offer`; the prefix is stripped. Declare `websocket: true` only where needed.
- `media` is optional for HTTP/WS-only applications. The two supported microphone values are `none` and `webrtc`. Use `webrtc` only if the backend actually consumes the incoming audio track.
- `iceServers` may provide self-hosted STUN. Media TURN comes from the paired Channel after user opt-in; do not store TURN secrets in application config.

## Sharing and lifetime

Share the actual regular entry file, for example `[体验入口](demo/index.html)`, relative to the current workspace root. Each previewed file must be at most 64 MiB. A file link opens the entry; it does not grant service access or publish a standalone website.

For a remote viewer, give the **verified** GeneHub web/relay address or installed-app route, source-machine selection, workspace/entry, and required pairing and `services` permission. The viewer's localhost is not the source machine. A relative entry link alone is not an anonymous public cloud-play URL. Do not guess a domain from the Channel name or invent `/assets/preview/...` links.

Stopping the runner, or any owned backend exiting, retires the entire registration. Closing media stops that media session; it does not stop the application runner. To end the application use Ctrl+C / SIGTERM on the owned runner and verify children and registration were released. A later run has a new identity and may require reopening/re-authorizing the preview. Do not promise permanent availability, background recovery, or independent viewer sessions without implementing and testing them.

## Diagnose by layer

| Symptom | Check and recover |
|---|---|
| No service toolbar | Target build supports Service Preview; entry's canonical path matches registration; runner is ready; correct Channel data root and source machine/workspace |
| Permission denied | Paired device has `services`; user authorized this entry; narrow grants are not automatically widened |
| Already registered / port occupied | Identify the existing owner, stop only the intended run, then retry; remove a private stale record only after confirming that run and children are gone |
| Readiness timeout | Actual command, cwd, configured port and health path; inspect redacted startup diagnostics and fix the backend |
| Route failure | Prefix registration and stripping, WS flag, supported headers, cancellation; do not retry a write automatically |
| HTTP works but media fails | Follow the media-contract diagnostics; signaling transport success does not prove ICE/media connectivity |
