import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { BlockedError, daemonEndpoint, defineSpecialty, openPreviewBrowser } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.preview.image-page-representations",
    title: "Real browser shows a 1024 image first and fetches original only after a click",
    oracle: "Image natural width is 1024 before the explicit action and 2048 after it",
    catches: ["floating preview silently downloads original", "original action does not load full pixels", "browser cannot decode derived image"],
    tags: ["preview", "image", "page-experience"],
    runner: "playwright",
    llm: { default: "none" },
    expectedDurationMs: 15000,
    timeoutMs: 60000,
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 1, pool: "browser" },
    surfaces: ["browser", "daemon", "host", "workbench-client"],
    productInterfaces: ["@genehub/workbench"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  },
  async (t) => {
    if (!t.browser) throw new BlockedError("real browser required");
    const page = await t.browser.newPage();
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 2048;
      canvas.height = 1024;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas unavailable");
      context.fillStyle = "#86ad46";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    writeFileSync(join(t.env.workspace, "landscape.png"), Buffer.from(base64, "base64"));
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let consumer: Awaited<ReturnType<typeof openPreviewBrowser>> | null = null;
    try {
      consumer = await openPreviewBrowser({
        openRoot: t.openRoot,
        lease: t.env,
        page,
        endpoint: daemonEndpoint(opened.daemon),
        refreshEndpoint: () => daemonEndpoint(opened.daemon),
        workspaceId: opened.workspaceId,
        entryPath: `${opened.rootHandle}/landscape.png`,
      });
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('img[alt="预览"]');
        return image?.naturalWidth === 1024;
      }, null, { timeout: 30000 });
      const before = await page.locator('img[alt="预览"]').evaluate((image) => (image as HTMLImageElement).naturalWidth);
      t.assertions.assert(before === 1024, `initial pixels: ${before}`);
      await page.getByRole("button", { name: "查看原图" }).click();
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('img[alt="预览"]');
        return image?.naturalWidth === 2048;
      }, null, { timeout: 30000 });
      const after = await page.locator('img[alt="预览"]').evaluate((image) => (image as HTMLImageElement).naturalWidth);
      t.assertions.assert(after === 2048, `original pixels: ${after}`);
      t.assertions.assert(consumer.errors.length === 0, `browser errors: ${consumer.errors.join(";")}`);
    } finally {
      await page.close();
      await consumer?.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
