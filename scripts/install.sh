#!/bin/sh
# Installs the daemon and the built-in agent — no desktop shell, no Node.
#
# This is the path for a machine with no graphical session: a server, a VM, a
# box you only ever reach over SSH. It is also the fallback when there is no
# installer for someone's platform yet. The Linux tarball is musl-static, so an
# older glibc on the box is not a reason for the binary to refuse to start.
#
#   curl -fsSL https://raw.githubusercontent.com/aikenc/genethub/main/scripts/install.sh | sh
#
# A deployment that offers a friendlier address serves this same file from it.
#
# POSIX sh on purpose: piping into `sh` is how people will run it, and that is
# not always bash.
set -eu

# channel: dev — written by scripts/channel.mjs
# Everything below that names a file, an address or an environment variable
# derives from that one word, so a prerelease install can never reach for an
# official asset — the channels install side by side on one machine and none
# may touch another's binaries or overrides (`dual-channel-release.md`).
# It is a plain assignment rather than something the script re-reads from its
# own file, because the usual way to run this is `curl | sh`, where $0 is not
# the script at all.
channel=dev

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$channel" in
  alpha)
    base="${GENEHUB_ALPHA_DOWNLOAD_BASE:-https://relay-alpha.genethub.com/download/alpha}"
    bin_dir="${GENEHUB_ALPHA_BIN_DIR:-$HOME/.local/bin}"
    tarball_prefix=genet-alpha
    cli_binary=genet-alpha
    agent_binary=genet-agent-alpha
    ;;
  beta)
    base="${GENEHUB_BETA_DOWNLOAD_BASE:-https://relay-beta.genethub.com/download/beta}"
    bin_dir="${GENEHUB_BETA_BIN_DIR:-$HOME/.local/bin}"
    tarball_prefix=genet-beta
    cli_binary=genet-beta
    agent_binary=genet-agent-beta
    ;;
  official)
    base="${GENEHUB_DOWNLOAD_BASE:-https://github.com/aikenc/genethub/releases/latest/download}"
    bin_dir="${GENEHUB_BIN_DIR:-$HOME/.local/bin}"
    tarball_prefix=genet
    cli_binary=genet
    agent_binary=genet-agent
    ;;
  *)
    # dev: the tree's own state. There is no dev artifact to download, so the
    # only way this runs is someone piping the source checkout into sh — which
    # would otherwise quietly install the *official* line over whatever they
    # meant to test. Refuse, unless a download base is named on purpose (the
    # way a CI rehearsal's artifacts get installed for a smoke test).
    [ -n "${GENEHUB_DEV_DOWNLOAD_BASE:-}" ] || die "this install.sh comes from the source tree (channel: dev) and has nothing to install.
  official:  curl -fsSL https://relay.genethub.com/install.sh | sh
  beta:      curl -fsSL https://relay-beta.genethub.com/install.sh | sh
  or set GENEHUB_DEV_DOWNLOAD_BASE to a directory of artifacts on purpose"
    base="$GENEHUB_DEV_DOWNLOAD_BASE"
    bin_dir="${GENEHUB_DEV_BIN_DIR:-$HOME/.local/bin}"
    tarball_prefix=genet-dev
    cli_binary=genet-dev
    agent_binary=genet-agent-dev
    ;;
esac

case "$(uname -s)" in
  Linux) os=linux ;;
  # Naming it beats a 404 from curl. The build works — nothing is published
  # because an unsigned macOS download is a security warning with an app behind
  # it, so it waits for notarisation.
  Darwin) die "no macOS build is published yet. Build from source: https://github.com/aikenc/genethub" ;;
  *) die "no build for $(uname -s). Build from source: https://github.com/aikenc/genethub" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "no build for $(uname -m)" ;;
esac

# Linux is published for x64 only so far. Saying so beats a 404 from curl.
if [ "$os" = linux ] && [ "$arch" != x64 ]; then
  die "no Linux $arch build yet. Build from source: https://github.com/aikenc/genethub"
fi

asset="$tarball_prefix-$os-$arch.tar.gz"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
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
for binary in "$cli_binary" "$agent_binary"; do
  found="$(find "$tmp/unpacked" -name "$binary" -type f -print | head -n 1)"
  [ -n "$found" ] || die "$binary is missing from $asset"
  # Replaced rather than written in place: overwriting a running binary is what
  # produces "text file busy" on Linux.
  rm -f "$bin_dir/$binary"
  cp "$found" "$bin_dir/$binary"
  chmod 755 "$bin_dir/$binary"
done

say ""
say "Installed:"
say "  $bin_dir/$cli_binary"
say "  $bin_dir/$agent_binary"

# `genet update` sets this after launching the copy of this script embedded in
# its own binary. Run the command from the install destination: the updater
# process is still the old executable, while this path now names the new one.
# Restart also starts a daemon that was not running, so a successful CLI update
# always leaves the machine reachable again.
if [ "${GENEHUB_RESTART_DAEMON:-}" = 1 ]; then
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
say "Start the daemon, then connect this machine to the hub:"
say "  $cli_binary daemon start"
say "  $cli_binary hub login --wait"
say ""
say "'$cli_binary daemon endpoint' prints the address and token to connect a"
say "workbench to."
