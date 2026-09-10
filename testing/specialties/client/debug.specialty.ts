import { strict as assert } from "node:assert";
import { defineSpecialty, BlockedError, daemonEndpoint, openPreviewBrowser, runGenetAsync, parseJson } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.client.debug-consent-and-isolation",
  title: "Two real browser clients require independent consent for CLI debugging",
  oracle: "CLI cannot execute before consent or after revocation; approved mobile-sized client executes and returns a DOM JPEG; second tab stays untouched and refresh loses consent",
  catches: ["device-wide consent leaks to tabs", "server approval replaces client approval", "mobile screenshot silently unsupported", "refresh extends authorization"],
  tags: ["page-experience", "client-debug"], runner: "playwright", llm: { default: "none" },
  expectedDurationMs: 25000, timeoutMs: 120000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "cli"], productInterfaces: ["@genehub/workbench", "genet client"],
  requiredArtifacts: ["genet-local", "genehub-host-local", "genehub_guest.wasm"],
}, async (t) => {
  if (!t.browser) throw new BlockedError("real browser required");
  const opened = await t.flows.main.startLocalEnvironment({ openRoot: t.openRoot, lease: t.env });
  const browsers: Awaited<ReturnType<typeof openPreviewBrowser>>[] = [];
  try {
    const pages = [await t.browser.newPage(), await t.browser.newPage()];
    await pages[0]!.setViewportSize({ width: 390, height: 844 });
    for (const page of pages) {
      browsers.push(await openPreviewBrowser({ openRoot: t.openRoot, lease: t.env, page, endpoint: daemonEndpoint(opened.daemon), workspaceId: "", entryPath: "", surface: "client-debug" }));
      await page.getByRole("button", { name: "选择控制机器", exact: true }).click();
      await page.getByRole("button", { name: "连接", exact: true }).click();
      await page.getByText("已连接控制机器", { exact: false }).waitFor();
    }
    const cli = async (...args: string[]) => {
      const response = await runGenetAsync(opened.daemon.genet, ["client", ...args], opened.daemon.env);
      assert.equal(response.code, 0, response.stderr);
      return parseJson(response.stdout).data as any;
    };
    const schemaReply = await runGenetAsync(opened.daemon.genet, ["schema", "client.eval"], opened.daemon.env);
    assert.equal(schemaReply.code, 0, schemaReply.stderr);
    const schema = parseJson(schemaReply.stdout).data as any;
    t.assertions.assert(schema.command.inputSchema.required.includes("script"), "eval schema must declare its required script");
    const clients = await cli("list");
    assert.equal(clients.length, 2, "each document has an independent client");
    const idText = await pages[0]!.getByText("客户端：", { exact: false }).textContent();
    const id = idText!.split("：")[1]!;
    const other = clients.find((client: any) => client.clientId !== id).clientId;
    const { session } = await cli("attach", id, "--label", "Test operator");
    const before = await runGenetAsync(opened.daemon.genet, ["client", "eval", id, "--session", session, "--script", "document.querySelector('#marker').textContent='unauthorized'"], opened.daemon.env);
    t.assertions.assert(before.code !== 0, "pending authorization must reject eval");
    await pages[0]!.getByRole("button", { name: "30 分钟", exact: true }).click();
    await t.tools.waitUntil(async () => (await cli("status", id, "--session", session)).status === "authorized", 10000);
    async function action(verb: string, ...args: string[]) {
      const { commandId } = await cli(verb, id, "--session", session, ...args);
      let response: any;
      await t.tools.waitUntil(async () => { response = await cli("result", id, "--session", session, "--command", commandId); return response.status === "complete"; }, 30000);
      t.assertions.assert(response.result.ok, response.result.error ?? "action failed");
      return response.result.value;
    }
    assert.equal(await action("eval", "--script", "document.querySelector('#marker').textContent='authorized'; 6*7"), 42);
    assert.equal(await pages[0]!.locator("#marker").textContent(), "authorized");
    assert.equal(await pages[1]!.locator("#marker").textContent(), "original");
    const crossed = await runGenetAsync(opened.daemon.genet, ["client", "inspect", other, "--session", session], opened.daemon.env);
    t.assertions.assert(crossed.code !== 0, "session capability is bound to one client");
    await action("act", "--selector", "input", "--value", "mobile input");
    assert.equal(await pages[0]!.getByRole("textbox").inputValue(), "mobile input");
    const shot = await action("screenshot");
    assert.equal(shot.method, "dom");
    t.assertions.assert(shot.dataUrl.startsWith("data:image/jpeg;base64,") && shot.dataUrl.length > 1000, "mobile DOM screenshot has actual JPEG bytes");
    await pages[0]!.getByRole("button", { name: "撤销授权", exact: true }).click();
    const after = await runGenetAsync(opened.daemon.genet, ["client", "inspect", id, "--session", session], opened.daemon.env);
    t.assertions.assert(after.code !== 0, "revoked grant must reject commands");
    const renewed = await cli("attach", id, "--label", "Expiry check");
    await pages[0]!.getByRole("button", { name: "1 小时", exact: true }).click();
    await t.tools.waitUntil(async () => (await cli("status", id, "--session", renewed.session)).status === "authorized", 10000);
    // Advance the real browser's clock; the coordinator's grant remains live,
    // so this specifically checks the client's own expiration gate.
    await pages[0]!.clock.install();
    await pages[0]!.clock.setFixedTime(new Date(Date.now() + 3_601_000));
    await t.tools.waitUntil(async () => {
      const response = await runGenetAsync(opened.daemon.genet, ["client", "status", id, "--session", renewed.session], opened.daemon.env);
      return response.code !== 0;
    }, 10000);
    const secondGrant = await cli("attach", other, "--label", "Disconnect check");
    await pages[1]!.getByRole("button", { name: "1 天", exact: true }).click();
    await t.tools.waitUntil(async () => (await cli("status", other, "--session", secondGrant.session)).status === "authorized", 10000);
    await pages[1]!.getByRole("button", { name: "断开联调", exact: true }).click();
    await pages[1]!.getByRole("button", { name: "选择控制机器", exact: true }).waitFor();
    await t.tools.waitUntil(async () => {
      const response = await runGenetAsync(opened.daemon.genet, ["client", "status", other, "--session", secondGrant.session], opened.daemon.env);
      return response.code !== 0;
    }, 10000);
    await pages[0]!.reload();
    await pages[0]!.getByRole("button", { name: "选择控制机器", exact: true }).waitFor();
    t.note("Real guest and CLI: independent clients, pending refusal, authorized eval/act, mobile DOM JPEG, cross-client refusal, revoke refusal, refresh requires reconnect. No physical iOS/WebView claim.");
  } finally {
    for (const browser of browsers) await browser.close();
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
