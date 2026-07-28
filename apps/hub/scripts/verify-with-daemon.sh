#!/usr/bin/env bash
# End-to-end check of the Hub against a real Paseo daemon.
#
# Exercises the whole protocol surface the daemon implements: device
# authorization, enrollment, the execution socket, and revocation from both
# sides. Everything runs on loopback with relay disabled, and the daemon home is
# a throwaway directory.
#
#   PASEO_BIN=/path/to/paseo ./scripts/verify-with-daemon.sh
set -euo pipefail

PASEO_BIN="${PASEO_BIN:-paseo}"
HUB_PORT="${HUB_PORT:-8791}"
DAEMON_PORT="${DAEMON_PORT:-7691}"
HUB_ORIGIN="http://127.0.0.1:${HUB_PORT}"
WORKDIR="$(mktemp -d /tmp/genethub-verify.XXXXXX)"
HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass=0
fail=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

check() { # check <description> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (期望 $3，实际 $2)"; fi
}

cleanup() {
  "$PASEO_BIN" daemon stop --home "$WORKDIR/paseo" >/dev/null 2>&1 || true
  [ -n "${HUB_PID:-}" ] && kill "$HUB_PID" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

jqp() { python3 -c "import json,sys;$1"; }

step "启动 Hub（临时数据库）"
HUB_PUBLIC_ORIGIN="$HUB_ORIGIN" HUB_PORT="$HUB_PORT" HUB_DB="$WORKDIR/hub.sqlite" \
  npx --prefix "$HUB_DIR" tsx "$HUB_DIR/src/index.ts" >"$WORKDIR/hub.log" 2>&1 &
HUB_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "$HUB_ORIGIN/api/health" >/dev/null 2>&1 && break
  sleep 1
done
check "Hub /api/health" "$(curl -sS "$HUB_ORIGIN/api/health")" '{"status":"ok"}'

step "启动隔离的 daemon（关闭 relay 与 web UI）"
"$PASEO_BIN" daemon start --home "$WORKDIR/paseo" --port "$DAEMON_PORT" --no-relay --no-web-ui >/dev/null
sleep 3

connect_and_approve() { # -> echoes machine id
  "$PASEO_BIN" hub connect "$HUB_ORIGIN" --host "127.0.0.1:$DAEMON_PORT" >"$WORKDIR/connect.log" 2>&1 &
  local code=""
  for _ in $(seq 1 30); do
    code="$(grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' "$WORKDIR/connect.log" | head -1 || true)"
    [ -n "$code" ] && break
    sleep 1
  done
  [ -n "$code" ] || { bad "未拿到配对码"; return 1; }

  curl -sS -c "$WORKDIR/cookies" "$HUB_ORIGIN/activate?code=$code" >/dev/null
  curl -sS -b "$WORKDIR/cookies" -c "$WORKDIR/cookies" -X POST "$HUB_ORIGIN/activate" \
    -d "code=$code" -d 'action=approve' >/dev/null
  sleep 8
}

step "设备码授权 + 登记"
connect_and_approve
check "daemon 关系状态" \
  "$("$PASEO_BIN" hub status --host "127.0.0.1:$DAEMON_PORT" --json | jqp 'print(json.load(sys.stdin)[0]["state"])')" \
  "connected"

MACHINES="$(curl -sS -b "$WORKDIR/cookies" "$HUB_ORIGIN/app/machines")"
check "Hub 记录到 1 台机器" "$(echo "$MACHINES" | jqp 'print(len(json.load(sys.stdin)["machines"]))')" "1"
check "执行通道已连接（在线）" "$(echo "$MACHINES" | jqp 'print(json.load(sys.stdin)["machines"][0]["online"])')" "True"
MACHINE_ID="$(echo "$MACHINES" | jqp 'print(json.load(sys.stdin)["machines"][0]["id"])')"

step "连接凭证（offer）"
OFFER="$(curl -sS -b "$WORKDIR/cookies" -X POST "$HUB_ORIGIN/app/machines/$MACHINE_ID/offer")"
check "offer 解码为 v2" \
  "$(echo "$OFFER" | jqp '
import base64
u = json.load(sys.stdin)["url"].split("#offer=")[1]
o = json.loads(base64.urlsafe_b64decode(u + "=" * (-len(u) % 4)))
print(o["v"])')" "2"
check "offer 下发已审计" \
  "$(curl -sS -b "$WORKDIR/cookies" "$HUB_ORIGIN/app/audit" | jqp \
    'print(sum(1 for e in json.load(sys.stdin)["entries"] if e["action"] == "offer.issued"))')" "1"

step "一次性设备链接"
LINK="$(curl -sS -b "$WORKDIR/cookies" -X POST "$HUB_ORIGIN/app/links" | jqp 'print(json.load(sys.stdin)["url"])')"
curl -sS -c "$WORKDIR/cookies2" -o /dev/null "$LINK"
check "新设备看到同一台机器" \
  "$(curl -sS -b "$WORKDIR/cookies2" "$HUB_ORIGIN/app/machines" | jqp \
    'print(json.load(sys.stdin)["machines"][0]["id"])')" "$MACHINE_ID"
check "链接不能重复使用" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$LINK")" "410"

step "daemon 侧解绑"
"$PASEO_BIN" hub disconnect --host "127.0.0.1:$DAEMON_PORT" >/dev/null 2>&1 || true
sleep 3
check "机器已从列表移除" \
  "$(curl -sS -b "$WORKDIR/cookies" "$HUB_ORIGIN/app/machines" | jqp \
    'print(len(json.load(sys.stdin)["machines"]))')" "0"

step "Hub 侧强制撤销"
connect_and_approve
MACHINE_ID="$(curl -sS -b "$WORKDIR/cookies" "$HUB_ORIGIN/app/machines" | jqp \
  'print(json.load(sys.stdin)["machines"][0]["id"])')"
curl -sS -b "$WORKDIR/cookies" -X POST "$HUB_ORIGIN/app/machines/$MACHINE_ID/revoke" >/dev/null
sleep 10
check "daemon 进入 revoked" \
  "$("$PASEO_BIN" hub status --host "127.0.0.1:$DAEMON_PORT" --json | jqp 'print(json.load(sys.stdin)[0]["state"])')" \
  "revoked"

printf '\n\033[1m%d 通过, %d 失败\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
