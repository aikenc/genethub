import { writeFileSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.authorization.confined-pty-or-refused",
    title: "A paired terminal retains the OS account filesystem capability",
    oracle:
      "paired and local terminals open; the paired terminal reads a known sibling file",
    catches: ["remote pty is an unconstrained login shell", "isolation failure reported as forbidden"],
    tags: ["core", "authorization", "parity"],
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 40_000,
    timeoutMs: 120_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const narrow = await t.flows.main.pairDevice(opened.client, opened.daemon);
    const chunks: string[] = [];
    const stop = narrow.client.onPty((_ptyId, data) => {
      if (data) chunks.push(data);
    });
    try {
      const pty = await narrow.client.call({type:"pty.open",payload:{workspaceId:opened.workspaceId,cols:80,rows:24}});
      t.assertions.assert(pty?.type === "pty", "complete device could not open PTY");
      const ptyId = pty?.type === "pty" ? pty.data.ptyId : "";
      const outside = path.join(path.dirname(opened.workspaceRoot), "outside-the-workspace.txt");
      writeFileSync(outside, "OS-ACCOUNT-RESOURCE");
      await narrow.client.call({type:"pty.write",payload:{ptyId,data:`cat '${outside}'; echo full-$((6*7))\n`}});
      await t.tools.waitUntil(() => chunks.join("").includes("OS-ACCOUNT-RESOURCE") && chunks.join("").includes("full-42"),20_000);
      await narrow.client.call({type:"pty.close",payload:{ptyId}});
      const whole = await t.flows.main.pairDevice(opened.client, opened.daemon);
      try {
        const unconfined = await whole.client.call({
          type: "pty.open",
          payload: { workspaceId: opened.workspaceId, cols: 80, rows: 24 },
        });
        t.assertions.assert(unconfined?.type === "pty", "an unconfined terminal is still allowed to those who hold it");
      } finally {
        whole.client.close();
      }

      const local = await opened.client.call({
        type: "pty.open",
        payload: { workspaceId: opened.workspaceId, cols: 80, rows: 24 },
      });
      t.assertions.assert(local?.type === "pty", "the local user opens a terminal");
    } finally {
      stop();
      narrow.client.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
