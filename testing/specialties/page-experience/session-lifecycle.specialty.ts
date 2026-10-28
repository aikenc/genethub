import { BlockedError, defineSpecialty, daemonEndpoint, openWorkbenchPage, registerControlledAgent, readControlledAgentJournal, startSharedBottleneck } from "../../framework/public.ts";

type LifecycleEvent = { at: number; operation?: string; phase?: string; outcome?: string; sessionId?: string; lane?: string; visibility?: string };
declare global { interface Window { sessionLifecycleEvidence: LifecycleEvent[] } }

defineSpecialty({
  id: "specialty.page-experience.session-consumer-lifecycle",
  title: "Real page navigation and browser visibility release body consumption without stopping tasks",
  oracle: "Settings and drafts release body consumption, rapid A/B/A selection recovers one consumer, a real hidden browser tab stops starting catalog polls, background tasks complete once, and returning displays their output and new live events",
  catches: ["a settings page retains the old transcript stream", "hidden page keeps polling", "late admission leaks a hidden subscription", "returning to a cached tab leaves a dead stream", "pause accidentally interrupts the source task"],
  tags: ["page-experience", "session-lifecycle"], runner: "playwright", llm: { default: "none" },
  expectedDurationMs: 60000, timeoutMs: 180000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent-sdk", "browser-lifecycle"],
  productInterfaces: ["@genehub/workbench", "session.create", "subscribe", "unsubscribe", "session.list"],
  requirements: [{ kind: "environment", env: "DISPLAY", format: "text" }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  const agent = registerControlledAgent(t.env, { id: "lifecycle-agent", profile: "flood-events", floods: 120, floodIntervalMs: 100 });
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  let link: Awaited<ReturnType<typeof startSharedBottleneck>> | undefined;
  try {
    await t.flows.main.requireAgentReady(opened.client, "lifecycle-agent");
    const ids: string[] = [];
    for (const label of ["A", "B"]) {
      const r = await opened.client.call({ type: "session.create", payload: { workspaceId: opened.workspaceId, agentId: "lifecycle-agent", modelId: null, modeId: null, title: `生命周期 ${label}`, cwd: null } });
      if (r?.type !== "session") throw new Error("public session creation failed");
      ids.push(r.data.id);
    }
    link = await startSharedBottleneck(daemonEndpoint(opened.daemon).url, { bandwidthMbps: 5, rttMs: 200 });
    browser = await openWorkbenchPage(t.openRoot, () => { const e = daemonEndpoint(opened.daemon); return { ...e, url: link!.urlFor(e.url) }; }, opened.workspaceId, ids[0]!, { viewport: { width: 1280, height: 900 } }, { trace: false, naturalVisibility: true,
      beforeNavigate: async page => { await page.addInitScript(() => {
        window.sessionLifecycleEvidence = [];
        window.addEventListener("genehub:client-diagnostic", event => {
          const e = (event as CustomEvent).detail, d = e?.detail;
          if (e?.kind === "operation" && window.sessionLifecycleEvidence.length < 2000) window.sessionLifecycleEvidence.push({ at: Date.parse(e.at), operation: d.operation, phase: d.phase, outcome: d.outcome, sessionId: d.sessionId, lane: d.lane });
        });
        document.addEventListener("visibilitychange", () => window.sessionLifecycleEvidence.push({ at: Date.now(), visibility: document.visibilityState }));
      }); },
    });
    const page = browser.page;
    const consumers = () => page.evaluate(() => {
      const active = new Set<string>();
      for (const e of window.sessionLifecycleEvidence) if (e.phase === "finish" && e.outcome === "ok" && e.sessionId) {
        const key = `${e.lane ?? "primary"}:${e.sessionId}`;
        // A gap-repair subscribe replaces the same server-side consumer.
        if (e.operation === "subscribe") active.add(key);
        else if (e.operation === "unsubscribe") active.delete(key);
      }
      return active.size;
    });
    await page.getByRole("heading", { name: "生命周期 A", exact: true }).waitFor();
    await t.tools.waitUntil(async () => await consumers() === 1, 15000);

    t.note(JSON.stringify({ phase: "rapid-selection", consumers: await consumers() }));
    const nav = page.getByRole("navigation", { name: "工作台导航" });
    await nav.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("region", { name: "全局设置", exact: true }).waitFor();
    await t.tools.waitUntil(async () => await consumers() === 0, 10000);
    await nav.getByRole("button", { name: "会话", exact: true }).click();
    await t.tools.waitUntil(async () => await consumers() === 1, 15000);
    const list = page.getByRole("complementary", { name: "会话列表", exact: true });
    await list.getByRole("button", { name: "新建会话", exact: true }).click();
    await t.tools.waitUntil(async () => await consumers() === 0, 10000);
    // Creating a draft navigates to the project surface. Return through the
    // public session navigation before selecting its existing conversations.
    await nav.getByRole("button", { name: "会话", exact: true }).click();
    await list.waitFor({ state: "visible" });
    t.note(JSON.stringify({ phase: "settings-and-draft", settingsConsumers: 0, draftConsumers: await consumers(), visibleRows: await list.locator(".conversation-row").count() }));
    const pick = async (label: string) => { await list.locator(".conversation-row").filter({ hasText: `生命周期 ${label}` }).getByRole("button").first().click(); };
    await pick("A"); await pick("B"); await pick("A");
    await page.getByRole("heading", { name: "生命周期 A", exact: true }).waitFor();
    await t.tools.waitUntil(async () => await consumers() === 1, 15000);

    await t.flows.main.sendPrompt(opened.client, ids[0]!, "background-only-task");
    await page.getByText("background-only-task", { exact: true }).first().waitFor();
    t.assertions.assert(readControlledAgentJournal(agent).filter(e => e.event === "answered").length === 0,
      "the task completed before the real visibility transition");

    // The driver leaves focus emulation off. Switch actual tabs and require
    // Chromium's own visibility fact before checking the product's behavior.
    const other = await browser.context.newPage();
    await other.bringToFront();
    try { await page.waitForFunction(() => document.visibilityState === "hidden", undefined, { timeout: 5000 }); }
    catch { throw new BlockedError("Chromium did not expose real hidden-tab visibility after focus emulation was disabled"); }
    t.note(JSON.stringify({ phase: "real-hidden", visibility: await page.evaluate(() => document.visibilityState), consumers: await consumers() }));
    try { await t.tools.waitUntil(async () => await consumers() === 0, 10000); }
    catch (error) {
      t.note(JSON.stringify({ phase: "hidden-consumer-timeout", consumers: await consumers(), events: await page.evaluate(() => window.sessionLifecycleEvidence.filter(e => e.visibility || ["subscribe", "unsubscribe"].includes(e.operation ?? "")).slice(-24)) }));
      throw error;
    }
    const hiddenAt = Date.now();
    await t.tools.waitUntil(() => readControlledAgentJournal(agent).filter(e => e.event === "answered").length === 1, 25000);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 6500 - (Date.now() - hiddenAt))));
    const hiddenPolls = await page.evaluate(at => window.sessionLifecycleEvidence.filter(e => e.at >= at && e.operation === "session.list" && e.phase === "start").length, hiddenAt);
    t.assertions.assert(hiddenPolls === 0, "hidden page started new full catalog polls");
    const hiddenMs = Date.now() - hiddenAt;
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === "visible");
    await t.tools.waitUntil(async () => await consumers() === 1, 15000);
    await page.getByText(/f119\b/).first().waitFor();
    await t.flows.main.sendPrompt(opened.client, ids[0]!, "foreground-second-task");
    await page.getByText("foreground-second-task", { exact: true }).first().waitFor();
    await t.tools.waitUntil(() => readControlledAgentJournal(agent).filter(e => e.event === "answered").length === 2, 25000);
    const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId: ids[0]!, recentRounds: 2 } });
    const expected = Array.from({ length: 120 }, (_, i) => `f${i} `).join("");
    t.assertions.assert(snapshot?.type === "snapshot" && snapshot.data.items.filter(item => item.type === "assistantMessage" && item.text === expected).length === 2,
      "hidden/foreground tasks did not retain two exact final bodies");
    const journal = readControlledAgentJournal(agent);
    t.assertions.assert(journal.filter(e => e.event === "prompt").length === 2 && journal.filter(e => e.event === "answered").length === 2, "visibility changes repeated or stopped source tasks");
    t.note(JSON.stringify({ settingsConsumers: 0, draftConsumers: 0, rapidSelectionConsumers: 1, hiddenConsumers: 0, hiddenPolls, hiddenMs, restoredConsumers: await consumers(), sourceTasks: 2, exactReplies: 2,
      visibility: await page.evaluate(() => window.sessionLifecycleEvidence.filter(e => e.visibility).map(e => e.visibility)) }));
    await other.close();
  } finally { await browser?.close(); await link?.stop(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
