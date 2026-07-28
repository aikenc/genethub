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

echo "==> building the installer"
npm --prefix "$here/.." run build

echo "==> done"
ls -la "$here/../src-tauri/target/release/bundle" 2>/dev/null || true
