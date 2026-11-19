#!/bin/sh
# Installs the CLI, the wasm shell and the guest component — the daemon and
# the built-in agent both ride the component. No desktop shell, no Node.
#
# This is the path for a machine with no graphical session: a server, a VM, a
# box you only ever reach over SSH. It is also the fallback when there is no
# installer for someone's platform yet. The Linux tarball is musl-static, so an
# older glibc on the box is not a reason for the binary to refuse to start.
#
#   curl --proto '=https' --proto-redir '=https' --max-redirs 5 --globoff -fsSL \
#     https://raw.githubusercontent.com/aikenc/genethub/main/scripts/install.sh | sh
#
# A deployment that offers a friendlier address serves this same file from it.
#
# POSIX sh on purpose: piping into `sh` is how people will run it, and that is
# not always bash.
set -eu

# channel: local — written by scripts/channel.mjs
# Everything below that names a file, an address or an environment variable
# derives from that one word, so a prerelease install can never reach for a
# stable asset — the channels install side by side on one machine and none
# may touch another's binaries or overrides (`version-management.md`).
# It is a plain assignment rather than something the script re-reads from its
# own file, because the usual way to run this is `curl | sh`, where $0 is not
# the script at all.
channel=local

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$channel" in
  dev)
    base="${GENEHUB_DEV_DOWNLOAD_BASE:-https://relay-dev.genethub.com/download/dev}"
    bin_dir="${GENEHUB_DEV_BIN_DIR:-$HOME/.local/bin}"
    tarball_prefix=genet-dev
    cli_binary=genet-dev
    host_binary=genehub-host-dev
    component=genehub_guest-dev.wasm
    data_dir_name=GeneHub-dev
    data_dir="${GENEHUB_DEV_DATA_DIR:-}"
    ;;
  beta)
    base="${GENEHUB_BETA_DOWNLOAD_BASE:-https://relay-beta.genethub.com/download/beta}"
    bin_dir="${GENEHUB_BETA_BIN_DIR:-$HOME/.local/bin}"
    tarball_prefix=genet-beta
    cli_binary=genet-beta
    host_binary=genehub-host-beta
    component=genehub_guest-beta.wasm
    data_dir_name=GeneHub-beta
    data_dir="${GENEHUB_BETA_DATA_DIR:-}"
    ;;
  stable)
    base="${GENEHUB_DOWNLOAD_BASE:-https://github.com/aikenc/genethub/releases/latest/download}"
    bin_dir="${GENEHUB_BIN_DIR:-$HOME/.local/bin}"
    tarball_prefix=genet
    cli_binary=genet
    host_binary=genehub-host
    component=genehub_guest.wasm
    data_dir_name=GeneHub
    data_dir="${GENEHUB_DATA_DIR:-}"
    ;;
  *)
    # local: the tree's own state. There is no local artifact to download, so
    # the only way this runs is someone piping the source checkout into sh —
    # which would otherwise quietly install the *stable* line over whatever
    # they meant to test. Refuse, unless a download base is named on purpose
    # (the way a CI rehearsal's artifacts get installed for a smoke test).
    [ -n "${GENEHUB_LOCAL_DOWNLOAD_BASE:-}" ] || die "this install.sh comes from the source tree (channel: local) and has nothing to install.
  stable:  curl --proto '=https' --proto-redir '=https' --max-redirs 5 --globoff -fsSL https://relay.genethub.com/install.sh | sh
  beta:    curl --proto '=https' --proto-redir '=https' --max-redirs 5 --globoff -fsSL https://relay-beta.genethub.com/install.sh | sh
  or set GENEHUB_LOCAL_DOWNLOAD_BASE to a directory of artifacts on purpose"
    base="$GENEHUB_LOCAL_DOWNLOAD_BASE"
    bin_dir="${GENEHUB_LOCAL_BIN_DIR:-$HOME/.local/bin}"
    tarball_prefix=genet-local
    cli_binary=genet-local
    host_binary=genehub-host-local
    component=genehub_guest.wasm
    data_dir_name=GeneHub-local
    data_dir="${GENEHUB_LOCAL_DATA_DIR:-}"
    ;;
esac

# The daemon and the agent are one wasm component; the CLI execs the shell
# (host_binary) with it, so all three have to land side by side. It is
# installed under the channel's own name (set above), because the bin
# directory is shared and a running daemon reloads whenever its component file
# changes: another channel's component in the same directory is left alone.
#
# The name is the tarball's, not this script's: the CLI in it looks for the
# component under the name it was built with. This script is served apart
# from the tarball and can be newer than it, and a release from before
# per-channel names carries, and looks for, only the shared one.
shared_component=genehub_guest.wasm

# Downloads are executable code. Do not let an environment override turn the
# explicit installer into an HTTP, local-file or credential-bearing fetch. A
# query or fragment is unnecessary for the fixed release layout and makes URL
# review/logging ambiguous, so those are rejected too.
#
# One address is allowed to be plain http: a literal loopback host with a port,
# http://127.0.0.1:<port> or http://[::1]:<port>. Nothing off this machine can
# answer it, so there is no network path to tamper with, and it is what lets a
# development checkout install its own build without a certificate. It is
# decided by the address alone — there is no switch for it — and `localhost` is
# not accepted because it goes through name resolution. Redirects are refused
# outright for it.
loopback=0
case "$base" in
  https://*) ;;
  http://127.0.0.1:* | http://\[::1\]:*) loopback=1 ;;
  *) die "download base must use https:// (or a literal loopback address with a port)" ;;
esac
case "$base" in
  *\?* | *\#*) die "download base must not contain a query or fragment" ;;
esac
authority="${base#*://}"
authority="${authority%%/*}"
[ -n "$authority" ] || die "download base has no host"
case "$authority" in
  *@*) die "download base must not contain credentials" ;;
esac
if [ "$loopback" = 1 ]; then
  case "$authority" in
    127.0.0.1:*) port="${authority#127.0.0.1:}" ;;
    \[::1\]:*) port="${authority#\[::1\]:}" ;;
    *) die "download base is not a literal loopback address" ;;
  esac
  case "$port" in
    '' | *[!0-9]*) die "download base needs a numeric port on a loopback address" ;;
  esac
fi

case "$(uname -s)" in
  Linux) os=linux ;;
  # The CLI tarball needs no signature: curl does not quarantine downloads, so
  # the binaries run without a Gatekeeper word. (The desktop .app is the one
  # that waits for notarisation — a browser-downloaded app is quarantined.)
  Darwin) os=darwin ;;
  *) die "no build for $(uname -s). Build from source: https://github.com/aikenc/genethub" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "no build for $(uname -m)" ;;
esac

# Linux is published for x64 only, macOS for Apple Silicon only so far. Saying
# so beats a 404 from curl.
if [ "$os" = linux ] && [ "$arch" != x64 ]; then
  die "no Linux $arch build yet. Build from source: https://github.com/aikenc/genethub"
fi
if [ "$os" = darwin ] && [ "$arch" != arm64 ]; then
  die "no macOS $arch build yet (Apple Silicon only). Build from source: https://github.com/aikenc/genethub"
fi

asset="$tarball_prefix-$os-$arch.tar.gz"

if command -v curl >/dev/null 2>&1; then
  fetch() {
    if [ "$loopback" = 1 ]; then
      curl --proto '=http' --max-redirs 0 --globoff -fsSL "$1" -o "$2"
    else
      curl --proto '=https' --proto-redir '=https' --max-redirs 5 --globoff -fsSL "$1" -o "$2"
    fi
  }
elif command -v wget >/dev/null 2>&1; then
  fetch() {
    if [ "$loopback" = 1 ]; then
      wget --max-redirect=0 -qO "$2" "$1"
    else
      wget --https-only --max-redirect=5 -qO "$2" "$1"
    fi
  }
else
  die "need curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "need sha256sum or shasum"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "==> downloading $asset"
fetch "$base/$asset" "$tmp/$asset" || die "could not download $base/$asset"

# The checksum is not optional. A truncated download produces a binary that
# fails in some confusing way later, and telling those two apart afterwards is
# far more work than checking now.
say "==> checking the download"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" \
  || die "no SHA256SUMS next to the download, so it cannot be verified"
want="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)" \
  || die "SHA256SUMS does not mention $asset"
[ -n "$want" ] || die "SHA256SUMS does not mention $asset"
got="$(digest "$tmp/$asset")"
[ "$want" = "$got" ] || die "checksum mismatch for $asset: expected $want, got $got"

say "==> installing into $bin_dir"
mkdir -p "$tmp/unpacked" "$bin_dir"
tar -xzf "$tmp/$asset" -C "$tmp/unpacked"

if [ -z "$(find "$tmp/unpacked" -name "$component" -type f -print | head -n 1)" ]; then
  component="$shared_component"
  # A release from before per-channel names looks for the shared name, which
  # is also the one stable's component lives under. If another channel's CLI
  # is already in this directory, writing it would swap the component that
  # channel's running daemon reloads from — the failure per-channel names
  # exist to prevent — so refuse before touching anything.
  for other in genet genet-dev genet-beta genet-local; do
    if [ "$other" != "$cli_binary" ] && [ -e "$bin_dir/$other" ]; then
      case "$channel" in
        dev) bin_var=GENEHUB_DEV_BIN_DIR ;;
        *) bin_var=GENEHUB_BETA_BIN_DIR ;;
      esac
      die "$asset predates per-channel component names and would replace $bin_dir/$shared_component, which $other in the same directory may be running. Install it into its own directory instead: $bin_var=<directory> (or wait for a newer release)."
    fi
  done
fi
# Keep staging and replacement on the destination filesystem so each rename
# is atomic. The channel-specific directory also serializes installation.
transaction="$bin_dir/.genehub-$channel-install"
mkdir -m 700 "$transaction" || die "another installation is running or needs recovery: $transaction"
files="$cli_binary $host_binary $component"
applied=
python_pointer=
python_touched=
previous=
recover_files() {
  if [ -n "$applied" ]; then
    for name in $files; do
      if [ -e "$transaction/old/$name" ] || [ -L "$transaction/old/$name" ]; then
        cp -pP "$transaction/old/$name" "$transaction/restore/$name" \
          && mv -f "$transaction/restore/$name" "$bin_dir/$name" || return 1
      else
        rm -f "$bin_dir/$name" || return 1
      fi
    done
  fi
  if [ -n "$python_touched" ]; then
    if [ -f "$transaction/python.json" ]; then
      cp -p "$transaction/python.json" "$python_pointer.restore-$$" \
        && mv -f "$python_pointer.restore-$$" "$python_pointer" || return 1
    else
      rm -f "$python_pointer" || return 1
    fi
  fi
}
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  keep=
  if [ "$result" -ne 0 ] && { [ -n "$applied" ] || [ -n "$python_touched" ]; }; then
    if [ -e "$transaction/startup-observed" ]; then
      keep=yes
      say "New daemon startup reached its data. Automatic downgrade was stopped. Backups retained: $transaction" >&2
    elif recover_files; then
      say "Previous installation files restored." >&2
      if [ -n "$previous" ]; then
        read -r old_machine old_pid <<EOF
$previous
EOF
        if "$transaction/new/$cli_binary" daemon __restore-service "$old_machine" "$old_pid" >/dev/null; then
          say "Previous daemon instance verified." >&2
        else
          keep=yes
          say "Previous daemon recovery could not be verified. Backups retained: $transaction" >&2
        fi
      fi
    else
      keep=yes
      say "Previous installation could not be fully restored. Backups retained: $transaction" >&2
    fi
  fi
  [ -n "$keep" ] || rm -rf "$transaction"
  rm -rf "$tmp"
  exit "$result"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$transaction/new" "$transaction/old" "$transaction/restore"

refresh_service=
for binary in $files; do
  found="$(find "$tmp/unpacked" -name "$binary" -type f -print | head -n 1)"
  [ -n "$found" ] || die "$binary is missing from $asset"
  cp "$found" "$transaction/new/$binary"
  case "$binary" in
    *.wasm) chmod 644 "$transaction/new/$binary" ;;
    *) chmod 755 "$transaction/new/$binary" ;;
  esac
  if [ -e "$bin_dir/$binary" ] || [ -L "$bin_dir/$binary" ]; then
    cp -pP "$bin_dir/$binary" "$transaction/old/$binary"
  fi
  if ! cmp -s "$found" "$bin_dir/$binary"; then refresh_service=--refresh; fi
done

native_service=
if [ "${GENEHUB_NO_SERVICE:-}" != 1 ]; then
  if [ "$("$transaction/new/$cli_binary" daemon __service-capabilities 2>/dev/null || true)" = genehub-service-v1 ]; then
    native_service=yes
    if [ -n "$refresh_service" ] && [ -f "$transaction/old/$cli_binary" ]; then
      previous="$("$transaction/new/$cli_binary" daemon __install-state)"
      printf '%s\n' "$previous" > "$transaction/previous-runtime"
    fi
  fi
fi

# Keep older Python builds while activation is pending so the old pointer
# remains recoverable. A release that has no runtime leaves it untouched.
python_script="$(find "$tmp/unpacked" -name install-python.sh -type f -print | head -n 1)"
if [ -n "$python_script" ]; then
  if [ -z "$data_dir" ]; then
    case "$os" in
      darwin) data_dir="$HOME/Library/Application Support/$data_dir_name" ;;
      *) data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/$data_dir_name" ;;
    esac
  fi
  python_pointer="$data_dir/agents/runtime/python.json"
  if [ -f "$python_pointer" ]; then cp -p "$python_pointer" "$transaction/python.json"; fi
  python_touched=yes
  say "==> installing the Python runtime"
  GENEHUB_KEEP_PYTHON_VERSIONS=1 sh "$python_script" "$data_dir/agents/runtime" \
    || die "the Python runtime could not be installed. Run this installer again."
fi

if [ -n "$refresh_service" ]; then
  : > "$transaction/activation-pending"
fi
applied=yes
for binary in $files; do
  if ! cmp -s "$transaction/new/$binary" "$bin_dir/$binary"; then
    cp -p "$transaction/new/$binary" "$transaction/restore/$binary"
    mv -f "$transaction/restore/$binary" "$bin_dir/$binary"
  fi
done

# curl never quarantines, so this is a no-op in the normal `curl | sh` flow —
# but a browser-downloaded tarball carried through by hand would otherwise
# greet the first run with a Gatekeeper prompt.
if [ "$os" = darwin ]; then
  xattr -d com.apple.quarantine "$bin_dir/$cli_binary" "$bin_dir/$host_binary" "$bin_dir/$component" 2>/dev/null || true
fi

say ""
say "Installed:"
say "  $bin_dir/$cli_binary"
say "  $bin_dir/$host_binary"
say "  $bin_dir/$component"

# Only the installed CLI defines service lifecycle. An older archive may be
# served during rollout, before it includes the service entry point.
service=none
if [ -n "$native_service" ]; then
  say ""
  if ! service_result="$("$bin_dir/$cli_binary" daemon __install ${refresh_service:+$refresh_service})"; then
    say "$service_result" >&2
    die "could not activate the platform service"
  fi
  if [ -n "$previous" ]; then
    running="$("$transaction/new/$cli_binary" daemon __install-state)"
    [ "${running%% *}" = "${previous%% *}" ] || die "the updated daemon did not return with its previous machine identity"
  fi
  case "$service_result" in
    *'"desiredState":"stopped"'*) service=stopped ;;
    *'"deferred":true'*) service=deferred ;;
    *'"service":null'*) ;;
    *) service=managed ;;
  esac
fi

# Explicit first-install automation may opt into restarting a hand-run daemon
# after files have landed. The CLI self-update command is deliberately
# disabled until releases have an independent signing root.
if [ "$service" = none ] && [ "${GENEHUB_RESTART_DAEMON:-}" = 1 ]; then
  say ""
  say "==> restarting daemon with the new binary"
  "$bin_dir/$cli_binary" daemon restart
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    say ""
    say "$bin_dir is not on your PATH. Add it:"
    say "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.profile"
    ;;
esac

say ""
case "$service" in
  managed)
    say "Check the installed daemon service:"
    say "  $cli_binary daemon status"
    ;;
  stopped)
    say "The daemon service remains stopped. To resume: $cli_binary daemon start"
    ;;
  deferred) say "The existing daemon is active. Manage it with $cli_binary daemon status." ;;
  *)
    say "Start the daemon:"
    say "  $cli_binary daemon start"
    ;;
esac
say "Connect this machine to the hub (once):"
say "  $cli_binary hub login --wait"
say ""
say "'$cli_binary daemon endpoint' prints a one-use local connection address."
