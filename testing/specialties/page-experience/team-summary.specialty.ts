import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage, createLease, releaseLease } from "../../framework/public.ts";

for (const width of [390, 1280]) defineSpecialty({
  id: `specialty.page-experience.team-summary.${width}`,
  title: `Unified machine filter and source-safe conversation navigation at ${width}px`,
  oracle: "The actual Workbench defaults to all machines, filters without dialing or replacing the active view, opens a remote conversation, returns through the shared directory, and retains responsive layout without a machine switcher or overview dialog",
  catches: ["filter changes the execution target", "remote selection opens the wrong source", "directory disappears on navigation", "mobile filter causes horizontal overflow"],
  tags: ["team-summary", "machine-connections", "page-experience"], runner: "playwright", llm: { default: "mock" },
  resources: { environments: 1, cpu: 3, memoryMb: 3072, io: 1, browser: 1, pool: "browser" }, expectedDurationMs: 80_000, timeoutMs: 180_000,
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
    const entries = [a,b].map((o,i) => ({ id: o.client.identity!.machineId, deviceHandle: o.client.identity!.machineId,
      label: i===0 ? "机器甲" : "机器乙 · 4090-工作站-远程开发与创作环境-很长的机器名称用于检查省略与换行", kind: "remote" as const, online: true }));
    let directoryReads=0;
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(a.daemon), a.workspaceId, first,
      { viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 }, { trace: false },
      { targets: () => {directoryReads++; return entries;}, endpoint: id => daemonEndpoint(id === entries[0]!.id ? a.daemon : b!.daemon) });
    const page = browser.page;
    await page.getByRole("heading", { name: "甲机器专属会话", exact: true }).waitFor();
    let extraSockets = 0;
    page.on("websocket", () => { extraSockets++; });
    await page.getByRole("button", { name: /乙机器专属会话/, includeHidden: true }).waitFor({ state: "attached" });
    const socketsBeforePreview = extraSockets;
    await page.getByRole("link", { name: "远端产物", exact: true }).click();
    await page.getByRole("heading", { name: "Remote artifact on machine B", exact: true }).waitFor();
    t.assertions.assert(extraSockets === socketsBeforePreview, "cross-machine preview opened a duplicate machine connection");
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    if (width < 768) await page.getByRole("button", { name: "会话列表", exact: true }).click();
    const list = page.getByRole("complementary", { name: "会话列表", exact: true });
    const machines = list.getByRole("button", { name: "机器筛选", exact: true });
    t.assertions.assert(await machines.innerText() === "全部机器", "default compact label was not all machines");
    await machines.click();
    const machineMenu=list.getByRole("menu",{name:"机器筛选",exact:true});
    await machineMenu.getByRole("menuitemradio",{name:/全部机器.*2\/2 在线/,checked:true}).waitFor();
    t.assertions.assert((await machineMenu.getByRole("menuitemradio").allTextContents()).filter(text=>text.includes("在线 ·")).length===2,"machine rows omitted current state/version");
    const popupBox=await machineMenu.boundingBox(), listBox=await list.boundingBox();
    t.assertions.assert(Boolean(popupBox&&listBox&&popupBox.x>=listBox.x&&popupBox.x+popupBox.width<=listBox.x+listBox.width),"machine menu escaped the list width");
    await page.keyboard.press("Escape");
    t.assertions.assert(await machines.evaluate(e=>e===document.activeElement),"Escape did not return focus to the machine filter");
    await list.getByRole("button", { name: /甲机器项目/ }).waitFor();
    await list.getByRole("button", { name: /乙机器项目/ }).waitFor();
    if(width>=700){
      await page.evaluate(()=>{
        const failures:string[]=[];
        const observer=new MutationObserver(()=>{
          const rows=document.querySelectorAll('[aria-label="会话列表"] .conversation-row button');
          for(const button of rows) if((button as HTMLButtonElement).disabled||Number(getComputedStyle(button).opacity)<0.99) failures.push("navigation greyed/disabled another row");
        });
        observer.observe(document.body,{subtree:true,childList:true,attributes:true});
        Object.assign(window,{navigationCheck:{failures,observer}});
        const rows=[...document.querySelectorAll<HTMLButtonElement>('[aria-label="会话列表"] .conversation-row button')];
        rows.find(b=>b.textContent?.includes("乙机器专属会话"))!.click();
        rows.find(b=>b.textContent?.includes("甲机器专属会话"))!.click();
      });
      await page.waitForTimeout(200);
      await page.getByRole("heading",{name:"甲机器专属会话",exact:true}).waitFor();
      const navigationFailures=await page.evaluate(()=>{const v=(window as unknown as {navigationCheck:{failures:string[];observer:MutationObserver}}).navigationCheck;v.observer.disconnect();return v.failures;});
      t.assertions.assert(navigationFailures.length===0,"conversation navigation greyed/disabled the list");
    }
    await machines.press("ArrowDown"); await page.keyboard.press("End"); await page.keyboard.press("Enter");
    t.assertions.assert(await machines.innerText()===entries[1]!.label,"keyboard selection did not select the long machine name");
    const selectedGeometry=await machines.evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));
    t.assertions.assert(selectedGeometry.scroll<=selectedGeometry.width,"selected long name overflowed the compact filter");
    t.assertions.assert(await list.getByRole("button", { name: /甲机器项目/ }).count() === 0, "machine filter left another source visible");
    t.assertions.assert(await page.getByRole("heading", { name: "甲机器专属会话", exact: true, includeHidden: true }).count() === 1, "filter changed the active conversation");
    await list.getByRole("button", { name: /乙机器专属会话/ }).click();
    await page.getByRole("heading", { name: "乙机器专属会话", exact: true }).waitFor();
    const legacy = `/d/${entries[1]!.id}/w/${b.workspaceId}/s/${second}`;
    const compact = `/m-${entries[1]!.id.slice(2,10)}/w-${b.workspaceId.slice(2,10)}/s-${second.slice(2,10)}`;
    await page.waitForURL(url => url.pathname === legacy || url.pathname === compact);
    if (width < 768) await page.getByRole("button", { name: "会话列表", exact: true }).click();
    await machines.click(); await machineMenu.getByRole("menuitemradio",{name:/^全部机器/}).click();
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
    await page.getByRole("navigation",{name:"工作台导航",exact:true}).getByRole("button",{name:"项目",exact:true}).click();
    const projects=page.getByRole("complementary",{name:"项目列表面板",exact:true});
    await projects.getByRole("region",{name:"项目 乙机器项目",exact:true}).waitFor();
    await page.evaluate(()=>{
      const failures:string[]=[];
      const observer=new MutationObserver(()=>{
        for(const region of document.querySelectorAll('[aria-label="项目列表面板"] section')){
          if(region.querySelector(".text-danger")) failures.push("red flash");
          if(region.querySelector("button:disabled")) failures.push("temporarily disabled project");
          if(/同步中|待同步|项目状态尚未完整读取/.test(region.textContent??"")) failures.push("refresh replaced confirmed state");
        }
      });
      observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
      Object.assign(window,{feedbackRefresh:{failures,observer}});
    });
    const manualRefresh=async()=>{
      const before=directoryReads;
      await projects.getByRole("button",{name:"列表选项",exact:true}).click();
      await projects.getByRole("menuitem",{name:"刷新列表",exact:true}).click();
      await t.tools.waitUntil(()=>directoryReads>before,5_000);
      await projects.getByRole("button",{name:"列表选项",exact:true}).click();
      await t.tools.waitUntil(async()=>await projects.getByRole("menuitem",{name:"刷新列表",exact:true}).isEnabled(),15_000);
      await projects.getByRole("button",{name:"关闭列表选项",exact:true}).click();
    };
    await manualRefresh(); await manualRefresh();
    const beforeTimer=directoryReads;
    await t.tools.waitUntil(()=>directoryReads>beforeTimer,35_000);
    // Wait until the real periodic refresh completes, not just its directory lookup.
    await projects.getByRole("button",{name:"列表选项",exact:true}).click();
    await t.tools.waitUntil(async()=>await projects.getByRole("menuitem",{name:"刷新列表",exact:true}).isEnabled(),15_000);
    await projects.getByRole("button",{name:"关闭列表选项",exact:true}).click();
    const refreshFailures=await page.evaluate(()=>{const check=(window as unknown as {feedbackRefresh:{failures:string[];observer:MutationObserver}}).feedbackRefresh;check.observer.disconnect();return check.failures;});
    t.assertions.assert(refreshFailures.length===0,`normal manual/timer refresh changed project status: ${refreshFailures.slice(0,5).join(", ")}`);
    const snapshot = await b.client.call({ type: "session.get", payload: { sessionId: second } });
    t.assertions.assert(snapshot?.type === "snapshot" && snapshot.data.summary.title === "乙机器专属会话", "remote source was mutated by navigation");
    t.note(JSON.stringify({ width, sources: 2, filterPreservedActive: true, sourceSafeNavigation: true, geometry, selectedGeometry, directoryReads, manualAndTimerRefreshNoFlash:true }));
  } catch (error) {
    if (browser) t.note(`UI failure: ${await browser.page.locator("body").innerText().then(text=>text.slice(-5000)).catch(()=>"unavailable")}`);
    throw error;
  } finally {
    await browser?.close();
    for (const opened of [a,b]) if (opened) { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
    releaseLease(otherLease);
  }
});
