import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  defineSpecialty,
  genetEnv,
  locateGenet,
  runGenet,
} from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.filesystem.saved-workspace-add-root",
    title:
      "A saved Agent gains a directory without changing its identity or existing roots",
    oracle:
      "The public addRoot reply, saved workspace file and file.tree agree; duplicate/invalid requests leave membership unchanged and reopening retains handles",
    catches: [
      "workspace identity replaced",
      "existing settings lost",
      "duplicate root added",
      "failed addition corrupts saved workspace",
      "root handle changes on reopen",
    ],
    tags: ["core", "filesystem", "workspace-roots"],
    llm: { default: "none" },
    expectedDurationMs: 15000,
    timeoutMs: 90000,
    resources: {
      environments: 1,
      cpu: 1,
      memoryMb: 512,
      io: 1,
      browser: 0,
      pool: "standard",
    },
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["workspace.addRoot", "workspace.open", "file.tree"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({
      openRoot: t.openRoot,
      lease: t.env,
    });
    try {
      const first = path.join(opened.workspaceRoot, "first"),
        second = path.join(opened.workspaceRoot, "second");
      mkdirSync(first);
      mkdirSync(second);
      writeFileSync(path.join(second, "proof.txt"), "added-root");
      const source = path.join(opened.workspaceRoot, "saved.code-workspace");
      writeFileSync(
        source,
        '{ // user settings\n "folders": [{"path":"first", "name":"Primary"}], "settings":{"editor.tabSize":7}, "extensions":{"recommendations":["example.tool"]}}',
      );
      const before = await opened.client.call({
        type: "workspace.open",
        payload: { root: source },
      });
      if (before?.type !== "workspace")
        throw new Error("open did not return saved workspace");
      const id = before.data.id,
        firstHandle = before.data.folders[0]!.rootHandle;
      const observer = await t.flows.main.pairDevice(
        opened.client,
        opened.daemon,
        ["read", "files"],
        "root-observer",
      );
      try {
        await t.assertions.expectProtocolCode(
          () =>
            observer.client.call({
              type: "workspace.addRoot",
              payload: { workspaceId: id, root: second },
            }),
          "forbidden",
        );
      } finally {
        observer.client.close();
      }
      const added = await opened.client.call({
        type: "workspace.addRoot",
        payload: { workspaceId: id, root: second },
      });
      if (added?.type !== "workspace")
        throw new Error("addRoot did not return workspace");
      t.assertions.assert(
        added.data.id === id &&
          added.data.folders.length === 2 &&
          added.data.folders[0]!.rootHandle === firstHandle,
        "identity/order changed",
      );
      const disk = JSON.parse(readFileSync(source, "utf8"));
      t.assertions.assert(
        disk.settings["editor.tabSize"] === 7 &&
          disk.extensions.recommendations[0] === "example.tool" &&
          disk.folders[0].name === "Primary",
        "unknown configuration fields lost",
      );
      const tree = await opened.client.call({
        type: "file.tree",
        payload: {
          workspaceId: id,
          path: added.data.folders[1]!.rootHandle,
          depth: 1,
        },
      });
      t.assertions.assert(
        tree?.type === "fileTree" && JSON.stringify(tree).includes("proof.txt"),
        "added root not accessible",
      );
      const committed = readFileSync(source, "utf8");
      await opened.client.call({
        type: "workspace.addRoot",
        payload: { workspaceId: id, root: second },
      });
      t.assertions.assert(
        readFileSync(source, "utf8") === committed,
        "duplicate addition changed file",
      );
      for (const [workspaceId, root] of [
        [id, path.join(second, "missing")],
        [id, path.join(second, "proof.txt")],
        [opened.workspaceId, second],
      ]) {
        let rejected = false;
        try {
          await opened.client.call({
            type: "workspace.addRoot",
            payload: { workspaceId: workspaceId!, root: root! },
          });
        } catch {
          rejected = true;
        }
        t.assertions.assert(
          rejected && readFileSync(source, "utf8") === committed,
          "invalid addition accepted or altered source",
        );
      }
      const restart = runGenet(
        locateGenet(t.openRoot),
        ["daemon", "restart"],
        genetEnv(t.openRoot, t.env.env),
      );
      t.assertions.assert(restart.code === 0, "daemon restart failed");
      const afterRestart = await t.flows.main.openSecondClient(
        opened,
        "root-restart",
      );
      const durable = await afterRestart.call({ type: "workspace.list" });
      t.assertions.assert(
        durable?.type === "workspaces" &&
          JSON.stringify(durable.data.find((w) => w.id === id)?.folders) ===
            JSON.stringify(added.data.folders),
        "restart lost directory membership",
      );
      afterRestart.close();
      const reopenedClient = await t.flows.main.openSecondClient(
        opened,
        "root-reopen",
      );
      const reopened = await reopenedClient.call({
        type: "workspace.open",
        payload: { root: source },
      });
      t.assertions.assert(
        reopened?.type === "workspace" &&
          reopened.data.id === id &&
          JSON.stringify(reopened.data.folders) ===
            JSON.stringify(added.data.folders),
        "reopening lost identity or handles",
      );
      reopenedClient.close();
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
