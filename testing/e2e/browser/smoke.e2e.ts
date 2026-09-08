import { defineE2e, openBrowser } from "../../framework/public.ts";

defineE2e(
  {
    id: "e2e.browser.smoke",
    title: "Browser E2E is a distinct carrier, not a Node journey",
    oracle: "Playwright runner and browser resource are required",
    catches: ["Node client pretending to be a page"],
    tags: ["browser", "e2e"],
    runner: "playwright",
    resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 1, pool: "browser" },
    expectedDurationMs: 8_000,
    timeoutMs: 45_000,
    surfaces: ["browser"],
  },
  async (t) => {
    const browser = await openBrowser();
    try {
      await browser.page.goto("about:blank");
      await browser.page.evaluate(() => { document.body.textContent = "registered-e2e-body"; });
      t.assertions.assert(await browser.page.locator("body").textContent() === "registered-e2e-body", "registered browser body did not execute");
    } finally { await browser.close(); }
  },
);
