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
    await opened.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: "很长的项目名称用于检查列表布局" } });
    const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, session);
    const page = browser.page;
    await page.getByRole("button", { name: "当前项目", exact: true }).waitFor();
    const nav = page.getByRole("navigation", { name: "工作台导航" });
    await nav.getByRole("button", { name: "会话", exact: true }).click();
    const checkFilters = async (label: string) => {
      const bar = page.getByLabel(label, { exact: true });
      for (const text of ["全部", "进行中", "未读"]) {
        const button = bar.getByRole("button", { name: text, exact: true });
        // Browser scrolls the real overflow strip to reach each option.
        await button.click();
        t.assertions.assert(await button.getAttribute("aria-pressed") === "true", `filter ${text} was not selected`);
        const fits = await button.evaluate(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          const box=node.getBoundingClientRect(), text=range.getBoundingClientRect();
          const lines=[...range.getClientRects()];
          const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
          return new Set(lines.map(r=>Math.round(r.top))).size === 1 &&
            text.left>=box.left-1 && text.right<=box.right+1 && text.top>=box.top-1 && text.bottom<=box.bottom+1 &&
            Boolean(hit && node.contains(hit));
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
    const machineFilter=page.getByRole("complementary",{name:"会话列表",exact:true}).getByRole("button",{name:"机器筛选",exact:true});
    await machineFilter.click();
    const menu=page.getByRole("menu",{name:"机器筛选",exact:true});
    await menu.waitFor();
    const bounds=await menu.boundingBox();
    t.assertions.assert(!!bounds && bounds.x>=0 && bounds.x+bounds.width<=320 && bounds.y>=0 && bounds.y+bounds.height<=844,
      "scaled machine chooser leaves the visible viewport");
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});
    t.assertions.assert(await machineFilter.evaluate(e=>e===document.activeElement),"Escape did not restore machine-filter focus");
    await nav.getByRole("button", { name: "项目", exact: true }).click();
    await page.getByRole("button", { name: "打开项目 很长的项目名称用于检查列表布局", exact: true }).click();
    await page.setViewportSize({ width: 320, height: 844 });
    await checkFilters("当前项目会话状态");
    const destinations = page.getByRole("navigation", { name: "项目页签" });
    for (const text of ["会话", "组件", "目录", "小队"]) {
      const button = destinations.getByRole("button", { name: text, exact: true });
      await button.scrollIntoViewIfNeeded();
      t.assertions.assert(await button.evaluate(node => {const range=document.createRange();range.selectNodeContents(node);const text=range.getBoundingClientRect(),box=node.getBoundingClientRect();return new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size===1 && text.left>=box.left-1 && text.right<=box.right+1;}), `expert destination ${text} wraps`);
    }
    await destinations.getByRole("button", { name: "会话", exact: true }).click();
    await page.screenshot({ path: path.join(process.env.TESTCTL_BROWSER_ARTIFACTS!, "expert-320-xlarge.png") });
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
