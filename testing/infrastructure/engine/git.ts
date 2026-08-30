import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type { ArtifactIdentity, RepoIdentity } from "../types.ts";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return (result.stdout ?? "").trim();
}

function gitBytes(cwd: string, args: string[]): Buffer {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 && Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.alloc(0);
}

function nulPaths(value: Buffer): string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function updateFileIdentity(digest: ReturnType<typeof createHash>, repo: string, relative: string): void {
  digest.update("path\0").update(relative).update("\0");
  const file = path.resolve(repo, relative);
  const root = path.resolve(repo);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    digest.update("escaped\0");
    return;
  }
  try {
    const stat = lstatSync(file);
    digest.update(`mode\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) {
      digest.update("link\0").update(readlinkSync(file)).update("\0");
      return;
    }
    if (!stat.isFile()) {
      digest.update(`type\0${stat.isDirectory() ? "directory" : "other"}\0`);
      return;
    }
    digest.update("file\0");
    const fd = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    try {
      for (;;) {
        const size = readSync(fd, buffer, 0, buffer.length, null);
        if (size === 0) break;
        digest.update(buffer.subarray(0, size));
      }
    } finally {
      closeSync(fd);
    }
    digest.update("\0");
  } catch {
    // Deletions and an index-only rename have no current filesystem object;
    // the raw status and index inventory still bind their exact state.
    digest.update("missing\0");
  }
}

function dirtyIdentity(repo: string): { dirty: boolean; digest: string } {
  const status = gitBytes(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const index = gitBytes(repo, ["ls-files", "--stage", "-z"]);
  const changed = gitBytes(repo, ["diff", "--name-only", "-z", "HEAD", "--"]);
  const untracked = gitBytes(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const digest = createHash("sha256")
    .update("status\0")
    .update(status)
    .update("index\0")
    .update(index);
  const paths = new Set([...nulPaths(changed), ...nulPaths(untracked)]);
  for (const relative of [...paths].sort()) updateFileIdentity(digest, repo, relative);
  return { dirty: status.length > 0, digest: digest.digest("hex") };
}

export function repoIdentity(repo: string): RepoIdentity {
  if (!existsSync(path.join(repo, ".git")) && !existsSync(repo)) {
    return { path: repo, sha: "unknown", branch: "unknown", dirty: false, dirtyDigest: "missing" };
  }
  const sha = git(repo, ["rev-parse", "HEAD"]) || "unknown";
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const dirty = dirtyIdentity(repo);
  return { path: repo, sha, branch, dirty: dirty.dirty, dirtyDigest: dirty.digest };
}

export function artifactIdentity(openRoot: string): ArtifactIdentity {
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
