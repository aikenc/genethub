import path from "node:path";
import { existsSync } from "node:fs";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

for (const width of [390, 1280]) defineSpecialty({
  id: `specialty.page-experience.session-header.${width}`,
  title: `Session identity, expert creation and settings logs at ${width}px`,
  oracle: "A browser rename persists in the daemon, avatar navigation returns to its session, creation starts in the current expert directory, and a missing-session error is available only in settings logs",
  catches: ["expert name displaces session title", "avatar opens wrong expert", "new expert starts in unrelated directory", "global error banner returns", "errors disappear instead of reaching logs"],
  tags: ["page-experience", "session-header"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 40_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon"],
  productInterfaces: ["@genehub/workbench", "session.rename", "session.get", "workspace.open", "directory.mkdir"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await opened.client.call({type: "session.rename", payload: {sessionId: id, title: "会话标题验收"}});
    await opened.client.call({type: "workspace.rename", payload: {workspaceId: opened.workspaceId, name: "当前验收专家"}});
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, id, { hasTouch: width < 768, isMobile: width < 768, viewport: { width, height: 844 } });
    const page = browser.page;
    await page.setViewportSize({width, height: 844});
    await page.getByRole("heading", {name: "会话标题验收", exact: true}).waitFor();
    const geometry = await page.getByRole("button", {name: "修改会话标题", exact: true}).evaluate(title => {
      const expert = document.querySelector('[aria-label="当前专家"]')!;
      const header = title.closest("header")!;
      return { titleFont: parseFloat(getComputedStyle(title).fontSize), expertFont: parseFloat(getComputedStyle(expert).fontSize),
        height: header.getBoundingClientRect().height - parseFloat(getComputedStyle(header).paddingTop),
        gap: expert.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
        touch: matchMedia("(pointer: coarse)").matches };
    });
    t.assertions.assert(width >= 768 || geometry.touch, "phone did not exercise coarse-pointer styles");
    t.assertions.assert(geometry.titleFont === 14 && geometry.expertFont === 12, `header typography: ${JSON.stringify(geometry)}`);
    t.assertions.assert(geometry.height <= 56 && geometry.gap >= 0 && geometry.gap <= 2, `header spacing: ${JSON.stringify(geometry)}`);
    t.note(`header geometry ${JSON.stringify(geometry)}`);
    await page.getByRole("button", {name: "修改会话标题", exact: true}).click();
    const dialog = page.getByRole("dialog", {name: "修改会话标题", exact: true});
    await dialog.getByRole("textbox", {name: "会话标题", exact: true}).fill("修改后的会话标题");
    await dialog.getByRole("textbox").press("Enter");
    await dialog.waitFor({state: "hidden"});
    const saved = await opened.client.call({type: "session.get", payload: {sessionId: id}});
    t.assertions.assert(saved?.type === "snapshot" && saved.data.summary.title === "修改后的会话标题", "header rename did not persist");
    await page.getByRole("heading", {name: "修改后的会话标题", exact: true}).waitFor();
    await page.getByRole("button", {name: "当前专家", exact: true}).click();
    const expert = page.getByRole("region", {name: "专家页面", exact: true});
    await expert.getByRole("heading", {name: "当前验收专家", exact: true}).waitFor();
    await expert.getByRole("button", {name: "返回", exact: true}).click();
    await page.getByRole("heading", {name: "修改后的会话标题", exact: true}).waitFor();
    await page.getByRole("button", {name: "当前专家", exact: true}).click();
    await expert.getByRole("button", {name: "切换专家", exact: true}).click();
    await page.getByRole("button", {name: "新建专家", exact: true}).click();
    const workspace = await opened.client.call({type: "workspace.list"});
    if (workspace?.type !== "workspaces") throw new Error("workspace list unavailable");
    const root = workspace.data.find(w => w.id === opened.workspaceId)!.root;
    await page.getByText(root, {exact: true}).waitFor();
    await page.getByRole("button", {name: "新建文件夹", exact: true}).click();
    await page.getByRole("textbox", {name: "新文件夹名称", exact: true}).fill("child-expert");
    await page.getByRole("button", {name: "创建", exact: true}).click();
    await page.getByRole("button", {name: "child-expert", exact: true}).click();
    await page.getByText(path.join(root, "child-expert"), {exact: true}).waitFor();
    await page.getByRole("button", {name: "添加此专家", exact: true}).click();
    await page.getByRole("heading", {name: "child-expert", exact: true}).waitFor();
    t.assertions.assert(existsSync(path.join(root, "child-expert")), "creation did not use the current expert directory");

    const missing = new URL(page.url());
    missing.pathname = `/d/${encodeURIComponent(daemonEndpoint(opened.daemon).localServerProof.machineId)}/w/${encodeURIComponent(opened.workspaceId)}/s/s_missing_header_check`;
    await page.goto(missing.href);
    await page.getByRole("heading", {name: "修改后的会话标题", exact: true}).waitFor();
    t.assertions.assert(await page.getByText("这个会话已经不在了。", {exact: true}).count() === 0, "missing-session error appeared outside settings logs");
    if (width < 768) await page.getByRole("button", {name: "会话列表", exact: true}).click();
    const nav = page.getByRole("navigation", {name: "工作台导航"});
    await nav.getByRole("button", {name: "设置", exact: true}).click();
    await page.getByRole("button", {name: "日志", exact: true}).click();
    const logs = page.getByRole("region", {name: "界面日志", exact: true});
    await logs.locator("li").first().waitFor();
    t.assertions.assert(await page.locator("main > [role=alert]").count() === 0, "global error still covers the main UI");
    await logs.getByRole("button", {name: "清空界面日志", exact: true}).click();
    await logs.getByText("暂无界面日志。", {exact: true}).waitFor();
    t.assertions.assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page overflows the viewport");
    t.note(`width=${width}; real rename, expert navigation, directory creation and error log verified`);
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
