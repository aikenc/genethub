import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CaseContext } from "../context.ts";
import { BlockedError } from "../../infrastructure/public.ts";
import { startRelay } from "./relay.ts";
import { startFaultLink } from "./fault-link.ts";
import { startHub } from "./hub.ts";
import { connectProductClient } from "./client.ts";
import { allocatePort } from "../../infrastructure/public.ts";
import { parseJson, runGenetAsync } from "./cli.ts";

/** Public package browser consumer plus real rendezvous/Hosted services.
 * The page uses the same Client as the workbench; the only browser fault seam
 * records native RTCPeerConnections and closes them without altering behavior.
 */
export async function openMultichannelBrowser(t: CaseContext, mode: "rendezvous" | "hosted" = "rendezvous") {
  if (!t.browser) throw new BlockedError("native Chromium WebRTC is required");
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let fabric: Awaited<ReturnType<typeof startFaultLink>> | undefined;
  let admissionStatus: (() => Promise<number>) | undefined;
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let opened: Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>> | undefined;
  let app: { close(): Promise<void> } | undefined;
  const page = await t.browser.newPage();
  const stop = async () => {
    await page.close().catch(() => {});
    await app?.close();
    opened?.client.close(); opened?.daemon.stop(); await opened?.mock.stop();
    await fabric?.stop(); relay?.stop(); await hub?.stop();
  };
  try {
    let input: () => Promise<Record<string, unknown>>;
    let revoke: (() => Promise<void>) | undefined;
    let expiresAt: string | undefined;
    let issued = 0;
    const leases: Array<{ receivedAt: number; expiresAt: string }> = [];
    if (mode === "hosted") {
      const port = await allocatePort();
      const token = randomBytes(32).toString("hex");
      hub = await startHub({ databasePath: join(t.env.root, "hub.sqlite"), relayOrigin: `http://127.0.0.1:${port}`, relayToken: token, routeGrantTtlSeconds: 60 });
      relay = await startRelay({ openRoot: t.openRoot, port, control: { origin: hub.origin, token } });
      t.env.env.GENEHUB_LOCAL_HUB_URL = hub.origin;
      opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      const owner = hub.browser(); await hub.signInOwner(owner);
      const route = async () => {
        const r = await runGenetAsync(opened!.daemon.genet, ["desktop", "route"], opened!.daemon.env);
        if (r.code !== 0) throw new Error("desktop pairing route failed");
        return parseJson(r.stdout).data as { navigate: string; complete: boolean };
      };
      const first = await route();
      const code = new URL(first.navigate).searchParams.get("code");
      if (!code) throw new Error("desktop route omitted pairing code");
      await hub.approvePairing(owner, code);
      await t.tools.waitUntil(async () => (await route()).complete, 45000);
      let machineId = "";
      await t.tools.waitUntil(async () => {
        const me = await owner.json<{ machines: Array<{ id: string; online: boolean }> }>("/app/me");
        machineId = me.machines.find(m => m.online)?.id ?? "";
        return !!machineId;
      }, 25000);
      const session = await owner.json<{ session: { id: string } }>("/app/me");
      revoke = async () => {
        const response = await owner.fetch(`/app/sessions/${session.session.id}/revoke`, { method: "POST" });
        if (!response.ok) throw new Error(`public session revocation failed: ${response.status}`);
      };
      admissionStatus = async () => {
        const response = await owner.fetch(`/app/machines/${machineId}/connect`, { method: "POST" });
        await response.body?.cancel(); return response.status;
      };
      input = async () => {
        const response = await owner.fetch(`/app/machines/${machineId}/connect`, { method: "POST" });
        if (!response.ok) throw Object.assign(new Error(`public hosted connect failed: ${response.status}`), { status: response.status });
        const ticket = await response.json() as { url: string; channelCapability: string; channelSecret: string; fabricRouteTicket: string; fabricRouteExpiresAt: string; fabricAuthorizationExpiresAt: string };
        issued++; expiresAt ??= ticket.fabricAuthorizationExpiresAt;
        leases.push({ receivedAt: Date.now(), expiresAt: ticket.fabricAuthorizationExpiresAt });
        return { url: ticket.url, channelCredential: { capabilityId: ticket.channelCapability, secret: ticket.channelSecret }, fabricRouteTicket: ticket.fabricRouteTicket, fabricAuthorizationExpiresAt: ticket.fabricAuthorizationExpiresAt };
      };
    } else {
      relay = await startRelay({ openRoot: t.openRoot });
      opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      const remote = await opened.client.call({ type: "device.remoteAttach", payload: { relayUrl: relay.origin, joinToken: relay.joinToken } });
      if (remote?.type !== "remoteAccess" || !remote.data.rendezvousUrl) throw new Error("remote attachment failed");
      const url = remote.data.rendezvousUrl;
      await t.tools.waitUntil(async () => {
        const r = await opened!.client.call({ type: "device.list" });
        return r?.type === "devices" && r.data.remote.online;
      }, 20000);
      const invite = await opened.client.call({ type: "device.invite", payload: null });
      if (invite?.type !== "invite") throw new Error("invite failed");
      const separator = invite.data.code.indexOf(".");
      const inviteId = invite.data.code.slice(0, separator);
      const pairing = await connectProductClient({ url, inviteCredential: { inviteId, secret: invite.data.code.slice(separator + 1) } });
      try {
        const claimed = await pairing.call({ type: "device.claim", payload: { code: inviteId, deviceName: "multichannel-browser" } });
        if (claimed?.type !== "claimed") throw new Error("claim failed");
        input = async () => ({ url, credential: claimed.data });
      } finally { pairing.close(); }
    }
    const root = join(t.env.root, "multichannel-browser");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "index.html"), '<!doctype html><pre id="status">connecting</pre><script type="module" src="/consumer.ts"></script>');
    await writeFile(join(root, "consumer.ts"), `
import { Client, ServicePreviewClient } from '@genehub/workbench/client';
async function connectionInput(){const result=await window.connectionInput();if(result.admissionError)throw Object.assign(new Error(result.admissionError.message),{status:result.admissionError.status});return result;}
const endpoint=await connectionInput();
const client=new Client({...endpoint,rtcEnabled:false,requestTimeoutMs:3000,onDiagnostic(e){if(e.kind==='operation' && e.detail.phase==='finish'){mc.operations.push(e.detail);if(mc.operations.length>128)mc.operations.shift()}},redial:()=>connectionInput()});
const mc={client,ServicePreviewClient,events:[],repairs:0,states:[],operations:[]};
client.onStateChange(s=>{mc.states.push(s);if(mc.states.length>128)mc.states.shift();document.querySelector('#status').textContent=s});
window.mc=mc;client.connect();
`);
    await page.exposeFunction("connectionInput", async () => {
      let next: Record<string, unknown>;
      try { next = await input(); } catch (error) {
        return { admissionError: { message: error instanceof Error ? error.message : String(error), status: (error as {status?: number}).status } };
      }
      fabric ??= await startFaultLink(String(next.url));
      return { ...next, url: fabric.urlFor(String(next.url)) };
    });
    await page.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      (window as any).nativePeers = [];
      window.RTCPeerConnection = new Proxy(Native, { construct(target, args) {
        const peer = Reflect.construct(target, args); (window as any).nativePeers.push(peer); return peer;
      } });
    });
    const require = createRequire(join(t.openRoot, "packages/workbench/package.json"));
    const testRequire = createRequire(join(t.openRoot, "testing/package.json"));
    const vite = await import(pathToFileURL(require.resolve("vite")).href);
    const server = await vite.createServer({ configFile: false, root, logLevel: "error",
      resolve: { alias: [{ find: "@genehub/workbench/client", replacement: testRequire.resolve("@genehub/workbench/client") }] },
      server: { host: "127.0.0.1", port: 0, fs: { allow: [root, t.openRoot] } } });
    app = server; await server.listen();
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => (window as any).mc?.client.connectionState === "ready", null, { timeout: 30000 });
    return { page, opened, relay, revoke, admissionStatus, fabric: fabric!, expiry: () => expiresAt, issued: () => issued, leases: () => [...leases], stop,
      async rtc() {
        await page.evaluate(() => (window as any).mc.client.setRtcEnabled(true));
        await page.waitForFunction(() => (window as any).mc.client.rtcState === "connected", null, { timeout: 30000 });
      },
      async cutRtc() { await page.evaluate(() => { for (const p of (window as any).nativePeers) p.close(); }); },
    };
  } catch (error) { await stop(); throw error; }
}
