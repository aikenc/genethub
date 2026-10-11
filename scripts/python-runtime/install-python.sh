#!/bin/sh
# Installs the platform Python (Linux, macOS) into <runtime-dir>.
#
#   sh install-python.sh <runtime-dir>
#
# Run by the installers (scripts/install.sh, the desktop installer) and by the
# dev tooling; the daemon never installs anything, it only reads the result:
# <runtime-dir>/python.json, {"python":"/abs/path/to/python3"}.
#
# Idempotent: an interpreter that already starts and reports the pinned version
# is kept. The version, release and hashes live in python.pin next to this file.
# Needs only what every Linux and macOS install has: sh, uname, curl or wget,
# tar, and sha256sum or shasum. Exit status is non-zero, with the reason on
# stderr, when the Python cannot be installed.
#
# GENEHUB_PYTHON_CACHE=<dir> (the dev tooling sets it) keeps a verified archive
# at <dir>/<release>/<file> and tries it first, so many dev slots on one
# machine download once. Installers leave it unset.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
pin() { sed -n "s/^$1=//p" "$here/python.pin" | head -n 1; }

root=${1:-}
[ -n "$root" ] || die "usage: install-python.sh <runtime-dir>"

version=$(pin version)
release=$(pin release)
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64 | Linux/amd64) triple=x86_64-unknown-linux-gnu ;;
  Linux/aarch64 | Linux/arm64) triple=aarch64-unknown-linux-gnu ;;
  Darwin/arm64 | Darwin/aarch64) triple=aarch64-apple-darwin ;;
  Darwin/x86_64) triple=x86_64-apple-darwin ;;
  *) die "no Python build for $(uname -s) $(uname -m)" ;;
esac
want=$(pin "sha256.$triple")
[ -n "$version" ] && [ -n "$release" ] && [ -n "$want" ] || die "python.pin has no entry for $triple"

name="python-$version-$release"
target="$root/$name"
python="$target/bin/python3"

# Usable: it starts in isolated mode and reports exactly the pinned version,
# which also catches a damaged or half-written tree.
usable() {
  [ -x "$1" ] && "$1" -I -c 'import sys; sys.exit(0 if sys.version.split()[0] == sys.argv[1] else 1)' "$version" >/dev/null 2>&1
}

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "need sha256sum or shasum"
fi
if command -v curl >/dev/null 2>&1; then
  # A mirror that stalls (under 1 KiB/s for a minute) is given up on.
  fetch() { curl -fsSL --retry 2 --connect-timeout 15 --speed-limit 1024 --speed-time 60 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -T 60 -O "$2" "$1"; }
else
  die "need curl or wget"
fi
command -v tar >/dev/null 2>&1 || die "need tar"

mkdir -p "$root"
if ! usable "$python"; then
  file="cpython-$version%2B$release-$triple-install_only_stripped.tar.gz"
  # A configured mirror is tried first; the hash makes any mirror safe to use,
  # because content that does not match is never unpacked.
  urls=""
  cached="cpython-$version+$release-$triple-install_only_stripped.tar.gz"
  if [ -n "${GENEHUB_PYTHON_CACHE:-}" ]; then
    urls="file://$GENEHUB_PYTHON_CACHE/$release/$file"
  fi
  for base in ${GENEHUB_PYTHON_MIRRORS:-}; do
    urls="$urls ${base%/}/$release/$file"
  done
  urls="$urls https://github.com/astral-sh/python-build-standalone/releases/download/$release/$file"
  urls="$urls https://mirrors.aliyun.com/github/releases/astral-sh/python-build-standalone/$release/$file"

  staging="$root/.staging-$$"
  trap 'rm -rf "$staging"' EXIT INT TERM
  rm -rf "$staging"
  mkdir -p "$staging"
  archive="$staging/python.tar.gz"
  got=""
  for url in $urls; do
    say "==> downloading Python $version: $url"
    if fetch "$url" "$archive" 2>/dev/null; then
      if [ "$(digest "$archive")" = "$want" ]; then
        got=yes
        if [ -n "${GENEHUB_PYTHON_CACHE:-}" ] && [ ! -f "$GENEHUB_PYTHON_CACHE/$release/$cached" ]; then
          mkdir -p "$GENEHUB_PYTHON_CACHE/$release" && cp "$archive" "$GENEHUB_PYTHON_CACHE/$release/$cached" 2>/dev/null || true
        fi
        break
      fi
      say "    checksum mismatch, trying the next address"
    fi
    rm -f "$archive"
  done
  [ -n "$got" ] || die "could not download Python $version: every address failed or did not match the pinned checksum"

  say "==> unpacking Python $version"
  tar -xzf "$archive" -C "$staging" || die "could not unpack the Python archive"
  rm -f "$archive"
  [ -d "$staging/python" ] || die "the Python archive has no python directory"
  if [ "$(uname -s)" = Darwin ] && command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$staging/python" 2>/dev/null || true
  fi
  rm -rf "$target"
  mv "$staging/python" "$target"
  usable "$python" || die "the installed Python does not start in isolated mode"
fi

# The platform Python is not a place to install packages into. This is the
# standard marker (PEP 668): a global `pip install` stops with this text, while
# a virtual environment created from it is unaffected.
stdlib=$("$python" -I -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')
cat > "$stdlib/EXTERNALLY-MANAGED" <<'MARKER'
[externally-managed]
Error=This is the Python that ships with GeneHub; do not install packages into it.
 Create a virtual environment and install there:
 "$GENEHUB_PYTHON" -m venv <dir> && <dir>/bin/pip install <package>
MARKER

# Atomic, so the daemon never reads half of it.
escaped=$(printf '%s' "$python" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
printf '{"python":"%s"}\n' "$escaped" > "$root/python.json.tmp"
mv "$root/python.json.tmp" "$root/python.json"

# Only the pinned build stays. A Python that is still running from an older
# build is not a reason to keep it: an upgrade restarts everything that uses it.
for old in "$root"/python-*; do
  [ -e "$old" ] || continue
  [ "$old" = "$target" ] || rm -rf "$old"
done

say "Python $version ready: $python"
