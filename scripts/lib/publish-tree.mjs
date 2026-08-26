// The persistent per-channel publish worktree and the publish lock, shared
// by publish-component.mjs (every Live publish) and setup.mjs (warming a new
// machine).
//
// A committed Live build compiles for its channel while the source tree
// always says `local`. Stamping the main checkout would flip-flop it
// local→beta→local on every publish and poison every cargo cache in it, so
// the stamped build happens in a dedicated worktree that stays stamped
// between publishes. Reusing that worktree is what makes a warm publish
// fast — but only if an unchanged tree leaves the stamped files untouched,
// because cargo keys freshness on mtime. `git reset --hard` fights that: the
// stamped files differ from HEAD by design, so reset rewrites every one of
// them. The dance below copies them aside, resets, re-stamps, and restores
// the old mtime only where the post-stamp bytes came out identical — a
// genuinely changed upstream file keeps its fresh mtime and rebuilds, an
// unchanged one stays invisible to cargo.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { STAMPED_PATHS } from "../channel.mjs";

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

// mkdir-as-lock: one Live publish per channel at a time. Two concurrent
// publishes would race the worktree, the shared target dir, and the
// read-current → next-version computation, and the loser's failure mode is a
// half-stamped build, not a clean error.
export function acquirePublishLock(open, channel) {
  mkdirSync(join(open, "target", "publish"), { recursive: true });
  const lock = join(open, "target", "publish", `${channel}.lock`);
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new Error(
        `another ${channel} publish holds ${lock} — wait for it, or remove the directory if the holder died`,
      );
    }
    throw error;
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

// The worktree lives inside target/ (ignored, disposable) and is keyed by
// channel in its full path — two channels never share one, and a basename
// collision with an unrelated worktree cannot register here.
export function publishWorktreePath(open, channel) {
  return join(open, "target", "publish", "worktrees", channel);
}

export function ensureStampedWorktree(open, channel, sha) {
  // target/ cleanups leave dangling worktree registrations behind; prune
  // before asking whether ours exists.
  git(open, ["worktree", "prune"]);
  const path = publishWorktreePath(open, channel);
  if (!existsSync(join(path, ".git"))) {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    git(open, ["worktree", "add", "--detach", path, sha]);
  } else {
    // Stamped files are modified relative to HEAD, so checkout will not move
    // them; only reset --hard brings the worktree to the requested sha.
    const aside = mkdtempSync(join(tmpdir(), "genehub-stamp-aside-"));
    try {
      const saved = [];
      for (const relative of STAMPED_PATHS) {
        const file = join(path, relative);
        if (!existsSync(file)) continue;
        const copy = join(aside, relative);
        mkdirSync(dirname(copy), { recursive: true });
        copyFileSync(file, copy);
        // Nanoseconds: Date only carries milliseconds, and handing a
        // truncated mtime back would shift the file by up to 1ms against
        // cargo's freshness comparisons.
        saved.push([relative, statSync(file, { bigint: true }).mtimeNs]);
      }
      git(path, ["reset", "--hard", sha]);
      git(path, ["clean", "-fd"]);
      stamp(path, channel);
      // Byte-identical re-stamp → hand the old mtime back so cargo sees a
      // file older than its build outputs and stays warm. A real content
      // change keeps the fresh mtime the write just produced.
      for (const [relative, mtimeNs] of saved) {
        const file = join(path, relative);
        if (!existsSync(file)) continue;
        if (readFileSync(file, "utf8") !== readFileSync(join(aside, relative), "utf8")) continue;
        const seconds = Number(mtimeNs) / 1e9;
        utimesSync(file, seconds, seconds);
      }
    } finally {
      rmSync(aside, { recursive: true, force: true });
    }
    return path;
  }
  stamp(path, channel);
  return path;
}

function stamp(path, channel) {
  // The worktree's own copy of the stamper — it self-locates its repo from
  // import.meta.url, so running it by path stamps the worktree, never the
  // main checkout. Idempotent under write-if-changed.
  execFileSync(process.execPath, [join(path, "scripts/channel.mjs"), channel], { stdio: "inherit" });
}
