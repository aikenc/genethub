import { defineSpecialty, daemonEndpoint, openWorkbenchPage, startSharedBottleneck } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.session-list-initial",
  title: "Initial connection, first catalog failure and confirmed empty catalog have distinct messages",
  oracle: "The real page cannot report a failed refresh or empty project while its actual device connection is pending; a successful native empty catalog shows the empty state; a real constrained first catalog fails without claiming recent records and recovers after link restoration.",
  catches: ["connecting is reported as a failed catalog", "unloaded sessions pretend to be empty", "first query failure claims cached records", "confirmed empty catalog cannot show its ordinary empty state"],
  tags: ["page-experience", "session-catalog", "catalog-initial-display"], runner: "playwright", llm: { default: "mock" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "tcp"], productInterfaces: ["@genehub/workbench", "session.create", "session.rename", "session.delete", "session.list"],
  expectedDurationMs: 120000, timeoutMs: 240000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  let link: Awaited<ReturnType<typeof startSharedBottleneck>> | undefined;
  try {
    const target = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    await o.client.call({ type: "session.rename", payload: { sessionId: target, title: "实际首次列表记录" } });
    // Constrain the real opaque carrier after Host discovery, so the
    // actual workbench mounts while its native handshake remains pending.
    link = await startSharedBottleneck(daemonEndpoint(o.daemon).url, { bandwidthMbps: 100, rttMs: 5000 });
    browser = await openWorkbenchPage(t.openRoot, () => { const control = daemonEndpoint(o.daemon); return { ...control, url: link!.urlFor(control.url), bulk: daemonEndpoint(o.daemon) }; }, o.workspaceId, target, { viewport: { width: 1280, height: 900 } }, { trace: false });
    const page = browser.page;
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
    const pane = page.getByRole("complementary", { name: "会话列表", exact: true });
    await pane.getByRole("status").filter({ hasText: /同步中|待同步/ }).waitFor();
    await page.waitForTimeout(1500);
    t.assertions.assert(await pane.getByText(/刷新失败|从一个项目开始会话|没有匹配的会话/).count() === 0, "pending native connection was presented as a failed or empty native catalog");
    link.setProfile({ bandwidthMbps: 100, rttMs: 0 });
    await pane.locator(".conversation-row").filter({ hasText: "实际首次列表记录" }).waitFor();
    await o.client.call({ type: "session.delete", payload: { sessionId: target } });
    await pane.getByText("从一个项目开始会话", { exact: true }).waitFor({ timeout: 20000 });
    t.assertions.assert(await pane.getByText(/刷新失败|正在连接|正在加载/).count() === 0, "confirmed native empty catalog still looked pending or failed");
    await browser.close(); browser = undefined;
    await link.stop(); link = undefined;
    const next = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    await o.client.call({ type: "session.rename", payload: { sessionId: next, title: "真实首读故障后恢复" } });
    for (let i = 0; i < 50; i++) await Promise.all(Array.from({ length: 20 }, () => t.flows.main.createBuiltinSession(o.client, o.workspaceId)));
    // Keep the recovery witness in the bounded first page, after seeding.
    await o.client.call({ type: "session.rename", payload: { sessionId: next, title: "真实首读故障后恢复" } });
    // The current directory loads a bounded 100-row head rather than the
    // former whole catalog; constrain that real smaller response sufficiently
    // to exceed its existing read deadline, without extending any timeout.
    link = await startSharedBottleneck(daemonEndpoint(o.daemon).url, { bandwidthMbps: 0.002, rttMs: 0 });
    browser = await openWorkbenchPage(t.openRoot, () => { const control = daemonEndpoint(o.daemon); return { ...control, url: link!.urlFor(control.url), bulk: daemonEndpoint(o.daemon) }; }, o.workspaceId, next, { viewport: { width: 390, height: 844 } }, { trace: false });
    const mobile = browser.page;
    await mobile.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
    const initial = mobile.getByRole("complementary", { name: "会话列表", exact: true });
    try {
      await initial.getByRole("status").filter({ hasText: /读取超时|暂不可用/ }).waitFor({ timeout: 100000 });
    } catch (error) {
      throw new Error(`First constrained catalog did not show its read failure: ${(await initial.innerText()).slice(-1800)}; ${error instanceof Error ? error.message : String(error)}`);
    }
    t.assertions.assert(await initial.getByText(/上次状态|上次同步|当前显示最近记录|从一个项目开始会话|没有匹配的会话/).count() === 0, "first native catalog failure claimed cached or empty records");
    link.setProfile({ bandwidthMbps: 100, rttMs: 0 });
    await initial.locator(".conversation-row").filter({ hasText: "真实首读故障后恢复" }).waitFor({ timeout: 30000 });
    t.assertions.assert(await initial.getByText(/暂不可用|读取超时|同步中|刷新失败/).count() === 0, "successful actual list did not clear initial failure");
    t.note(JSON.stringify({ delayedActualConnection: true, confirmedNativeEmpty: true, actualSessions: 1001, firstFailure: "opaque shared bottleneck", mobile: "390x844", recovered: true }));
  } finally { await browser?.close(); await link?.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
