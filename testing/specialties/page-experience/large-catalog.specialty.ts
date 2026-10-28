import { defineSpecialty, daemonEndpoint, openWorkbenchPage, registerControlledAgent, readControlledAgentJournal, startSharedBottleneck } from "../../framework/public.ts";

type Observed = { at: number; operation?: string; phase?: string; outcome?: string; sessionId?: string; requestId?: string; epoch?: number; lane?: string; state?: string };
declare global { interface Window { catalogEvidence: Observed[] } }

defineSpecialty({
  id: "specialty.page-experience.large-catalog-refresh",
  title: "Actual Workbench with 802 sessions bounds catalog refreshes and releases background body subscriptions",
  oracle: "The real page lists 802 public-created sessions, seven tab visits leave one body consumer, concurrent task completions never overlap same-page workspace lists, and a real physical cut restores the page without a catalog storm or repeated source tasks",
  catches: ["802-session incident replaced with a tiny fixture", "session coalescing invalidated by physical recovery", "warm background tabs keep loading lists", "only bare Client traffic was measured"],
  tags: ["page-experience", "large-catalog", "team-scale"], runner: "playwright", llm: { default: "none" },
  expectedDurationMs: 120000, timeoutMs: 300000,
  resources: { environments: 1, cpu: 3, memoryMb: 4096, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent-sdk", "tcp"], productInterfaces: ["@genehub/workbench", "workspace.list", "session.list", "subscribe", "unsubscribe"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  const agent = registerControlledAgent(t.env, { id: "catalog-agent", profile: "flood-events", floods: 200, delayMs: 1000 });
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  let link: Awaited<ReturnType<typeof startSharedBottleneck>> | undefined;
  try {
    await t.flows.main.requireAgentReady(opened.client, "catalog-agent");
    const ids: string[] = [];
    for (let offset = 0; offset < 802; offset += 6) {
      const batch = await Promise.all(Array.from({ length: Math.min(6, 802 - offset) }, async (_, i) => {
        const reply = await opened.client.call({ type: "session.create", payload: { workspaceId: opened.workspaceId, agentId: "catalog-agent", modelId: null, modeId: null, title: `目录会话 ${String(offset + i).padStart(3, "0")}`, cwd: null } });
        if (reply?.type !== "session") throw new Error("public catalog seeding failed");
        return reply.data.id;
      }));
      ids.push(...batch);
    }
    const listed = await opened.client.call({ type: "session.list", payload: { workspaceId: null, includeArchived: false } });
    t.assertions.assert(listed?.type === "sessions" && listed.data.length === 802, "fixture did not contain exactly 802 sessions");
    // This page scenario shapes a real local carrier. Both relay legs and
    // aggregate channel fairness are independently covered by team-mixed.
    link = await startSharedBottleneck(daemonEndpoint(opened.daemon).url, { bandwidthMbps: 5, rttMs: 200 });
    const endpoint = () => { const e = daemonEndpoint(opened.daemon); return { ...e, url: link!.urlFor(e.url) }; };
    browser = await openWorkbenchPage(t.openRoot, endpoint, opened.workspaceId, ids[0]!, { viewport: { width: 1280, height: 900 } }, { trace: false,
      beforeNavigate: async page => { await page.addInitScript(() => {
        window.catalogEvidence = [];
        window.addEventListener("genehub:client-diagnostic", event => {
          const e = (event as CustomEvent).detail;
          if (!e || window.catalogEvidence.length >= 4000) return;
          const d = e.detail;
          if (e.kind === "operation" || e.kind === "connection") window.catalogEvidence.push({ at: Date.parse(e.at), operation: d.operation, phase: d.phase, outcome: d.outcome, sessionId: d.sessionId, requestId: d.requestId, epoch: d.connectionEpoch, lane: d.lane, state: d.state });
        });
      }); },
    });
    const page = browser.page;
    page.setDefaultTimeout(45000);
    await page.getByRole("heading", { name: "目录会话 000", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
    const list = page.getByRole("complementary", { name: "会话列表", exact: true });
    await t.tools.waitUntil(async () => await list.locator(".conversation-row").count() === 802, 45000);
    for (let i = 1; i < 7; i++) {
      const title = `目录会话 ${String(i).padStart(3, "0")}`;
      await list.locator(".conversation-row").filter({ hasText: title }).getByRole("button").first().click();
      await page.getByRole("heading", { name: title, exact: true }).waitFor();
    }
    const mark = Date.now();
    await Promise.all(ids.slice(0, 7).map(id => t.flows.main.sendPrompt(opened.client, id, "Emit deterministic output.")));
    await t.tools.waitUntil(() => readControlledAgentJournal(agent).filter(e => e.event === "answered").length === 7, 15000);
    const answeredAt = Date.now();
    // Allow a complete normal summary-poll interval to observe the burst.
    await page.waitForTimeout(6500);
    await t.tools.waitUntil(() => page.evaluate(() => {
      const active = new Set<string>();
      for (const e of window.catalogEvidence) if ((e.operation === "session.list" || e.operation === "workspace.list") && e.requestId) {
        if (e.phase === "start") active.add(e.requestId);
        else if (e.phase === "finish") active.delete(e.requestId);
      }
      return active.size > 0;
    }), 15000);
    const beforeCut = await page.evaluate(() => window.catalogEvidence);
    const activeConsumers = new Set<string>();
    for (const e of beforeCut) if (e.phase === "finish" && e.outcome === "ok" && e.sessionId) {
      const key = `${e.lane ?? "primary"}:${e.sessionId}`;
      if (e.operation === "subscribe") activeConsumers.add(key);
      else if (e.operation === "unsubscribe") activeConsumers.delete(key);
    }
    const activeBody = activeConsumers.size;
    const peak = (events: Observed[], operation: string) => {
      const active = new Set<string>(); let max = 0;
      for (const e of events) if (e.operation === operation && e.requestId) {
        if (e.phase === "start") active.add(e.requestId);
        if (e.phase === "finish") active.delete(e.requestId);
        max = Math.max(max, active.size);
      }
      return max;
    };
    const cutAndRecover = async (offset: number) => {
      for (const flow of link!.connections().filter(c => !c.closed)) link!.cutConnection(flow.id);
      await page.waitForFunction(offset => window.catalogEvidence.slice(offset).some(e => e.state === "reconnecting"), offset);
      await page.waitForFunction(offset => window.catalogEvidence.slice(offset).some(e => e.state === "ready"), offset);
    };
    const cutAt = Date.now();
    await cutAndRecover(beforeCut.length);
    await page.waitForTimeout(6500);
    const events = await page.evaluate(() => window.catalogEvidence);
    const afterCut = events.slice(beforeCut.length);
    const body = await opened.client.call({ type: "session.get", payload: { sessionId: ids[6]!, recentRounds: 1 } });
    t.assertions.assert(body?.type === "snapshot", "last selected session disappeared");
    t.note(JSON.stringify({ catalog: 802, visited: 7, activeBody, burstWorkspacePeak: peak(beforeCut.filter(e => e.at >= mark), "workspace.list"),
      workspacePeak: peak(events, "workspace.list"), sessionPeak: peak(events, "session.list"),
      recoveryWorkspaceReads: afterCut.filter(e => e.operation === "workspace.list" && e.phase === "start").length,
      sourcePrompts: readControlledAgentJournal(agent).filter(e => e.event === "prompt").length, answered: 7 }));
    t.note(JSON.stringify({ catalogSequence: events.filter(e => e.at >= mark && (e.state || e.operation === "workspace.list" || e.operation === "session.list"))
      .slice(-24).map(e => ({ ms: e.at - mark, op: e.operation, phase: e.phase, state: e.state, epoch: e.epoch })), cutAtMs: cutAt - mark }));
    await page.getByText(/f199\b/).first().waitFor();
    // A task's completion can legitimately refresh the Workspace catalog after
    // the first cut. Isolate hydration counting with a second, quiescent cut;
    // retain the first cut to test an RPC that survives physical recovery.
    await t.tools.waitUntil(() => page.evaluate(answeredAt => {
      const events = window.catalogEvidence;
      const catalog = events.filter(e => e.operation === "session.list" || e.operation === "workspace.list");
      const active = new Set<string>();
      for (const e of catalog) if (e.requestId) {
        if (e.phase === "start") active.add(e.requestId);
        else if (e.phase === "finish") active.delete(e.requestId);
      }
      const fresh = catalog.some(e => e.operation === "session.list" && e.phase === "start" && e.at >= answeredAt &&
        catalog.some(end => end.requestId === e.requestId && end.phase === "finish"));
      return fresh && active.size === 0 && Date.now() - (catalog.at(-1)?.at ?? 0) >= 500;
    }, answeredAt), 90000);
    const quietOffset = await page.evaluate(() => window.catalogEvidence.length);
    await cutAndRecover(quietOffset);
    await page.waitForTimeout(6500);
    const finalEvents = await page.evaluate(() => window.catalogEvidence);
    const quietWorkspaceReads = finalEvents.slice(quietOffset).filter(e => e.operation === "workspace.list" && e.phase === "start").length;
    t.note(JSON.stringify({ phase: "quiescent-recovery", quietWorkspaceReads, workspacePeak: peak(finalEvents, "workspace.list"), sessionPeak: peak(finalEvents, "session.list") }));
    t.assertions.assert(activeBody === 1, "background tabs retained body consumers after seven real page visits");
    t.assertions.assert(peak(finalEvents, "workspace.list") <= 1 && peak(finalEvents, "session.list") <= 1, "same-page catalog requests overlapped");
    t.assertions.assert(quietWorkspaceReads <= 1, "quiescent physical recovery triggered repeated workspace hydration");
    t.assertions.assert(await list.locator(".conversation-row").count() === 802 && readControlledAgentJournal(agent).filter(e => e.event === "prompt").length === 7, "recovery lost directory rows or repeated source tasks");
  } finally {
    await browser?.close(); await link?.stop();
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
