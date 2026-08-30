import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { repoIdentity } from "./git.ts";

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("repository identity binds index, tracked edits, and untracked file contents", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "genehub-repo-identity-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    const tracked = path.join(repo, "tracked.txt");
    writeFileSync(tracked, "base\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-qm", "base"]);

    const clean = repoIdentity(repo);
    assert.equal(clean.dirty, false);

    writeFileSync(tracked, "working-one\n");
    const workingOne = repoIdentity(repo);
    writeFileSync(tracked, "working-two\n");
    const workingTwo = repoIdentity(repo);
    assert.equal(workingOne.dirty, true);
    assert.notEqual(workingOne.dirtyDigest, workingTwo.dirtyDigest);

    writeFileSync(tracked, "index-one\n");
    git(repo, ["add", "tracked.txt"]);
    writeFileSync(tracked, "same-working-tree\n");
    const indexOne = repoIdentity(repo);
    writeFileSync(tracked, "index-two\n");
    git(repo, ["add", "tracked.txt"]);
    writeFileSync(tracked, "same-working-tree\n");
    const indexTwo = repoIdentity(repo);
    assert.notEqual(indexOne.dirtyDigest, indexTwo.dirtyDigest);

    const untracked = path.join(repo, "new.log");
    writeFileSync(untracked, "untracked-one\n");
    const untrackedOne = repoIdentity(repo);
    writeFileSync(untracked, "untracked-two\n");
    const untrackedTwo = repoIdentity(repo);
    assert.notEqual(untrackedOne.dirtyDigest, untrackedTwo.dirtyDigest);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
