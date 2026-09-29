import { createSocket } from "node:dgram";
import { defineSpecialty, openMultichannelBrowser } from "../../framework/public.ts";

// External STUN Binding responders emulate two NAT mappings. Documentation IPs
// force distinct srflx candidates; host candidates provide the actual loopback
// connection. This proves non-trickle collection, not public NAT reachability.
async function stun(delayMs: number, lastOctet: number) {
  const socket = createSocket("udp4");
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let requests = 0, responses = 0;
  socket.on("message", (request, remote) => {
    if (request.length < 20 || request.readUInt16BE(0) !== 1 || request.readUInt32BE(4) !== 0x2112a442) return;
    requests++;
    const timer = setTimeout(() => {
      timers.delete(timer);
      const response = Buffer.alloc(32);
      response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(12, 2);
      request.copy(response, 4, 4, 20);
      response.writeUInt16BE(0x0020, 20); response.writeUInt16BE(8, 22);
      response[25] = 1; response.writeUInt16BE(remote.port ^ 0x2112, 26);
      const mapped = Buffer.from([192, 0, 2, lastOctet]);
      for (let i = 0; i < 4; i++) response[28 + i] = mapped[i]! ^ response[4 + i]!;
      socket.send(response, remote.port, remote.address, () => { responses++; });
    }, delayMs);
    timers.add(timer);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolve());
  });
  return { url: `stun:127.0.0.1:${socket.address().port}`, stats: () => ({ requests, responses }),
    async stop() { for (const timer of timers) clearTimeout(timer); await new Promise<void>(resolve => socket.close(() => resolve())); } };
}

defineSpecialty({
  id: "specialty.multichannel.late-ice-candidates",
  title: "One-shot RTC signaling retains STUN candidates arriving after the first srflx and two seconds",
  oracle: "Real Chromium and native host gather both immediate and 3200ms STUN mappings in each restricted/business channel, retain healthy Fabric RPC during gathering, then exchange business RPC over RTC",
  catches: ["first srflx truncates a one-shot offer or answer", "two-second gathering discards a late route"],
  tags: ["network-isolation-fix", "multichannel", "network-risk-v2"], runner: "playwright", llm: { default: "none" },
  expectedDurationMs: 25000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 1280, io: 1, browser: 1, pool: "browser" },
  surfaces: ["browser", "daemon", "cloud-server", "relay"], productInterfaces: ["@genehub/workbench/client", "hub-http"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  const fast = await stun(0, 1), late = await stun(3200, 2);
  const keys = ["HUB_ICE_SERVERS", "HUB_DEV_ICE_SERVERS", "HUB_BETA_ICE_SERVERS"];
  const previous = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = JSON.stringify([fast.url, late.url]);
  let stack: Awaited<ReturnType<typeof openMultichannelBrowser>> | undefined;
  try {
    stack = await openMultichannelBrowser(t, "hosted");
    await stack.page.evaluate(() => (window as any).mc.client.setRtcEnabled(true));
    const during = await stack.page.evaluate(async () => {
      const m = (window as any).mc, started = performance.now();
      const reply = await m.client.call({ type: "workspace.list" });
      return { type: reply?.type, ms: performance.now() - started, rtc: m.client.rtcState };
    });
    await stack.page.waitForFunction(() => (window as any).mc.client.rtcState === "connected", null, { timeout: 40000 });
    const result = await stack.page.evaluate(async () => {
      const m = (window as any).mc;
      const reply = await m.client.call({ type: "workspace.list" });
      return { type: reply?.type, path: m.operations.findLast((op: any) => op.operation === "workspace.list")?.transport,
        diagnostics: m.diagnostics.filter((e: any) => e.kind === "rtc").map((e: any) => e.detail),
        localSrflx: (window as any).nativePeers.map((peer: RTCPeerConnection) => (peer.localDescription?.sdp.match(/ typ srflx /g) ?? []).length) };
    });
    const ready = result.diagnostics.filter((d: any) => d.milestone === "transportReady");
    const remote = result.diagnostics.filter((d: any) => d.milestone === "remoteCandidates");
    t.note(JSON.stringify({ during, fast: fast.stats(), late: late.stats(), type: result.type, path: result.path, localSrflx: result.localSrflx, ready, remote }));
    t.assertions.assert(during.type === "workspaces" && during.ms < 1500 && during.rtc !== "connected", "candidate gathering blocked baseline RPC");
    t.assertions.assert(ready.length === 2 && ready.every((d: any) => d.gatherMs >= 3000), "one browser channel stopped gathering early");
    t.assertions.assert(result.localSrflx.length === 2 && result.localSrflx.every((n: number) => n >= 2), "late browser candidates absent from signaled offers");
    t.assertions.assert(remote.length === 2 && remote.every((d: any) => d.remoteCandidateSrflx >= 2), "late native candidates absent from signaled answers");
    t.assertions.assert(result.type === "workspaces" && result.path === "rtc", "RTC business path did not activate");
  } finally {
    await stack?.stop();
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await fast.stop(); await late.stop();
  }
});
