#!/bin/sh
# Installs the pinned CPython build for macOS into <runtime-dir> and prints
# its path. Source: python-build-standalone (python.org only ships a .pkg that
# needs an administrator and installs system-wide).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$here/install-common.sh"

VERSION=3.13.16
RELEASE=20261003
case "$(uname -m)" in
  arm64 | aarch64)
    TRIPLE=aarch64-apple-darwin
    SHA256=9e01f63bbb08576cd9c8bc2d0564d098cb30c8453a0cd4bcf6aef458f6d2a147
    ;;
  x86_64)
    TRIPLE=x86_64-apple-darwin
    SHA256=b4dad38ba6a344555ccb71a1b08caad0a6c0dda88c5803658bc95bd7f04e9f5c
    ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac

install_runtime "${1:-}"
