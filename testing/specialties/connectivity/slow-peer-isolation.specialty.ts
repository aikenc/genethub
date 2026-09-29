import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectProductClient, defineSpecialty, startFaultLink, startRelay,
  startShapedTcpProxy,
} from "../../framework/public.ts";

for (const peers of [1, 4] as const) {
defineSpecialty({
  id: peers === 1 ? "specialty.neteff.slow-peer-preview-isolation" : "specialty.neteff.slow-peer-concurrent-cancel",
  title: peers === 1 ? "One stalled relay client does not block a healthy client's preview" : "Eight previews on four healthy clients survive a stalled client and its cancellation",
  oracle: "With only client A downstream held for 3 seconds, client B's 64KiB preview on a separate healthy socket completes within 1200ms, with exact content and a responsive workspace.list control",
  catches: ["a shared physical-uplink budget remains owned by an unrelated client's end-to-end acknowledgement"],
  tags: ["network-review-experiment", "neteff", "connectivity", "relay", "wasm-guest"],
  llm: { default: "none" }, expectedDurationMs: 15000, timeoutMs: 90000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "workbench-client"],
  productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  retention: true,
}, async t => {
  const image = (name: string, size: number) => {
    const bytes = randomBytes(size);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    writeFileSync(join(t.env.workspace, name), bytes);
    return createHash("sha256").update(bytes).digest("hex");
  };
  const largeHash = image("isolated-large.png", 8 * 1024 * 1024);
  const smallHash = image("isolated-small.png", 64 * 1024);
  const relay = await startRelay({ openRoot: t.openRoot });
  const uplink = await startShapedTcpProxy({
    targetUrl: relay.origin, profile: { rttMs: 20, bandwidthMbps: 100 },
  });
  const stalledLeg = await startFaultLink(relay.origin);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let a: Awaited<ReturnType<typeof connectProductClient>> | undefined;
  let b: Awaited<ReturnType<typeof connectProductClient>> | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  const extra: Array<Awaited<ReturnType<typeof connectProductClient>>> = [];
  try {
    const attached = await opened.client.call({
      type: "device.remoteAttach",
      payload: { relayUrl: uplink.urlFor(relay.origin), joinToken: relay.joinToken },
    });
    if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) throw new Error("relay attach failed");
    await t.tools.waitUntil(async () => {
      const result = await opened.client.call({ type: "device.list" });
      return result?.type === "devices" && result.data.remote.online;
    }, 20000);
    const first = await t.flows.main.pairDevice(opened.client, opened.daemon, [], "stalled-client");
    first.client.close();
    const second = await t.flows.main.pairDevice(opened.client, opened.daemon, [], "healthy-client");
    second.client.close();
    a = await connectProductClient({
      url: stalledLeg.urlFor(attached.data.rendezvousUrl), credential: first.credential,
    });
    b = await connectProductClient({ url: attached.data.rendezvousUrl, credential: second.credential });
    // Independent browser connections may share one paired device identity.
    // Avoid creating and abandoning extra local logical sessions while seeding
    // the cohort: those correctly retain resume slots after their sockets close.
    for (let i = 1; i < peers; i++) {
      extra.push(await connectProductClient({ url: attached.data.rendezvousUrl, credential: second.credential }));
    }
    const healthy = [b, ...extra];
    const ids = healthy.map(client => client.logicalConnectionId);
    const aId = a.logicalConnectionId, bId = b.logicalConnectionId;
    const path = (name: string) => `${opened.rootHandle}/${name}`;
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const baselineStarted = performance.now();
    const baseline = await b.preview(opened.workspaceId, path("isolated-small.png"));
    const baselineMs = performance.now() - baselineStarted;
    t.assertions.assert(digest(baseline.bytes) === smallHash && baselineMs < 1200, "healthy preview baseline failed");
    // Allow the baseline's final ACK and idle interval to precede the fault.
    await new Promise(resolve => setTimeout(resolve, 250));
    uplink.resetStats();
    stalledLeg.blackhole("server");
    let aDone = false;
    const large = a.preview(opened.workspaceId, path("isolated-large.png"))
      .then(result => { aDone = true; return result; });
    void large.catch(() => {});
    await t.tools.waitUntil(() => stalledLeg.heldBytes().server > 0 && uplink.stats().clientToTargetBytes > 640 * 1024, 5000);
    t.assertions.assert(!aDone, "A finished before the downstream fault");
    const controlStarted = performance.now();
    const control = await b.call({ type: "workspace.list" });
    const controlMs = performance.now() - controlStarted;
    t.assertions.assert(control?.type === "workspaces" && controlMs < 1200, "independent B control path is unhealthy");
    const faultBytes = uplink.stats().clientToTargetBytes;
    const heldBytes = stalledLeg.heldBytes().server;
    let released = false;
    release = setTimeout(() => { released = true; stalledLeg.clearBlackhole(); }, 3000);
    const began = performance.now();
    const otherSmall = (peers === 1 ? [] : healthy).map(async client => {
      const started = performance.now();
      const hashes: string[] = [];
      const latencies: number[] = [];
      for (let round = 0; round < 3; round++) {
        const results = await Promise.all(Array.from({ length: client === b ? 1 : 2 }, async () => {
          const began = performance.now();
          const result = await client.preview(opened.workspaceId, path("isolated-small.png"));
          latencies.push(performance.now() - began);
          return result;
        }));
        hashes.push(...results.map(result => digest(result.bytes)));
      }
      return { ms: Math.max(...latencies), totalMs: performance.now() - started, hashes };
    });
    const otherPreviews = Promise.all(otherSmall);
    void otherPreviews.catch(() => {});
    const smallTask = b.preview(opened.workspaceId, path("isolated-small.png"));
    void smallTask.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    const followingStarted = performance.now();
    const following = b.call({ type: "workspace.list" }).then(reply => ({
      replyType: reply?.type, elapsedMs: performance.now() - followingStarted,
    }));
    void following.catch(() => {});
    const small = await smallTask;
    const busyMs = performance.now() - began;
    const completedBeforeRelease = !released;
    const followingControl = await following;
    const concurrent = await otherPreviews;
    if (peers > 1) {
      // Cancel the stalled peer while every healthy peer retains its session.
      t.assertions.assert(!aDone && !released, "stalled preview completed before cancellation");
      clearTimeout(release); a.close(); stalledLeg.clearBlackhole();
      const cancelled = await large.then(() => false, () => true);
      t.assertions.assert(cancelled, "closed preview did not report cancellation");
      const recoveryStarted = performance.now();
      const recovered = await b.preview(opened.workspaceId, path("isolated-small.png"));
      t.assertions.assert(digest(recovered.bytes) === smallHash && performance.now() - recoveryStarted < 1200, "cancelled peer leaked shared occupancy");
    }
    const big = peers === 1 ? await large : undefined;
    const retained = a.logicalConnectionId === aId && b.logicalConnectionId === bId;
    const hashesMatch = digest(small.bytes) === smallHash && (!big || digest(big.bytes) === largeHash);
    const summary = JSON.stringify({ baselineMs, controlMs, busyMs, followingControl, completedBeforeRelease,
      peers, concurrent, heldBytes, faultBytes, retained, hashesMatch });
    t.note(summary);
    t.assertions.assert(followingControl.replyType === "workspaces" && followingControl.elapsedMs < 1200,
      `RPC behind a paced preview blocked: ${summary}`);
    t.assertions.assert(concurrent.every(row => row.ms < 1200 && row.hashes.every(hash => hash === smallHash)) &&
      healthy.every((client, i) => client.logicalConnectionId === ids[i]), `concurrent peers starved or replaced: ${summary}`);
    t.assertions.assert((peers > 1 || retained) && hashesMatch, `identity/content failed: ${summary}`);
    t.assertions.assert(busyMs <= 1200 && completedBeforeRelease,
      `client A's stalled downstream blocked independent B preview: ${summary}`);
  } finally {
    if (release) clearTimeout(release);
    stalledLeg.clearBlackhole();
    for (const client of extra) client.close();
    a?.close(); b?.close(); opened.client.close(); opened.daemon.stop();
    await opened.mock.stop(); await stalledLeg.stop(); await uplink.stop(); relay.stop();
  }
});

}
