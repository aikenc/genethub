import { strict as assert } from "node:assert";
import { defineSpecialty, BlockedError, daemonEndpoint, openPreviewBrowser, runGenetAsync, parseJson, startShapedTcpProxy } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.client.debug-reconnect",
  title: "Client consent survives a real long network outage without replaying stale operations",
  oracle: "After more than 90 seconds disconnected the same client/session resumes without approval, deadlines decrease, stale commands do not execute; offline revoke and coordinator restart cannot restore old consent",
  catches: ["heartbeat expiry revokes valid consent", "reconnect extends authorization", "stale queued actions execute on return", "revoked consent resurrects", "missing registration loops forever"],
  tags: ["network-risk-v2", "page-experience", "client-debug", "client-debug-reconnect"], runner: "playwright", llm: { default: "none" },
  expectedDurationMs: 140000, timeoutMs: 240000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "cli"], productInterfaces: ["@genehub/workbench", "genet client"],
  requiredArtifacts: ["genet-local", "genehub-host-local", "genehub_guest.wasm"],
}, async (t) => {
  if (!t.browser) throw new BlockedError("real browser required");
  const opened = await t.flows.main.startLocalEnvironment({ openRoot: t.openRoot, lease: t.env });
  let endpoint = daemonEndpoint(opened.daemon);
  let proxy = await startShapedTcpProxy({ targetUrl: endpoint.url, profile: { rttMs: 0, bandwidthMbps: 1000 } });
  let browser: Awaited<ReturnType<typeof openPreviewBrowser>> | undefined;
  const page = await t.browser.newPage();
  let phase = "connect";
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const refreshedEndpoint = () => {
      // Loopback admission is one-use: just like browserHost, obtain a new
      // real endpoint proof on every redial, including failed attempts.
      const fresh = daemonEndpoint(opened.daemon);
      return { ...fresh, url: proxy.urlFor(fresh.url) };
    };
    browser = await openPreviewBrowser({ openRoot: t.openRoot, lease: t.env, page, endpoint: refreshedEndpoint(), refreshEndpoint: refreshedEndpoint, workspaceId: "", entryPath: "", surface: "client-debug" });
    await page.getByRole("button", { name: "选择控制机器", exact: true }).click();
    await page.getByRole("button", { name: "连接", exact: true }).click();
    await page.getByText("已连接控制机器", { exact: false }).waitFor();
    const raw = (...args: string[]) => runGenetAsync(opened.daemon.genet, ["client", ...args], opened.daemon.env);
    const cli = async (...args: string[]) => {
      const result = await raw(...args);
      assert.equal(result.code, 0, result.stderr);
      return parseJson(result.stdout).data as any;
    };
    const id = (await page.getByText("客户端：", { exact: false }).textContent())!.split("：")[1]!;
    const { session } = await cli("attach", id, "--label", "Reconnect operator");
    await page.getByRole("button", { name: "30 分钟", exact: true }).click();
    await t.tools.waitUntil(async () => (await cli("status", id, "--session", session)).status === "authorized", 10000);
    const before = await cli("status", id, "--session", session);
    const running = await cli("eval", id, "--session", session, "--script", "globalThis.debugRuns=(globalThis.debugRuns||0)+1;document.querySelector('#marker').textContent='running';new Promise(resolve=>setTimeout(()=>resolve('done'),15000))");
    await page.getByText("running", { exact: true }).waitFor();
    const queued = await cli("eval", id, "--session", session, "--script", "document.querySelector('#marker').textContent='STALE'");
    phase = "long outage";
    await proxy.stop(); // Actual TCP sockets close; the product runtime is untouched.
    const disconnectedAt = Date.now();
    await t.tools.waitUntil(async () => (await cli("list")).find((entry: any) => entry.clientId === id)?.online === false, 60000);
    assert.notEqual((await raw("inspect", id, "--session", session)).code, 0, "offline operations must be rejected");
    await t.tools.waitUntil(async () => Date.now() - disconnectedAt > 95000, 100000);
    const retained = (await cli("list")).find((entry: any) => entry.clientId === id);
    assert.equal(retained.authorized, true, "long offline client keeps original authorization");
    const queueResult = await cli("result", id, "--session", session, "--command", queued.commandId);
    assert.equal(queueResult.result.ok, false);
    assert.match(queueResult.result.error, /expired before delivery/);
    const runningResult = await cli("result", id, "--session", session, "--command", running.commandId);
    assert.equal(runningResult.result.ok, false);
    assert.match(runningResult.result.error, /may have run/);
    endpoint = daemonEndpoint(opened.daemon);
    proxy = await startShapedTcpProxy({ targetUrl: endpoint.url, profile: { rttMs: 0, bandwidthMbps: 1000 } });
    phase = "resume after long outage";
    await t.tools.waitUntil(async () => (await cli("list")).find((entry: any) => entry.clientId === id)?.online === true, 45000);
    assert.equal(await page.getByRole("button", { name: "30 分钟", exact: true }).count(), 0, "reconnect does not ask again");
    const after = await cli("status", id, "--session", session);
    assert.ok(after.remainingMs < before.remainingMs - 90000, "offline time does not extend consent");
    const resumed = await cli("eval", id, "--session", session, "--script", "globalThis.debugRuns");
    let result: any;
    await t.tools.waitUntil(async () => { result = await cli("result", id, "--session", session, "--command", resumed.commandId); return result.status === "complete"; }, 15000);
    assert.equal(result.result.value, 1, "uncertain operation was not replayed");
    assert.equal(await page.locator("#marker").textContent(), "running", "stale queued mutation did not run");
    await proxy.stop();
    phase = "offline revoke";
    await page.getByRole("button", { name: "撤销授权", exact: true }).click();
    await page.getByText("未授权执行远程操作", { exact: false }).waitFor();
    endpoint = daemonEndpoint(opened.daemon);
    proxy = await startShapedTcpProxy({ targetUrl: endpoint.url, profile: { rttMs: 0, bandwidthMbps: 1000 } });
    await t.tools.waitUntil(async () => (await raw("status", id, "--session", session)).code !== 0, 45000);
    const renewed = await cli("attach", id, "--label", "Restart operator");
    await page.getByRole("button", { name: "1 小时", exact: true }).click();
    await t.tools.waitUntil(async () => (await cli("status", id, "--session", renewed.session)).status === "authorized", 15000);
    await proxy.stop();
    phase = "coordinator restart";
    opened.daemon.stop();
    const start = await runGenetAsync(opened.daemon.genet, ["daemon", "start"], opened.daemon.env);
    assert.equal(start.code, 0, start.stderr);
    endpoint = daemonEndpoint(opened.daemon);
    proxy = await startShapedTcpProxy({ targetUrl: endpoint.url, profile: { rttMs: 0, bandwidthMbps: 1000 } });
    await page.getByText("联调已自动重新连接", { exact: false }).waitFor({ timeout: 45000 });
    const newId = (await page.getByText("客户端：", { exact: false }).textContent())!.split("：")[1]!;
    assert.notEqual(newId, id);
    assert.equal((await cli("list")).find((entry: any) => entry.clientId === newId).authorized, false);
    assert.notEqual((await raw("inspect", newId, "--session", renewed.session)).code, 0, "restart cannot restore stale consent");
    t.note("Real TCP outage >95s, actual WASM coordinator/CLI/browser; same consent resumes, deadline shrinks, expired queue and uncertain result never replay, offline revoke holds, coordinator restart auto-registers without granting authority. No physical Safari claim.");
  } catch (error) {
    const panel = await page.locator("[data-genehub-client-debug]").evaluate((element) => element.shadowRoot?.querySelector("section")?.textContent ?? "").catch(() => "unavailable");
    throw new Error(`${phase}: ${String(error)}; client panel: ${panel.slice(0, 1800)}`);
  } finally {
    await proxy.stop(); await browser?.close();
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
