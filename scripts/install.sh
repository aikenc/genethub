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
case "$base" in
  https://*) ;;
  *) die "download base must use https://" ;;
esac
case "$base" in
  *\?* | *\#*) die "download base must not contain a query or fragment" ;;
esac
authority="${base#https://}"
authority="${authority%%/*}"
[ -n "$authority" ] || die "download base has no host"
case "$authority" in
  *@*) die "download base must not contain credentials" ;;
esac

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
    curl --proto '=https' --proto-redir '=https' --max-redirs 5 --globoff -fsSL "$1" -o "$2"
  }
elif command -v wget >/dev/null 2>&1; then
  fetch() {
    wget --https-only --max-redirect=5 -qO "$2" "$1"
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

# The platform Python: script Agents and the built-in Skills run on it. The
# daemon never installs it, it only finds what this records, so an install is
# not finished until it is in place — and it comes before anything on this
# machine changes, so a failure here leaves the old version running. The
# script travels in the tarball (already checked above); a release from before
# it existed has none, and its daemon installs nothing either.
python_script="$(find "$tmp/unpacked" -name install-python.sh -type f -print | head -n 1)"
if [ -n "$python_script" ]; then
  if [ -z "$data_dir" ]; then
    case "$os" in
      darwin) data_dir="$HOME/Library/Application Support/$data_dir_name" ;;
      *) data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/$data_dir_name" ;;
    esac
  fi
  say "==> installing the Python runtime"
  sh "$python_script" "$data_dir/agents/runtime" \
    || die "the Python runtime could not be installed. Nothing else was changed; run this installer again."
fi
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
for binary in "$cli_binary" "$host_binary" "$component"; do
  found="$(find "$tmp/unpacked" -name "$binary" -type f -print | head -n 1)"
  [ -n "$found" ] || die "$binary is missing from $asset"
  # Replaced rather than written in place: overwriting a running binary is what
  # produces "text file busy" on Linux.
  rm -f "$bin_dir/$binary"
  cp "$found" "$bin_dir/$binary"
  case "$binary" in
    *.wasm) chmod 644 "$bin_dir/$binary" ;;
    *) chmod 755 "$bin_dir/$binary" ;;
  esac
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

# The daemon runs under the platform's user service manager whenever one is
# usable: started at boot or login, restarted whenever it exits, and outside
# whichever shell ran this script — a daemon started by hand from a remote
# shell dies with that shell. GENEHUB_NO_SERVICE=1 keeps the hand-run daemon.
# Each channel gets its own service, so upgrading one never touches another.
service=none
systemd_unit="genehub-$channel.service"
launchd_label="com.genethub.$channel.daemon"

daemon_pid() {
  "$bin_dir/$cli_binary" daemon status 2>/dev/null \
    | sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' | head -n 1
}

# Whether pid $1 is this script's ancestor: run from that daemon's own shell,
# stopping it would kill this script halfway through.
runs_inside() {
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    [ "$p" = "$1" ] && return 0
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

# Hands a daemon started by hand over to the service manager. Returns 1 when
# that cannot be done from here.
stop_hand_run_daemon() {
  pid="$(daemon_pid)"
  [ -n "$pid" ] || return 0
  if runs_inside "$pid"; then
    say "    the daemon started by hand (pid $pid) is running this installer, so it"
    say "    stays as it is; rerun from SSH or another channel's shell to hand it over"
    return 1
  fi
  say "==> stopping the daemon started by hand (pid $pid)"
  "$bin_dir/$cli_binary" daemon stop >/dev/null || die "could not stop the daemon (pid $pid)"
}

setup_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export XDG_RUNTIME_DIR
  fi
  systemctl --user show-environment >/dev/null 2>&1 || return 1
  config="${XDG_CONFIG_HOME:-$HOME/.config}"
  unit="$config/systemd/user/$systemd_unit"
  if [ ! -f "$unit" ]; then
    stop_hand_run_daemon || { service=deferred; return 0; }
  fi
  mkdir -p "$config/systemd/user"
  # Agents are found on PATH, and a user service otherwise gets a bare one.
  # `%` is a systemd specifier; the quotes keep spaces (WSL's Windows dirs).
  service_path="$(printf '%s' "$PATH" | sed 's/%/%%/g; s/"/\\"/g')"
  cat > "$unit.tmp" <<UNIT
[Unit]
Description=GeneHub daemon ($channel)
After=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart="$bin_dir/$cli_binary" daemon run
WorkingDirectory=%h
Environment="PATH=$service_path"
# Extra settings for this channel's daemon, one KEY=value per line.
EnvironmentFile=-$config/genehub/$channel.env
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  mv "$unit.tmp" "$unit"
  systemctl --user daemon-reload
  systemctl --user enable "$systemd_unit" >/dev/null 2>&1 \
    || die "systemctl --user enable $systemd_unit failed"
  # --no-block: from this daemon's own shell the restart ends this script too.
  systemctl --user restart --no-block "$systemd_unit"
  # Without lingering the user manager, and the daemon, stop at logout.
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
    loginctl enable-linger "$(id -un)" 2>/dev/null \
      || say "    to keep it running after logout: sudo loginctl enable-linger $(id -un)"
  fi
  service=systemd
}

xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

setup_launchd() {
  command -v launchctl >/dev/null 2>&1 || return 1
  domain="gui/$(id -u)"
  launchctl print "$domain" >/dev/null 2>&1 || return 1
  plist="$HOME/Library/LaunchAgents/$launchd_label.plist"
  loaded=0
  launchctl print "$domain/$launchd_label" >/dev/null 2>&1 && loaded=1
  if [ ! -f "$plist" ] && [ "$loaded" = 0 ]; then
    stop_hand_run_daemon || { service=deferred; return 0; }
  fi
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist.tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$launchd_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$bin_dir/$cli_binary")</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml_escape "$PATH")</string></dict>
  <key>WorkingDirectory</key><string>$(xml_escape "$HOME")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
PLIST
  changed=1
  cmp -s "$plist.tmp" "$plist" 2>/dev/null && changed=0
  mv "$plist.tmp" "$plist"
  if [ "$loaded" = 0 ]; then
    launchctl bootstrap "$domain" "$plist" || die "launchctl bootstrap $plist failed"
  elif [ "$changed" = 1 ] && ! runs_inside "$(daemon_pid)"; then
    # A changed definition only loads on bootstrap; bootout ends the daemon,
    # which would also end this script were it running inside it.
    launchctl bootout "$domain/$launchd_label" 2>/dev/null || true
    # bootout returns before the old job is gone; bootstrapping at once fails
    # with "5: Input/output error" and leaves no daemon at all.
    tries=0
    until launchctl bootstrap "$domain" "$plist" 2>/dev/null; do
      tries=$((tries + 1))
      [ "$tries" -lt 10 ] || die "launchctl bootstrap $plist failed"
      sleep 1
    done
  else
    [ "$changed" = 1 ] && say "    the new service definition loads at next login"
    launchctl kickstart -k "$domain/$launchd_label"
  fi
  service=launchd
}

if [ "${GENEHUB_NO_SERVICE:-}" != 1 ]; then
  say ""
  case "$os" in
    linux) setup_systemd || true ;;
    darwin) setup_launchd || true ;;
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
  systemd)
    say "The daemon runs as the systemd user service $systemd_unit:"
    say "  systemctl --user status $systemd_unit"
    ;;
  launchd)
    say "The daemon runs as the launchd agent $launchd_label:"
    say "  launchctl print gui/\$(id -u)/$launchd_label"
    ;;
  deferred) ;;
  *)
    say "Start the daemon:"
    say "  $cli_binary daemon start"
    ;;
esac
say "Connect this machine to the hub (once):"
say "  $cli_binary hub login --wait"
say ""
say "'$cli_binary daemon endpoint' prints a one-use local connection address."
