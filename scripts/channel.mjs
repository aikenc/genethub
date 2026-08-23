#!/usr/bin/env node
// The release channel of the product, written in at build time.
//
// Four identities of the product exist — `dev` (what the source tree claims
// to be), the two prerelease lines `alpha` and `beta`, and the `official`
// release — and the released three must coexist on one machine without
// sharing processes, data directories, environment variables or update feeds
// (`docs/dual-channel-release.md` in genethub-cloud). Everything that makes a
// build belong to one of them is derived here, from one table, so no two
// files can disagree about what a beta is called.
//
// It works the way `scripts/version.mjs` works, and for the same reason: the
// tree always claims to be `dev`, and the release workflow stamps
// `official|beta|alpha` in just before it builds. A channel a human has to
// edit into a dozen places is a channel that ships half-renamed — one process
// killed by the wrong installer, one daemon reading the other line's data
// directory.
//
// The Rust and TypeScript consumers get a generated constants module each,
// rewritten wholesale — sed-ing values into source code is how a quote or a
// comma ends up in a binary name. The packaging files (tauri.conf.json, the
// two `[[bin]]` names, installer.nsh, install.sh) carry marked lines this
// script rewrites in place, the same portable way version.mjs does.
//
//   node scripts/channel.mjs dev|official|beta|alpha   stamp the tree for a channel
//   node scripts/channel.mjs --from-tag                stamp from the tag being built, if there is one
//   node scripts/channel.mjs --show                    print the channel the tree is stamped for

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const usage = () => {
  console.error(`  node scripts/channel.mjs dev|official|beta|alpha   stamp the tree for a channel
  node scripts/channel.mjs --from-tag                stamp from the tag being built, if there is one
  node scripts/channel.mjs --show                    print the channel the tree is stamped for`);
};

// The one table. All four columns side by side so a review — and the wiring
// tests — can see every channel in the same glance. The official column is
// frozen: those names are what installed copies already answer to, and
// changing one silently orphans every override a user has set.
//
// dev is what the tree claims: it installs nowhere, updates from nowhere and
// points at no Hub — a source build has no business touching the released
// lines' data, and there is no release to fetch for it.
const TABLE = {
  channel: { dev: "dev", official: "official", beta: "beta", alpha: "alpha" },
  product: { dev: "GeneHub Dev", official: "GeneHub", beta: "GeneHub Beta", alpha: "GeneHub Alpha" },
  identifier: {
    dev: "com.genethub.desktop.dev",
    official: "com.genethub.desktop",
    beta: "com.genethub.desktop.beta",
    alpha: "com.genethub.desktop.alpha",
  },
  desktop_binary: {
    dev: "genethub-desktop-dev",
    official: "genethub-desktop",
    beta: "genethub-desktop-beta",
    alpha: "genethub-desktop-alpha",
  },
  // The one binary that is both the CLI and the daemon (`genet daemon
  // run`) — the merge retired a separate daemon binary (`genethub-cli.md`).
  cli_binary: { dev: "genet-dev", official: "genet", beta: "genet-beta", alpha: "genet-alpha" },
  agent_binary: {
    dev: "genet-agent-dev",
    official: "genet-agent",
    beta: "genet-agent-beta",
    alpha: "genet-agent-alpha",
  },
  // The wasm shell: it loads genehub_guest.wasm and picks the daemon or the
  // agent entry per process. Shipped beside the CLI in every package — the
  // CLI refuses to start a daemon without it.
  host_binary: {
    dev: "genehub-host-dev",
    official: "genehub-host",
    beta: "genehub-host-beta",
    alpha: "genehub-host-alpha",
  },
  agent_home_dir: {
    dev: ".genet-agent-dev",
    official: ".genet-agent",
    beta: ".genet-agent-beta",
    alpha: ".genet-agent-alpha",
  },
  data_dir_name: { dev: "GeneHub-dev", official: "GeneHub", beta: "GeneHub-beta", alpha: "GeneHub-alpha" },
  workspace_dir_name: {
    dev: "GeneHub-dev",
    official: "GeneHub",
    beta: "GeneHub-beta",
    alpha: "GeneHub-alpha",
  },
  tray_id: { dev: "genethub-tray-dev", official: "genethub-tray", beta: "genethub-tray-beta", alpha: "genethub-tray-alpha" },

  env_data_dir: { dev: "GENEHUB_DEV_DATA_DIR", official: "GENEHUB_DATA_DIR", beta: "GENEHUB_BETA_DATA_DIR", alpha: "GENEHUB_ALPHA_DATA_DIR" },
  env_workspace_dir: {
    dev: "GENEHUB_DEV_WORKSPACE_DIR",
    official: "GENEHUB_WORKSPACE_DIR",
    beta: "GENEHUB_BETA_WORKSPACE_DIR",
    alpha: "GENEHUB_ALPHA_WORKSPACE_DIR",
  },
  env_log: { dev: "GENEHUB_DEV_LOG", official: "GENEHUB_LOG", beta: "GENEHUB_BETA_LOG", alpha: "GENEHUB_ALPHA_LOG" },
  env_host_pid: {
    dev: "GENEHUB_DEV_HOST_PID",
    official: "GENEHUB_HOST_PID",
    beta: "GENEHUB_BETA_HOST_PID",
    alpha: "GENEHUB_ALPHA_HOST_PID",
  },
  env_daemon_command: {
    dev: "GENEHUB_DEV_DAEMON_COMMAND",
    official: "GENEHUB_DAEMON_COMMAND",
    beta: "GENEHUB_BETA_DAEMON_COMMAND",
    alpha: "GENEHUB_ALPHA_DAEMON_COMMAND",
  },
  // Whoever spawns the wasm shell names the front-door CLI through this
  // variable; the shell hands it to the guest as GENEHUB_CLI.
  env_cli: {
    dev: "GENEHUB_DEV_CLI",
    official: "GENEHUB_CLI",
    beta: "GENEHUB_BETA_CLI",
    alpha: "GENEHUB_ALPHA_CLI",
  },
  // The directory the daemon was started in, handed to the guest which
  // cannot ask the OS for it.
  env_cwd: {
    dev: "GENEHUB_DEV_CWD",
    official: "GENEHUB_CWD",
    beta: "GENEHUB_BETA_CWD",
    alpha: "GENEHUB_ALPHA_CWD",
  },
  // The component file the shell loaded, handed to the guest so the daemon
  // can watch it and ask the shell for an in-place reload when it changes.
  env_component_file: {
    dev: "GENEHUB_DEV_COMPONENT_FILE",
    official: "GENEHUB_COMPONENT_FILE",
    beta: "GENEHUB_BETA_COMPONENT_FILE",
    alpha: "GENEHUB_ALPHA_COMPONENT_FILE",
  },
  env_machine_name: {
    dev: "GENEHUB_DEV_MACHINE_NAME",
    official: "GENEHUB_MACHINE_NAME",
    beta: "GENEHUB_BETA_MACHINE_NAME",
    alpha: "GENEHUB_ALPHA_MACHINE_NAME",
  },
  env_agent_command: {
    dev: "GENET_AGENT_DEV_COMMAND",
    official: "GENET_AGENT_COMMAND",
    beta: "GENET_AGENT_BETA_COMMAND",
    alpha: "GENET_AGENT_ALPHA_COMMAND",
  },
  env_agent_home: {
    dev: "GENET_AGENT_DEV_HOME",
    official: "GENET_AGENT_HOME",
    beta: "GENET_AGENT_BETA_HOME",
    alpha: "GENET_AGENT_ALPHA_HOME",
  },
  env_download_base: {
    dev: "GENEHUB_DEV_DOWNLOAD_BASE",
    official: "GENEHUB_DOWNLOAD_BASE",
    beta: "GENEHUB_BETA_DOWNLOAD_BASE",
    alpha: "GENEHUB_ALPHA_DOWNLOAD_BASE",
  },
  env_bin_dir: { dev: "GENEHUB_DEV_BIN_DIR", official: "GENEHUB_BIN_DIR", beta: "GENEHUB_BETA_BIN_DIR", alpha: "GENEHUB_ALPHA_BIN_DIR" },
  env_hub_url: { dev: "GENEHUB_DEV_HUB_URL", official: "GENEHUB_HUB_URL", beta: "GENEHUB_BETA_HUB_URL", alpha: "GENEHUB_ALPHA_HUB_URL" },

  default_machine_name: {
    dev: "GeneHub Dev machine",
    official: "GeneHub machine",
    beta: "GeneHub Beta machine",
    alpha: "GeneHub Alpha machine",
  },
  agent_label: {
    dev: "GeneHub Dev Agent",
    official: "GeneHub Agent",
    beta: "GeneHub Beta Agent",
    alpha: "GeneHub Alpha Agent",
  },

  // The update manifest needs a stable address per channel. Official rides
  // the latest release; prereleases cannot — GitHub's `latest` never names
  // one — so beta and alpha releases additionally publish to rolling `beta`
  // and `alpha` tags, which is what makes these addresses stay put
  // (release.yml). dev has none: a source build is not on the scale at all.
  manifest_url: {
    dev: "",
    official: "https://github.com/aikenc/genethub/releases/latest/download/latest.json",
    beta: "https://github.com/aikenc/genethub/releases/download/beta/latest-beta.json",
    alpha: "https://github.com/aikenc/genethub/releases/download/alpha/latest-alpha.json",
  },

  // Default Hub this channel's CLI/daemon dials (`genethub-cli.md` §4.1).
  // Alpha's public name is only a default — it is the intranet line, and a
  // real deployment overrides it (GENEHUB_ALPHA_HUB_URL / CI vars).
  hub_url: {
    dev: "",
    official: "https://relay.genethub.com",
    beta: "https://relay-beta.genethub.com",
    alpha: "https://relay-alpha.genethub.com",
  },
  web_app_url: {
    dev: "http://127.0.0.1:5173/app",
    official: "https://relay.genethub.com/app",
    beta: "https://relay-beta.genethub.com/app",
    alpha: "https://relay-alpha.genethub.com/app",
  },
  logic_manifest_urls: {
    dev: [],
    official: ["https://relay.genethub.com/artifacts/manifests/logic/latest.json"],
    beta: ["https://relay-beta.genethub.com/artifacts/manifests/logic/latest-beta.json"],
    alpha: ["https://relay-alpha.genethub.com/artifacts/manifests/logic/latest-alpha.json"],
  },
  app_download_url: {
    dev: "https://github.com/aikenc/genethub/releases",
    official: "https://github.com/aikenc/genethub/releases",
    beta: "https://github.com/aikenc/genethub/releases",
    alpha: "https://github.com/aikenc/genethub/releases",
  },

  // Where install.sh pulls the Linux tarball from. The prerelease lines
  // cannot use `releases/latest/download` (same reason as above), so their
  // default is their own control plane, which resolves the newest
  // prerelease itself. dev refuses to install at all unless
  // GENEHUB_DEV_DOWNLOAD_BASE is given — there is no dev artifact.
  download_base: {
    dev: "",
    official: "https://github.com/aikenc/genethub/releases/latest/download",
    beta: "https://relay-beta.genethub.com/download/beta",
    alpha: "https://relay-alpha.genethub.com/download/alpha",
  },
  tarball_prefix: { dev: "genet-dev", official: "genet", beta: "genet-beta", alpha: "genet-alpha" },
};

const value = (key, channel) => {
  const row = TABLE[key];
  if (!row) throw new Error(`unknown identity key: ${key}`);
  return row[channel];
};

const CHANNEL_TYPE = '"dev" | "official" | "beta" | "alpha"';

// One line replaced at a time, matching only what the marker comments
// promise — a replace that silently matches nothing is how a channel ships
// half-stamped, so every pattern failing to match is an error.
function rewriteLines(path, replacements) {
  // Windows runners check out with CRLF; `$`-anchored patterns miss every
  // line if the trailing `\r` is left on it.
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const matched = new Set();
  const out = lines.map((line) => {
    for (let i = 0; i < replacements.length; i++) {
      const [pattern, substitute] = replacements[i];
      if (pattern.test(line)) {
        matched.add(i);
        return substitute instanceof Function ? substitute(line) : substitute;
      }
    }
    return line;
  });
  if (matched.size !== replacements.length) {
    const missed = replacements.filter((_, i) => !matched.has(i)).map(([p]) => p);
    throw new Error(`${path}: no line matched ${missed.join(", ")} — the marker drifted from the stamper`);
  }
  writeFileSync(path, out.join("\n"));
}

// The scoped form: sed's `/^\[\[bin\]\]/,/^\[/ s/...` — only the first
// `version`/`name` inside the named section, or a later section's entry
// would be rewritten instead.
function rewriteInSection(path, sectionStart, pattern, substitute) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  let inside = false;
  let done = false;
  const out = lines.map((line) => {
    if (!inside && sectionStart.test(line)) inside = true;
    else if (inside && /^\[/.test(line) && !sectionStart.test(line)) inside = false;
    if (inside && !done && pattern.test(line)) {
      done = true;
      return substitute;
    }
    return line;
  });
  if (!done) throw new Error(`${path}: no line matched ${pattern} inside ${sectionStart} — the marker drifted from the stamper`);
  writeFileSync(path, out.join("\n"));
}

const rustModule = (channel) => {
  const manifestUrl = value("manifest_url", channel);
  // rustfmt's line budget decides the shape: the released channels' URLs do
  // not fit on one line and dev's empty string does, and CI rejects a tree
  // rustfmt would rewrite — so the generator emits what rustfmt would.
  const manifestConst =
    `pub const DEFAULT_MANIFEST_URL: &str = "${manifestUrl}";`.length <= 100
      ? `pub const DEFAULT_MANIFEST_URL: &str = "${manifestUrl}";`
      : `// Broken across two lines: the released channels' URLs are longer than
// rustfmt's line budget, and CI rejects a tree rustfmt would rewrite.
pub const DEFAULT_MANIFEST_URL: &str =
    "${manifestUrl}";`;
  return `//! Which release channel this build belongs to.
//!
//! Written wholesale by \`scripts/channel.mjs\` — edit that script, not this
//! file. The tree always says \`dev\`; a release build is the workflow
//! stamping its channel in before it compiles, exactly the way
//! \`scripts/version.mjs\` stamps the version.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// \`dev\` | \`official\` | \`beta\` | \`alpha\`.
pub const CHANNEL: &str = "${value("channel", channel)}";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "${value("product", channel)}";
/// Root of everything the daemon owns, under the platform data directory.
pub const DATA_DIR_NAME: &str = "${value("data_dir_name", channel)}";
/// The folder the agent works in until the user points it somewhere else.
pub const WORKSPACE_DIR_NAME: &str = "${value("workspace_dir_name", channel)}";
/// The one binary: CLI to agents, daemon as \`genet daemon run\`.
pub const CLI_BINARY: &str = "${value("cli_binary", channel)}";
pub const AGENT_BINARY: &str = "${value("agent_binary", channel)}";
/// The wasm shell next to the CLI: loads \`genehub_guest.wasm\` and runs its
/// daemon or agent entry. The CLI refuses to start a daemon without it.
pub const HOST_BINARY: &str = "${value("host_binary", channel)}";
/// Where the agent keeps its sessions and \`models.json\`, under the home dir.
pub const AGENT_HOME_DIR: &str = "${value("agent_home_dir", channel)}";
pub const ENV_DATA_DIR: &str = "${value("env_data_dir", channel)}";
pub const ENV_WORKSPACE_DIR: &str = "${value("env_workspace_dir", channel)}";
pub const ENV_LOG: &str = "${value("env_log", channel)}";
/// The shell's pid, handed to the WASI guest which has none of its own.
pub const ENV_HOST_PID: &str = "${value("env_host_pid", channel)}";
pub const ENV_MACHINE_NAME: &str = "${value("env_machine_name", channel)}";
pub const ENV_AGENT_COMMAND: &str = "${value("env_agent_command", channel)}";
/// Runs the daemon instead of \`genet daemon run\`, for pointing the product at
/// the wasm guest under its shell. Mirrors \`ENV_AGENT_COMMAND\`: a binary that
/// already knows what it is, so no argv is appended.
pub const ENV_DAEMON_COMMAND: &str = "${value("env_daemon_command", channel)}";
/// Whoever spawns the wasm shell names the front-door CLI through this
/// variable; the shell hands it to the guest as GENEHUB_CLI.
pub const ENV_CLI: &str = "${value("env_cli", channel)}";
/// The component file the shell loaded, handed to the guest so the daemon
/// can watch it and ask for an in-place reload when it changes.
pub const ENV_COMPONENT_FILE: &str = "${value("env_component_file", channel)}";
pub const ENV_AGENT_HOME: &str = "${value("env_agent_home", channel)}";
/// What the owner sees this machine called before they name it.
pub const DEFAULT_MACHINE_NAME: &str = "${value("default_machine_name", channel)}";
/// What the built-in agent calls itself in the picker.
pub const AGENT_LABEL: &str = "${value("agent_label", channel)}";
/// Where the published builds of this channel announce themselves.
/// Empty for dev: a source build is not on the update scale at all.
${manifestConst}
/// Default Hub for \`genet hub login\` and a standalone first pair.
/// Empty for dev: a source build points nowhere unless told.
pub const DEFAULT_HUB_URL: &str = "${value("hub_url", channel)}";
pub const ENV_HUB_URL: &str = "${value("env_hub_url", channel)}";
/// Channel website the Desktop shell navigates to after boot.
pub const WEB_APP_URL: &str = "${value("web_app_url", channel)}";
`;
};

const agentModule = (channel) => `//! Which release channel this build belongs to.
//!
//! Written wholesale by \`scripts/channel.mjs\` — edit that script, not this
//! file. The daemon has the full set of names; the agent only needs to find
//! its own home directory, and it reads the same override name the daemon
//! writes when it spawns one.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// \`dev\` | \`official\` | \`beta\` | \`alpha\`.
pub const CHANNEL: &str = "${value("channel", channel)}";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "${value("product", channel)}";
pub const ENV_HOME: &str = "${value("env_agent_home", channel)}";
pub const HOME_DIR_NAME: &str = "${value("agent_home_dir", channel)}";
/// The shell's pid, handed to the WASI guest which has none of its own.
pub const ENV_HOST_PID: &str = "${value("env_host_pid", channel)}";
/// The directory the daemon was started in; a WASI guest cannot ask the OS.
pub const ENV_CWD: &str = "${value("env_cwd", channel)}";
`;

const hostModule = (channel) => `//! Which release channel this build belongs to.
//!
//! Written wholesale by \`scripts/channel.mjs\` — edit that script, not this
//! file. The shell and the guest are separate crates that must agree on the
//! names things are handed over with, so the shell reads the same stamped
//! constants the guest's crates do.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// \`dev\` | \`official\` | \`beta\` | \`alpha\`.
pub const CHANNEL: &str = "${value("channel", channel)}";
/// Whoever spawns the shell names the front-door CLI through this variable;
/// the guest sees it as GENEHUB_CLI.
pub const ENV_CLI: &str = "${value("env_cli", channel)}";
/// The shell's pid, handed to the WASI guest which has none of its own.
pub const ENV_HOST_PID: &str = "${value("env_host_pid", channel)}";
/// The directory the daemon was started in; a WASI guest cannot ask the OS.
pub const ENV_CWD: &str = "${value("env_cwd", channel)}";
/// The component file the shell loaded; the daemon watches it to ask for an
/// in-place reload when it changes.
pub const ENV_COMPONENT_FILE: &str = "${value("env_component_file", channel)}";
/// Host ABI integer written into signed guest envelopes. Bump when
/// \`wit/genehub-host.wit\` changes a load-time contract.
pub const HOST_ABI: u32 = 23;
/// Content-addressed module id in \`genehub.daemon.artifact.v2\`.
pub const MODULE_ID: &str = "genehub:guest/wasm";
/// Stamped signed-logic discovery URLs. Empty for dev.
pub const LOGIC_MANIFEST_URLS: &[&str] = &[${value("logic_manifest_urls", channel).map((entry) => `"${entry}"`).join(", ")}];
/// Data-dir env the desktop/CLI already stamps; the host store lives under it.
pub const ENV_DATA_DIR: &str = "${value("env_data_dir", channel)}";
`;

const desktopModule = (channel) => `//! Which release channel this build belongs to.
//!
//! Written wholesale by \`scripts/channel.mjs\` — edit that script, not this
//! file. The tree always says \`dev\`; a release build is the workflow
//! stamping its channel in before it compiles.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// \`dev\` | \`official\` | \`beta\` | \`alpha\`.
pub const CHANNEL: &str = "${value("channel", channel)}";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "${value("product", channel)}";
/// The shell's slice of state, joined under \`app_data_dir()\`. Two derivation
/// chains exist and both have to move together: this one follows the
/// identifier (which channel.mjs also stamps), and the daemon's own
/// \`dirs::data_dir()\` root follows DATA_DIR_NAME in its copy of this module.
pub const DATA_DIR_NAME: &str = "${value("data_dir_name", channel)}";
/// What the shell spawns (with \`daemon run\`): the merged CLI+daemon binary.
pub const CLI_BINARY: &str = "${value("cli_binary", channel)}";
/// The wasm shell staged next to the CLI: the desktop spawns it directly with
/// \`genehub_guest.wasm\` when both are found beside the CLI binary.
pub const HOST_BINARY: &str = "${value("host_binary", channel)}";
/// Names the front-door CLI to the wasm shell it spawns; the shell hands it
/// to the guest as GENEHUB_CLI.
pub const ENV_CLI: &str = "${value("env_cli", channel)}";
/// The override the shell passes to the daemon it spawns — has to stay the
/// name the daemon reads (\`apps/daemon/src/channel.rs\`), or the shell and
/// the daemon disagree about where the data lives and the shell ends up
/// adopting the other channel's daemon through a stale endpoint file.
pub const ENV_DATA_DIR: &str = "${value("env_data_dir", channel)}";
pub const TRAY_ID: &str = "${value("tray_id", channel)}";
/// Official download page opened from the tray.
pub const APP_DOWNLOAD_URL: &str = "${value("app_download_url", channel)}";
/// Channel website the shell may navigate to after boot.
pub const WEB_APP_URL: &str = "${value("web_app_url", channel)}";
`;

const tsModule = (channel) => `// Which release channel this build belongs to.
//
// Written wholesale by \`scripts/channel.mjs\` — edit that script, not this
// file. The tree always says "dev"; a release build is the workflow stamping
// its channel in before it compiles. The separately deployed hosted Web sets
// VITE_GENEHUB_CHANNEL instead, so publishing a page never mutates the paired
// Open checkout just to stamp a native release identity.
export type ReleaseChannel = ${CHANNEL_TYPE};
const STAMPED_CHANNEL: ReleaseChannel = "${value("channel", channel)}";
const hostedChannel = import.meta.env.VITE_GENEHUB_CHANNEL;
export const CHANNEL: ReleaseChannel = isReleaseChannel(hostedChannel)
  ? hostedChannel
  : STAMPED_CHANNEL;
const PRODUCTS: Record<ReleaseChannel, string> = {
  dev: "GeneHub Dev",
  official: "GeneHub",
  beta: "GeneHub Beta",
  alpha: "GeneHub Alpha",
};
export const PRODUCT = import.meta.env.VITE_GENEHUB_BRAND || PRODUCTS[CHANNEL];
// The desktop shell checks its own release independently from whichever
// daemon the workbench currently controls. In a browser this stays unused;
// in a source build it is empty, because dev is not on a release scale.
export const MANIFEST_URL = "${value("manifest_url", channel)}";

function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return value === "dev" || value === "official" || value === "beta" || value === "alpha";
}
`;

const shellEnv = (channel) => `# Written by scripts/channel.mjs — edit that script, not this file.
# Sourced by apps/desktop/scripts/bundle.mjs and the release workflow's smoke
# steps so the packaging agrees with the binaries cargo just built under
# their stamped names.
CHANNEL=${value("channel", channel)}
PRODUCT="${value("product", channel)}"
DESKTOP_BINARY=${value("desktop_binary", channel)}
CLI_BINARY=${value("cli_binary", channel)}
AGENT_BINARY=${value("agent_binary", channel)}
HOST_BINARY=${value("host_binary", channel)}
ENV_DATA_DIR=${value("env_data_dir", channel)}
ENV_WORKSPACE_DIR=${value("env_workspace_dir", channel)}
# The daemon's override for where the agent binary lives — the journey
# harness sets this under its stamped name to point at the cargo target dir.
ENV_AGENT_COMMAND=${value("env_agent_command", channel)}
`;

function stamp(channel) {
  const product = value("product", channel);
  // Install / Start-menu / application-bundle path. Tauri derives those from
  // productName, so this must stay free of spaces even though the window title
  // keeps the friendlier display name in \`product\`.
  const pathName = value("data_dir_name", channel);
  const identifier = value("identifier", channel);
  const cliBinary = value("cli_binary", channel);
  const agentBinary = value("agent_binary", channel);
  const hostBinary = value("host_binary", channel);
  const desktopBinary = value("desktop_binary", channel);

  writeFileSync(join(repo, "apps/daemon/src/channel.rs"), rustModule(channel));
  writeFileSync(join(repo, "apps/agent/src/channel.rs"), agentModule(channel));
  writeFileSync(join(repo, "apps/host/src/channel.rs"), hostModule(channel));
  writeFileSync(join(repo, "apps/desktop/src-tauri/src/channel.rs"), desktopModule(channel));
  writeFileSync(join(repo, "packages/workbench/src/channel.ts"), tsModule(channel));
  writeFileSync(join(repo, "scripts/channel.env"), shellEnv(channel));

  // The bundle config: productName is the install-directory name (and what
  // the Start menu folder is called); the window title stays the display
  // product. Identifier and mainBinaryName keep each channel's processes
  // and locks apart. Every substitute keeps the line's tail — a whole-line
  // replacement eats the trailing comma and the next Tauri build reports a
  // parse error, not a wrong name.
  // Boot page only: the remote official site brings its own CSP. Giving the
  // bundled boot surface connect-src/ipc would recreate a privileged renderer.
  const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'";
  rewriteLines(join(repo, "apps/desktop/src-tauri/tauri.conf.json"), [
    [/^  "productName": "[^"]*"/, (line) => line.replace(/"productName": "[^"]*"/, `"productName": "${pathName}"`)],
    [/^  "identifier": "[^"]*"/, (line) => line.replace(/"identifier": "[^"]*"/, `"identifier": "${identifier}"`)],
    [/^  "mainBinaryName": "[^"]*"/, (line) => line.replace(/"mainBinaryName": "[^"]*"/, `"mainBinaryName": "${desktopBinary}"`)],
    // Indentation-agnostic: the windows block moved a level when the CLI
    // merge restructured it, and a fixed-indent pattern misses silently.
    [/^(\s*)"title": "[^"]*"/, (line) => line.replace(/"title": "[^"]*"/, `"title": "${product}"`)],
    // Whole-line replace: the CSP string itself contains quotes, so a
    // field-only substitute would leave a broken JSON value behind.
    [/^\s*"csp": "/, `      "csp": "${csp}"`],
  ]);

  // The binaries' own names. Crate (package) names stay put — source packages
  // are shared between channels by design; only what the process is called
  // changes.
  rewriteInSection(join(repo, "apps/cli/Cargo.toml"), /^\[\[bin\]\]/, /^name = ".*"$/, `name = "${cliBinary}"`);
  rewriteInSection(join(repo, "apps/agent/Cargo.toml"), /^\[\[bin\]\]/, /^name = ".*"$/, `name = "${agentBinary}"`);
  rewriteInSection(join(repo, "apps/host/Cargo.toml"), /^\[\[bin\]\]/, /^name = ".*"$/, `name = "${hostBinary}"`);

  // The installer stops the supervisor by image name and the daemon by the
  // pid in its lock file — the daemon is the same `genet` binary every client
  // runs, so a name match would kill clients with it (`genethub-cli.md` §2).
  rewriteLines(join(repo, "apps/desktop/src-tauri/installer.nsh"), [
    [/^!define GH_DESKTOP_EXE ".*"$/, `!define GH_DESKTOP_EXE "${desktopBinary}.exe"`],
    [/^!define GH_CLI_EXE ".*"$/, `!define GH_CLI_EXE "${cliBinary}.exe"`],
    [/^!define GH_HOST_EXE ".*"$/, `!define GH_HOST_EXE "${hostBinary}.exe"`],
    [/^!define GH_DATA_DIR_NAME ".*"$/, `!define GH_DATA_DIR_NAME "${value("data_dir_name", channel)}"`],
    // The shell-supervised daemon's lock sits one level deeper: the shell's
    // app-data directory carries the identifier on Windows (Tauri
    // `app_data_dir`), so the installer needs the bundle id to find it.
    [/^!define GH_BUNDLE_ID ".*"$/, `!define GH_BUNDLE_ID "${identifier}"`],
  ]);

  // install.sh is served to users on its own, so its channel travels inside
  // it as one assignment this script rewrites.
  rewriteLines(join(repo, "scripts/install.sh"), [
    [/^# channel: .*$/, `# channel: ${channel} — written by scripts/channel.mjs`],
    [/^channel="?[a-z]*"?$/, `channel=${channel}`],
  ]);

  console.log(`stamped ${channel} into the workspace, the shell and the packaging`);
  // Printed because this runs unattended: the log of a release should show
  // what went in, not just that something ran.
  console.log(readFileSync(join(repo, "apps/daemon/src/channel.rs"), "utf8").match(/pub const CHANNEL.*$/m)[0]);
  const conf = readFileSync(join(repo, "apps/desktop/src-tauri/tauri.conf.json"), "utf8");
  console.log(conf.match(/"productName".*$/m)[0].trim());
  console.log(conf.match(/"identifier".*$/m)[0].trim());
  console.log(conf.match(/"csp".*$/m)[0].trim());
  console.log(readFileSync(join(repo, "scripts/install.sh"), "utf8").match(/^# channel:.*$/m)[0]);
}

// The channel a tag build belongs to: anything carrying a semver prerelease
// marker is that prerelease line, a plain version is official, and anything
// else is not a release at all.
function fromRef() {
  const ref = process.env.GITHUB_REF_NAME ?? "";
  if (/^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$/.test(ref)) return "beta";
  if (/^v[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/.test(ref)) return "alpha";
  if (/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(ref)) return "official";
  return "";
}

const arg = process.argv[2] ?? "";
if (["dev", "official", "beta", "alpha"].includes(arg)) {
  stamp(arg);
} else if (arg === "--from-tag") {
  const channel = fromRef();
  if (!channel) {
    console.log(`not a release tag (GITHUB_REF_NAME=${process.env.GITHUB_REF_NAME ?? "unset"}), leaving the tree as it is`);
  } else {
    stamp(channel);
  }
} else if (arg === "--detect") {
  // Just the answer, without touching the tree — the workflow's first job
  // asks this to decide what the later jobs build and publish. A rehearsal
  // run is not a release tag, so it builds dev, matching the tree.
  process.stdout.write(fromRef() || "dev");
} else if (arg === "--show") {
  const body = readFileSync(join(repo, "apps/daemon/src/channel.rs"), "utf8");
  process.stdout.write(body.match(/pub const CHANNEL: &str = "(.*)";/)[1]);
} else {
  usage();
  process.exit(2);
}
