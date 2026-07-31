#!/usr/bin/env bash
# Builds a desktop installer.
#
# The daemon and the built-in agent are release binaries copied into `bin/`,
# where Tauri picks them up as bundled resources. Nothing here needs Node at
# runtime: the UI is a static build loaded by the system WebView, which is what
# keeps the installer small and the machine free of a runtime it never asked for
# (`docs/desktop-client.md` §4.1).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"

# What this build calls itself. `scripts/channel.sh` writes channel.env next
# to itself before a release build (and `official` when nobody stamped), so the
# packaging here agrees with the names cargo just built. The defaults are for
# a local build nobody stamped — official, because that is what the tree says.
CHANNEL=official
CLI_BINARY=genet
AGENT_BINARY=genet-agent
ENV_DATA_DIR=GENEHUB_DATA_DIR
ENV_WORKSPACE_DIR=GENEHUB_WORKSPACE_DIR
LIB_DIR_NAME=GeneHub
DESKTOP_FILE=GeneHub.desktop
# shellcheck disable=SC1091
[ -f "$repo/scripts/channel.env" ] && . "$repo/scripts/channel.env"

echo "==> building the daemon and the built-in agent ($CHANNEL)"
cargo build --release --manifest-path "$repo/Cargo.toml" -p genet-cli -p genet-agent

echo "==> staging binaries"
# Cleaned first: the previous build's staged binaries are still here, and a
# beta build after an official one would otherwise ship both channels'
# daemons in one installer. README.md is tracked and stays.
find "$here/../src-tauri/bin" -mindepth 1 -maxdepth 1 ! -name README.md -delete
# The shell looks for the platform's own name at runtime (`bundled_binary` in
# `src-tauri/src/lib.rs`), so the suffix has to survive the copy.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) exe=".exe" ;;
  *) exe="" ;;
esac
for binary in "$CLI_BINARY" "$AGENT_BINARY"; do
  cp "$repo/target/release/$binary$exe" "$here/../src-tauri/bin/$binary$exe"
done

# AppImage is left out of the default because its tooling is downloaded at
# bundle time, which turns an offline build into a failed one. Ask for it
# explicitly with BUNDLES=appimage when a release needs it.
case "$(uname -s)" in
  Linux) bundles="${BUNDLES:-deb}" ;;
  Darwin) bundles="${BUNDLES:-dmg}" ;;
  *) bundles="${BUNDLES:-nsis}" ;;
esac

echo "==> building the installer ($bundles)"
npm --prefix "$here/.." run build -- --bundles "$bundles"

bundle_dir="$here/../src-tauri/target/release/bundle"
# Matched by name and newest first, not "any .deb": old packages survive in
# this directory, and `find -print -quit` happily checks last week's official
# build while calling it this build — which then fails one rename later with
# "no such file", because the paths inside belong to the other channel.
deb="$(ls -t "$bundle_dir/deb/$LIB_DIR_NAME"_*.deb 2>/dev/null | head -n 1 || true)"
# Missing is only a failure when this build was asked for one — the Windows
# job builds nsis and has no deb to check, by design.
if [[ "$bundles" == *deb* && -z "$deb" ]]; then
  echo "FAIL: no package named '$LIB_DIR_NAME'_*.deb under $bundle_dir/deb" >&2
  exit 1
fi
[[ -z "$deb" ]] || echo "    checking $deb"

# The two claims the installer has to keep are cheap to check and easy to break
# by accident, so they are checked here rather than trusted:
# no Node runtime anywhere in the tree, and a download under budget
# (`docs/roadmap.md` MVP 验收清单).
if [[ -n "$deb" ]]; then
  echo "==> checking the package"
  contents="$(dpkg-deb -c "$deb")"
  if grep -Eq '/(node|node\.exe)$|/node_modules/' <<<"$contents"; then
    echo "FAIL: a Node runtime is inside the package" >&2
    grep -E '/(node|node\.exe)$|/node_modules/' <<<"$contents" >&2
    exit 1
  fi

  download_mb=$(( $(stat -c %s "$deb") / 1000000 ))
  installed_mb=$(( $(dpkg-deb -f "$deb" Installed-Size) / 1000 ))
  echo "    download ${download_mb}MB (budget 80MB), installed ${installed_mb}MB (budget 200MB)"
  if (( download_mb > 80 || installed_mb > 200 )); then
    echo "FAIL: over the size budget" >&2
    exit 1
  fi
  echo "    no Node runtime in the package"

  # A package that installs cleanly but ships a binary that cannot start is a
  # failure nobody notices until a user hits it, so the shipped daemon is run
  # from an unpacked copy rather than the one cargo just built.
  staged="$(mktemp -d)"
  trap 'rm -rf "$staged"' EXIT
  dpkg-deb -x "$deb" "$staged"
  # Redirected to a file rather than piped: the daemon does not exit on its own,
  # and closing a pipe under it would make this look like a crash. stderr is
  # kept too — a daemon that cannot start says why, and "did not come up" with
  # no reason attached is a debugging session, not a check.
  env "$ENV_DATA_DIR=$staged/data" "$ENV_WORKSPACE_DIR=$staged/workspace" timeout 15 \
    "$staged/usr/lib/$LIB_DIR_NAME/bin/$CLI_BINARY" daemon run >"$staged/out.json" 2>"$staged/err.log" || true
  if grep -q '"event":"listening"' "$staged/out.json"; then
    echo "    the packaged daemon starts and reports a port"
  else
    echo "FAIL: the packaged daemon did not come up" >&2
    cat "$staged/err.log" >&2
    ls -la "$staged/usr/lib/$LIB_DIR_NAME/bin/" >&2 || true
    exit 1
  fi

  # A fresh install has to be able to answer "where would you run this?" itself.
  test -d "$staged/workspace" \
    || { echo "FAIL: a new install has no folder to work in" >&2; exit 1; }
  echo "    a new install comes with a folder to work in"

  test -f "$staged/usr/share/applications/$DESKTOP_FILE" \
    || { echo "FAIL: no application entry, so it will not appear in the menu" >&2; exit 1; }
  echo "    the application entry is present"
fi

echo "==> done"
ls -la "$bundle_dir" 2>/dev/null || true
