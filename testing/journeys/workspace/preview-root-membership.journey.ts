import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AssetPreviewError_ } from "@genehub/web/client";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.workspace.preview-root-membership",
    title: "Preview accepts only root handles owned by its workspace",
    oracle: "member-qualified preview succeeds; rootless and foreign-root locators are 403",
    catches: ["single-root fallback bypasses membership", "foreign root substitutes local bytes"],
    tags: ["core", "workspace", "filesystem", "authorization", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    writeFileSync(path.join(t.env.workspace, "guide.txt"), "member bytes");
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const member = await opened.client.preview(
        opened.workspaceId,
        `${opened.rootHandle}/guide.txt`,
      );
      t.assertions.assert(
        new TextDecoder().decode(member.bytes) === "member bytes",
        "member-qualified preview returned the wrong bytes",
      );

      const foreignRoot = path.join(t.env.root, "foreign-workspace");
      mkdirSync(foreignRoot, { recursive: true });
      writeFileSync(path.join(foreignRoot, "guide.txt"), "foreign bytes");
      const foreign = await opened.client.call({
        type: "workspace.open",
        payload: { root: foreignRoot },
      });
      t.assertions.assert(foreign?.type === "workspace", `unexpected ${foreign?.type}`);
      if (foreign?.type !== "workspace") throw new Error("foreign workspace.open failed");
      const foreignHandle = foreign.data.folders[0]?.rootHandle;
      t.assertions.assert(Boolean(foreignHandle), "foreign workspace has no rootHandle");
      if (!foreignHandle) throw new Error("foreign workspace has no rootHandle");

      mkdirSync(path.join(opened.workspaceRoot, foreignHandle), { recursive: true });
      writeFileSync(
        path.join(opened.workspaceRoot, foreignHandle, "guide.txt"),
        "decoy bytes",
      );

      for (const locator of ["guide.txt", `${foreignHandle}/guide.txt`]) {
        try {
          await opened.client.preview(opened.workspaceId, locator);
          t.assertions.assert(false, `preview accepted non-member locator ${locator}`);
        } catch (error) {
          t.assertions.assert(
            error instanceof AssetPreviewError_,
            `preview failed as ${String(error)}`,
          );
          if (!(error instanceof AssetPreviewError_)) throw error;
          t.assertions.assert(
            error.status === 403,
            `preview accepted or misclassified ${locator}: ${error.status}`,
          );
        }
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
