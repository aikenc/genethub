import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openMultichannelBrowser, startFaultLink, daemonEndpoint, connectProductClient, runGenet } from "../../framework/public.ts";

const meta = (name: string, oracle: string, ms: number) => ({
  id: `specialty.multichannel.review-${name}`, title: oracle, oracle,
  catches: [oracle], tags: ["network-review-experiment", "multichannel", "page-experience"],
  runner: "playwright" as const, llm: { default: "none" as const },
  expectedDurationMs: ms, timeoutMs: ms + 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 1280, io: 1, browser: 1, pool: "browser" as const },
  surfaces: ["browser", "daemon", "relay"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
});

defineSpecialty(meta("rtc-preview-pacing",
  "A preview proven to traverse native RTC does not open the shared Fabric pacing window", 30000), async t => {
  t.env.env.GENEHUB_LOCAL_LOG = "warn,genet_daemon::dataplane::uplink_pace=info";
  const bytes = randomBytes(8 * 1024 * 1024);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  writeFileSync(join(t.env.workspace, "rtc-review.png"), bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const stack = await openMultichannelBrowser(t);
  try {
    const logical = await stack.page.evaluate(() => (window as any).mc.client.logicalConnectionId);
    await stack.rtc();
    // Cut the real Fabric socket: a successful transfer now proves RTC, not
    // merely the label recorded at request start.
    stack.fabric.block();
    const before = stack.fabric.bytes();
    const result = await stack.page.evaluate(async ({workspace, path}) => {
      const m = (window as any).mc;
      const r = await m.client.preview(workspace, path);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", r.bytes)))
        .map(n => n.toString(16).padStart(2, "0")).join("");
      return { bytes: r.bytes.length, hash, logical: m.client.logicalConnectionId,
        operation: m.operations.filter((o: any) => o.operation === "asset.preview").at(-1) };
    }, {workspace: stack.opened.workspaceId, path: `${stack.opened.rootHandle}/rtc-review.png`});
    const support = await stack.page.evaluate(() => (window as any).mc.client.diagnostics());
    t.assertions.assert(support.events.some((e: any) => e.operation === "data.endpoint" && e.code === "rtc" && e.outcome === "online"), "active RTC path is missing from support snapshot");
    const after = stack.fabric.bytes();
    const log = readFileSync(join(t.env.data, "logs", "daemon.log"), "utf8");
    const pace = log.split("\n").filter(line => line.includes('event="uplink_pace"'));
    const summary = `bytes=${result.bytes} digestMatches=${result.hash === digest} retained=${result.logical === logical} transport=${result.operation?.transport} fabricServerDelta=${after.server - before.server} paceEvents=${pace.length}; ${pace.join(" | ")}`;
    t.note(summary);
    t.assertions.assert(result.hash === digest && result.logical === logical && result.operation?.transport === "rtc",
      `native RTC preview path not proven: ${summary}`);
    t.assertions.assert(after.server - before.server < 65536, `payload crossed blocked Fabric: ${summary}`);
    t.assertions.assert(pace.length === 0, `RTC preview changed shared Fabric pacing: ${summary}`);
  } finally { await stack.stop(); }
});

defineSpecialty(meta("rtc-pause-survives-reconnect",
  "After three native RTC failures, a Fabric reconnect without a page or network lifecycle event does not restart RTC", 110000), async t => {
  if (!t.browser) throw new Error("native Chromium is required");
  // Real Chromium network policy disables direct UDP for this isolated browser.
  // Unlike CDP packetLoss, this also constrains local host candidate gathering.
  const browser = await t.browser.browser()!.browserType().launch({
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  });
  let stack: Awaited<ReturnType<typeof openMultichannelBrowser>> | undefined;
  try {
    stack = await openMultichannelBrowser(t, "rendezvous", await browser.newContext());
    await stack.page.evaluate(() => (window as any).mc.client.setRtcEnabled(true));
    await stack.page.waitForFunction(() => (window as any).mc.diagnostics.some((e: any) =>
      e.kind === "rtc" && e.detail.phase === "paused"), null, { timeout: 110000 }).catch(async error => {
        const observed = await stack!.page.evaluate(() => {
          const m = (window as any).mc;
          return {state: m.client.connectionState, rtc: m.client.rtcState, upgrades: m.rtcUpgrades, diagnostics: m.diagnostics};
        });
        throw new Error(`${error}; native fault evidence=${JSON.stringify(observed)}`);
      });
    const before = await stack.page.evaluate(() => ({
      starts: (window as any).mc.rtcUpgrades.filter((e: any) => e.phase === "start").length,
      failures: (window as any).mc.rtcUpgrades.filter((e: any) => e.phase === "finish" && e.outcome !== "ok").length,
      visible: document.visibilityState,
    }));
    await stack.page.waitForTimeout(3000);
    stack.fabric.block();
    await stack.page.waitForFunction(() => (window as any).mc.client.connectionState !== "ready", null, {timeout: 10000});
    stack.fabric.unblock();
    await stack.page.waitForFunction(() => (window as any).mc.client.connectionState === "ready", null, {timeout: 25000});
    await stack.page.waitForTimeout(2000);
    const after = await stack.page.evaluate(() => ({
      starts: (window as any).mc.rtcUpgrades.filter((e: any) => e.phase === "start").length,
      visible: document.visibilityState,
    }));
    const summary = JSON.stringify({before, after});
    t.note(summary);
    t.assertions.assert(before.failures >= 3 && before.visible === "visible" && after.visible === "visible", summary);
    t.assertions.assert(after.starts === before.starts, `RTC restarted despite pause: ${summary}`);
    await stack.page.evaluate(() => {
      const client = (window as any).mc.client;
      client.setRtcEnabled(false); client.setRtcEnabled(true);
    });
    await stack.page.waitForFunction(starts => (window as any).mc.rtcUpgrades.filter((e: any) => e.phase === "start").length > starts,
      after.starts, {timeout: 5000});
  } finally { try { await stack?.stop(); } finally { await browser.close(); } }
});


defineSpecialty(meta("inflight-preview-rtc-fallback",
  "An in-flight native RTC preview falls back through Fabric in the same logical session without refetching or corrupting content", 40000), async t => {
  const bytes = randomBytes(48 * 1024 * 1024);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  writeFileSync(join(t.env.workspace, "fallback.png"), bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const stack = await openMultichannelBrowser(t);
  try {
    await stack.rtc();
    const logical = await stack.page.evaluate(() => (window as any).mc.client.logicalConnectionId);
    await stack.page.evaluate(({workspace, path}) => {
      const m = (window as any).mc;
      m.pendingPreview = m.client.preview(workspace, path).then(async (r: any) => {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", r.bytes)))
          .map(n => n.toString(16).padStart(2, "0")).join("");
        m.previewResult = {hash, bytes: r.bytes.length, logical: m.client.logicalConnectionId};
      }, (error: Error) => {m.previewError = error.message;});
    }, {workspace: stack.opened.workspaceId, path: `${stack.opened.rootHandle}/fallback.png`});
    await stack.page.waitForFunction(async () => {
      for (const peer of (window as any).nativePeers) {
        for (const stat of (await peer.getStats()).values()) {
          if (stat.type === "data-channel" && stat.bytesReceived > 256 * 1024) return true;
        }
      }
      return false;
    }, null, {timeout: 20000});
    t.assertions.assert(await stack.page.evaluate(() => !(window as any).mc.previewResult), "preview finished before RTC failure");
    const before = stack.fabric.bytes();
    const began = performance.now();
    await stack.cutRtc();
    await stack.page.waitForFunction(() => (window as any).mc.previewResult || (window as any).mc.previewError, null, {timeout: 45000});
    const result = await stack.page.evaluate(() => ({result: (window as any).mc.previewResult, error: (window as any).mc.previewError}));
    const fabricBytes = stack.fabric.bytes().server - before.server;
    t.note(JSON.stringify({result, fabricBytes, elapsedAfterFaultMs: Math.round(performance.now()-began)}));
    t.assertions.assert(!result.error && result.result?.hash === digest && result.result?.logical === logical,
      `in-flight fallback failed: ${JSON.stringify(result)}`);
    t.assertions.assert(fabricBytes > 65536, "remaining preview never traversed Fabric");
  } finally { await stack.stop(); }
});


for (const losses of [1, 2]) {
defineSpecialty({
  ...meta(losses === 1 ? "preview-session-loss" : "preview-retry-bounded", "A read-only preview gets one fresh read after daemon session loss, without mixing file versions or waiting out the old head timeout", 20000),
  runner: "node", resources: {environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard"},
}, async t => {
  const file = join(t.env.workspace, "restart.png");
  const original = randomBytes(1024 * 1024); Buffer.from([137,80,78,71,13,10,26,10]).copy(original);
  writeFileSync(file, original);
  const opened = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
  const link = await startFaultLink(daemonEndpoint(opened.daemon).url);
  let activeLink = link;
  const links = [link];
  const diagnostics: any[] = [];
  const endpoint = daemonEndpoint(opened.daemon);
  const client = await connectProductClient({...endpoint, url: link.urlFor(endpoint.url),
    onDiagnostic: event => {
      if (event.kind === "operation" || event.kind === "error") diagnostics.push(event);
      if (losses === 2 && event.kind === "operation" && event.detail.operation === "asset.preview" && event.detail.phase === "start" && diagnostics.filter(e => e.kind === "operation" && e.detail.operation === "asset.preview" && e.detail.phase === "start").length === 2) {
        activeLink.blackhole("server");
      }
    },
    redial: async () => {
      const fresh = daemonEndpoint(opened.daemon);
      activeLink = await startFaultLink(fresh.url); links.push(activeLink);
      return {...fresh, url: activeLink.urlFor(fresh.url)};
    },
  });
  try {
    const oldId = client.logicalConnectionId;
    link.blackhole("server");
    const oldBytes = link.heldBytes().server;
    const began = performance.now();
    const preview = client.preview(opened.workspaceId, `${opened.rootHandle}/restart.png`);
    void preview.catch(() => {});
    await t.tools.waitUntil(() => link.heldBytes().server > oldBytes, 10000);
    const replacement = randomBytes(original.length); Buffer.from([137,80,78,71,13,10,26,10]).copy(replacement);
    writeFileSync(file, replacement);
    const restart = runGenet(opened.daemon.genet, ["daemon", "restart"], opened.daemon.env);
    t.assertions.assert(restart.code === 0, "isolated daemon restart failed");
    link.cut();
    if (losses === 2) {
      await t.tools.waitUntil(() => activeLink !== link && activeLink.heldBytes().server > 0 && diagnostics.filter(e => e.kind === "operation" && e.detail.operation === "asset.preview" && e.detail.phase === "start").length === 2, 15000);
      const again = runGenet(opened.daemon.genet, ["daemon", "restart"], opened.daemon.env);
      t.assertions.assert(again.code === 0, "second isolated daemon restart failed");
      activeLink.cut();
      const outcome = await preview.then(() => "unexpected success", error => error instanceof Error ? error.message : String(error));
      const attempts = diagnostics.filter(e => e.kind === "operation" && e.detail.operation === "asset.preview" && e.detail.phase === "start").length;
      t.note(JSON.stringify({attempts, outcome, elapsedMs: Math.round(performance.now() - began)}));
      t.assertions.assert(outcome === "SessionLost" && attempts === 2, "a second lost session must fail without a third preview read");
      return;
    }
    const result = await preview;
    const elapsedMs = performance.now() - began;
    const matches = createHash("sha256").update(result.bytes).digest("hex") === createHash("sha256").update(replacement).digest("hex");
    const attempts = diagnostics.filter(e => e.kind === "operation" && e.detail.operation === "asset.preview" && e.detail.phase === "start").length;
    t.note(JSON.stringify({matches, attempts, elapsedMs: Math.round(elapsedMs), changedSession: oldId !== client.logicalConnectionId}));
    t.assertions.assert(matches && oldId !== client.logicalConnectionId && attempts === 2, "preview did not recover as one complete fresh version");
    t.assertions.assert(elapsedMs < 15000, `preview waited ${elapsedMs}ms instead of failing/recovering promptly`);
  } finally {client.close(); await Promise.all(links.map(link => link.stop())); opened.client.close(); opened.daemon.stop(); await opened.mock.stop();}
});
}
