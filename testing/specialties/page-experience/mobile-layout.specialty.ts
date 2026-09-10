import path from "node:path";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.mobile-layout",
  title: "Shared list filters and viewport remain usable across narrow widths and UI scale",
  oracle: "Real list filters keep whole labels, every option remains clickable, trailing actions do not overlap text, and the shell reaches the viewport bottom after resize",
  catches: ["Chinese filter wraps", "fixed actions cover filters", "root height leaves a bottom gap", "expert filters diverge from session filters"],
  retention: true,
  tags: ["page-experience", "mobile-layout"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 45_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui"], productInterfaces: ["@genehub/workbench", "workspace.rename", "session.create"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await opened.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: "很长的专家名称用于检查列表布局" } });
    const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, session);
    const page = browser.page;
    await page.getByRole("button", { name: "当前专家", exact: true }).waitFor();
    const nav = page.getByRole("navigation", { name: "工作台导航" });
    await nav.getByRole("button", { name: "会话", exact: true }).click();
    const checkFilters = async (label: string) => {
      const bar = page.getByLabel(label, { exact: true });
      for (const text of ["全部", "进行中", "待你处理", "异常／受阻", "未读"]) {
        const button = bar.getByRole("button", { name: text, exact: true });
        // Browser scrolls the real overflow strip to reach each option.
        await button.click();
        t.assertions.assert(await button.getAttribute("aria-pressed") === "true", `filter ${text} was not selected`);
        const fits = await button.evaluate(node => {
          const style = getComputedStyle(node);
          const range = document.createRange(); range.selectNodeContents(node);
          return style.whiteSpace === "nowrap" && range.getBoundingClientRect().width <= node.getBoundingClientRect().width;
        });
        t.assertions.assert(fits, `filter ${text} wraps or clips`);
      }
      await bar.getByRole("button", { name: "全部", exact: true }).click();
    };
    for (const width of [320, 375, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await checkFilters("会话状态工具栏");
      const geometry = await page.evaluate(() => ({ bottom: document.querySelector(".genehub-ui")!.getBoundingClientRect().bottom, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }));
      t.assertions.assert(Math.abs(geometry.bottom - geometry.height) < 2 && !geometry.overflow, `shell geometry at ${width}: ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: path.join(process.env.TESTCTL_BROWSER_ARTIFACTS!, `layout-${width}.png`) });
      t.note(`Chromium viewport ${width}: ${JSON.stringify(geometry)}; not iPhone PWA validation`);
    }
    await nav.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "系统设置", exact: true }).click();
    await page.getByRole("radiogroup", { name: "界面大小" }).getByRole("radio", { name: "特大", exact: true }).click();
    await nav.getByRole("button", { name: "会话", exact: true }).click();
    await page.setViewportSize({ width: 320, height: 844 });
    await checkFilters("会话状态工具栏");
    const scaled = await page.evaluate(() => ({ bottom: document.querySelector(".genehub-ui")!.getBoundingClientRect().bottom, height: innerHeight }));
    t.assertions.assert(Math.abs(scaled.bottom - scaled.height) < 2, `scaled shell geometry: ${JSON.stringify(scaled)}`);
    await page.getByRole("button", { name: "会话筛选", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const bounds = await dialog.boundingBox();
    t.assertions.assert(!!bounds && bounds.y >= 0 && bounds.y + bounds.height <= 844, "scaled dialog leaves visible viewport");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await nav.getByRole("button", { name: "专家", exact: true }).click();
    await page.getByRole("button", { name: "很长的专家名称用于检查列表布局", exact: true }).click();
    await page.setViewportSize({ width: 320, height: 844 });
    await checkFilters("当前专家会话状态");
    const destinations = page.getByRole("navigation", { name: "专家页签" });
    for (const text of ["会话", "组件", "目录", "小队"]) {
      const button = destinations.getByRole("button", { name: text, exact: true });
      await button.scrollIntoViewIfNeeded();
      t.assertions.assert(await button.evaluate(node => getComputedStyle(node).whiteSpace === "nowrap"), `expert destination ${text} wraps`);
    }
    await destinations.getByRole("button", { name: "会话", exact: true }).click();
    await page.screenshot({ path: path.join(process.env.TESTCTL_BROWSER_ARTIFACTS!, "expert-320-xlarge.png") });
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
