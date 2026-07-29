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

echo "==> building the daemon and the built-in agent"
cargo build --release --manifest-path "$repo/Cargo.toml" -p genet-daemon -p genet-agent

echo "==> staging binaries"
mkdir -p "$here/../src-tauri/bin"
for binary in genet-daemon genet-agent; do
  cp "$repo/target/release/$binary" "$here/../src-tauri/bin/$binary"
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
deb="$(find "$bundle_dir" -name '*.deb' -print -quit 2>/dev/null || true)"

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
  # and closing a pipe under it would make this look like a crash.
  GENEHUB_DATA_DIR="$staged/data" GENEHUB_WORKSPACE_DIR="$staged/workspace" timeout 15 \
    "$staged/usr/lib/GeneHub/bin/genet-daemon" >"$staged/out.json" 2>/dev/null || true
  if grep -q '"event":"listening"' "$staged/out.json"; then
    echo "    the packaged daemon starts and reports a port"
  else
    echo "FAIL: the packaged daemon did not come up" >&2
    exit 1
  fi

  # A fresh install has to be able to answer "where would you run this?" itself.
  test -d "$staged/workspace" \
    || { echo "FAIL: a new install has no folder to work in" >&2; exit 1; }
  echo "    a new install comes with a folder to work in"

  test -f "$staged/usr/share/applications/GeneHub.desktop" \
    || { echo "FAIL: no application entry, so it will not appear in the menu" >&2; exit 1; }
  echo "    the application entry is present"
fi

echo "==> done"
ls -la "$bundle_dir" 2>/dev/null || true
