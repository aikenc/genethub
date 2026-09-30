import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { allocatePort, daemonEndpoint, defineSpecialty, openBrowser, openPreviewBrowser, openWorkbenchPage, startHub, startRelay } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.preview-sharing",
  title: "An anonymous share viewer returns file feedback through Cloud and Fabric",
  oracle: "Owner chooses 1h/1d/7d; fresh Cloud browser loads H5 and Unicode resources, writes notes and logs, copies a durable receipt and reloads; outside resources and machine actions are rejected and revocation stops existing peers",
  catches: ["fragment share credential ignored by Cloud entry", "portable annotations read-only", "logs require original session window", "expired connection proof cannot refresh", "share grants whole machine", "revocation only applies after reconnect"],
  tags: ["page-experience", "preview-feedback", "authorization"],
  runner: "playwright", requiredRepos: ["cloud"], llm: { default: "mock" },
  expectedDurationMs: 45_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["cloud-console", "cloud-server", "relay", "daemon", "asset-preview"],
  productInterfaces: ["@genehub/workbench", "hub-http", "preview.feedback", "asset.preview"],
}, async t => {
  const relayPort = await allocatePort();
  const relayToken = randomBytes(24).toString("hex");
  const hub = await startHub({ databasePath: path.join(t.env.root, "hub.sqlite"), relayOrigin: `http://127.0.0.1:${relayPort}`, relayToken, consoleDir: path.join(process.env.TESTCTL_CLOUD_ROOT!, "console/dist") });
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let opened: Awaited<ReturnType<typeof t.flows.main.openWorkspace>> | undefined;
  let owner: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let visitor: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let pwa: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  let consumer: Awaited<ReturnType<typeof openPreviewBrowser>> | undefined;
  let shared: Client | undefined;
  try {
    relay = await startRelay({ openRoot: t.openRoot, port: relayPort, control: { origin: hub.origin, token: relayToken } });
    await writeFile(path.join(t.env.workspace, "页面.json"), '{"message":"Unicode resource loaded"}');
    await writeFile(path.join(t.env.workspace, "private.txt"), "outside share scope");
    await writeFile(path.join(t.env.workspace, "review.html"), '<!doctype html><html><head><title>Share review</title></head><body><p id="target">Review target</p><p id="data">Loading</p><script>fetch("页面.json").then(r=>r.json()).then(x=>document.getElementById("data").textContent=x.message);console.error("Captured visitor log");</script></body></html>');
    opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const pair = await opened.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: "Share test machine" } });
    if (pair?.type !== "hubStatus" || pair.data.state !== "pairing") throw new Error("daemon did not begin pairing");
    const account = hub.browser();
    await hub.signInOwner(account); await hub.approvePairing(account, pair.data.userCode);
    await t.tools.waitUntil(async () => {
      const status = await opened!.client.call({ type: "hub.status" });
      return status?.type === "hubStatus" && status.data.state === "paired" && status.data.online;
    }, 45_000);
    // Share credentials stay in memory. Browser traces would capture fragment tokens.
    owner = await openBrowser({}, { trace: false });
    const entryPath = `${opened.rootHandle}/review.html`;
    consumer = await openPreviewBrowser({ openRoot: t.openRoot, lease: t.env, page: owner.page, endpoint: daemonEndpoint(opened.daemon), refreshEndpoint: () => daemonEndpoint(opened!.daemon), workspaceId: opened.workspaceId, entryPath });
    const page = owner.page;
    await page.frameLocator('iframe[title="HTML 文件预览"]').locator("#data").getByText("Unicode resource loaded").waitFor();
    await page.getByRole("button", { name: "分享预览", exact: true }).click();
    const select = page.getByLabel("分享授权时间", { exact: true });
    t.assertions.assert(JSON.stringify(await select.locator("option").evaluateAll(nodes => nodes.map(n => (n as HTMLOptionElement).value))) === JSON.stringify(["3600", "86400", "604800"]), "share lifetimes are not 1h/1d/7d");
    await page.getByRole("button", { name: "生成链接", exact: true }).click();
    const link = page.getByRole("textbox", { name: "预览分享链接", exact: true });
    await link.waitFor();
    const shareUrl = await link.inputValue();
    visitor = await openBrowser({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 430, height: 800 } }, { trace: false });
    await visitor.page.goto(shareUrl);
    const v = visitor.page;
    const frame = v.frameLocator('iframe[title="HTML 文件预览"]');
    await frame.locator("#data").getByText("Unicode resource loaded").waitFor();
    t.assertions.assert((await visitor.context.cookies(hub.origin)).length === 0, "share viewer needed a login cookie");
    await v.getByRole("button", { name: "进入批注", exact: true }).click();
    await frame.locator("#target").click();
    await v.getByRole("textbox", { name: "批注", exact: true }).fill("Visitor annotation");
    await v.getByRole("button", { name: "加入草稿", exact: true }).click();
    await v.getByRole("button", { name: "完成批注", exact: true }).click();
    await v.getByLabel("更多预览操作", { exact: true }).click();
    await v.getByRole("button", { name: "保存运行产物", exact: true }).click();
    await v.getByText("已保存到文件反馈草稿，请点击反馈选择并提交", { exact: false }).waitFor();
    await v.keyboard.press("Escape");
    await v.getByRole("button", { name: "提交预览反馈", exact: true }).click();
    await v.getByRole("textbox", { name: "反馈说明", exact: true }).fill("Visitor manual feedback");
    await v.getByRole("button", { name: "提交反馈", exact: true }).click();
    const receipt = v.getByRole("textbox", { name: "可复制的预览反馈", exact: true });
    await receipt.waitFor();
    const text = await receipt.inputValue();
    const id = text.match(/pf_[a-f0-9]{32}/)![0];
    t.assertions.assert(text.includes("Visitor annotation") && text.includes("\n运行证据："), "receipt omitted selected notes or logs");
    await v.getByRole("button", { name: "复制编号和内容", exact: true }).click();
    t.assertions.assert(await v.evaluate(() => navigator.clipboard.readText()) === text, "feedback copy did not put the receipt on clipboard");
    const stored = await opened.client.call({ type: "preview.feedback", payload: { workspaceId: opened.workspaceId, operation: { kind: "read", id } } });
    t.assertions.assert(stored?.type === "previewFeedback" && stored.data.kind === "receipt" && stored.data.data.annotations.length === 1 && stored.data.data.bundles.length === 1, "owner could not retrieve visitor evidence");
    await v.reload();
    await frame.locator("#target").waitFor();
    await v.getByRole("button", { name: "提交预览反馈", exact: true }).click();
    await receipt.waitFor();
    t.assertions.assert(await receipt.inputValue() === text, "reload redeemed no fresh proof or lost file receipt");
    await v.getByRole("button", { name: "关闭反馈", exact: true }).click();
    await v.getByRole("button", { name: "进入批注", exact: true }).click();
    await frame.locator("#target").click();
    await v.getByRole("textbox", { name: "批注", exact: true }).fill("Unsubmitted previous note");
    await v.getByRole("button", { name: "提交预览反馈", exact: true }).click();
    await v.getByRole("button", { name: "新的反馈", exact: true }).click();
    await v.getByRole("button", { name: "进入批注", exact: true }).waitFor();
    t.assertions.assert(await v.getByRole("button", { name: "进入批注", exact: true }).isVisible(), "new feedback retained the previous annotation mode");
    t.assertions.assert(await v.getByRole("textbox", { name: "批注", exact: true }).count() === 0, "new feedback retained a pending previous note");
    await v.getByRole("button", { name: "进入批注", exact: true }).click();
    await frame.locator("#target").click();
    await v.getByRole("textbox", { name: "批注", exact: true }).fill("Second visitor annotation");
    await v.getByRole("button", { name: "加入草稿", exact: true }).click();
    await v.getByRole("textbox", { name: "批注", exact: true }).waitFor({ state: "detached" });
    await v.getByRole("button", { name: "完成批注", exact: true }).click();
    await v.getByRole("button", { name: "提交预览反馈", exact: true }).click();
    await v.getByRole("textbox", { name: "反馈说明", exact: true }).fill("Second independent feedback");
    await v.getByRole("button", { name: "提交反馈", exact: true }).click();
    await receipt.waitFor();
    const secondText = await receipt.inputValue();
    const secondId = secondText.match(/pf_[a-f0-9]{32}/)![0];
    t.assertions.assert(secondId !== id && secondText.includes("Second visitor annotation") && !secondText.includes("Visitor annotation") && !secondText.includes("\n运行证据："), `new feedback evidence mismatch: ${JSON.stringify({sameId: secondId === id, notes: secondText.split("\n").filter(line => line.startsWith("批注 ")), hasOldLog: secondText.includes("\n运行证据：")})}`);
    const second = await opened.client.call({ type: "preview.feedback", payload: { workspaceId: opened.workspaceId, operation: { kind: "read", id: secondId } } });
    t.assertions.assert(second?.type === "previewFeedback" && second.data.kind === "receipt" && second.data.data.annotations.length === 1 && second.data.data.bundles.length === 0, "new file feedback did not start with independent evidence");
    const fragment = new URLSearchParams(new URL(shareUrl).hash.slice(1));
    const redeem = () => fetch(fragment.get("genehubPreviewRedeem")!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: fragment.get("genehubPreviewShare") }) });
    const dial = await (await redeem()).json();
    shared = new Client({ url: dial.url, fabricRouteTicket: dial.fabricRouteTicket, fabricAuthorizationExpiresAt: dial.fabricAuthorizationExpiresAt, channelCredential: { capabilityId: dial.channelCapability, secret: dial.channelSecret }, rtcEnabled: false, socketFactory: url => new WebSocket(url) as unknown as WebSocketLike });
    shared.connect(); await t.tools.waitUntil(() => shared!.connectionState === "ready", 45_000);
    for (const request of [{ type: "workspace.list" as const }, { type: "session.list" as const, payload: { workspaceId: opened.workspaceId, includeArchived: false } }]) {
      let denied = false; try { await shared.call(request); } catch { denied = true; }
      t.assertions.assert(denied, `share admitted machine RPC ${request.type}`);
    }
    let denied = false;
    try { await shared.preview(opened.workspaceId, `${opened.rootHandle}/private.txt`); } catch { denied = true; }
    t.assertions.assert(denied, "share leaked an unrelated file");
    await page.getByRole("button", { name: "撤销分享", exact: true }).click();
    denied = false;
    try { await shared.preview(opened.workspaceId, entryPath); } catch { denied = true; }
    t.assertions.assert(denied, "existing peer retained preview access after revocation");
    await consumer.close(); consumer = undefined;
    await owner.close(); owner = undefined;
    await visitor.close(); visitor = undefined;
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    opened.mock.script({text: "[review.html](review.html)"});
    await t.flows.main.sendPrompt(opened.client, session, "Show the preview entry.");
    pwa = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened!.daemon), opened.workspaceId, session, {
      viewport: {width: 320, height: 775}, hasTouch: true, isMobile: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    }, {trace: false});
    await pwa.context.addInitScript(() => Object.defineProperty(navigator, "standalone", {value: true}));
    await pwa.page.reload();
    await pwa.page.getByRole("link", {name: "review.html", exact: true}).first().click();
    await pwa.page.getByRole("button", {name: "在浏览器打开预览", exact: true}).click();
    await pwa.page.getByText("链接授权时间：1h", {exact: true}).waitFor();
    await pwa.page.getByRole("textbox", {name: "预览分享链接", exact: true}).waitFor();
    t.assertions.assert(await pwa.page.getByLabel("分享授权时间", {exact: true}).count() === 0, "PWA shortcut does not enforce its 1h default");
    t.assertions.assert(await pwa.page.getByRole("dialog", {name: "文件预览", exact: true}).isVisible(), "PWA external open minimized the original preview");
    await pwa.page.getByRole("button", {name: "关闭分享", exact: true}).click();
    await pwa.page.getByRole("button", {name: "最小化", exact: true}).click();
    await pwa.page.getByRole("button", {name: "最大化预览", exact: true}).waitFor();
    t.note("Fresh anonymous Cloud console and real Fabric peer: Unicode H5 fetch, annotation, bounded logs, persistent copied receipt, reload redemption, outside-file/machine-RPC rejection and immediate revocation. iOS standalone branch creates a 1h link and stays expanded until explicit minimize. Chromium platform simulation; no real iPhone certification.");
  } finally {
    shared?.close(); await pwa?.close(); await consumer?.close(); await visitor?.close(); await owner?.close();
    opened?.client.close(); opened?.daemon.stop(); await opened?.mock.stop(); relay?.stop(); await hub.stop();
  }
});
