#!/bin/sh
# Installs the pinned CPython build for Linux into <runtime-dir> and prints
# its path. Source: python-build-standalone (python.org ships no Linux binary).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$here/install-common.sh"

VERSION=3.13.16
RELEASE=20261003
case "$(uname -m)" in
  x86_64 | amd64)
    TRIPLE=x86_64-unknown-linux-gnu
    SHA256=4595c5589fff7bf0cb158d9a88a797e0d791fa33830770fcb7bf3f4b104feeae
    ;;
  aarch64 | arm64)
    TRIPLE=aarch64-unknown-linux-gnu
    SHA256=6e9641400f8debd9b7924b27b5ff0662c372852382e291a76c450c7b67414cf6
    ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac

install_runtime "${1:-}"
