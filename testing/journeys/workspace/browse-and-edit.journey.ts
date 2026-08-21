import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.workspace.browse-and-edit",
    title: "Files can be browsed and edited through the workspace",
    oracle: "file.tree shows src/ and file.write changes disk",
    catches: ["tree from memory", "write ignored"],
    tags: ["core", "workspace", "filesystem", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["genet-cli", "@genehub/web/client"],
  },
  async (t) => {
    mkdirSync(path.join(t.env.workspace, "src"), { recursive: true });
    writeFileSync(path.join(t.env.workspace, "src/main.rs"), "fn main() {}");
    writeFileSync(path.join(t.env.workspace, "README.md"), "# hi");
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const tree = await opened.client.call({
        type: "file.tree",
        payload: { workspaceId: opened.workspaceId, path: null, depth: 3 },
      });
      t.assertions.assert(tree?.type === "fileTree", `unexpected ${tree?.type}`);
      const children = tree?.type === "fileTree" ? tree.data.children ?? [] : [];
      t.assertions.assert(
        children.some((node) => node.name === "src" && node.isDir),
        "src directory missing from file.tree",
      );
      await opened.client.call({
        type: "file.write",
        payload: {
          workspaceId: opened.workspaceId,
          path: `${opened.rootHandle}/src/main.rs`,
          content: 'fn main() { println!("edited"); }',
        },
      });
      t.assertions.fileEquals(opened.workspaceRoot, "src/main.rs", 'fn main() { println!("edited"); }');
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
