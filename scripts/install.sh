#!/bin/sh
# Installs the daemon and the built-in agent — no desktop shell, no Node.
#
# This is the path for a machine with no graphical session: a server, a VM, a
# box you only ever reach over SSH. It is also the fallback when there is no
# installer for someone's platform yet.
#
#   curl -fsSL https://genehub.dev/install.sh | sh
#
# POSIX sh on purpose: piping into `sh` is how people will run it, and that is
# not always bash.
set -eu

base="${GENEHUB_DOWNLOAD_BASE:-https://github.com/genethub/genethub/releases/latest/download}"
bin_dir="${GENEHUB_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) die "no build for $(uname -s). Build from source: https://github.com/genethub/genethub" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "no build for $(uname -m)" ;;
esac

# Linux is published for x64 only so far. Saying so beats a 404 from curl.
if [ "$os" = linux ] && [ "$arch" != x64 ]; then
  die "no Linux $arch build yet. Build from source: https://github.com/genethub/genethub"
fi

asset="genet-$os-$arch.tar.gz"

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
for binary in genet-daemon genet-agent; do
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
say "  $bin_dir/genet-daemon"
say "  $bin_dir/genet-agent"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    say ""
    say "$bin_dir is not on your PATH. Add it:"
    say "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.profile"
    ;;
esac

say ""
say "Start it:"
say "  genet-daemon"
say ""
say "It prints the address and token to connect a workbench to."
