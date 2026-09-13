import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BlockedError,
  connectProductClient,
  defineSpecialty,
  startRelay,
} from "../../framework/public.ts";

// Fault sources: fb_XR0qEbstIxjW and fb_dr_jQLe1lL3t. Chromium is needed for
// native RTC, not to replace a daemon/client/transport with a browser mock.
defineSpecialty(
  {
    id: "specialty.connectivity.rtc-subscription-ownership",
    title: "Browser subscriptions remain live across RTC upgrades and fallback",
    oracle: "Real browser receives sequenced session events and completion over the same connection that owns its subscription with stable logical identity across RTC activation, relay outage and real RTC failure",
    catches: ["empty new conversation after RTC connects", "history snapshot without subsequent events", "RTC fallback loses subscription", "unsubscribe targets a different peer"],
    tags: ["network-risk-v2", "multichannel","page-experience", "rtc-subscriptions", "connectivity"],
    runner: "playwright",
    llm: { default: "mock" },
    expectedDurationMs: 30000,
    timeoutMs: 150000,
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 1, pool: "browser" },
    surfaces: ["browser", "relay", "daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  },
  async (t) => {
    if (!t.browser) throw new BlockedError("Chromium with native WebRTC required");
    if (process.platform === "win32") throw new BlockedError("Relay pause injection requires POSIX signals");
    const relay = await startRelay({ openRoot: t.openRoot });
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }).catch((error: unknown) => {
      relay.stop();
      throw error;
    });
    let server: { close(): Promise<void> } | undefined;
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const attached = await opened.client.call({
        type: "device.remoteAttach",
        payload: { relayUrl: relay.origin, joinToken: relay.joinToken },
      });
      if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl)
        throw new Error("Relay attachment did not return a rendezvous URL");
      const url = attached.data.rendezvousUrl;
      await t.tools.waitUntil(async () => {
        const devices = await opened.client.call({ type: "device.list" });
        return devices?.type === "devices" && devices.data.remote.online;
      }, 20000);
      const invite = await opened.client.call({ type: "device.invite", payload: null });
      if (invite?.type !== "invite") throw new Error("device.invite failed");
      const split = invite.data.code.indexOf(".");
      const inviteId = invite.data.code.slice(0, split);
      const pairing = await connectProductClient({
        url,
        inviteCredential: { inviteId, secret: invite.data.code.slice(split + 1) },
      });
      const credential = await (async () => {
        try {
          const reply = await pairing.call({ type: "device.claim", payload: { code: inviteId, deviceName: "rtc-browser" } });
          if (reply?.type !== "claimed") throw new Error("device.claim failed");
          return reply.data;
        } finally { pairing.close(); }
      })();
      const warmSessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const localEvents = await t.flows.main.attachEventLog(opened.client, sessionId);
      const page = await t.browser.newPage();
      // Serve the public package through Vite, as a real browser consumer.
      // Credentials are delivered in memory, never embedded in fixture files.
      const root = join(t.env.root, "rtc-browser");
      await mkdir(root, { recursive: true });
      const require = createRequire(join(t.openRoot, "packages/workbench/package.json"));
      const testingRequire = createRequire(join(t.openRoot, "testing/package.json"));
      const vite = await import(pathToFileURL(require.resolve("vite")).href);
      await writeFile(join(root, "index.html"), '<!doctype html><pre id="events"></pre><script type="module" src="/consumer.ts"></script>');
      await writeFile(join(root, "consumer.ts"), `
import { Client } from '@genehub/workbench/client';
const input = await window.connectionInput();
const operations = [], events = [], repairs = [], states = [], errors = [];
const client = new Client({...input, rtcEnabled:false, heartbeatMs:1000, heartbeatTimeoutMs:1500, onDiagnostic(e) {
  if(e.kind==='error') { errors.push(e.detail.message); if(errors.length>8) errors.shift(); }
  if(e.kind==='operation' && e.detail.phase==='finish') operations.push({operation:e.detail.operation,transport:e.detail.transport,outcome:e.detail.outcome});
}});
const handlers = {
  onEvent(e) { events.push(e); document.querySelector('#events').textContent=events.map(e=>e.event.type).join(' '); },
  onResync(snapshot,replayed,reset) { repairs.push({snapshot,replayed,reset}); }
};
client.onStateChange(state => states.push(state));
window.probe = { client, events, repairs, operations, states, errors, attach: id=>client.subscribe(id,handlers) };
client.connect();
`);
      await page.exposeFunction("connectionInput", () => ({ url, credential }));
      const app = await vite.createServer({
        configFile: false, root, logLevel: "error",
        resolve: { alias: [{ find: "@genehub/workbench/client", replacement: testingRequire.resolve("@genehub/workbench/client") }] },
        server: { host: "127.0.0.1", port: 0, fs: { allow: [root, t.openRoot] } },
      });
      server = app;
      await app.listen();
      await page.addInitScript(() => {
        const NativePeer = window.RTCPeerConnection;
        (window as any).nativePeers = [];
        window.RTCPeerConnection = new Proxy(NativePeer, {
          construct(target, args) {
            const peer = Reflect.construct(target, args);
            (window as any).nativePeers.push(peer);
            return peer;
          },
        });
      });
      const diagnosticFailure = async (error: unknown): Promise<never> => {
        const observed = await page.evaluate(() => {
          const p = (window as any).probe;
          return p ? { state: p.client.connectionState, rtc: p.client.rtcState, failure: p.client.rtcFailure, errors: p.errors, states: p.states.slice(-8), operations: p.operations.slice(-8) } : { probe: false };
        });
        throw new Error(`${String(error)}; browser ${JSON.stringify(observed)}`);
      };
      try {
      await page.goto(app.resolvedUrls.local[0]);
      await page.waitForFunction(() => (window as any).probe?.client.connectionState === "ready", null, { timeout: 30000 }).catch(diagnosticFailure);
      const logicalId = await page.evaluate(() => (window as any).probe.client.logicalConnectionId);
      t.assertions.assert(typeof logicalId === "string", "logical identity missing");
      const initial = await page.evaluate((id) => (window as any).probe.attach(id), warmSessionId);
      t.assertions.assert(initial.snapshot.items.length === 0, "new session was not empty");
      await page.evaluate(() => (window as any).probe.client.setRtcEnabled(true));
      await page.waitForFunction(() => (window as any).probe.client.rtcState === "connected", null, { timeout: 30000 }).catch(diagnosticFailure);

      // Subscribe after the upgrade (the blank pane failure), then send an
      // actual mock-backed Agent turn and observe it independently on loopback.
      await page.evaluate(async (id) => {
        const p = (window as any).probe;
        await p.attach(id);
        await p.client.call({ type: "workspace.list" });
      }, sessionId);
      opened.mock.script({ text: "subscription result" });
      await t.flows.main.sendPrompt(opened.client, sessionId, "Respond briefly.");
      await t.tools.waitUntil(() => localEvents.some((e) => e.type === "turnCompleted"), 45000);
      await page.waitForFunction(() => (window as any).probe.events.some((e: any) => e.event.type === "turnCompleted"), null, { timeout: 10000 });
      t.assertions.assert((await page.locator("#events").innerText()).includes("turnCompleted"), "browser never rendered completion");

      // Reopening an existing conversation must load history AND remain live.
      const reopened = await page.evaluate(async (id) => {
        const p = (window as any).probe;
        await p.client.unsubscribe(id);
        p.events.length = 0;
        return p.attach(id);
      }, sessionId);
      t.assertions.assert(reopened.snapshot.items.length > 0, "history snapshot missing");
      await opened.client.call({ type: "session.rename", payload: { sessionId, title: "after-reopen" } });
      await page.waitForFunction(() => (window as any).probe.events.some((e: any) => e.event.type === "titleChanged" && e.event.title === "after-reopen"));
      await page.evaluate(() => (window as any).probe.client.setRtcEnabled(false));
      await opened.client.call({ type: "session.rename", payload: { sessionId, title: "after-fallback" } });
      await page.waitForFunction(() => (window as any).probe.events.some((e: any) => e.event.type === "titleChanged" && e.event.title === "after-fallback"));

      // A paused relay cannot stop events after the same logical peer moves to RTC.
      await page.evaluate(() => (window as any).probe.client.setRtcEnabled(true));
      await page.waitForFunction(() => (window as any).probe.client.rtcState === "connected", null, { timeout: 30000 }).catch(diagnosticFailure);
      relay.process.kill("SIGSTOP");
      try {
        await page.evaluate(() => (window as any).probe.client.call({ type: "workspace.list" }));
        await opened.client.call({ type: "session.rename", payload: { sessionId, title: "during-baseline-outage" } });
        await page.waitForFunction(() => (window as any).probe.events.some((e: any) => e.event.type === "titleChanged" && e.event.title === "during-baseline-outage"), null, { timeout: 10000 });
        t.assertions.assert(await page.evaluate(() => (window as any).probe.client.connectionState === "ready"), "healthy RTC was lost with the relay");
      } finally {
        relay.process.kill("SIGCONT");
      }
      const beforeFault = await page.evaluate(() => {
        const p = (window as any).probe;
        const before = { repairs: p.repairs.length, states: p.states.length };
        // Terminate the actual Chromium peers; every replacement still uses native WebRTC.
        for (const peer of (window as any).nativePeers) peer.close();
        return before;
      });
      // A healthy authenticated standby should hide physical failure from the
      // business session. Assert a real reply, not an intermediate UI state.
      const afterFault = await page.evaluate(async (offset) => {
        const p = (window as any).probe;
        const reply = await p.client.call({ type: "workspace.list" });
        return { reply: reply?.type, state: p.client.connectionState, states: p.states.slice(offset) };
      }, beforeFault.states).catch(diagnosticFailure);
      t.assertions.assert(afterFault.reply === "workspaces" && afterFault.state === "ready", "RTC failure interrupted ordinary RPC");
      t.assertions.assert(!afterFault.states.includes("reconnecting"), "RTC failure discarded the healthy standby");
      const resumed = await page.evaluate(() => ({ id: (window as any).probe.client.logicalConnectionId, repairs: (window as any).probe.repairs.length }));
      t.assertions.assert(resumed.id === logicalId, "RTC failure replaced the logical connection");
      t.assertions.assert(resumed.repairs === beforeFault.repairs, "carrier recovery rebuilt business subscriptions");
      await opened.client.call({ type: "session.rename", payload: { sessionId, title: "after-reconnect" } });
      await page.waitForFunction(() => (window as any).probe.events.some((e: any) => e.event.type === "titleChanged" && e.event.title === "after-reconnect"));
      await page.evaluate(async (id) => {
        const p = (window as any).probe;
        await p.client.unsubscribe(id);
        p.events.length = 0;
      }, sessionId);
      await opened.client.call({ type: "session.rename", payload: { sessionId, title: "while-unsubscribed" } });
      await page.evaluate(() => (window as any).probe.client.call({ type: "workspace.list" }));
      const evidence = await page.evaluate(() => {
        const p = (window as any).probe;
        return { count: p.events.length, operations: p.operations };
      });
      t.assertions.assert(evidence.count === 0, "events delivered after unsubscribe");
      t.assertions.assert(evidence.operations.some((e: any) => e.operation === "workspace.list" && e.transport === "rtc" && e.outcome === "ok"), "ordinary RPC never used actual RTC");
      t.assertions.assert(evidence.operations.filter((e: any) => ["subscribe", "unsubscribe"].includes(e.operation)).every((e: any) => e.outcome === "ok"), "subscription lifecycle failed");
      t.assertions.assert(evidence.operations.some((e: any) => e.operation === "subscribe" && e.transport === "rtc" && e.outcome === "ok"), "subscription still used the temporary baseline selector");
      await page.evaluate(() => (window as any).probe.client.close());
      await page.close();
      t.note("Actual Chromium: one logical identity for RPC/subscription/events; empty session, Agent completion, reopen, configured fallback, live events during relay pause, native RTC failure without resubscription, and cancellation verified.");
      } catch (error) { await diagnosticFailure(error); }
    } finally {
      await server?.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
      relay.stop();
    }
  },
);
