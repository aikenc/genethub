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
  oracle: "With 1500 real external records a warm legacy read keeps its observed snapshot until reconciliation, strict pages still report corrupt metadata, external changes reconcile within 12 seconds and committed rename/delete appear immediately",
  catches: ["each sequential observer rescans all history", "tolerant legacy cache hides a strict page error", "cache never reconciles external writers", "committed mutation leaves cached stale history"],
  tags: ["core", "session-pages", "session-read", "catalog-pressure"],
  expectedDurationMs: 25_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 2, browser: 0, pool: "standard" },
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const seed = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    const home = join(o.workspaceRoot, ".genethub", "sessions");
    const model = JSON.parse(readFileSync(join(home, seed, "meta.json"), "utf8"));
    // Let any setup observation and recent-write overlay expire before the
    // external writer establishes the observed catalog.
    await new Promise(resolve => setTimeout(resolve, 5100));
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
    const first = await listed();
    const coldMs = performance.now() - coldStart;
    t.assertions.assert(first.length === 1501 && first.some(s => s.id === target && s.title === "external 0"),
      "legacy catalog lost compatible records or admitted corrupt metadata");
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
    await t.tools.waitUntil(async () => (await listed()).some(s => s.id === target && s.title === changed.title), 12_000);
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
  title: "Real sidebar loads ten root rows, lazy child rows and finds an older child through global search",
  oracle: "The actual workbench initially renders ten root conversations without child rows, more history adds ten, opening the child loads ten, and a global search finds the oldest child conversation beyond that page",
  catches: ["collapsed child history eagerly displayed", "load more button does nothing", "global search only filters recent ten", "switching out of search leaves full history on default page"],
  tags: ["page-experience", "session-pages"], runner: "playwright", expectedDurationMs: 25_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 1, pool: "browser" },
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    await o.client.call({ type: "workspace.rename", payload: { workspaceId: o.workspaceId, name: "分页验收" } });
    const rootIds: string[] = [];
    for (let i = 0; i < 25; i++) rootIds.push(await t.flows.main.createBuiltinSession(o.client, o.workspaceId));
    await o.client.call({ type: "agentSpace.configure", payload: { workspaceId: o.workspaceId, expectedRevision: 0, operation: { kind: "setLifecycle", lifecycle: "persistent" } } });
    const childRoot = join(t.env.root, "child-space"); mkdirSync(childRoot);
    const child = await o.client.call({ type: "workspace.open", payload: { root: childRoot } });
    if (child?.type !== "workspace") throw Error("child missing");
    await o.client.call({ type: "workspace.rename", payload: { workspaceId: child.data.id, name: "子岗位" } });
    await o.client.call({ type: "agentSpace.configure", payload: { workspaceId: child.data.id, expectedRevision: 0, operation: { kind: "setParent", parentWorkspaceId: o.workspaceId } } });
    let old = "";
    for (let i = 0; i < 15; i++) {
      const id = await t.flows.main.createBuiltinSession(o.client, child.data.id);
      if (i === 0) { old = id; await o.client.call({ type: "session.rename", payload: { sessionId: id, title: "隐藏旧会话" } }); }
    }
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(o.daemon), o.workspaceId, rootIds.at(-1)!, { viewport: { width: 1280, height: 900 } });
    const page = browser.page;
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
    const pane = page.getByRole("complementary", { name: "会话列表", exact: true });
    const group = pane.getByRole("listitem", { name: "项目分组 分页验收", exact: true });
    const waitRows = async (count: number, phase: string) => {
      try { await t.tools.waitUntil(async () => await group.locator(".conversation-row").count() === count, 10_000); }
      catch { throw Error(`${phase}: expected ${count} rows, got ${await group.locator(".conversation-row").count()}; ${String(await pane.innerText()).slice(0,1800)}`); }
    };
    await t.tools.waitUntil(async () => await group.locator(".conversation-row").count() === 10, 15_000);
    t.assertions.assert(await group.getByText("隐藏旧会话", { exact: true }).count() === 0, "collapsed child row leaked into default list");
    await group.getByRole("button", { name: "加载 分页验收 的更早会话", exact: true }).click();
    await waitRows(20, "load-more");
    await page.waitForTimeout(12_000); // Two real shared refresh cycles.
    t.assertions.assert(await group.locator(".conversation-row").count() === 20, "periodic refresh discarded explicitly loaded older history");
    await group.locator("summary").filter({ hasText: "子 Space" }).click();
    await group.locator("summary").filter({ hasText: "分页验收 / 子岗位" }).click();
    await waitRows(30, "child-expansion");
    await pane.getByRole("button", { name: "会话列表选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "搜索会话", exact: true }).click();
    await pane.getByRole("searchbox", { name: "搜索会话", exact: true }).fill("隐藏旧会话");
    await pane.locator(".conversation-row").filter({ hasText: "隐藏旧会话" }).waitFor({ timeout: 20_000 });
    t.assertions.assert(Boolean(old), "old child record not created");
    await pane.getByRole("button", { name: "关闭搜索", exact: true }).click();
    await waitRows(30, "search-exit");
    t.note("actual browser: ten root rows; twenty after more; ten child rows on expansion; global search found oldest child beyond its first page");
  } finally { await browser?.close(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
