import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineSpecialty, openMultichannelBrowser, allocatePort, registerControlledAgent, readControlledAgentJournal } from "../../framework/public.ts";

const meta = (name: string, title: string, oracle: string, duration = 30000) => ({
  id: `specialty.multichannel.${name}`, title, oracle, catches: [title],
  tags: ["network-risk-v2", "multichannel", "page-experience", name], runner: "playwright" as const, llm: { default: "none" as const },
  expectedDurationMs: duration, timeoutMs: duration + 120000,
  resources: { environments: 1, cpu: 2, memoryMb: 1280, io: 1, browser: 1, pool: "browser" as const },
  surfaces: ["browser", "daemon", "relay", "cloud-server"], productInterfaces: ["@genehub/workbench/client", "hub-http"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
});
defineSpecialty(meta("hosted-live-revocation", "Revoking a Hosted session stops its already active RTC access",
  "After public session revoke, fresh admission fails and the active browser stops successful RPC within the proposed 5-second revocation SLO"), async t => {
  const stack = await openMultichannelBrowser(t, "hosted");
  try {
    await stack.rtc();
    const before = await stack.page.evaluate(async () => (await (window as any).mc.client.call({ type: "workspace.list" }))?.type);
    t.assertions.assert(before === "workspaces", "pre-revocation RTC RPC failed");
    await stack.revoke!();
    const admission = await stack.admissionStatus!();
    t.assertions.assert(admission === 401 || admission === 403, "revoked session still receives fresh admission");
    await new Promise(r => setTimeout(r, 5500));
    const probe = await stack.page.evaluate(async () => {
      try { return (await (window as any).mc.client.call({ type: "workspace.list" }))?.type === "workspaces"; }
      catch (e: any) { const c = (window as any).mc.client; if (c.connectionState === "closed" || /unauthorized|forbidden|permissionDenied/i.test(String(e?.detail?.code ?? ""))) return false; throw e; }
    });
    t.assertions.assert((await stack.opened.client.call({ type: "workspace.list" }))?.type === "workspaces", "independent owner unhealthy after revocation");
    t.assertions.assert(!probe, "revoked Hosted source still performs business RPC over active RTC after 5 seconds");
  } finally { await stack.stop(); }
});
defineSpecialty(meta("hosted-lease-renewal", "A legal Hosted client retains its subscription across authorization expiry",
  "An original subscription receives sequenced title changes past a real 60-second route lease, without logical replacement or resubscription", 95000), async t => {
  const stack = await openMultichannelBrowser(t, "hosted");
  try {
    const sessionId = await t.flows.main.createBuiltinSession(stack.opened.client, stack.opened.workspaceId);
    await stack.page.evaluate(async id => {
      const m = (window as any).mc;
      await m.client.subscribe(id, { onEvent(e: unknown) { m.events.push(e); }, onResync() { m.repairs++; } });
      m.id = m.client.logicalConnectionId;
    }, sessionId);
    await stack.rtc();
    const expiry = Date.parse(stack.expiry() ?? "");
    t.assertions.assert(Number.isFinite(expiry), "real Hosted expiry missing");
    const expected: string[] = [];
    // Cross the real lease; do not alter client clocks or registry state.
    while (Date.now() < expiry + 5000) {
      const title = "lease-" + expected.length;
      expected.push(title);
      await stack.opened.client.call({ type: "session.rename", payload: { sessionId, title } });
      await stack.page.waitForFunction(value => (window as any).mc.events.some((e: any) => e.event.type === "titleChanged" && e.event.title === value), title, { timeout: 12000 });
      await new Promise(r => setTimeout(r, 1000));
    }
    t.note(`crossedLease=true ticketsIssued=${stack.issued()}`);
    const renewed = stack.leases().some(lease => Date.parse(lease.expiresAt) > expiry && lease.receivedAt > expiry - 55000);
    t.assertions.assert(renewed, "continued access without a newly issued lease whose expiry advances");
    const observed = await stack.page.evaluate(() => (window as any).mc.events.filter((e: any) => e.event.type === "titleChanged").map((e: any) => e.event.title));
    t.assertions.assert(JSON.stringify(observed) === JSON.stringify(expected), "renewal lost, duplicated or reordered events on the original subscription");
    const retained = await stack.page.evaluate(() => {
      const m = (window as any).mc; return m.client.logicalConnectionId === m.id && m.repairs === 0;
    });
    t.assertions.assert(retained, "authorization renewal rebuilt the original business subscription");
  } finally { await stack.stop(); }
});
defineSpecialty(meta("direct-preview-resume", "Direct-only preview resumes the original response after RTC loss",
  "A real registered service sees one HTTP request; its original response delivers 0..19 exactly once after native RTC failure, without issuing another fetch", 40000), async t => {
  const stack = await openMultichannelBrowser(t);
  let runner: ReturnType<typeof spawn> | undefined;
  try {
    const port = await allocatePort();
    const backendFile = join(t.env.workspace, "backend.mjs");
    const starts = join(t.env.workspace, "http-requests");
    await writeFile(backendFile, `
import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';
createServer((req,res)=>{
 if(req.url==='/health'){res.end('ok');return}
 appendFileSync('http-requests','request\\n');
 res.writeHead(200,{'content-type':'text/plain'});let n=0;res.write(n+++'\\n');
 const timer=setInterval(()=>{res.write(n+++'\\n');if(n===20){clearInterval(timer);res.end()}},500);
 res.on('close',()=>clearInterval(timer));
}).listen(${port},'127.0.0.1');
`);
    await writeFile(join(t.env.workspace, "index.html"), "<!doctype html><title>Direct service</title>");
    const config = join(t.env.workspace, "preview.json");
    await writeFile(config, JSON.stringify({ entry: "index.html", dataPolicy: "direct-only",
      backends: [{ command: [process.execPath, backendFile], origin: `http://127.0.0.1:${port}`, health: "/health", routes: [{ prefix: "/api/stream/" }] }] }));
    runner = spawn(process.execPath, [join(t.openRoot, "apps/daemon/builtin-skills/genehub-preview/assets/node-adapter/run.mjs"), "--config", config, "--daemon-root", t.env.data], { stdio: ["ignore", "pipe", "pipe"] });
    let tail = ""; runner.stderr?.on("data", b => { tail = (tail + b).slice(-1000); });
    await stack.rtc();
    await stack.page.evaluate(async ({ workspace, entry }) => {
      const m = (window as any).mc;
      for (let i = 0; i < 100; i++) {
        m.service = await m.ServicePreviewClient.discover(m.client, workspace, entry);
        if (m.service) return;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error("registered service did not appear");
    }, { workspace: stack.opened.workspaceId, entry: `${stack.opened.rootHandle}/index.html` }).catch(e => { throw new Error(`${e}; adapter ${tail}`); });
    await stack.page.evaluate(() => {
      const m = (window as any).mc; m.text = ""; m.finished = false; m.error = "";
      void (async () => {
        try {
          const response = await m.service.fetch("/api/stream/");
          const reader = response.body.getReader(), decoder = new TextDecoder();
          for (;;) { const r = await reader.read(); if (r.done) break; m.text += decoder.decode(r.value, { stream: true }); }
          m.finished = true;
        } catch (e) { m.error = String(e); }
      })();
    });
    await stack.page.waitForFunction(() => (window as any).mc.text.includes("0\n"), null, { timeout: 10000 });
    await stack.cutRtc();
    await stack.page.waitForFunction(() => (window as any).mc.finished || !!(window as any).mc.error, null, { timeout: 30000 });
    const result = await stack.page.evaluate(() => ({ text: (window as any).mc.text, error: (window as any).mc.error }));
    const requests = readFileSync(starts, "utf8").trim().split("\n").length;
    t.note(`serviceRequests=${requests} receivedLines=${result.text.trim().split("\n").length}`);
    t.assertions.assert(!result.error, `original direct preview failed instead of resuming: ${result.error}`);
    t.assertions.assert(requests === 1 && result.text === Array.from({ length: 20 }, (_, i) => `${i}\n`).join(""), "preview replayed HTTP or lost response data");
  } finally {
    runner?.kill("SIGTERM"); await stack.stop();
  }
});

defineSpecialty(meta("hosted-revoked-lease-expiry", "A revoked Hosted source cannot keep RTC access past the original lease",
  "Public revocation rejects fresh admission and successful business RPC stops no later than the original 60-second lease plus 5 seconds", 95000), async t => {
  const stack = await openMultichannelBrowser(t, "hosted");
  try {
    await stack.rtc();
    const expiry = Date.parse(stack.expiry() ?? "");
    t.assertions.assert(Number.isFinite(expiry), "real route expiry missing");
    await stack.revoke!();
    const admission = await stack.admissionStatus!();
    t.assertions.assert(admission === 401 || admission === 403, "revoked session still receives fresh admission");
    while (Date.now() < expiry + 5000) await new Promise(r => setTimeout(r, 1000));
    const accepted = await stack.page.evaluate(async () => {
      try { return (await (window as any).mc.client.call({ type: "workspace.list" }))?.type === "workspaces"; }
      catch (e: any) { const c = (window as any).mc.client; if (c.connectionState === "closed" || /unauthorized|forbidden|permissionDenied/i.test(String(e?.detail?.code ?? ""))) return false; throw e; }
    });
    t.note(`expiredByMs=${Date.now() - expiry} successfulAdmissionCount=${stack.issued()}`);
    t.assertions.assert((await stack.opened.client.call({ type: "workspace.list" }))?.type === "workspaces", "independent owner unhealthy at lease expiry");
    t.assertions.assert(!accepted, "revoked source still performs RPC after original authorization expiry");
  } finally { await stack.stop(); }
});

defineSpecialty(meta("both-paths-subscription", "An original subscription catches up after both physical paths fail",
  "Native RTC and opaque Fabric TCP both close; original subscription receives all ten ordered unique mutations after Fabric recovers, without resubscription", 40000), async t => {
  const stack = await openMultichannelBrowser(t);
  try {
    const sessionId = await t.flows.main.createBuiltinSession(stack.opened.client, stack.opened.workspaceId);
    await stack.page.evaluate(async id => {
      const m = (window as any).mc;
      await m.client.subscribe(id, { onEvent(e: unknown) { m.events.push(e); }, onResync() { m.repairs++; } });
      m.id = m.client.logicalConnectionId;
    }, sessionId);
    await stack.rtc();
    await stack.page.evaluate(() => (window as any).mc.client.call({ type: "workspace.list" }));
    t.assertions.assert(await stack.page.evaluate(() => (window as any).mc.operations.some((o: any) => o.transport === "rtc" && o.outcome === "ok")), "ordinary business never used native RTC");
    const before = stack.fabric.connections();
    stack.fabric.block(); await stack.cutRtc();
    await stack.page.waitForFunction(() => (window as any).mc.client.connectionState !== "ready", null, { timeout: 10000 });
    for (let n = 0; n < 10; n++) await stack.opened.client.call({ type: "session.rename", payload: { sessionId, title: "outage-" + n } });
    t.assertions.assert(await stack.page.evaluate(() => !(window as any).mc.events.some((e: any) => e.event.title?.startsWith("outage-"))), "fault did not isolate both paths");
    stack.fabric.unblock();
    await stack.page.waitForFunction(() => (window as any).mc.events.filter((e: any) => e.event.type === "titleChanged" && e.event.title.startsWith("outage-")).length >= 10, null, { timeout: 25000 }).catch(async () => {
      const state = await stack.page.evaluate(() => {
        const m = (window as any).mc;
        return { state: m.client.connectionState, rtc: m.client.rtcState, retained: m.id === m.client.logicalConnectionId,
          repairs: m.repairs, titles: m.events.filter((e: any) => e.event.type === "titleChanged").map((e: any) => e.event.title), states: m.states.slice(-12) };
      });
      throw new Error("both-path recovery failed: " + JSON.stringify(state) + " fabricConnections=" + stack.fabric.connections());
    });
    const result = await stack.page.evaluate(() => {
      const m = (window as any).mc;
      return { retained: m.id === m.client.logicalConnectionId, repairs: m.repairs,
        titles: m.events.filter((e: any) => e.event.type === "titleChanged" && e.event.title.startsWith("outage-")).map((e: any) => e.event.title) };
    });
    t.assertions.assert(stack.fabric.connections() > before, "recovery never crossed a replacement physical connection");
    t.assertions.assert(result.retained && result.repairs === 0, "recovery replaced business ownership");
    t.assertions.assert(JSON.stringify(result.titles) === JSON.stringify(Array.from({ length: 10 }, (_, n) => "outage-" + n)), "events lost, duplicated or reordered");
    await stack.page.evaluate(async id => { const m = (window as any).mc; await m.client.unsubscribe(id); m.events.length = 0; }, sessionId);
    await stack.opened.client.call({ type: "session.rename", payload: { sessionId, title: "after-unsubscribe" } });
    await stack.page.evaluate(() => (window as any).mc.client.call({ type: "workspace.list" }));
    await new Promise(r => setTimeout(r, 500));
    t.assertions.assert(await stack.page.evaluate(() => (window as any).mc.events.length === 0), "recovered subscription ignored unsubscribe");
  } finally { await stack.stop(); }
});

for (const rtc of [false, true]) {
  defineSpecialty(meta("revoked-write-" + (rtc ? "rtc" : "fabric"), "Revoked " + (rtc ? "RTC" : "Fabric") + " access cannot modify workspace files",
    "A real Hosted client writes a control file before revocation; fresh admission is denied, attempted later write fails and never appears on disk"), async t => {
    const stack = await openMultichannelBrowser(t, "hosted");
    try {
      if (rtc) await stack.rtc();
      const request = { type: "file.write", payload: { workspaceId: stack.opened.workspaceId, path: stack.opened.rootHandle + "/before-revoke.txt", content: "allowed" } };
      await stack.page.evaluate(async r => { await (window as any).mc.client.call(r); }, request);
      t.assertions.assert(readFileSync(join(stack.opened.workspaceRoot, "before-revoke.txt"), "utf8") === "allowed", "authorized control mutation failed");
      const transport = await stack.page.evaluate(() => (window as any).mc.operations.findLast((o: any) => o.operation === "file.write")?.transport);
      t.assertions.assert(rtc ? transport === "rtc" : transport !== "rtc", "pre-revocation write used an unexpected carrier");
      await stack.revoke!();
      const status = await stack.admissionStatus!();
      t.assertions.assert(status === 401 || status === 403, "revoked session received fresh admission");
      await new Promise(r => setTimeout(r, 5500));
      request.payload.path = stack.opened.rootHandle + "/after-revoke.txt";
      const denied = await stack.page.evaluate(async r => { try { await (window as any).mc.client.call(r); return false; } catch { return true; } }, request);
      const mutated = existsSync(join(stack.opened.workspaceRoot, "after-revoke.txt"));
      t.note("postRevokeDenied=" + denied + " diskMutation=" + mutated);
      t.assertions.assert(denied && !mutated, "revoked file protection failed: denied=" + denied + " diskMutation=" + mutated);
      t.assertions.assert((await stack.opened.client.call({ type: "workspace.list" }))?.type === "workspaces", "revocation damaged independent owner");
    } finally { await stack.stop(); }
  });
}

for (const rtc of [false, true]) {
  defineSpecialty(meta("revoked-existing-streams-" + (rtc ? "rtc" : "fabric"), "Revocation retires an existing subscription and running command",
    "A live subscribed session and started command stop after public revocation; a delayed disk mutation never occurs and an independent owner continues renaming the session", 30000), async t => {
    const stack = await openMultichannelBrowser(t, "hosted");
    try {
      const id = await t.flows.main.createBuiltinSession(stack.opened.client, stack.opened.workspaceId);
      await stack.page.evaluate(async id => {
        const m = (window as any).mc;
        await m.client.subscribe(id, { onEvent(e: unknown) { m.events.push(e); } });
      }, id);
      if (rtc) await stack.rtc();
      await stack.opened.client.call({ type: "session.rename", payload: { sessionId: id, title: "authorized-event" } });
      await stack.page.waitForFunction(() => (window as any).mc.events.some((e: any) => e.event.title === "authorized-event"), null, { timeout: 5000 });
      await stack.page.evaluate(async request => {
        const m = (window as any).mc;
        m.running = m.client.openShellStream(request); await m.running.finish(); await m.running.responseHead;
        m.streamEnded = false;
        void m.running.done.then(() => { m.streamEnded = true; }, () => { m.streamEnded = true; });
      }, { workspaceId: stack.opened.workspaceId, cwd: stack.opened.workspaceRoot, timeoutMs: 20000,
        argv: ["python3", "-c", "import pathlib,time; pathlib.Path('revoked-start').write_text('started'); time.sleep(8); pathlib.Path('revoked-effect').write_text('bad')"] });
      await t.tools.waitUntil(() => existsSync(join(stack.opened.workspaceRoot, "revoked-start")), 5000);
      const revokedAt = Date.now(); await stack.revoke!();
      const status = await stack.admissionStatus!();
      t.assertions.assert(status === 401 || status === 403, "revoked session retained admission");
      await stack.page.waitForFunction(() => (window as any).mc.client.connectionState === "closed" && (window as any).mc.streamEnded, null, { timeout: 5500 });
      for (let n = 0; n < 3; n++) await stack.opened.client.call({ type: "session.rename", payload: { sessionId: id, title: "denied-event-" + n } });
      await new Promise(r => setTimeout(r, Math.max(1000, revokedAt + 9000 - Date.now())));
      t.assertions.assert(!existsSync(join(stack.opened.workspaceRoot, "revoked-effect")), "revoked running command still mutated disk");
      t.assertions.assert(await stack.page.evaluate(() => !(window as any).mc.events.some((e: any) => e.event.title?.startsWith("denied-event-"))), "revoked subscription delivered new events");
      t.assertions.assert((await stack.opened.client.call({ type: "workspace.list" }))?.type === "workspaces", "revocation damaged the independent owner");
    } finally { await stack.stop(); }
  });
}

for (const useRtc of [false, true]) defineSpecialty({
  ...meta("hosted-renewal-continuity-" + (useRtc ? "rtc" : "fabric"),
    "Five real Hosted renewals preserve responsive business access",
    "Across five newly issued leases, public RPC stays under one second, connection state remains ready and the original subscription receives exact ordered events", 180000),
  tags: ["multichannel", "network-risk-v2", "merge-risk", "renewal-continuity"],
}, async t => {
  const stack = await openMultichannelBrowser(t, "hosted");
  try {
    const id = await t.flows.main.createBuiltinSession(stack.opened.client, stack.opened.workspaceId);
    if (useRtc) await stack.rtc();
    await stack.page.evaluate(async id => {
      const m = (window as any).mc;
      await m.client.subscribe(id, { onEvent(e: unknown) { m.events.push(e); }, onResync() { m.repairs++; } });
      m.originalId = m.client.logicalConnectionId; m.states.length = 0;
    }, id);
    const initial = stack.issued(), expected: string[] = [];
    let maxRpcMs = 0;
    const deadline = Date.now() + 210000;
    while (stack.issued() < initial + 5 && Date.now() < deadline) {
      const probe = await stack.page.evaluate(async () => {
        const m = (window as any).mc, started = performance.now();
        const reply = await m.client.call({ type: "workspace.list" });
        return { ms: performance.now() - started, type: reply?.type, states: [...m.states] };
      });
      maxRpcMs = Math.max(maxRpcMs, probe.ms);
      t.assertions.assert(probe.type === "workspaces" && probe.ms < 1000, "healthy renewal delayed business RPC: " + probe.ms + "ms");
      t.assertions.assert(probe.states.every((s: string) => s === "ready"), "healthy renewal advertised connection loss: " + probe.states);
      const title = "continuous-" + expected.length; expected.push(title);
      await stack.opened.client.call({ type: "session.rename", payload: { sessionId: id, title } });
      await stack.page.waitForFunction(title => (window as any).mc.events.some((e: any) => e.event.title === title), title, { timeout: 3000 });
      await new Promise(r => setTimeout(r, 200));
    }
    await new Promise(r => setTimeout(r, 1000));
    const actual = await stack.page.evaluate(() => {
      const m = (window as any).mc;
      return { retained: m.originalId === m.client.logicalConnectionId, repairs: m.repairs, states: m.states,
        titles: m.events.filter((e: any) => e.event.type === "titleChanged").map((e: any) => e.event.title) };
    });
    t.note(`renewals=${stack.issued() - initial} maxRpcMs=${Math.round(maxRpcMs)} events=${expected.length}`);
    t.assertions.assert(stack.issued() >= initial + 5, "five real lease renewals did not occur");
    t.assertions.assert(actual.retained && actual.repairs === 0 && actual.states.every((s: string) => s === "ready"), "renewal replaced or interrupted the business owner");
    t.assertions.assert(JSON.stringify(actual.titles) === JSON.stringify(expected), "renewal lost, duplicated or reordered subscription events");
  } finally { await stack.stop(); }
});

defineSpecialty({
  ...meta("hosted-rtc-residency-on-renewal", "Hosted RTC stays the business path across real authorization renewals",
    "With an unresponsive STUN server, two RTC channels connect within 25 seconds through host candidates; two real Hosted renewals then keep at least 95% of business RPC and observed time on RTC, with no new SDP negotiation or fallback over one second", 110000),
  catches: ["authorization renewal repeatedly displaces a healthy RTC path", "serial candidate gathering delays both RTC channels", "slow candidate gathering leaves RTC active only briefly"],
  tags: ["multichannel", "network-risk-v2", "renewal-continuity", "rtc-residency"],
  timeoutMs: 240000,
}, async t => {
  // A UDP endpoint that receives STUN requests without answering is an external
  // network fault. Chromium, Hub, Relay and the daemon remain real product paths.
  const blackhole = createSocket("udp4");
  let stunRequests = 0;
  blackhole.on("message", () => { stunRequests++; });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    blackhole.once("error", failed);
    blackhole.bind(0, "127.0.0.1", () => { blackhole.off("error", failed); resolve(); });
  });
  const stunUrl = `stun:127.0.0.1:${blackhole.address().port}`;
  const iceKeys = ["HUB_ICE_SERVERS", "HUB_DEV_ICE_SERVERS", "HUB_BETA_ICE_SERVERS"] as const;
  const previousIce = iceKeys.map(key => process.env[key]);
  for (const key of iceKeys) process.env[key] = JSON.stringify([stunUrl]);
  let stack: Awaited<ReturnType<typeof openMultichannelBrowser>> | undefined;
  try {
    stack = await openMultichannelBrowser(t, "hosted");
    await stack.page.evaluate(() => {
      const m = (window as any).mc;
      const monitor = { startedAt: 0, startedWallAt: 0, lastAt: 0, lastState: "", rtcMs: 0, awaySince: 0, maxAwayMs: 0,
        transitions: [] as Array<{ atMs: number; state: string }>, initialConnectionStates: m.states.length };
      m.rtcMonitor = monitor;
      m.stopRtcMonitor = m.client.onRtcStateChange((state: string) => {
        const now = performance.now();
        if (!monitor.startedAt) {
          if (state !== "connected") return;
          monitor.startedAt = now; monitor.startedWallAt = Date.now(); monitor.lastAt = now; monitor.lastState = state;
          return;
        }
        if (monitor.lastState === "connected") monitor.rtcMs += now - monitor.lastAt;
        if (monitor.lastState === "connected" && state !== "connected") monitor.awaySince = now;
        if (monitor.lastState !== "connected" && state === "connected" && monitor.awaySince) {
          monitor.maxAwayMs = Math.max(monitor.maxAwayMs, now - monitor.awaySince); monitor.awaySince = 0;
        }
        monitor.lastAt = now; monitor.lastState = state;
        monitor.transitions.push({ atMs: Math.round(now - monitor.startedAt), state });
      });
      m.client.setRtcEnabled(true);
    });
    await stack.page.waitForFunction(() => (window as any).mc.rtcMonitor.startedAt > 0, null, { timeout: 80000 });
    const initialIssued = stack.issued();
    const probes: Array<{ ok: boolean; transport: string | null; ms: number }> = [];
    const deadline = Date.now() + 115000;
    while (stack.issued() < initialIssued + 2 && Date.now() < deadline) {
      probes.push(await stack.page.evaluate(async () => {
        const m = (window as any).mc, started = performance.now();
        try {
          const reply = await m.client.call({ type: "workspace.list" });
          return { ok: reply?.type === "workspaces",
            transport: m.operations.findLast((o: any) => o.operation === "workspace.list")?.transport ?? null,
            ms: Math.round(performance.now() - started) };
        } catch {
          return { ok: false, transport: null, ms: Math.round(performance.now() - started) };
        }
      }));
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    const measured = await stack.page.evaluate(() => {
      const m = (window as any).mc, watch = m.rtcMonitor, now = performance.now();
      m.stopRtcMonitor();
      const rtcMs = watch.rtcMs + (watch.lastState === "connected" ? now - watch.lastAt : 0);
      return { totalMs: Math.round(now - watch.startedAt), rtcMs: Math.round(rtcMs),
        startedWallAt: watch.startedWallAt,
        maxAwayMs: Math.round(Math.max(watch.maxAwayMs, watch.awaySince ? now - watch.awaySince : 0)),
        transitions: watch.transitions, connectionStates: m.states.slice(watch.initialConnectionStates),
        upgrades: m.rtcUpgrades, candidates: m.diagnostics.filter((e: any) => e.kind === "rtc" && "candidateHost" in e.detail)
          .map((e: any) => ({ host: e.detail.candidateHost, srflx: e.detail.candidateSrflx })),
        rtcTimings: m.diagnostics.filter((e: any) => e.kind === "rtc" && e.detail.milestone === "transportReady")
          .map((e: any) => ({ role: e.detail.channelRole, configMs: e.detail.configMs,
            gatherMs: e.detail.gatherMs, signalMs: e.detail.signalMs, channelMs: e.detail.channelMs,
            handshakeMs: e.detail.handshakeMs, totalMs: e.detail.totalMs })),
        serverTimings: m.diagnostics.filter((e: any) => e.kind === "rtc" && e.detail.milestone === "serverTiming")
          .map((e: any) => ({ role: e.detail.channelRole, configMs: e.detail.serverConfigMs,
            gatherMs: e.detail.serverGatherMs, answerMs: e.detail.serverAnswerMs })) };
    });
    const renewals = stack.issued() - initialIssued;
    const rtcProbes = probes.filter(probe => probe.ok && probe.transport === "rtc").length;
    const firstUpgradeMs = measured.upgrades.find((upgrade: any) => upgrade.phase === "finish" && upgrade.outcome === "ok")?.durationMs ?? null;
    const upgradeStarts = measured.upgrades.filter((upgrade: any) => upgrade.phase === "start").length;
    const renewalAtMs = stack.leases().slice(initialIssued).map(lease => lease.receivedAt - measured.startedWallAt);
    const maxRpcMs = Math.max(0, ...probes.map(probe => probe.ms));
    const summary = `renewals=${renewals} stunRequests=${stunRequests} firstUpgradeMs=${firstUpgradeMs} ` +
      `rtcResidentMs=${measured.rtcMs}/${measured.totalMs} rtcRpc=${rtcProbes}/${probes.length} ` +
      `maxAwayMs=${measured.maxAwayMs} maxRpcMs=${maxRpcMs} upgradeStarts=${upgradeStarts} ` +
      `renewalAtMs=${JSON.stringify(renewalAtMs)} ` +
      `transitions=${JSON.stringify(measured.transitions.slice(0, 12))} candidates=${JSON.stringify(measured.candidates.slice(0, 4))} ` +
      `rtcTimings=${JSON.stringify(measured.rtcTimings)} serverTimings=${JSON.stringify(measured.serverTimings)}`;
    t.note(summary);
    t.assertions.assert(stunRequests > 0 && firstUpgradeMs !== null, `STUN fault or real RTC upgrade was not exercised: ${summary}`);
    t.assertions.assert(firstUpgradeMs < 25_000, `blackholed STUN serialized RTC channel setup: ${summary}`);
    t.assertions.assert(renewals >= 2, `two real Hosted renewals did not occur: ${summary}`);
    t.assertions.assert(measured.connectionStates.every((state: string) => state === "ready") && probes.every(probe => probe.ok),
      `authorization renewal interrupted business access: ${summary}`);
    t.assertions.assert(measured.maxAwayMs < 1000 && measured.rtcMs / measured.totalMs >= 0.95 &&
      rtcProbes / probes.length >= 0.95 && upgradeStarts === 1 &&
      measured.transitions.every((transition: { state: string }) => transition.state !== "connecting"),
    `healthy RTC was displaced by authorization renewal: ${summary}`);
  } finally {
    await stack?.stop();
    for (const [index, key] of iceKeys.entries()) {
      const value = previousIce[index];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>(resolve => blackhole.close(() => resolve()));
  }
});

for (const path of ["fabric", "rtc"] as const) defineSpecialty({
  ...meta(`event-flood-${path}`, `A ${path} browser learns the terminal outcome after 4000 real Agent events`,
    "The original browser subscription converges through a terminal event or declared resync; its logical connection survives and public session.get reports idle", 45000),
  tags: ["multichannel", "network-risk-v2", "event-flood", `event-flood-${path}`],
}, async t => {
  const agent = registerControlledAgent(t.env, { profile: "flood-events", id: `browser-flood-${path}`, floods: 4000 });
  t.env.env.GENEHUB_LOCAL_LOG = "warn,genet_daemon::dataplane=debug";
  const stack = await openMultichannelBrowser(t);
  try {
    await t.flows.main.requireAgentReady(stack.opened.client, agent.agentId);
    const sessionId = await t.flows.main.createAgentSession(stack.opened.client, {
      workspaceId: stack.opened.workspaceId, agentId: agent.agentId, modelId: null,
    });
    if (path === "rtc") await stack.rtc();
    await stack.page.evaluate(async id => {
      const m = (window as any).mc; m.floodSettled = false; m.id = m.client.logicalConnectionId; m.states = []; m.diagnostics = [];
      await m.client.subscribe(id, {
        onEvent(e: any) { m.events.push(e); if (["turnCompleted", "turnFailed"].includes(e.event.type)) m.floodSettled = true; },
        onResync(snapshot: any) { m.repairs++; if (snapshot.summary.status === "idle") m.floodSettled = true; },
      });
    }, sessionId);
    await t.flows.main.sendPrompt(stack.opened.client, sessionId, "say a lot");
    await stack.page.waitForFunction(() => (window as any).mc.floodSettled, null, { timeout: 60000 });
    const result = await stack.page.evaluate(async id => {
      const m = (window as any).mc, reply = await m.client.call({ type: "session.get", payload: { sessionId: id } });
      return { idle: reply?.type === "snapshot" && reply.data.summary.status === "idle",
        same: m.client.logicalConnectionId === m.id, states: m.states, events: m.events.length, repairs: m.repairs, diagnostics: m.diagnostics };
    }, sessionId);
    t.assertions.assert(readControlledAgentJournal(agent).some(e => e.event === "answered" && e.floods === 4000), "Agent did not emit the required flood");
    t.assertions.assert(result.idle && result.same && !result.states.includes("reconnecting"), "legal event burst broke the original browser connection: " + JSON.stringify(result));
    t.note(JSON.stringify({ path, ...result }));
  } finally { await stack.stop(); }
});
