import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage, createLease, releaseLease } from "../../framework/public.ts";

for (const width of [390, 1280]) defineSpecialty({
  id: `specialty.page-experience.team-summary.${width}`,
  title: `Unified machine filter and source-safe conversation navigation at ${width}px`,
  oracle: "The actual Workbench defaults to all machines, filters without dialing or replacing the active view, opens a remote conversation, returns through the shared directory, and retains responsive layout without a machine switcher or overview dialog",
  catches: ["filter changes the execution target", "remote selection opens the wrong source", "directory disappears on navigation", "mobile filter causes horizontal overflow"],
  tags: ["team-summary", "machine-connections", "page-experience"], runner: "playwright", llm: { default: "mock" },
  resources: { environments: 1, cpu: 3, memoryMb: 3072, io: 1, browser: 1, pool: "browser" }, expectedDurationMs: 40_000, timeoutMs: 180_000,
  surfaces: ["workbench-ui", "daemon"], productInterfaces: ["@genehub/workbench", "session.page", "workspace.list", "session.get"],
}, async t => {
  const otherLease = createLease("summary-ui-");
  const a = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let b: typeof a | undefined, browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    b = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: otherLease });
    const first = await t.flows.main.createBuiltinSession(a.client, a.workspaceId), second = await t.flows.main.createBuiltinSession(b.client, b.workspaceId);
    for (const [o, id, label] of [[a, first, "甲"], [b, second, "乙"]] as const) {
      await o.client.call({ type: "session.rename", payload: { sessionId: id, title: `${label}机器专属会话` } });
      await o.client.call({ type: "workspace.rename", payload: { workspaceId: o.workspaceId, name: `${label}机器项目` } });
    }
    const note = join(otherLease.workspace, "remote-artifact.md");
    await writeFile(note, "# Remote artifact on machine B\n\nSource-owned bytes.\n");
    await t.flows.main.configureMockProvider(a.client, a.mock);
    await t.flows.main.configureMockProvider(b.client, b.mock);
    a.mock.script({ respond: () => ({ text: `[远端产物](/assets/preview/v3/${b!.client.identity!.machineId}?path=${encodeURIComponent(note)})` }) });
    await t.flows.main.sendPrompt(a.client, first, "提供这次交付的产物。");
    await t.tools.waitUntil(async () => {
      const reply = await a.client.call({ type: "session.get", payload: { sessionId: first } });
      return reply?.type === "snapshot" && reply.data.summary.status === "idle" && reply.data.items.some(item => item.type === "assistantMessage");
    }, 15_000);
    const entries = [a,b].map((o,i) => ({ id: o.client.identity!.machineId, deviceHandle: o.client.identity!.machineId, label: `机器${i === 0 ? "甲" : "乙"}`, kind: "remote" as const, online: true }));
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(a.daemon), a.workspaceId, first,
      { viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 }, { trace: false },
      { targets: () => entries, endpoint: id => daemonEndpoint(id === entries[0]!.id ? a.daemon : b!.daemon) });
    const page = browser.page;
    await page.getByRole("heading", { name: "甲机器专属会话", exact: true }).waitFor();
    let extraSockets = 0;
    page.on("websocket", () => { extraSockets++; });
    await page.getByRole("combobox", { name: "机器筛选", exact: true, includeHidden: true }).getByRole("option", { name: /全部机器 · 2\/2 在线/, includeHidden: true }).waitFor({ state: "attached" });
    const socketsBeforePreview = extraSockets;
    await page.getByRole("link", { name: "远端产物", exact: true }).click();
    await page.getByRole("heading", { name: "Remote artifact on machine B", exact: true }).waitFor();
    t.assertions.assert(extraSockets === socketsBeforePreview, "cross-machine preview opened a duplicate machine connection");
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    if (width < 768) await page.getByRole("button", { name: "会话列表", exact: true }).click();
    const list = page.getByRole("complementary", { name: "会话列表", exact: true });
    const machines = list.getByRole("combobox", { name: "机器筛选", exact: true });
    await machines.getByRole("option", { name: /全部机器 · 2\/2 在线/ }).waitFor({ state: "attached" });
    t.assertions.assert(await machines.inputValue() === "", "default view was not all machines");
    await list.getByRole("button", { name: /甲机器项目/ }).waitFor();
    await list.getByRole("button", { name: /乙机器项目/ }).waitFor();
    await machines.selectOption(entries[1]!.id);
    t.assertions.assert(await list.getByRole("button", { name: /甲机器项目/ }).count() === 0, "machine filter left another source visible");
    t.assertions.assert(await page.getByRole("heading", { name: "甲机器专属会话", exact: true, includeHidden: true }).count() === 1, "filter changed the active conversation");
    await list.getByRole("button", { name: /乙机器专属会话/ }).click();
    await page.getByRole("heading", { name: "乙机器专属会话", exact: true }).waitFor();
    const legacy = `/d/${entries[1]!.id}/w/${b.workspaceId}/s/${second}`;
    const compact = `/m-${entries[1]!.id.slice(2,10)}/w-${b.workspaceId.slice(2,10)}/s-${second.slice(2,10)}`;
    await page.waitForURL(url => url.pathname === legacy || url.pathname === compact);
    if (width < 768) await page.getByRole("button", { name: "会话列表", exact: true }).click();
    await machines.selectOption("");
    await list.getByRole("button", { name: /甲机器专属会话/ }).click();
    await page.getByRole("heading", { name: "甲机器专属会话", exact: true }).waitFor();
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
    t.assertions.assert(geometry.scroll <= geometry.viewport, "unified list overflowed horizontally");
    if (width < 768) await page.getByRole("button", { name: "会话列表", exact: true }).click();
    await list.getByRole("button", { name: "新建会话", exact: true }).click();
    const draft = page.getByRole("region", { name: "项目页面", exact: true });
    await draft.waitFor();
    const draftInput = page.getByPlaceholder("描述任务…", {exact:true});
    await draftInput.fill("跨机器选择项目，保留尚未发送的目标");
    await page.locator('input[type="file"]').first().setInputFiles({name:"draft-retained.txt",mimeType:"text/plain",buffer:Buffer.from("Unsent browser-owned file")});
    await page.getByText("draft-retained.txt",{exact:true}).waitFor();
    await draft.getByRole("button", {name:/乙机器项目.*机器乙/}).click();
    await t.tools.waitUntil(async()=>await draftInput.inputValue()==="跨机器选择项目，保留尚未发送的目标",5_000);
    await page.getByText("draft-retained.txt",{exact:true}).waitFor();
    const afterDraft = await a.client.call({ type: "session.page", payload: { requests: [{workspaceId: a.workspaceId, limit: 100, cursor: null}], includeArchived: true } });
    t.assertions.assert(afterDraft?.type === "sessionPages" && afterDraft.data[0]?.sessions.length === 1, "opening a draft created a persisted session");
    if (width < 768) await page.getByRole("button", { name: "返回", exact: true }).first().click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    t.assertions.assert(await page.getByRole("button", { name: /切换机器/ }).count() === 0, "retired machine switcher is still exposed");
    const snapshot = await b.client.call({ type: "session.get", payload: { sessionId: second } });
    t.assertions.assert(snapshot?.type === "snapshot" && snapshot.data.summary.title === "乙机器专属会话", "remote source was mutated by navigation");
    t.note(JSON.stringify({ width, sources: 2, filterPreservedActive: true, sourceSafeNavigation: true, geometry }));
  } catch (error) {
    if (browser) t.note(`UI failure: ${await browser.page.locator("body").innerText().then(text=>text.slice(-5000)).catch(()=>"unavailable")}`);
    throw error;
  } finally {
    await browser?.close();
    for (const opened of [a,b]) if (opened) { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
    releaseLease(otherLease);
  }
});
