---
name: try-genehub
description: >-
  Boot a throwaway GeneHub instance (daemon + web workbench, plus the
  genethub-cloud control plane and relay if that sibling checkout exists) and
  hand back URLs to try it in a browser, without building the desktop
  installer. Use when the user asks to try, demo, experience, or preview
  GeneHub, asks "我能体验了吗" / for a link to play with the running app, or
  specifically wants to run through the full user journey (register, pair a
  machine to a Hub, cross-device link) rather than just the single-daemon
  chat demo.
---

# Try GeneHub

One script boots a disposable daemon + web workbench pair, plus (if a sibling
`genethub-cloud` checkout exists) the control plane and relay, and prints the
URLs to open. It is idempotent — re-running `start` reuses whatever is
already healthy instead of stacking duplicate processes, so it is safe to
call again after a break.

## Quick start

```bash
genethub/.cursor/skills/try-genehub/scripts/demo.sh start
```

This builds `genet-daemon`/`genet-agent` if missing, installs npm deps if
missing, starts everything, waits for it to come up, and prints two URLs.

### 1. Chat with this machine directly — no account, one port

```
http://127.0.0.1:5173/connect.html
```

Give that URL to the user as-is. `connect.html` is a tiny generated redirect
page (not part of the product, deleted by `stop`) that reads its own
`location.host` in the browser and builds the `#endpoint=...` fragment from
that, then redirects into the app. This matters because the daemon's own port
changes every run and is proxied — see the remote section below for why.

### 2. The full journey — register, pair, cross-device link

```
http://127.0.0.1:47210/
```

This is the `genethub-cloud` control plane's own server-rendered pages (real
product code, `server/src/http/pages.ts` — not a demo stand-in). Walk the user
through:

1. **先体验** on `/` — creates a temp account + recovery key, no form.
2. In the *already-open* workbench tab from URL 1 above, open **设置** in the
   sidebar → the "连接到 Hub" card (`src/hub/Pairing.tsx`) → paste the Hub URL
   `http://127.0.0.1:47210` (yes, `127.0.0.1` — the *daemon* dials that
   locally, it never goes through the user's browser) → **获取配对码**.
3. Back on the Hub tab, go to `/activate`, type the code shown, confirm.
   The already-open workbench tab flips to "已连接" **on its own** — no
   reload, no new tab needed. That single flip is steps 3–7 of the main
   journey in `docs/testing.md` §3 done at once (temp user, machine bound,
   machine visible in "我的机器").
4. On the Hub's `/` page, **换设备继续 → 生成链接**, then open that link in a
   second tab/incognito window (still on the Hub's own address) to see the
   same machine show up under a second session — that's the "接力" journey.
5. Optional, and the one part with a genuine rough edge in this sandbox:
   clicking **连接** on a machine from the Hub page routes through the open
   relay. See "Cross-device relay connect" below before promising it works
   in one click.

## Where the DeepSeek key comes from

## Where the DeepSeek key comes from

The script reads `DEEPSEEK_API_KEY` from the environment, falling back to
`genethub/.env`. It writes that key straight into the daemon's
`config.json` (provider `deepseek`, base URL `https://api.deepseek.com/v1`),
so chat works immediately with no manual setup step. If no key is found the
services still start; say so and point the user at the in-app Settings panel
instead of failing.

## Remote / sandboxed environments — read this before declaring success

If this shell has `~/.cursor-server` or `~/.vscode-server` (check with
`ls ~/.cursor-server 2>/dev/null`), the person you're helping is very likely
**not** browsing from this machine — they connect to it remotely through
Cursor, and only whatever port Cursor forwards is reachable from their actual
browser. Two things exist specifically to survive that:

1. **Only one port to forward.** `start_web` sets `GENEHUB_DATA_DIR` when
   launching vite, which activates `daemonProxy()` in `vite.config.ts`
   (already in the product for this exact reason — read its doc comment).
   `/daemon/*` on the web port transparently proxies to the daemon's real
   port, so the WebSocket never needs its own forward.
2. **`connect.html` doesn't hardcode a host.** It builds the endpoint URL from
   `location.host` *in the user's browser*, so it is correct whether they hit
   `127.0.0.1:5173` directly or a forwarded `https://something-else`.

So: for the single-daemon chat demo, tell the user to forward (or otherwise
expose) **one** port — the web port (default `5173`) — through Cursor's Ports
panel, then open `http://<that forwarded address>/connect.html`. Do not hand
out a raw `ws://127.0.0.1:<daemon-port>/...` fragment; it silently fails for
anyone not on this exact machine, and the daemon log showing zero incoming
connections is the tell that this happened.

Do not try to work around connectivity issues by driving a browser automation
tool instead — it does not make remote ports reachable and tends to hang for
minutes in this kind of sandbox.

### The full-journey demo needs a second forwarded port

The cloud control plane (default `47210`) is a *separate origin* from the web
workbench by design (`docs/self-hosting.md` §4 — "托管工作台的那台机器上不要跑
daemon"; the same separation applies to the Hub). There is no way to fold it
into the single `5173` forward the way `/daemon` is proxied, because the Hub's
own pages need to own path `/` (`/activate`, `/machines/:id/open`, …), which
the workbench app already owns on its own port. Tell the user to forward
**both** `5173` and `47210` and give them both forwarded addresses.

The relay (default `47211`) does **not** need forwarding — `GENEHUB_RELAY_PROXY_TARGET`
makes vite proxy `/relay` on the web port through to it, same trick as
`/daemon`.

### Cross-device relay connect: the one remaining manual step

`HUB_WORKBENCH_URL` is a fixed string baked in when the control plane starts
(`http://127.0.0.1:5173/hub-connect.html`), because — unlike `connect.html` —
this link is generated *server-side* by the Hub, which has no way to know what
host the *workbench* ends up forwarded to. So the "打开工作台" link the Hub
hands out after approving a connection always has `127.0.0.1:5173` baked into
its visible host. Two consequences:

1. **The user must swap that host themselves**, the same manual step as
   `connect.html` always needed — replace `127.0.0.1:5173` with `5173`'s
   forwarded address, keep everything after it (the `#endpoint=...` fragment).
2. Once they land on the resulting `hub-connect.html#endpoint=...` on the
   *correct* host, its inline script does the rest automatically: it unpacks
   the `ws://127.0.0.1:<relay-port>/forward/client?ticket=...` URL baked into
   that fragment (relay's real, unforwarded port) and rewrites it to
   `ws://<location.host>/relay/forward/client?ticket=...` before redirecting
   into the app — riding the same `/relay` vite proxy mentioned above.

Tell the user about step 1 up front rather than letting them hit a dead
`127.0.0.1` link and conclude the demo is broken.

If you change how `start_web` is invoked, re-verify the proxy actually works
before telling the user it's ready — `free_port`/pipefail and the fact that
`npm run dev` forks a child both bit this script during development (see the
git history of `demo.sh` if curious). A fast sanity check:

```bash
curl -s http://127.0.0.1:$WEB_PORT/daemon/health   # must print "ok", not HTML
```

If it prints the app's `index.html` instead of `ok`, the proxy did not
activate (usually `GENEHUB_DATA_DIR` not reaching the vite process, or
`endpoint.json` not written yet when vite started).

## Other commands

```bash
scripts/demo.sh status   # what's currently running (daemon/web/cloud/relay)
scripts/demo.sh url      # reprint both URLs without restarting anything
scripts/demo.sh stop     # tear everything down
```

If there is no sibling `genethub-cloud` checkout (`../genethub-cloud` next to
this repo), `start_cloud`/`start_relay` log that they're skipping and the
script degrades to the old single-daemon demo — `status` will say
`cloud: unavailable`. That is expected in a checkout that only has the
open-source repo; don't treat it as a failure.

## Gotchas this script exists to avoid

- Never `pkill -f` a path-based pattern (e.g. `target/release/genet-daemon`)
  to manage these processes by hand. The shell wrapper invoking your command
  carries that same path in its own argv, so the pattern self-matches and
  kills your own command mid-run. The script tracks PIDs in
  `$GENEHUB_DEMO_DIR/{daemon,web}.pid` instead — reuse `stop`/`status` rather
  than reaching for `pkill`.
- `npm run dev` forks a shell that forks the real vite/node process; killing
  just the pid `$!` gives you leaves that child alive holding the port for
  the *next* `start`, which then fails with `EADDRINUSE` and no obvious
  cause. `stop_all` uses `kill -TERM -$pid` (process group, because each pid
  came from `setsid cmd &`) and `start_web`/`start_daemon` call `free_port`
  first to self-heal anything still orphaned from before this fix existed.

## Customizing

Environment variables, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `GENEHUB_DEMO_DIR` | `/tmp/genehub-demo` | Where data/workspace/logs/pids live |
| `GENEHUB_DEMO_DAEMON_PORT` | `47100` | Fixed daemon port (stable across restarts, easier to forward) |
| `GENEHUB_DEMO_WEB_PORT` | `5173` | Web workbench dev server port |
| `GENEHUB_DEMO_CLOUD_PORT` | `47210` | genethub-cloud control plane port |
| `GENEHUB_DEMO_RELAY_PORT` | `47211` | Open-source relay port (never forwarded — rides `/relay` on the web port) |
| `DEEPSEEK_API_KEY` | (from `.env`) | Overrides the key read from `genethub/.env` |

Ports were moved off the more "obvious"-looking `47110`/`47111` after those
kept coming up `EADDRINUSE` from a stale orphaned socket in this sandbox
(`ss`/`lsof` showed an `ESTABLISHED` connection with no owning process —
suspected leftover from Cursor's own auto-port-forwarding probing a port it
once saw a listener on). If a fresh `start` ever fails the same way, look for
an `ESTABLISHED` entry with no PID via `ss -tnp | grep <port>` before assuming
the script's `free_port` is broken, and just pick a different port.
