#!/bin/sh
# Entry point the daemon runs on macOS and Linux:
#   sh install.sh <runtime-dir>
# It picks this platform's script; that script is idempotent and prints the
# interpreter's absolute path as its last line: {"python":"/abs/path"}.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s)" in
  Darwin) exec sh "$here/install-macos.sh" "$@" ;;
  Linux) exec sh "$here/install-linux.sh" "$@" ;;
  *)
    printf '{"error":"unsupported operating system: %s"}\n' "$(uname -s)"
    exit 1
    ;;
esac
