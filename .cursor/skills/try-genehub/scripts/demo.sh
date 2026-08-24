#!/usr/bin/env bash
# Spins up a throwaway GeneHub instance for someone to try in a browser
# without building the desktop installer: daemon + web workbench dev server
# pre-wired to DeepSeek, plus (since `start`) the genethub-cloud control plane
# and open-source relay, so the full journey — register, pair this machine to
# a Hub, list it, generate a one-time cross-device link — is actually
# clickable, not just the single-daemon chat demo.
# Idempotent: re-running `start` reuses whatever is already healthy instead of
# stacking duplicate processes.
#
# Usage:
#   scripts/demo.sh start   # boot daemon + web + cloud + relay, print the URLs
#   scripts/demo.sh url     # just print the URLs (services must already be up)
#   scripts/demo.sh status  # show what's running
#   scripts/demo.sh stop    # tear everything down
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# genethub-cloud is a sibling checkout, not a subdirectory of this repo — see
# the dual-monorepo split in genethub-cloud/docs/product.md §3.5. If it is
# missing, the cloud/relay pieces are skipped and this degrades to the old
# single-daemon demo rather than failing outright.
CLOUD_REPO="$REPO/../genethub-cloud"
DEMO_DIR="${GENEHUB_DEMO_DIR:-/tmp/genehub-demo}"
DATA_DIR="$DEMO_DIR/data"
WORKSPACE_DIR="$DEMO_DIR/workspace"
CLOUD_DATA_DIR="$DEMO_DIR/cloud"
DAEMON_PORT="${GENEHUB_DEMO_DAEMON_PORT:-47100}"
WEB_PORT="${GENEHUB_DEMO_WEB_PORT:-5173}"
CLOUD_PORT="${GENEHUB_DEMO_CLOUD_PORT:-47210}"
RELAY_PORT="${GENEHUB_DEMO_RELAY_PORT:-47211}"
DAEMON_BIN="$REPO/target/release/genet"
AGENT_BIN="$REPO/target/release/genet-agent"
WEB_DIR="$REPO/packages/workbench"
RELAY_DIR="$REPO/apps/relay"
CLOUD_DIR="$CLOUD_REPO/server"

# IMPORTANT: never `pkill -f` a path-based pattern here. The shell wrapper
# that runs this very script also carries that path in its own argv, so a
# pattern like "target/release/genet" self-matches and kills the
# script mid-run. Track PIDs explicitly instead.
DAEMON_PID_FILE="$DEMO_DIR/daemon.pid"
WEB_PID_FILE="$DEMO_DIR/web.pid"
CLOUD_PID_FILE="$DEMO_DIR/cloud.pid"
RELAY_PID_FILE="$DEMO_DIR/relay.pid"
RELAY_TOKEN_FILE="$DEMO_DIR/relay.token"

log() { echo "==> $*" >&2; }

daemon_running() { [[ -f "$DAEMON_PID_FILE" ]] && kill -0 "$(cat "$DAEMON_PID_FILE")" 2>/dev/null; }
web_running() { [[ -f "$WEB_PID_FILE" ]] && kill -0 "$(cat "$WEB_PID_FILE")" 2>/dev/null; }
cloud_running() { [[ -f "$CLOUD_PID_FILE" ]] && kill -0 "$(cat "$CLOUD_PID_FILE")" 2>/dev/null; }
relay_running() { [[ -f "$RELAY_PID_FILE" ]] && kill -0 "$(cat "$RELAY_PID_FILE")" 2>/dev/null; }
cloud_available() { [[ -d "$CLOUD_DIR" ]]; }

# `npm run dev` forks a shell that forks the real vite/node process; both
# stayed alive in earlier iterations of this script because plain `kill` on
# npm's own pid leaves its child holding the port. Each pid here comes from
# `setsid cmd &`, which makes the pid both the session id and the process
# group id, so signalling the negative pid reaches the whole tree in one shot.
kill_group() { kill -TERM "-$1" 2>/dev/null || kill "$1" 2>/dev/null || true; }

# Self-heals past runs that leaked a process this script no longer has a pid
# file for (e.g. a manual `kill` on npm's pid that left vite's child holding
# the port). Without this, `--strictPort` just fails start_web with no clue.
free_port() {
  local port="$1"
  local pid
  pid="$(ss -ltnp 2>/dev/null | awk -v p=":$port\$" '$4 ~ p {print $0}' | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  if [[ -n "$pid" ]]; then
    log "port $port was held by a leftover process (pid $pid); cleaning it up"
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.5
  fi
}

build_binaries() {
  # Always ask cargo, never just check for the binaries' existence: a stale
  # binary from before the day's code changes looks identical to a fresh one
  # until you notice a feature that was definitely added is missing at
  # runtime. cargo no-ops quickly when nothing changed, so this costs nothing
  # in the common case.
  log "building genet and genet-agent (release)"
  cargo build --release --manifest-path "$REPO/Cargo.toml" -p genet-cli -p genet-agent
}

write_config() {
  local key="$1"
  mkdir -p "$DATA_DIR" "$WORKSPACE_DIR"
  python3 - "$DATA_DIR/config.json" "$DAEMON_PORT" "$key" "$WORKSPACE_DIR" <<'PY'
import json, sys
path, port, key, workspace = sys.argv[1:5]
existing = {}
try:
    with open(path) as f:
        existing = json.load(f)
except FileNotFoundError:
    pass
existing.setdefault("agents", {}).setdefault("providers", {})["deepseek"] = {
    "apiKey": key,
    "baseUrl": "https://api.deepseek.com/v1",
}
existing["port"] = int(port)
existing.setdefault("lanEnabled", False)
existing.setdefault("hubUrl", None)
existing.setdefault("agents", {}).setdefault("custom", {})
existing.setdefault("workspaces", [])
existing.setdefault("replayWindow", 2048)
with open(path, "w") as f:
    json.dump(existing, f, indent=2)
PY
}

deepseek_key() {
  if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
    printf '%s' "$DEEPSEEK_API_KEY"
    return
  fi
  if [[ -f "$REPO/.env" ]]; then
    grep '^DEEPSEEK_API_KEY=' "$REPO/.env" | head -1 | cut -d= -f2-
    return
  fi
  echo ""
}

start_daemon() {
  if daemon_running; then
    log "daemon already running (pid $(cat "$DAEMON_PID_FILE"))"
    if [[ -f "$DEMO_DIR/daemon.bin.mtime" ]] && [[ "$(stat -c %Y "$DAEMON_BIN")" != "$(cat "$DEMO_DIR/daemon.bin.mtime")" ]]; then
      log "WARNING: the binary on disk changed since this daemon started (code was rebuilt)."
      log "Run 'stop' then 'start' again to pick it up — a running agent keeps running the old code otherwise."
    fi
    return
  fi
  local key
  key="$(deepseek_key)"
  if [[ -z "$key" ]]; then
    log "WARNING: no DEEPSEEK_API_KEY found (checked env and $REPO/.env)."
    log "The workbench will load but chat needs a provider key configured in Settings."
  fi
  write_config "$key"
  free_port "$DAEMON_PORT"
  log "starting daemon on port $DAEMON_PORT"
  GENEHUB_DATA_DIR="$DATA_DIR" GENEHUB_WORKSPACE_DIR="$WORKSPACE_DIR" \
    setsid "$DAEMON_BIN" daemon run >"$DEMO_DIR/daemon.log" 2>&1 < /dev/null &
  echo $! > "$DAEMON_PID_FILE"
  stat -c %Y "$DAEMON_BIN" > "$DEMO_DIR/daemon.bin.mtime"
  for _ in $(seq 1 20); do
    [[ -f "$DATA_DIR/endpoint.json" ]] && break
    sleep 0.5
  done
  if [[ ! -f "$DATA_DIR/endpoint.json" ]]; then
    log "daemon failed to come up, see $DEMO_DIR/daemon.log"
    exit 1
  fi
}

start_web() {
  if web_running; then
    log "web workbench already running (pid $(cat "$WEB_PID_FILE"))"
    return
  fi
  if [[ ! -d "$WEB_DIR/node_modules" ]]; then
    log "installing web workbench deps (first run only)"
    npm --prefix "$WEB_DIR" install
  fi
  free_port "$WEB_PORT"
  log "starting web workbench on port $WEB_PORT"
  # GENEHUB_DATA_DIR here makes vite.config.ts's daemonProxy read the same
  # endpoint.json and proxy /daemon -> the real daemon port. That means the
  # WebSocket rides the same origin as the page, so only $WEB_PORT ever needs
  # forwarding — the daemon's own (randomly-portable) port never does.
  # GENEHUB_RELAY_PROXY_TARGET does the same for the relay (fixed port, so no
  # file-based discovery needed) — see relayProxy() in vite.config.ts.
  ( cd "$WEB_DIR" && GENEHUB_DATA_DIR="$DATA_DIR" GENEHUB_RELAY_PROXY_TARGET="http://127.0.0.1:$RELAY_PORT" \
      setsid npm run dev -- --port "$WEB_PORT" --host 127.0.0.1 --strictPort \
      >"$DEMO_DIR/web.log" 2>&1 < /dev/null & echo $! > "$WEB_PID_FILE" )
  for _ in $(seq 1 20); do
    curl -s -o /dev/null "http://127.0.0.1:$WEB_PORT/" && break
    sleep 0.5
  done
}

# A static page that computes the daemon URL from wherever the browser
# actually loaded it from (`location.host`), instead of a host baked in ahead
# of time — which is unusable once a remote/sandboxed machine's port gets
# forwarded to some other host:port we cannot predict here. Written into
# vite's `public/` so it's served as-is; removed by `stop`.
write_connect_page() {
  local token="$1"
  mkdir -p "$WEB_DIR/public"
  cat > "$WEB_DIR/public/connect.html" <<HTML
<!doctype html>
<script>
  var proto = location.protocol === "https:" ? "wss" : "ws";
  var url = proto + "://" + location.host + "/daemon/ws?token=${token}";
  location.replace("./#endpoint=" + encodeURIComponent(url));
</script>
HTML
}

# The cloud's "打开工作台" links (both `/machines/:id/open` and the pairing
# flow) are server-rendered once, at `HUB_WORKBENCH_URL`, so they bake in
# 127.0.0.1:$WEB_PORT — fine on this machine, wrong once someone opens them
# through a forwarded address. This page is that fixed URL's target: it can't
# fix its *own* host (the browser already had to resolve that to get here —
# see the skill doc for the one manual step this still needs), but it can and
# does fix the *relay* host buried inside the `#endpoint=` fragment it was
# handed, rewriting it from the relay's real (unforwarded) port to `/relay` on
# whatever host actually served this page.
write_hub_connect_page() {
  mkdir -p "$WEB_DIR/public"
  cat > "$WEB_DIR/public/hub-connect.html" <<'HTML'
<!doctype html>
<script>
  var params = new URLSearchParams(location.hash.slice(1));
  var inner = params.get("endpoint");
  if (!inner) {
    document.write("no endpoint in the URL — open this via the cloud's \"打开工作台\" link, not directly");
  } else {
    var innerUrl = new URL(inner);
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var fixed = proto + "://" + location.host + "/relay" + innerUrl.pathname + innerUrl.search;
    location.replace("./#endpoint=" + encodeURIComponent(fixed));
  }
</script>
HTML
}

start_cloud() {
  if ! cloud_available; then
    log "genethub-cloud not found at $CLOUD_REPO — skipping control plane + relay (single-daemon demo only)"
    return
  fi
  if cloud_running; then
    log "cloud control plane already running (pid $(cat "$CLOUD_PID_FILE"))"
    return
  fi
  if [[ ! -d "$CLOUD_DIR/node_modules" ]]; then
    log "installing genethub-cloud/server deps (first run only)"
    npm --prefix "$CLOUD_DIR" install
  fi
  head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$RELAY_TOKEN_FILE"
  mkdir -p "$CLOUD_DATA_DIR"
  free_port "$CLOUD_PORT"
  log "starting cloud control plane on port $CLOUD_PORT"
  ( cd "$CLOUD_DIR" && \
    HUB_PORT="$CLOUD_PORT" HUB_HOST=127.0.0.1 \
    HUB_DB="$CLOUD_DATA_DIR/hub.sqlite" \
    HUB_RELAY_ORIGIN="http://127.0.0.1:$RELAY_PORT" \
    HUB_RELAY_TOKEN="$(cat "$RELAY_TOKEN_FILE")" \
    HUB_WORKBENCH_URL="http://127.0.0.1:$WEB_PORT/hub-connect.html" \
    setsid npx tsx src/main.ts >"$DEMO_DIR/cloud.log" 2>&1 < /dev/null & echo $! > "$CLOUD_PID_FILE" )
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:$CLOUD_PORT/api/health" && return
    sleep 0.5
  done
  log "cloud control plane failed to come up, see $DEMO_DIR/cloud.log"
  exit 1
}

start_relay() {
  if ! cloud_available; then return; fi
  if relay_running; then
    log "relay already running (pid $(cat "$RELAY_PID_FILE"))"
    return
  fi
  if [[ ! -f "$RELAY_TOKEN_FILE" ]]; then
    log "no relay token on disk — run 'start_cloud' first"
    exit 1
  fi
  free_port "$RELAY_PORT"
  log "starting relay on port $RELAY_PORT"
  ( cd "$RELAY_DIR" && \
    RELAY_PORT="$RELAY_PORT" RELAY_HOST=127.0.0.1 \
    RELAY_CONTROL_ORIGIN="http://127.0.0.1:$CLOUD_PORT" \
    RELAY_CONTROL_TOKEN="$(cat "$RELAY_TOKEN_FILE")" \
    setsid npx tsx src/main.ts >"$DEMO_DIR/relay.log" 2>&1 < /dev/null & echo $! > "$RELAY_PID_FILE" )
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:$RELAY_PORT/api/health" && return
    sleep 0.5
  done
  log "relay failed to come up, see $DEMO_DIR/relay.log"
  exit 1
}

print_url() {
  if [[ ! -f "$DATA_DIR/endpoint.json" ]]; then
    log "daemon endpoint not found; run 'start' first"
    exit 1
  fi
  local token
  token="$(python3 -c "import json;print(json.load(open('$DATA_DIR/endpoint.json'))['token'])")"
  write_connect_page "$token"
  echo
  echo "== Chat with this machine directly (no account needed) =="
  echo "  http://127.0.0.1:$WEB_PORT/connect.html"
  echo "It figures out the daemon address from whatever host served the page,"
  echo "so it also works after Cursor forwards $WEB_PORT to some other host:port —"
  echo "just replace 127.0.0.1:$WEB_PORT above with that forwarded address."

  if cloud_available; then
    write_hub_connect_page
    echo
    echo "== Full journey: register, pair this machine, cross-device link =="
    echo "  http://127.0.0.1:$CLOUD_PORT/"
    echo "Forward this port too (Cursor Ports panel) alongside $WEB_PORT above."
    echo "On the Hub page: 先体验 (temp account) -> in the workbench's Settings,"
    echo "paste Hub URL http://127.0.0.1:$CLOUD_PORT (that one stays 127.0.0.1 —"
    echo "the daemon calls it locally, it never goes through the browser) and"
    echo "get a pairing code -> back on the Hub page's /activate, enter the code"
    echo "-> approve. The workbench tab you already had open flips to 已连接 by"
    echo "itself. From there '我的机器' -> 连接, and 换设备继续 -> 生成链接 both work"
    echo "on the Hub's own forwarded address."
    echo
    echo "The '打开工作台' link that flow produces bakes in 127.0.0.1:$WEB_PORT —"
    echo "swap that for $WEB_PORT's forwarded address the same way as above and it"
    echo "will fix up the relay socket inside the fragment automatically (see"
    echo "hub-connect.html / vite.config.ts relayProxy)."
  fi
}

status() {
  if daemon_running; then echo "daemon: running (pid $(cat "$DAEMON_PID_FILE"))"; else echo "daemon: stopped"; fi
  if web_running; then echo "web: running (pid $(cat "$WEB_PID_FILE"))"; else echo "web: stopped"; fi
  if cloud_available; then
    if cloud_running; then echo "cloud: running (pid $(cat "$CLOUD_PID_FILE"))"; else echo "cloud: stopped"; fi
    if relay_running; then echo "relay: running (pid $(cat "$RELAY_PID_FILE"))"; else echo "relay: stopped"; fi
  else
    echo "cloud: unavailable (no checkout at $CLOUD_REPO)"
  fi
}

stop_all() {
  if daemon_running; then kill_group "$(cat "$DAEMON_PID_FILE")"; log "stopped daemon"; fi
  if web_running; then kill_group "$(cat "$WEB_PID_FILE")"; log "stopped web"; fi
  if cloud_running; then kill_group "$(cat "$CLOUD_PID_FILE")"; log "stopped cloud"; fi
  if relay_running; then kill_group "$(cat "$RELAY_PID_FILE")"; log "stopped relay"; fi
  sleep 0.5
  rm -f "$DAEMON_PID_FILE" "$WEB_PID_FILE" "$CLOUD_PID_FILE" "$RELAY_PID_FILE" "$RELAY_TOKEN_FILE" \
    "$WEB_DIR/public/connect.html" "$WEB_DIR/public/hub-connect.html"
}

case "${1:-start}" in
  start)
    build_binaries
    start_daemon
    start_cloud
    start_relay
    start_web
    print_url
    ;;
  url) print_url ;;
  status) status ;;
  stop) stop_all ;;
  *)
    echo "usage: $0 {start|url|status|stop}" >&2
    exit 1
    ;;
esac
