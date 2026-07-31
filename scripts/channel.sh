#!/usr/bin/env bash
# The release channel of the product, written in at build time.
#
# Two installable lines of the product exist — the official release and the
# beta — and they must coexist on one machine without sharing processes, data
# directories, environment variables or update feeds (`docs/dual-channel-release.md`
# in genethub-cloud). Everything that makes a build belong to one of them is
# derived here, from one table, so no two files can disagree about what a beta
# is called.
#
# It works the way `scripts/version.sh` works, and for the same reason: the
# tree always claims to be `official`, and the release workflow stamps `beta`
# in just before it builds. A channel a human has to edit into a dozen places
# is a channel that ships half-renamed — one process killed by the wrong
# installer, one daemon reading the other line's data directory.
#
# The Rust and TypeScript consumers get a generated constants module each,
# rewritten wholesale — sed-ing values into source code is how a quote or a
# comma ends up in a binary name. The packaging files (tauri.conf.json, the
# two `[[bin]]` names, installer.nsh, install.sh) carry marked lines this
# script rewrites in place, the same portable way version.sh does.
#
#   scripts/channel.sh official|beta      stamp the tree for a channel
#   scripts/channel.sh --from-tag         stamp from the tag being built, if there is one
#   scripts/channel.sh --show             print the channel the tree is stamped for
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '/^#   scripts/,/^#   scripts.*--show/p' "${BASH_SOURCE[0]}" | sed 's/^# //' >&2
}

# The one table. Both columns side by side so a review — and the wiring tests
# — can see official and beta in the same glance. The official column is
# frozen: those names are what installed copies already answer to, and
# changing one silently orphans every override a user has set.
value() {
  local key="$1" channel="$2"
  case "$channel:$key" in
    official:channel)             printf '%s' official ;;
    beta:channel)                 printf '%s' beta ;;

    official:product)             printf '%s' GeneHub ;;
    beta:product)                 printf '%s' "GeneHub Beta" ;;

    official:identifier)          printf '%s' com.genethub.desktop ;;
    beta:identifier)              printf '%s' com.genethub.desktop.beta ;;

    official:desktop_binary)      printf '%s' genethub-desktop ;;
    beta:desktop_binary)          printf '%s' genethub-desktop-beta ;;

    official:daemon_binary)       printf '%s' genet-daemon ;;
    beta:daemon_binary)           printf '%s' genet-daemon-beta ;;

    official:agent_binary)        printf '%s' genet-agent ;;
    beta:agent_binary)            printf '%s' genet-agent-beta ;;

    official:agent_home_dir)      printf '%s' .genet-agent ;;
    beta:agent_home_dir)          printf '%s' .genet-agent-beta ;;

    official:data_dir_name)       printf '%s' GeneHub ;;
    beta:data_dir_name)           printf '%s' GeneHub-beta ;;

    official:workspace_dir_name)  printf '%s' GeneHub ;;
    beta:workspace_dir_name)      printf '%s' GeneHub-beta ;;

    official:tray_id)             printf '%s' genethub-tray ;;
    beta:tray_id)                 printf '%s' genethub-tray-beta ;;

    official:env_data_dir)        printf '%s' GENEHUB_DATA_DIR ;;
    beta:env_data_dir)            printf '%s' GENEHUB_BETA_DATA_DIR ;;

    official:env_workspace_dir)   printf '%s' GENEHUB_WORKSPACE_DIR ;;
    beta:env_workspace_dir)       printf '%s' GENEHUB_BETA_WORKSPACE_DIR ;;

    official:env_log)             printf '%s' GENEHUB_LOG ;;
    beta:env_log)                 printf '%s' GENEHUB_BETA_LOG ;;

    official:env_machine_name)    printf '%s' GENEHUB_MACHINE_NAME ;;
    beta:env_machine_name)        printf '%s' GENEHUB_BETA_MACHINE_NAME ;;

    official:env_agent_command)   printf '%s' GENET_AGENT_COMMAND ;;
    beta:env_agent_command)       printf '%s' GENET_AGENT_BETA_COMMAND ;;

    official:env_agent_home)      printf '%s' GENET_AGENT_HOME ;;
    beta:env_agent_home)          printf '%s' GENET_AGENT_BETA_HOME ;;

    official:env_download_base)   printf '%s' GENEHUB_DOWNLOAD_BASE ;;
    beta:env_download_base)       printf '%s' GENEHUB_BETA_DOWNLOAD_BASE ;;

    official:env_bin_dir)         printf '%s' GENEHUB_BIN_DIR ;;
    beta:env_bin_dir)             printf '%s' GENEHUB_BETA_BIN_DIR ;;

    official:default_machine_name) printf '%s' "GeneHub machine" ;;
    beta:default_machine_name)    printf '%s' "GeneHub Beta machine" ;;

    official:agent_label)         printf '%s' "GeneHub Agent" ;;
    beta:agent_label)             printf '%s' "GeneHub Beta Agent" ;;

    # The update manifest needs a stable address per channel. Official rides
    # the latest release; beta cannot — GitHub's `latest` never names a
    # prerelease — so beta releases additionally publish to a rolling `beta`
    # tag, which is what makes this address stay put (release.yml).
    official:manifest_url)        printf '%s' "https://github.com/aikenc/genethub/releases/latest/download/latest.json" ;;
    beta:manifest_url)            printf '%s' "https://github.com/aikenc/genethub/releases/download/beta/latest-beta.json" ;;

    # Where install.sh pulls the Linux tarball from. Beta cannot use
    # `releases/latest/download` (same reason as above), so its default is the
    # beta control plane, which resolves the newest prerelease itself.
    official:download_base)       printf '%s' "https://github.com/aikenc/genethub/releases/latest/download" ;;
    beta:download_base)           printf '%s' "https://relay-beta.genethub.com/download/beta" ;;

    official:tarball_prefix)      printf '%s' genet ;;
    beta:tarball_prefix)          printf '%s' genet-beta ;;

    *) echo "unknown identity key: $key" >&2; exit 2 ;;
  esac
}

# `sed -i` wants an argument on BSD and refuses one on GNU; this runs on both.
rewrite() {
  local file="$1"
  shift
  sed "$@" "$file" >"$file.stamped"
  mv "$file.stamped" "$file"
}

rust_module() {
  local channel="$1"
  cat <<EOF
//! Which release channel this build belongs to.
//!
//! Written wholesale by \`scripts/channel.sh\` — edit that script, not this
//! file. The tree always says \`official\`; a beta build is the release
//! workflow stamping \`beta\` in before it compiles, exactly the way
//! \`scripts/version.sh\` stamps the version.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// \`official\` | \`beta\`.
pub const CHANNEL: &str = "$(value channel "$channel")";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "$(value product "$channel")";
/// Root of everything the daemon owns, under the platform data directory.
pub const DATA_DIR_NAME: &str = "$(value data_dir_name "$channel")";
/// The folder the agent works in until the user points it somewhere else.
pub const WORKSPACE_DIR_NAME: &str = "$(value workspace_dir_name "$channel")";
pub const DAEMON_BINARY: &str = "$(value daemon_binary "$channel")";
pub const AGENT_BINARY: &str = "$(value agent_binary "$channel")";
/// Where the agent keeps its sessions and \`models.json\`, under the home dir.
pub const AGENT_HOME_DIR: &str = "$(value agent_home_dir "$channel")";
pub const ENV_DATA_DIR: &str = "$(value env_data_dir "$channel")";
pub const ENV_WORKSPACE_DIR: &str = "$(value env_workspace_dir "$channel")";
pub const ENV_LOG: &str = "$(value env_log "$channel")";
pub const ENV_MACHINE_NAME: &str = "$(value env_machine_name "$channel")";
pub const ENV_AGENT_COMMAND: &str = "$(value env_agent_command "$channel")";
pub const ENV_AGENT_HOME: &str = "$(value env_agent_home "$channel")";
/// What the owner sees this machine called before they name it.
pub const DEFAULT_MACHINE_NAME: &str = "$(value default_machine_name "$channel")";
/// What the built-in agent calls itself in the picker.
pub const AGENT_LABEL: &str = "$(value agent_label "$channel")";
/// Where the published builds of this channel announce themselves.
pub const DEFAULT_MANIFEST_URL: &str = "$(value manifest_url "$channel")";
EOF
}

agent_module() {
  local channel="$1"
  cat <<EOF
//! Which release channel this build belongs to.
//!
//! Written wholesale by \`scripts/channel.sh\` — edit that script, not this
//! file. The daemon has the full set of names; the agent only needs to find
//! its own home directory, and it reads the same override name the daemon
//! writes when it spawns one.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// \`official\` | \`beta\`.
pub const CHANNEL: &str = "$(value channel "$channel")";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "$(value product "$channel")";
pub const ENV_HOME: &str = "$(value env_agent_home "$channel")";
pub const HOME_DIR_NAME: &str = "$(value agent_home_dir "$channel")";
EOF
}

desktop_module() {
  local channel="$1"
  cat <<EOF
//! Which release channel this build belongs to.
//!
//! Written wholesale by \`scripts/channel.sh\` — edit that script, not this
//! file. The tree always says \`official\`; a beta build is the release
//! workflow stamping \`beta\` in before it compiles.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// \`official\` | \`beta\`.
pub const CHANNEL: &str = "$(value channel "$channel")";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "$(value product "$channel")";
/// The shell's slice of state, joined under \`app_data_dir()\`. Two derivation
/// chains exist and both have to move together: this one follows the
/// identifier (which channel.sh also stamps), and the daemon's own
/// \`dirs::data_dir()\` root follows DATA_DIR_NAME in its copy of this module.
pub const DATA_DIR_NAME: &str = "$(value data_dir_name "$channel")";
pub const DAEMON_BINARY: &str = "$(value daemon_binary "$channel")";
/// The override the shell passes to the daemon it spawns — has to stay the
/// name the daemon reads (\`apps/daemon/src/channel.rs\`), or the shell and
/// the daemon disagree about where the data lives and the shell ends up
/// adopting the other channel's daemon through a stale endpoint file.
pub const ENV_DATA_DIR: &str = "$(value env_data_dir "$channel")";
pub const TRAY_ID: &str = "$(value tray_id "$channel")";
EOF
}

ts_module() {
  local channel="$1"
  cat <<EOF
// Which release channel this build belongs to.
//
// Written wholesale by \`scripts/channel.sh\` — edit that script, not this
// file. The tree always says "official"; a beta build is the release workflow
// stamping "beta" in before it compiles.
export const CHANNEL: "official" | "beta" = "$(value channel "$channel")";
export const PRODUCT = "$(value product "$channel")";
EOF
}

shell_env() {
  local channel="$1"
  cat <<EOF
# Written by scripts/channel.sh — edit that script, not this file.
# Sourced by apps/desktop/scripts/bundle.sh so the packaging agrees with the
# binaries cargo just built under their stamped names.
CHANNEL=$(value channel "$channel")
PRODUCT="$(value product "$channel")"
DESKTOP_BINARY=$(value desktop_binary "$channel")
DAEMON_BINARY=$(value daemon_binary "$channel")
AGENT_BINARY=$(value agent_binary "$channel")
ENV_DATA_DIR=$(value env_data_dir "$channel")
ENV_WORKSPACE_DIR=$(value env_workspace_dir "$channel")
# Where a deb puts the app and what it calls the menu entry, both derived by
# Tauri from productName — quoted because beta carries a space.
LIB_DIR_NAME="$(value product "$channel")"
DESKTOP_FILE="$(value product "$channel").desktop"
EOF
}

stamp() {
  local channel="$1"
  local product identifier daemon_binary agent_binary desktop_binary
  product="$(value product "$channel")"
  identifier="$(value identifier "$channel")"
  daemon_binary="$(value daemon_binary "$channel")"
  agent_binary="$(value agent_binary "$channel")"
  desktop_binary="$(value desktop_binary "$channel")"

  rust_module "$channel"   >"$repo/apps/daemon/src/channel.rs"
  agent_module "$channel"  >"$repo/apps/agent/src/channel.rs"
  desktop_module "$channel" >"$repo/apps/desktop/src-tauri/src/channel.rs"
  ts_module "$channel"     >"$repo/packages/web/src/channel.ts"
  shell_env "$channel"     >"$repo/scripts/channel.env"

  # The bundle config: what the installer and the Start menu show, the
  # identifier the data directory and single-instance lock derive from, and
  # the process name Windows will see.
  rewrite "$repo/apps/desktop/src-tauri/tauri.conf.json" \
    -e 's/^  "productName": "[^"]*"/  "productName": "'"$product"'"/' \
    -e 's/^  "identifier": "[^"]*"/  "identifier": "'"$identifier"'"/' \
    -e 's/^  "mainBinaryName": "[^"]*"/  "mainBinaryName": "'"$desktop_binary"'"/' \
    -e 's/^      "title": "[^"]*"/      "title": "'"$product"'"/'

  # The binaries' own names. Crate (package) names stay put — source packages
  # are shared between channels by design; only what the process is called
  # changes.
  rewrite "$repo/apps/daemon/Cargo.toml" \
    '/^\[\[bin\]\]/,/^\[/ s/^name = ".*"$/name = "'"$daemon_binary"'"/'
  rewrite "$repo/apps/agent/Cargo.toml" \
    '/^\[\[bin\]\]/,/^\[/ s/^name = ".*"$/name = "'"$agent_binary"'"/'

  # The installer kills processes by image name, and only this channel's.
  rewrite "$repo/apps/desktop/src-tauri/installer.nsh" \
    -e 's/^!define GH_DESKTOP_EXE ".*"$/!define GH_DESKTOP_EXE "'"$desktop_binary"'.exe"/' \
    -e 's/^!define GH_DAEMON_EXE ".*"$/!define GH_DAEMON_EXE "'"$daemon_binary"'.exe"/' \
    -e 's/^!define GH_AGENT_EXE ".*"$/!define GH_AGENT_EXE "'"$agent_binary"'.exe"/'

  # install.sh is served to users on its own, so its channel travels inside it
  # as one assignment this script rewrites.
  rewrite "$repo/scripts/install.sh" \
    -e 's/^# channel: .*$/# channel: '"$channel"' — written by scripts\/channel.sh/' \
    -e 's/^channel="[a-z]*"$/channel="'"$channel"'"/' \
    -e 's/^channel=[a-z]*$/channel='"$channel"'/'

  echo "stamped $channel into the workspace, the shell and the packaging"
  grep -m1 'pub const CHANNEL' "$repo/apps/daemon/src/channel.rs"
  grep -m1 '"productName"' "$repo/apps/desktop/src-tauri/tauri.conf.json"
  grep -m1 '"identifier"' "$repo/apps/desktop/src-tauri/tauri.conf.json"
  grep -m1 '^# channel:' "$repo/scripts/install.sh"
}

# The channel a tag build belongs to: anything carrying a semver prerelease
# marker is beta, a plain version is official, and anything else is not a
# release at all.
from_ref() {
  case "${GITHUB_REF_NAME:-}" in
    v[0-9]*.[0-9]*.[0-9]*-beta.[0-9]*) printf '%s' beta ;;
    v[0-9]*.[0-9]*.[0-9]*)             printf '%s' official ;;
    *)                                 printf '%s' "" ;;
  esac
}

case "${1:-}" in
  official | beta) stamp "$1" ;;
  --from-tag)
    channel="$(from_ref)"
    if [ -z "$channel" ]; then
      echo "not a release tag (GITHUB_REF_NAME=${GITHUB_REF_NAME:-unset}), leaving the tree as it is"
      exit 0
    fi
    stamp "$channel"
    ;;
  # Just the answer, without touching the tree — the workflow's first job asks
  # this to decide what the later jobs build and publish.
  --detect)
    channel="$(from_ref)"
    if [ -z "$channel" ]; then
      # A rehearsal run builds official, matching the tree.
      printf '%s' official
    else
      printf '%s' "$channel"
    fi
    ;;
  --show)
    sed -n 's/^pub const CHANNEL: &str = "\(.*\)";$/\1/p' "$repo/apps/daemon/src/channel.rs"
    ;;
  *) usage; exit 2 ;;
esac
