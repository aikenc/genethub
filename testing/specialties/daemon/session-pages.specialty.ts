import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionPageRequest } from "@genehub/proto";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

const shared = {
  tags: ["core", "session-pages", "session-read"], llm: { default: "none" as const },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "filesystem", "workbench-client"],
  productInterfaces: ["session.page", "session.list", "session.rename", "session.archive", "session.delete", "workspace.remove"],
};

defineSpecialty({ ...shared,
  id: "specialty.daemon.legacy-catalog-reconciliation",
  title: "Legacy readers reuse a bounded catalog without weakening strict pages or hiding writes",
  oracle: "With 1500 real external records a warm legacy read keeps its observed snapshot until reconciliation, strict pages still report corrupt metadata, records created next to a session this daemon just wrote reconcile within 12 seconds, an in-place edit by another process within the 30s cold period, and committed rename/delete appear immediately",
  catches: ["each sequential observer rescans all history", "tolerant legacy cache hides a strict page error", "cache never reconciles external writers", "committed mutation leaves cached stale history"],
  tags: ["core", "session-pages", "session-read", "catalog-pressure"],
  expectedDurationMs: 45_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 2, browser: 0, pool: "standard" },
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const seed = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    const home = join(o.workspaceRoot, ".genethub", "sessions");
    const model = JSON.parse(readFileSync(join(home, seed, "meta.json"), "utf8"));
    for (let i = 0; i < 1500; i++) {
      const id = `s_catalog_external_${i}`;
      mkdirSync(join(home, id));
      writeFileSync(join(home, id, "meta.json"), JSON.stringify({ ...model, id,
        title: `external ${i}`, titleLocked: true, updatedAtMs: Date.now() }));
    }
    const target = "s_catalog_external_0";
    const targetFile = join(home, target, "meta.json");
    const corrupt = join(home, "s_catalog_corrupt"); mkdirSync(corrupt);
    const corruptFile = join(corrupt, "meta.json"); writeFileSync(corruptFile, "{");
    const listed = async () => {
      const r = await o.client.call({ type: "session.list", payload: {
        workspaceId: null, includeArchived: true, lean: true,
      } });
      if (r?.type !== "sessions") throw Error("legacy catalog reply missing");
      return r.data;
    };
    const coldStart = performance.now();
    // Other real readers (including built-in Agents) may have refreshed the
    // snapshot during setup. External writers have a bounded reconciliation
    // contract, not synchronous invalidation of another process's cache.
    let first = await listed();
    const initialCount = first.length;
    await t.tools.waitUntil(async () => {
      if (first.length === 1501 && first.some(s => s.id === target && s.title === "external 0")) return true;
      first = await listed();
      return first.length === 1501 && first.some(s => s.id === target && s.title === "external 0");
    }, 12_000);
    const coldMs = performance.now() - coldStart;
    t.note(`external reconciliation: initial=${initialCount}, observed=${first.length}, elapsedMs=${Math.round(coldMs)}`);
    t.assertions.assert(first.length === 1501 && first.some(s => s.id === target && s.title === "external 0"),
      `legacy catalog lost compatible records or admitted corrupt metadata: count=${first.length}, target=${JSON.stringify(first.find(s => s.id === target) ?? null)}, coldMs=${Math.round(coldMs)}`);
    const changed = { ...JSON.parse(readFileSync(targetFile, "utf8")), title: "external writer changed" };
    writeFileSync(targetFile, JSON.stringify(changed));
    const warmStart = performance.now();
    const warm = await listed();
    t.assertions.assert(warm.some(s => s.id === target && s.title === "external 0"),
      "the next observer rescanned external metadata instead of reusing its bounded snapshot");
    const page = await o.client.call({ type: "session.page", payload: {
      requests: [{ workspaceId: null, limit: 10, cursor: null }], includeArchived: true,
    } });
    t.assertions.assert(page?.type === "sessionPages" && Boolean(page.data[0]?.error),
      "a tolerant legacy snapshot suppressed the strict page corruption error");
    unlinkSync(corruptFile);
    const warmMs = performance.now() - warmStart;
    await t.tools.waitUntil(async () => (await listed()).some(s => s.id === target && s.title === changed.title), 35_000);
    await o.client.call({ type: "session.rename", payload: { sessionId: target, title: "committed rename" } });
    t.assertions.assert((await listed()).some(s => s.id === target && s.title === "committed rename"),
      "warm legacy catalog hid a committed rename");
    await o.client.call({ type: "session.delete", payload: { sessionId: target } });
    t.assertions.assert(!(await listed()).some(s => s.id === target), "warm legacy catalog resurrected a deleted session");
    t.note(`1500 external records: cold=${Math.round(coldMs)}ms warm-and-strict-error=${Math.round(warmMs)}ms; external reconciliation and immediate mutations verified`);
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

defineSpecialty({ ...shared,
  id: "specialty.daemon.session-pages-contract",
  title: "Session pages are bounded, complete and immediately reflect writes, deletions and registry edits",
  oracle: "Static page concatenation equals native full-list IDs; warm pages reflect real public mutations, external metadata becomes visible after reconciliation, and malformed scope/cursor/size requests never masquerade as successful empty data",
  catches: ["page truncates legacy list", "cursor loses equal-time records", "cached deletion resurrects", "scope removal leaves cached sessions visible", "equal-time page boundaries lose records"],
  expectedDurationMs: 20_000, timeoutMs: 120_000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await t.flows.main.createBuiltinSession(o.client, o.workspaceId));
    const request = async (requests: SessionPageRequest[], archived = true) => {
      const r = await o.client.call({ type: "session.page", payload: { requests, includeArchived: archived } });
      if (r?.type !== "sessionPages") throw Error("page reply missing");
      return r.data;
    };
    const all = async () => {
      const result: string[] = []; let cursor: string | null = null;
      do { const [page] = await request([{ workspaceId: o.workspaceId, limit: 7, cursor }]);
        t.assertions.assert(Boolean(page) && !page!.error && page!.sessions.length <= 7, "page size/error contract violated");
        result.push(...page!.sessions.map(s => s.id)); cursor = page!.nextCursor;
      } while (cursor);
      return result;
    };
    // Compatible external metadata writers can produce identical timestamps.
    // Let the bounded recent-write overlay expire before pinning this static dataset.
    const tiedAt = Date.now() - 60_000;
    for (const id of ids) {
      const file = join(t.env.workspace, ".genethub", "sessions", id, "meta.json");
      const meta = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...meta, titleLocked: true, updatedAtMs: tiedAt }));
    }
    await new Promise(resolve => setTimeout(resolve, 5100));
    const listed = await o.client.call({ type: "session.list", payload: { workspaceId: o.workspaceId, includeArchived: true, lean: true } });
    const pages = await all();
    t.assertions.assert(listed?.type === "sessions" && pages.length === 25 && new Set(pages).size === 25 && pages.every(id => ids.includes(id)), "pagination lost/duplicated native history or changed legacy list");
    t.assertions.assert(pages.join(",") === [...ids].sort().reverse().join(","), "equal-time cursor did not preserve deterministic ID order");
    const target = ids[0]!;
    await o.client.call({ type: "session.rename", payload: { sessionId: target, title: "warm catalog changed" } });
    const [renamed] = await request([{ workspaceId: o.workspaceId, limit: 10, cursor: null }]);
    t.assertions.assert(renamed?.sessions.some(s => s.id === target && s.title === "warm catalog changed"), "warm catalog missed a committed rename");
    await o.client.call({ type: "session.archive", payload: { sessionId: target, archived: true } });
    const [current] = await request([{ workspaceId: o.workspaceId, limit: 100, cursor: null }], false);
    t.assertions.assert(current && !current.sessions.some(s => s.id === target), "warm page ignored archive mutation");
    const raw = readFileSync(join(t.env.workspace, ".genethub", "sessions", target, "meta.json"), "utf8");
    await o.client.call({ type: "session.delete", payload: { sessionId: target } });
    mkdirSync(join(t.env.workspace, ".genethub", "sessions", target), { recursive: true });
    writeFileSync(join(t.env.workspace, ".genethub", "sessions", target, "meta.json"), raw);
    t.assertions.assert(!(await all()).includes(target), "deleted disk leftover resurrected in page cache");
    const [partial, good] = await request([{ workspaceId: "w_missing", limit: 10, cursor: null }, { workspaceId: o.workspaceId, limit: 10, cursor: null }]);
    t.assertions.assert(Boolean(partial?.error) && !good?.error && good!.sessions.length === 10, "one failed scope hid successful scope or became empty success");
    const [wrong] = await request([{ workspaceId: null, limit: 10, cursor: good!.nextCursor }]);
    t.assertions.assert(Boolean(wrong?.error), "scope-mismatched cursor was accepted");
    for (const requests of [[], [{ workspaceId: null, limit: 101, cursor: null }], [{ workspaceId: o.workspaceId, limit: 0, cursor: null }], [{ workspaceId: o.workspaceId, limit: 10, cursor: null }, { workspaceId: o.workspaceId, limit: 10, cursor: null }]]) {
      let refused = false; try { await request(requests); } catch { refused = true; }
      t.assertions.assert(refused, "invalid page batch accepted");
    }
    const external = "s_external_page";
    const path = join(t.env.workspace, ".genethub", "sessions", external); mkdirSync(path);
    const model = JSON.parse(readFileSync(join(t.env.workspace, ".genethub", "sessions", ids[1]!, "meta.json"), "utf8"));
    writeFileSync(join(path, "meta.json"), JSON.stringify({ ...model, id: external, title: "external writer", titleLocked: true, updatedAtMs: Date.now() + 1000 }));
    await t.tools.waitUntil(async () => (await all()).includes(external), 12_000);
    const root = join(t.env.root, "other-project"); mkdirSync(root);
    const opened = await o.client.call({ type: "workspace.open", payload: { root } });
    if (opened?.type !== "workspace") throw Error("other project missing");
    const other = await t.flows.main.createBuiltinSession(o.client, opened.data.id);
    await request([{ workspaceId: null, limit: 100, cursor: null }]);
    await o.client.call({ type: "workspace.remove", payload: { workspaceId: opened.data.id } });
    const [removed] = await request([{ workspaceId: opened.data.id, limit: 10, cursor: null }]);
    const [global] = await request([{ workspaceId: null, limit: 100, cursor: null }]);
    t.assertions.assert(Boolean(removed?.error) && !global?.sessions.some(s => s.id === other), "registry removal did not invalidate warm pages");
    t.note("25 native records; static pages complete; warm rename/archive/delete, external reconciliation, cursor/size errors and registry invalidation verified");
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

defineSpecialty({ ...shared,
  id: "specialty.page-experience.session-pages",
  title: "Flat root paging and an older child conversation through its member page",
  oracle: "The real sidebar initially shows100 root conversations, paging retains120 across a real periodic refresh; internal history stays in its member page, whose ten-row default can find an older child through complete history and returns to ten without creating or resuming work",
  catches: ["internal history leaks into the root list", "paging does nothing", "refresh discards loaded history", "member search only checks recent ten", "history search creates work or inflates default previews"],
  tags: ["page-experience", "session-pages"], runner: "playwright", expectedDurationMs: 60000, timeoutMs: 120000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 1, pool: "browser" },
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    await o.client.call({type:"workspace.rename",payload:{workspaceId:o.workspaceId,name:"分页验收"}});
    await o.client.call({type:"agentSpace.configure",payload:{workspaceId:o.workspaceId,expectedRevision:0,operation:{kind:"setLifecycle",lifecycle:"persistent"}}});
    const childRoot=join(t.env.root,"child-space");mkdirSync(childRoot);
    const child=await o.client.call({type:"workspace.open",payload:{root:childRoot}});
    if(child?.type!=="workspace") throw Error("child missing");
    await o.client.call({type:"workspace.rename",payload:{workspaceId:child.data.id,name:"子岗位"}});
    await o.client.call({type:"agentSpace.configure",payload:{workspaceId:child.data.id,expectedRevision:0,operation:{kind:"setParent",parentWorkspaceId:o.workspaceId}}});
    let old="";
    for(let i=0;i<15;i++){
      const id=await t.flows.main.createBuiltinSession(o.client,child.data.id);
      if(i===0){old=id;await o.client.call({type:"session.rename",payload:{sessionId:id,title:"隐藏旧会话"}});}
    }
    const rootIds:string[]=[];
    // More than the actual100-row machine head is required to exercise paging.
    // Child history is older and independently bounded by its own page UI.
    for(let i=0;i<120;i++){
      const id=await t.flows.main.createBuiltinSession(o.client,o.workspaceId);rootIds.push(id);
      await o.client.call({type:"session.rename",payload:{sessionId:id,title:`分页根会话${i}`}});
    }
    const before=await o.client.call({type:"session.get",payload:{sessionId:old}});
    if(before?.type!=="snapshot") throw Error("old child snapshot missing");
    let directoryReads=0;
    browser=await openWorkbenchPage(t.openRoot,()=>{directoryReads++;return daemonEndpoint(o.daemon);},o.workspaceId,rootIds.at(-1)!,{viewport:{width:1280,height:900}});
    const page=browser.page,nav=page.getByRole("navigation",{name:"工作台导航",exact:true});
    await nav.getByRole("button",{name:"会话",exact:true}).click();
    const pane=page.getByRole("complementary",{name:"会话列表",exact:true});
    const roots=pane.locator(".conversation-row").filter({hasText:/分页根会话/});
    await t.tools.waitUntil(async()=>await roots.count()===100,15000);
    t.assertions.assert(await pane.getByText("隐藏旧会话",{exact:true}).count()===0,"child history leaked into the root list");
    await pane.getByRole("button",{name:/加载 .+ 的更早会话/}).click();
    await t.tools.waitUntil(async()=>await roots.count()===120,10000);
    const observed=directoryReads;
    await t.tools.waitUntil(()=>directoryReads>observed,35000);
    t.assertions.assert(await roots.count()===120,"actual periodic refresh discarded explicitly loaded root history");
    await nav.getByRole("button",{name:"项目",exact:true}).click();
    const projects=page.getByRole("complementary",{name:"项目列表面板",exact:true});
    const group=projects.getByRole("region",{name:"项目 分页验收",exact:true});
    await group.getByRole("button",{name:"展开成员 分页验收",exact:true}).click();
    await group.getByRole("button",{name:"打开成员 子岗位",exact:true}).click();
    const project=page.getByRole("region",{name:"项目页面",exact:true});
    await project.getByRole("heading",{name:"子岗位",exact:true}).waitFor();
    await t.tools.waitUntil(async()=>await project.locator(".conversation-row").count()===10,10000);
    t.assertions.assert(await project.getByText("隐藏旧会话",{exact:true}).count()===0,"old child was not beyond the default ten");
    await project.getByRole("button",{name:"项目菜单",exact:true}).click();
    await page.getByRole("menuitem",{name:"查看全部会话",exact:true}).click();
    await project.getByRole("textbox",{name:"搜索当前项目会话",exact:true}).fill("隐藏旧会话");
    await project.getByText("隐藏旧会话",{exact:true}).waitFor({timeout:20000});
    await project.getByText("隐藏旧会话",{exact:true}).click();
    await page.getByRole("heading",{name:"隐藏旧会话",exact:true}).waitFor();
    t.assertions.assert(page.url().includes(old.slice(2,10)),"member search opened another conversation");
    const after=await o.client.call({type:"session.get",payload:{sessionId:old}});
    t.assertions.assert(after?.type==="snapshot" && after.data.summary.status==="idle" &&
      after.data.summary.updatedAtMs===before.data.summary.updatedAtMs,"history lookup resumed or changed the saved conversation");
    await page.getByRole("button",{name:"当前项目",exact:true}).click();
    const search=project.getByRole("textbox",{name:"搜索当前项目会话",exact:true});
    if(await search.count()){
      await search.fill("");await project.getByRole("button",{name:"项目菜单",exact:true}).click();
      await page.getByRole("menuitem",{name:"最近会话",exact:true}).click();
    }
    await t.tools.waitUntil(async()=>await project.locator(".conversation-row").count()===10,10000);
    await nav.getByRole("button",{name:"会话",exact:true}).click();
    t.assertions.assert(await roots.count()===120 && await pane.getByText("隐藏旧会话",{exact:true}).count()===0,
      "leaving child search lost root paging or leaked internal history");
    t.note(JSON.stringify({rootHead:100,rootHistory:120,childDefault:10,childHistory:15,oldChildFound:true,sourceUnchanged:true,directoryReads}));
  } finally { await browser?.close(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
