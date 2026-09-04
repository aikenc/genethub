import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type { ArtifactIdentity, RepoIdentity } from "../types.ts";
import { GENET, locateRuntimeArtifact } from "./artifacts.ts";

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
  const dirtyDigest = createHash("sha256").update(git(repo, ["status", "--porcelain"])).digest("hex");
  return { path: repo, sha, branch, dirty, dirtyDigest };
}

export function artifactIdentity(openRoot: string): ArtifactIdentity {
  const artifact = locateRuntimeArtifact(openRoot, GENET);
  if (!artifact.path) return { path: null, hash: null, kind: "missing" };
  const digest = spawnSync("sha256sum", [artifact.path], { encoding: "utf8" });
  const hash = (digest.stdout ?? "").split(/\s+/)[0] || null;
  return { path: artifact.path, hash, kind: path.basename(artifact.path) };
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
