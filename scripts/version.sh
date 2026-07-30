#!/usr/bin/env bash
# The version of the product, written in at build time.
#
# The product's version is the git tag, and nothing in the tree claims to know it:
# the three files below hold 0.0.0, meaning "this build was never released", and
# the release workflow calls this script with the tag just before it builds. So a
# release is a tag and nothing else — no version commit, no file to remember.
#
# It works this way because the other way was tried: three numbers maintained by
# hand sat at 0.1.0 through seventeen tagged releases, and every installed copy
# reported 0.1.0 to its own workbench. A number that a human has to copy into
# three places is a number that will be wrong, and the only cure that holds is
# nobody having to copy it anywhere.
#
# Why a script rather than `version.workspace = true` everywhere: Cargo can
# inherit a version only inside one workspace and cannot read another file at all,
# and the desktop shell sits outside the workspace on purpose (root `Cargo.toml`
# says why). Its manifest has to carry a literal, so something has to write it.
#
#   scripts/version.sh 0.1.18                 write a version
#   scripts/version.sh --from-tag             write the tag being built, if there is one
#   scripts/version.sh --verify <binary>      check a built binary reports what it should
set -euo pipefail

# What a build nobody released calls itself. Also the value sitting in the tree,
# so `git diff` after a release build shows exactly what CI wrote.
UNRELEASED="0.0.0"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '/^#   scripts/,/^#   scripts.*verify/p' "${BASH_SOURCE[0]}" | sed 's/^# //' >&2
}

# What a build made from this checkout should report: the tag it is building, or
# the placeholder. One rule in one place, so no workflow has to spell it out and
# no two of them can spell it differently.
expected() {
  case "${GITHUB_REF_NAME:-}" in
    v[0-9]*) printf '%s' "${GITHUB_REF_NAME#v}" ;;
    *) printf '%s' "$UNRELEASED" ;;
  esac
}

# Edited in place the portable way: `sed -i` wants an argument on BSD and refuses
# one on GNU, and this is run on both.
rewrite() {
  local file="$1" script="$2"
  sed "$script" "$file" >"$file.stamped"
  mv "$file.stamped" "$file"
}

write() {
  local version="$1"

  # The workspace number, which the daemon, the agent, the protocol crate and the
  # test harness all inherit. Scoped to the block, or the first entry under
  # `[workspace.dependencies]` would be rewritten instead.
  rewrite "$repo/Cargo.toml" \
    '/^\[workspace\.package\]/,/^\[/ s/^version = ".*"$/version = "'"$version"'"/'

  # The desktop shell, which is its own workspace and so needs its own literal.
  rewrite "$repo/apps/desktop/src-tauri/Cargo.toml" \
    '/^\[package\]/,/^\[/ s/^version = ".*"$/version = "'"$version"'"/'

  # What the installer shows, and what Windows lists under installed programs.
  # Tauri would fall back to the crate version if this field were deleted, but it
  # is written here instead: one place that writes all three is easier to trust
  # than a fallback that only shows itself in a bundle nobody builds locally.
  rewrite "$repo/apps/desktop/src-tauri/tauri.conf.json" \
    's/^  "version": "[^"]*"/  "version": "'"$version"'"/'

  echo "stamped $version into the workspace, the shell and the bundle config"
  # Printed because this runs unattended: the log of a release should show the
  # number that went in, not just that something ran.
  grep -m1 '^version = ' "$repo/Cargo.toml"
  grep -m1 '^version = ' "$repo/apps/desktop/src-tauri/Cargo.toml"
  grep -m1 '"version"' "$repo/apps/desktop/src-tauri/tauri.conf.json"
}

case "${1:-}" in
  --from-tag)
    version="$(expected)"
    if [ "$version" = "$UNRELEASED" ]; then
      # A rehearsal run, or a build off a branch. Nothing is published from
      # those, so an unreleased number is the honest thing to ship in them.
      echo "not a tag build (GITHUB_REF_NAME=${GITHUB_REF_NAME:-unset}), leaving $UNRELEASED"
      exit 0
    fi
    write "$version"
    ;;
  # Proof that the number CI stamped is the number the artifact carries. Cheap,
  # and it covers the one way this can fail silently: a job that builds something
  # shippable without stamping it first ships 0.0.0, and 0.0.0 tells every user
  # they are running an unreleased build that can never see an update.
  --verify)
    binary="${2:-}"
    test -n "$binary" || { usage; exit 2; }
    want="$(expected)"
    got="$("$binary" --version | tr -d '\r\n')"
    if [ "$got" != "$want" ]; then
      echo "::error::$binary calls itself $got, but this build should be $want — a stamping step is missing"
      exit 1
    fi
    echo "ok: $binary calls itself $got"
    ;;
  [0-9]*) write "$1" ;;
  *) usage; exit 2 ;;
esac
