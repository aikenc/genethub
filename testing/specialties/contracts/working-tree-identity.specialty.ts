import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, repoIdentity } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.working-tree-content-identity",
  title: "Dirty identity changes when bytes change without a Git status change",
  oracle: "Real isolated Git index and untracked directory; stable bytes hash identically, both tracked and untracked edits change identity with unchanged status",
  catches: ["status-only fingerprint falsely binds different source versions"],
  tags: ["core", "contract", "network-audit"], llm: { default: "none" },
  expectedDurationMs: 500, timeoutMs: 10000, surfaces: ["testctl", "git"],
}, async t => {
  const repo = join(t.env.root, "identity-repo"); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init");
  writeFileSync(join(repo, "tracked.txt"), "indexed");
  git("add", "tracked.txt");
  writeFileSync(join(repo, "tracked.txt"), "working-one");
  const status = git("status", "--porcelain"), first = repoIdentity(repo).dirtyDigest;
  t.assertions.assert(repoIdentity(repo).dirtyDigest === first, "same bytes did not produce stable identity");
  writeFileSync(join(repo, "tracked.txt"), "working-two");
  t.assertions.assert(git("status", "--porcelain") === status, "fixture changed status instead of only content");
  t.assertions.assert(repoIdentity(repo).dirtyDigest !== first, "different tracked content retained the same identity");
  mkdirSync(join(repo, "untracked"));
  writeFileSync(join(repo, "untracked", "data"), "one");
  const untrackedStatus = git("status", "--porcelain"), before = repoIdentity(repo).dirtyDigest;
  writeFileSync(join(repo, "untracked", "data"), "two");
  t.assertions.assert(git("status", "--porcelain") === untrackedStatus, "untracked fixture changed status");
  t.assertions.assert(repoIdentity(repo).dirtyDigest !== before, "different untracked content retained the same identity");
});
