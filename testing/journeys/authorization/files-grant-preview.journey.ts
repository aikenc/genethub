import { writeFileSync } from "node:fs";
import path from "node:path";

import { AssetPreviewError_ } from "@genehub/workbench/client";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.authorization.files-grant-preview",
    title: "A device without a files grant cannot take the bytes by another door",
    oracle: "asset.preview is 403 without files; 200 with read+files",
    catches: ["files grant only gates RPC"],
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
    const narrow = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "narrow");
    try {
      try {
        await narrow.client.preview(opened.workspaceId, asset);
        t.assertions.assert(false, "read alone bought the file bytes");
      } catch (error) {
        t.assertions.assert(error instanceof AssetPreviewError_, `preview failed as ${String(error)}`);
        if (!(error instanceof AssetPreviewError_)) throw error;
        t.assertions.assert(error.status === 403, `read alone bought the file bytes: ${error.status}`);
      }
    } finally {
      narrow.client.close();
    }
    const allowed = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "files"], "allowed");
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
