import { defineSpecialty, daemonEndpoint, openWorkbenchPage, startSharedBottleneck } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.session-list-freshness",
  title: "A real slow catalog cannot erase a known Human request and one live conversation can recover independently",
  oracle: "An opaque constrained link delays a thousand-session catalog past its real deadline. The real page retains the last confirmed Human request with a visible observation label, receives that conversation's later completion, and clears the list error after transport recovery.",
  catches: ["global list error replaces every row with unknown", "stale facts pretend to be live", "one live session cannot recover until full list succeeds", "mobile hides the failure explanation"],
  tags: ["page-experience", "session-catalog", "team-urgent-recovery"], runner: "playwright", llm: { default: "mock" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "tcp"], productInterfaces: ["@genehub/workbench", "session.list", "session.respondPermission", "session.send"],
  expectedDurationMs: 90000, timeoutMs: 240000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  let link: Awaited<ReturnType<typeof startSharedBottleneck>> | undefined;
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    o.mock.script({ tool: { name: "request_user_input", arguments: { questions: [{ id: "accept", header: "范围", question: "确认本次验收", options: [{ label: "继续", description: "继续本次工作" }, { label: "结束", description: "保留结果" }] }] } } }, { text: "ACTUAL_RECOVERY_COMPLETE", repeat: 4 });
    const target = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    await o.client.call({ type: "session.rename", payload: { sessionId: target, title: "真实待办必须保留" } });
    for (let n = 0; n < 50; n++) await Promise.all(Array.from({ length: 20 }, () => t.flows.main.createBuiltinSession(o.client, o.workspaceId)));
    await t.flows.main.sendPrompt(o.client, target, "请确认本次工作范围");
    await t.tools.waitUntil(async () => { const r = await o.client.call({ type: "session.get", payload: { sessionId: target } }); return r?.type === "snapshot" && r.data.summary.interactionSummary?.count === 1; }, 15000);
    link = await startSharedBottleneck(daemonEndpoint(o.daemon).url, { bandwidthMbps: 100, rttMs: 0 });
    browser = await openWorkbenchPage(t.openRoot, () => {
      const control = daemonEndpoint(o.daemon), body = daemonEndpoint(o.daemon);
      // Real independent admissions, as the production Host supplies. Only
      // the catalog/control carrier is shaped; body events stay observable.
      return { ...control, url: link!.urlFor(control.url), bulk: body };
    }, o.workspaceId, target, { viewport: { width: 1280, height: 900 } }, { trace: false });
    const page = browser.page;
    await page.getByRole("group", { name: "确认本次验收", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
    const row = page.getByRole("complementary", { name: "会话列表", exact: true }).locator(".conversation-row").filter({ hasText: "真实待办必须保留" });
    await row.getByRole("img", { name: /待你处理/ }).waitFor();
    link.setProfile({ bandwidthMbps: 0.02, rttMs: 0 });
    // Public timers trigger the catalog read. No private client/store methods
    // or synthetic RPC replies are substituted to force the failure.
    await page.getByText(/会话列表刷新失败/).first().waitFor({ timeout: 100000 });
    await row.getByRole("img", { name: /上次确认.*待你处理/ }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    t.assertions.assert(await row.getByText(/上次确认.*待你处理/).isVisible(), "mobile concealed the last known real request");
    // A second authenticated consumer answers while this page's catalog is
    // delayed, matching a live row update independent of a list refresh.
    // This does not claim that a UI command crosses a 20kbps saturated link.
    const current = await o.client.call({ type: "session.get", payload: { sessionId: target } });
    if (current?.type !== "snapshot" || !current.data.pendingPermissions[0]) throw Error("real question missing");
    const request = current.data.pendingPermissions[0];
    await o.client.call({ type: "session.respondPermission", payload: { sessionId: target, requestId: request.id,
      outcome: { outcome: "answered", answers: (request.questions ?? []).map(q => ({ questionId: q.id, selectedOptionIds: q.options[0] ? [q.options[0].id] : [] })) } } });
    await row.getByRole("button").first().click();
    await page.getByText("ACTUAL_RECOVERY_COMPLETE", { exact: true }).first().waitFor({ timeout: 30000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
    await row.waitFor();
    await t.tools.waitUntil(async () => await row.getByText(/上次确认/).count() === 0, 15000);
    t.assertions.assert(await page.getByText(/会话列表刷新失败/).count() > 0, "independent row was only checked after full catalog recovery");
    link.setProfile({ bandwidthMbps: 100, rttMs: 0 });
    await t.tools.waitUntil(async () => await page.getByText(/会话列表刷新失败/).count() === 0, 30000);
    t.assertions.assert(await row.getByRole("img", { name: /待你处理/ }).count() === 0, "answered Human request remained pending after catalog recovery");
    t.note(JSON.stringify({ actualSessions: 1001, transportFault: "opaque shared bottleneck", staleRequestVisible: true, viewport: "390x844", recovered: true }));
  } finally { await browser?.close(); await link?.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
