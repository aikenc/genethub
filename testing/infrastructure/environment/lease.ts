import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

export interface EnvironmentLease {
  id: string;
  root: string;
  home: string;
  data: string;
  workspace: string;
  config: string;
  logs: string;
  env: Record<string, string>;
}

export function createLease(prefix = "genehub-env-"): EnvironmentLease {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "config");
  const logs = path.join(root, "logs");
  // Keep product data isolated under the lease, while allowing a child test
  // process to locate the pinned Rust toolchain installed for this machine.
  // Rustup otherwise follows HOME into the disposable lease and cannot find a
  // default toolchain.
  const toolchainHome = userInfo().homedir;
  for (const dir of [home, data, workspace, config, logs]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(workspace, ".keep"), "");
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    GENEHUB_DATA_DIR: data,
    GENEHUB_LOCAL_DATA_DIR: data,
    GENEHUB_WORKSPACE_DIR: workspace,
    GENEHUB_LOCAL_WORKSPACE_DIR: workspace,
    GENEHUB_LOG: path.join(logs, "daemon.log"),
    GENEHUB_LOCAL_LOG: "warn",
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(toolchainHome, ".rustup"),
    CARGO_HOME: process.env.CARGO_HOME ?? path.join(toolchainHome, ".cargo"),
    RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? "1.95.0",
  };
  return {
    id: path.basename(root),
    root,
    home,
    data,
    workspace,
    config,
    logs,
    env,
  };
}

export function releaseLease(lease: EnvironmentLease): void {
  rmSync(lease.root, { recursive: true, force: true });
}
