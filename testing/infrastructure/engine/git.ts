import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type { ArtifactIdentity, RepoIdentity } from "../types.ts";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return (result.stdout ?? "").trim();
}

export function repoIdentity(repo: string): RepoIdentity {
  if (!existsSync(path.join(repo, ".git")) && !existsSync(repo)) {
    return { path: repo, sha: "unknown", branch: "unknown", dirty: false, dirtyDigest: "missing" };
  }
  const sha = git(repo, ["rev-parse", "HEAD"]) || "unknown";
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const dirty = git(repo, ["status", "--porcelain"]).length > 0;
  const digest = createHash("sha256");
  const snapshot = (args: string[]): Buffer => {
    const result = spawnSync("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("cannot fingerprint Git working tree");
    return result.stdout;
  };
  digest.update("working-tree-content-v2\0");
  digest.update(snapshot(["status", "--porcelain", "-z"]));
  digest.update(snapshot(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--"]));
  digest.update(snapshot(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--"]));
  const untracked = snapshot(["ls-files", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean).sort();
  for (const name of untracked) {
    const file = path.join(repo, name), stat = lstatSync(file);
    digest.update(name + "\0" + stat.mode + "\0");
    digest.update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
    digest.update("\0");
  }
  const dirtyDigest = digest.digest("hex");
  return { path: repo, sha, branch, dirty, dirtyDigest };
}

export function artifactIdentity(openRoot: string): ArtifactIdentity {
  const override = process.env.GENET_E2E_DAEMON?.trim();
  if (override) {
    const result = spawnSync("sha256sum", [override], { encoding: "utf8" });
    return { path: override, hash: result.status === 0 ? result.stdout.split(/\s+/)[0]! : null, kind: "override" };
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  const names = ["genet-local", "genet-dev", "genet-beta", "genet"];
  for (const profile of ["iterate", "debug", "release"] as const) {
    for (const name of names) {
      const candidate = path.join(openRoot, "target", profile, `${name}${suffix}`);
      if (!existsSync(candidate)) continue;
      const digest = spawnSync("sha256sum", [candidate], { encoding: "utf8" });
      const hash = (digest.stdout ?? "").split(/\s+/)[0] || null;
      return { path: candidate, hash, kind: name };
    }
  }
  return { path: null, hash: null, kind: "missing" };
}

export function runsIgnored(spaceRoot: string): boolean {
  const probes = ["runs", "runs/", "runs/summary.md"];
  for (const probe of probes) {
    const result = spawnSync("git", ["-C", spaceRoot, "check-ignore", "-q", probe], { encoding: "utf8" });
    if (result.status === 0) return true;
  }
  const parent = spawnSync("git", ["-C", spaceRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const root = (parent.stdout ?? "").trim();
  if (!root) return false;
  const relative = path.relative(root, path.join(spaceRoot, "runs", "summary.md"));
  const again = spawnSync("git", ["-C", root, "check-ignore", "-q", relative], { encoding: "utf8" });
  return again.status === 0;
}

/** Exact bytes of native artifacts and built JS inputs, including explicit overrides. */
export function artifactBundleIdentity(openRoot: string, cloudRoot?: string) {
  const roots = [
    ...["iterate", "debug", "release"].flatMap(profile => [
      ...["genet-local", "genet-dev", "genet-beta", "genet", "genehub-host-local"].map(name => path.join(openRoot, "target", profile, name)),
      path.join(openRoot, "target", "wasm32-wasip2", profile, "genehub_guest.wasm"),
    ]),
    path.join(openRoot, "target", "genehub-app.wasm"),
    ...["packages/workbench/dist", "packages/proto/dist", "apps/relay/dist", "testing/package-lock.json", "packages/workbench/package-lock.json", "apps/relay/package-lock.json", "Cargo.lock"].map(p => path.join(openRoot, p)),
    ...(cloudRoot ? ["server/dist", "server/package-lock.json"].map(p => path.join(cloudRoot, p)) : []),
    ...["GENET_E2E_DAEMON", "GENEHUB_HOST", "GENEHUB_LOCAL_COMPONENT", "GENEHUB_LOCAL_DAEMON_COMPONENT", "GENET_APP_WASM", "GENEHUB_MULTICHANNEL_PREVIOUS_CLI", "GENEHUB_MULTICHANNEL_PREVIOUS_COMPONENT"].map(key => process.env[key]).filter((p): p is string => !!p),
  ];
  const files: Array<{ path: string; hash: string }> = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    const stat = lstatSync(p);
    if (stat.isDirectory()) { for (const name of readdirSync(p).sort()) walk(path.join(p, name)); return; }
    if (!stat.isFile() && !stat.isSymbolicLink()) return;
    const result = spawnSync("sha256sum", [p], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("cannot fingerprint artifact input");
    files.push({ path: p, hash: result.stdout.split(/\s+/)[0]! });
  };
  for (const root of [...new Set(roots)].sort()) walk(root);
  return { files, hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"), runtime: { node: process.version, platform: process.platform, arch: process.arch } };
}
