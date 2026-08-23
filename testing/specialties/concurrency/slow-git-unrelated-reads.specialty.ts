import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.concurrency.slow-git-unrelated-reads",
    title: "A slow git.status does not stall unrelated daemon reads",
    oracle: "workspace.list and file.tree return in under 500ms while git.status is still in a 900ms wrapper",
    catches: ["git Process::Run holds the daemon message loop"],
    tags: ["core", "concurrency", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const git = spawnSync("which", ["git"], { encoding: "utf8" });
    t.assertions.assert(git.status === 0, "git is not on PATH");
    const realGit = git.stdout.trim();
    const wrapperDir = path.join(t.env.root, "slow-bin");
    mkdirSync(wrapperDir, { recursive: true });
    const marker = path.join(wrapperDir, "git-started");
    writeFileSync(
      path.join(wrapperDir, "git"),
      `#!/bin/sh\n: > ${JSON.stringify(marker)}\nsleep 0.9\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(path.join(wrapperDir, "git"), 0o755);
    t.env.env.PATH = `${wrapperDir}${path.delimiter}${t.env.env.PATH ?? process.env.PATH ?? ""}`;

    const gitRoot = path.join(t.env.root, "git-canary");
    mkdirSync(gitRoot, { recursive: true });
    t.data.git.init(gitRoot);
    writeFileSync(path.join(gitRoot, "tracked.txt"), "content\n");

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const reader = await t.flows.main.openSecondClient(opened, "canary-git-read");
    try {
      const extra = await opened.client.call({ type: "workspace.open", payload: { root: gitRoot } });
      t.assertions.assert(extra?.type === "workspace", `workspace.open returned ${extra?.type}`);
      const workspaceId = extra?.type === "workspace" ? extra.data.id : "";
      const gitStatus = opened.client.call({ type: "git.status", payload: { workspaceId } });
      await t.tools.waitUntil(() => existsSync(marker), 10_000);
      const readStarted = Date.now();
      const listed = await reader.call({ type: "workspace.list" });
      const readMs = Date.now() - readStarted;
      const treeStarted = Date.now();
      const tree = await reader.call({
        type: "file.tree",
        payload: { workspaceId, path: null, depth: 1 },
      });
      const treeMs = Date.now() - treeStarted;
      t.assertions.assert(listed?.type === "workspaces", `workspace.list returned ${listed?.type}`);
      t.assertions.assert(tree?.type === "fileTree", `file.tree returned ${tree?.type}`);
      t.assertions.assert(readMs < 500, `unrelated read during slow git took ${readMs}ms`);
      t.assertions.assert(treeMs < 500, `unrelated file.tree during slow git took ${treeMs}ms`);
      const status = await gitStatus;
      t.assertions.assert(status?.type === "gitStatus", `git.status returned ${status?.type}`);
    } finally {
      reader.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
