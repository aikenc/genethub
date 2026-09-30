import { writeFile } from "node:fs/promises";
import path from "node:path";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.preview-annotation",
  title: "File Preview shares one toolbar and keeps native scrolling after HTML annotation selection",
  oracle: "Real session file links open MD/HTML; toolbar buttons align without overlap at 320/430px, menu actions remain available, real wheel/touch scroll moves the selected element and notes save through the daemon",
  catches: ["annotation controls cover document", "multiple toolbar rows", "transparent layer cancels native pan", "selection stays fixed while document scrolls", "offscreen note pins to top", "annotation tap activates HTML button"],
  tags: ["page-experience", "preview-annotation"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 30_000, timeoutMs: 120_000, retention: true,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "asset-preview"],
  productInterfaces: ["@genehub/workbench", "session.previewAnnotations.get"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  const paragraphs = Array.from({ length: 20 }, (_, n) => `<p id="paragraph-${n}" style="margin:24px 0;min-height:100px">Section ${n}: content for scrolling and annotation.</p>`).join("");
  await writeFile(path.join(t.env.workspace, "review.html"), `<!doctype html><html><head><title>Review</title></head><body style="margin:24px"><button id="action" onclick="this.textContent='Activated'">Action</button>${paragraphs}</body></html>`);
  await writeFile(path.join(t.env.workspace, "review.md"), "# Review notes\n\nFirst paragraph.\n\n" + Array.from({ length: 20 }, (_, n) => `## Section ${n}\n\nContent for scrolling.\n`).join("\n"));
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await opened.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: "Preview regression" } });
    const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    opened.mock.script({ text: "[review.md](review.md) · [review.html](review.html)" });
    await t.flows.main.sendPrompt(opened.client, session, "Show the two review files.");
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, session, { viewport: { width: 430, height: 775 }, hasTouch: true, isMobile: true });
    const page = browser.page;
    const openFile = async (name: string) => {
      await page.getByRole("link", { name, exact: true }).click();
      await page.getByRole("dialog", { name: "文件预览", exact: true }).waitFor();
      await page.getByRole("button", { name: "进入批注", exact: true }).waitFor();
    };
    const checkRow = async () => {
      const header = page.getByLabel("预览工具栏", { exact: true });
      const boxes = await header.locator("button:visible, summary:visible").evaluateAll(nodes => nodes.map(node => {
        const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
      }));
      t.assertions.assert(boxes.length >= 4 && Math.max(...boxes.map(b => b.y + b.height / 2)) - Math.min(...boxes.map(b => b.y + b.height / 2)) < 3, `Preview controls are not on one row: ${JSON.stringify(boxes)}`);
      for (const [i, box] of boxes.entries()) for (const other of boxes.slice(i + 1))
        t.assertions.assert(box.x + box.width <= other.x + 1 || other.x + other.width <= box.x + 1, "Preview controls overlap");
      const geometry = await header.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, height: node.getBoundingClientRect().height }));
      t.assertions.assert(geometry.scrollWidth <= geometry.width + 1 && geometry.height < 50, `toolbar geometry: ${JSON.stringify(geometry)}`);
    };
    await openFile("review.md");
    for (const width of [320, 430]) { await page.setViewportSize({ width, height: 775 }); await checkRow(); }
    const heading = page.getByRole("heading", { name: "Review notes", exact: true });
    const header = await page.getByLabel("预览工具栏", { exact: true }).boundingBox();
    t.assertions.assert((await heading.boundingBox())!.y >= header!.y + header!.height, "MD controls cover the heading");
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await openFile("review.html");
    const frame = page.frameLocator('iframe[title="HTML 文件预览"]');
    await frame.locator("#paragraph-0").waitFor();
    for (const width of [320, 430]) { await page.setViewportSize({ width, height: 775 }); await checkRow(); }
    t.assertions.assert(!(await page.getByRole("button", { name: "截图", exact: true }).isVisible()), "low frequency action remains on toolbar");
    await page.getByLabel("更多预览操作", { exact: true }).click();
    for (const name of ["截图", "录制", "保存运行产物", "重新检查服务"])
      t.assertions.assert(await page.getByRole("button", { name, exact: true }).isVisible(), `menu omitted ${name}`);
    await page.keyboard.press("Escape");
    t.assertions.assert(await page.getByRole("dialog", { name: "文件预览", exact: true }).isVisible(), "Escape from menu minimized Preview");
    await page.getByRole("button", { name: "进入批注", exact: true }).click();
    await frame.locator("#action").click();
    await page.getByRole("textbox", { name: "批注", exact: true }).waitFor();
    t.assertions.assert(await frame.locator("#action").innerText() === "Action", "annotation tap activated HTML application");
    await frame.locator("#paragraph-0").click();
    const selected = page.getByLabel("选中批注元素", { exact: true });
    await selected.waitFor();
    const before = await frame.locator("body").evaluate(() => scrollY);
    const box = (await frame.locator("#paragraph-0").boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 20);
    await page.mouse.wheel(0, 110);
    await t.tools.waitUntil(async () => (await frame.locator("body").evaluate(() => scrollY)) > before + 50, 5000);
    await t.tools.waitUntil(async () => {
      const top = await frame.locator("#paragraph-0").evaluate(node => node.getBoundingClientRect().top);
      return Math.abs(parseFloat(await selected.evaluate(node => (node as HTMLElement).style.top)) - top) < 2;
    }, 5000);
    // A browser touch gesture must move the document without becoming a new pick.
    const cdp = await browser.context.newCDPSession(page);
    const iframeBox = (await page.locator('iframe[title="HTML 文件预览"]').boundingBox())!;
    const touchY = iframeBox.y + Math.min(300, iframeBox.height / 2);
    const touchX = iframeBox.x + 90;
    const touchBefore = await frame.locator("body").evaluate(() => scrollY);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY }] });
    for (let n = 1; n <= 6; n++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchX, y: touchY - n * 22 }] });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await t.tools.waitUntil(async () => (await frame.locator("body").evaluate(() => scrollY)) > touchBefore + 50, 5000);
    await cdp.detach();
    await page.getByRole("textbox", { name: "批注", exact: true }).fill("Keep this section readable");
    await page.getByRole("button", { name: "加入草稿", exact: true }).click();
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "session.previewAnnotations.get", payload: { sessionId: session } });
      return reply?.type === "previewAnnotations" && reply.data.annotations.some(note => note.comment === "Keep this section readable" && note.target.kind === "htmlElement" && note.target.selector === "p#paragraph-0");
    }, 5000);
    t.assertions.assert(await page.getByRole("button", { name: "查看批注", exact: true }).count() === 0, "offscreen note stuck to viewport top");
    await page.getByRole("button", { name: "完成批注", exact: true }).click();
    await frame.locator("#action").click();
    t.assertions.assert(await frame.locator("#action").innerText() === "Activated", "browse mode did not restore HTML interaction");
    await page.screenshot({ path: path.join(process.env.TESTCTL_BROWSER_ARTIFACTS!, "preview-toolbar-430.png") });
    t.note("Real session MD/H5 links, 320/430px toolbar, menu, wheel/touch, moving selection, daemon note save and browse restore passed; Chromium, not real iPhone WebKit.");
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
