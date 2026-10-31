import { request as forward, createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { allocatePort, connectProductClient, defineSpecialty, startHub, startRelay } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.host.hosted-admission-polling",
  title: "Idle Hosted connections use bounded admission polling and still revoke",
  oracle: "A transparent HTTP observer forwards every request to the real Hub; one idle real Fabric client produces 1-3 authority checks in 22 seconds, separated by at least 9 seconds, and public session revocation denies new admission and ends access",
  catches: ["per-connection authority still polls every second", "idle connection never checks revocation", "lower polling breaks Hosted admission"],
  tags: ["core", "authorization-depth", "daemon-resource-isolation"], llm: { default: "none" }, requiredRepos: ["cloud"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  expectedDurationMs: 40_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 0 },
  surfaces: ["daemon", "genehub-host", "cloud-server", "relay"], productInterfaces: ["hub-http", "@genehub/workbench/client"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const port = await allocatePort(), token = randomBytes(24).toString("hex");
  const hub = await startHub({ databasePath: join(t.env.root, "polling.sqlite"), relayOrigin: `http://127.0.0.1:${port}`, relayToken: token });
  const checks: number[] = [];
  // Observe the real HTTP boundary, without replacing authority responses or
  // reading credentials into evidence. Relay control uses the real Hub too.
  const observer = createServer((req, res) => {
    if (req.url === "/api/fabric/v2/peer-admissions/check") checks.push(Date.now());
    const upstream = forward(new URL(req.url ?? "/", hub.origin), { method: req.method, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let remote: Awaited<ReturnType<typeof connectProductClient>> | undefined;
  try {
    await new Promise<void>(resolve => observer.listen(0, "127.0.0.1", resolve));
    const address = observer.address(); if (!address || typeof address === "string") throw new Error("observer has no port");
    relay = await startRelay({ openRoot: t.openRoot, port, control: { origin: hub.origin, token } });
    const owner = hub.browser(); await hub.signInOwner(owner);
    const paired = await opened.client.call({ type: "hub.pair", payload: { hubUrl: `http://127.0.0.1:${address.port}`, displayName: "polling fixture" } });
    if (paired?.type !== "hubStatus" || paired.data.state !== "pairing") throw new Error("pairing did not start");
    await hub.approvePairing(owner, paired.data.userCode);
    let machineId = "";
    await t.tools.waitUntil(async () => {
      const me = await owner.json<{ machines: Array<{ id: string; online: boolean }> }>("/app/me");
      machineId = me.machines.find(m => m.online)?.id ?? ""; return !!machineId;
    }, 45000);
    const ticket = await owner.json<{ url: string; channelCapability: string; channelSecret: string; fabricRouteTicket: string; fabricAuthorizationExpiresAt: string }>(`/app/machines/${machineId}/connect`, { method: "POST" });
    remote = await connectProductClient({ url: ticket.url, channelCredential: { capabilityId: ticket.channelCapability, secret: ticket.channelSecret }, fabricRouteTicket: ticket.fabricRouteTicket, fabricAuthorizationExpiresAt: ticket.fabricAuthorizationExpiresAt });
    t.assertions.assert((await remote.call({ type: "workspace.list" }))?.type === "workspaces", "real Hosted RPC failed");
    await new Promise(resolve => setTimeout(resolve, 22000));
    const gaps = checks.slice(1).map((time, i) => time - checks[i]!);
    t.assertions.assert(checks.length >= 1 && checks.length <= 3 && gaps.every(gap => gap >= 9000), "authority polling is missing or excessive: " + JSON.stringify({ count: checks.length, gaps }));
    const me = await owner.json<{ session: { id: string } }>("/app/me");
    const revoked = await owner.fetch(`/app/sessions/${me.session.id}/revoke`, { method: "POST" });
    t.assertions.assert(revoked.ok, "public session revocation failed"); await revoked.body?.cancel();
    const refused = await owner.fetch(`/app/machines/${machineId}/connect`, { method: "POST" });
    t.assertions.assert(refused.status === 401 || refused.status === 403, "revoked session retained new admission"); await refused.body?.cancel();
    await t.tools.waitUntil(() => remote!.connectionState !== "ready", 15000);
    t.assertions.assert((await opened.client.call({ type: "workspace.list" }))?.type === "workspaces", "revocation affected independent local owner");
    t.note(JSON.stringify({ idleChecks: checks.length, minimumGapMs: gaps.length ? Math.min(...gaps) : null, freshAdmissionDenied: true }));
  } finally {
    remote?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
    relay?.stop(); observer.closeAllConnections(); await new Promise<void>(resolve => observer.close(() => resolve())); await hub.stop();
  }
});
