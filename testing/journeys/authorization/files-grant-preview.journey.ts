import { writeFileSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.authorization.files-grant-preview",
    title: "A complete paired device reads the exact preview bytes",
    oracle: "paired preview returns the same bytes as the workspace file",
    catches: ["full paired preview loses or changes file bytes"],
    tags: ["core", "authorization", "parity"],
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    writeFileSync(path.join(t.env.workspace, "secret.txt"), "the bytes");
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const asset = `${opened.rootHandle}/secret.txt`;
    const allowed = await t.flows.main.pairDevice(opened.client, opened.daemon, "allowed");
    try {
      const ok = await allowed.client.preview(opened.workspaceId, asset);
      t.assertions.assert(
        new TextDecoder().decode(ok.bytes) === "the bytes",
        "files was granted and still refused the bytes",
      );
    } finally {
      allowed.client.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
