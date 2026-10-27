import { createHash } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { defineSpecialty } from "../../framework/public.ts";
import { startSharedBottleneck } from "../../framework/drivers/shared-bottleneck.ts";

for (const twoHops of [false, true]) defineSpecialty({
  id: twoHops ? "specialty.neteff.four-channel-two-hop-duplex-raw-receiver" : "specialty.neteff.four-channel-duplex-raw-receiver",
  title: twoHops ? "Four raw TCP channels traverse two independent duplex WAN budgets" : "Four raw TCP channels share one duplex bottleneck without starving reverse payload",
  oracle: twoHops ? "Two independent aggregate 2Mbps/200ms WAN legs, each with four sockets: exact three8MiB forward bodies and1.05MB reverse body, reverse receiver within10s during forward pressure; neither leg gains capacity from opening sockets" : "One aggregate 2Mbps per direction, four sockets, exact three 8MiB forward bodies and 1.05MB reverse body; reverse receiver finishes within 10s while forward bodies remain active",
  catches: ["adding sockets multiplies simulated capacity", "forward traffic blocks the independent reverse bottleneck", "an upload RPC is blamed before calibrating its transport model"],
  tags: ["fabric-pool", "network-calibration", "duplex"], llm: { default: "none" },
  expectedDurationMs: 25000, timeoutMs: 60000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["os-tcp", "shared-bottleneck"], productInterfaces: ["node:net"], requiredArtifacts: [], retention: true,
}, async t => {
  const size = 8 * 1024 * 1024, upload = Buffer.from("upload-pattern-".repeat(70000));
  const sockets = new Set<Socket>(), owners = new Map<number, Socket>();
  const received = new Map<number, { bytes: number; hash: ReturnType<typeof createHash> }>();
  const errors: string[] = [], starts: number[] = [];
  let stopped = false, began = 0, uploadBytes = 0, uploadFirst: number | null = null, uploadDone: number | null = null, finishedAtUpload = -1;
  const uploadHash = createHash("sha256");
  const server = createServer(socket => {
    sockets.add(socket); socket.setNoDelay(true);
    let owner: number | undefined;
    socket.on("error", error => { if (!stopped) errors.push(error.name); });
    socket.on("data", (bytes: Buffer) => {
      if (owner === undefined) {
        owner = bytes[0]; bytes = bytes.subarray(1);
        if (owner === undefined || owner > 3 || owners.has(owner)) { errors.push("invalid raw owner"); return; }
        owners.set(owner, socket);
        if (owner) received.set(owner, { bytes: 0, hash: createHash("sha256") });
      }
      if (!bytes.length) return;
      const body = received.get(owner);
      if (!body || body.bytes + bytes.length > size) { errors.push("unexpected raw forward bytes"); return; }
      body.bytes += bytes.length; body.hash.update(bytes);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("raw reference did not bind");
  let link: Awaited<ReturnType<typeof startSharedBottleneck>> | undefined, secondLink: Awaited<ReturnType<typeof startSharedBottleneck>> | undefined;
  try {
    const origin = `tcp://127.0.0.1:${address.port}`;
    if (twoHops) secondLink = await startSharedBottleneck(origin, { bandwidthMbps: 1000, rttMs: 0 });
    link = await startSharedBottleneck(secondLink ? secondLink.urlFor(origin) : origin, { bandwidthMbps: 1000, rttMs: 0 });
    const fronts: Socket[] = [];
    for (let owner = 0; owner < 4; owner++) {
      const target = new URL(link.urlFor(origin));
      const socket = createConnection({ host: target.hostname, port: Number(target.port) });
      sockets.add(socket); fronts.push(socket); socket.setNoDelay(true);
      socket.on("error", error => { if (!stopped) errors.push(error.name); });
      socket.on("data", (bytes: Buffer) => {
        if (owner !== 3 || uploadBytes + bytes.length > upload.length) { errors.push("unexpected raw reverse bytes"); return; }
        uploadFirst ??= performance.now() - began;
        uploadBytes += bytes.length; uploadHash.update(bytes);
        if (uploadBytes === upload.length) {
          uploadDone = performance.now() - began;
          finishedAtUpload = [...received.values()].filter(row => row.bytes === size).length;
        }
      });
      await once(socket, "connect"); socket.write(Buffer.from([owner]));
    }
    await t.tools.waitUntil(() => owners.size === 4 || errors.length > 0, 5000);
    if (errors.length) throw new Error(errors.join(","));
    const before = link.stats(), secondBefore = secondLink?.stats();
    link.setProfile({ bandwidthMbps: 2, rttMs: 200 }); secondLink?.setProfile({ bandwidthMbps: 2, rttMs: 200 }); began = performance.now();
    for (let owner = 1; owner < 4; owner++) {
      starts.push(owner);
      const socket = fronts[owner]!, chunk = Buffer.alloc(16384, 64 + owner);
      let offset = 0;
      const pump = () => {
        while (!stopped && !socket.destroyed && offset < size) {
          const length = Math.min(chunk.length, size - offset); offset += length;
          if (!socket.write(chunk.subarray(0, length))) { socket.once("drain", pump); return; }
        }
      };
      pump();
    }
    owners.get(3)!.write(upload);
    while (performance.now() - began < 20000 && !errors.length) await new Promise(resolve => setTimeout(resolve, 100));
    const elapsedMs = performance.now() - began, busy = link.stats(), secondBusy = secondLink?.stats();
    const forwardBytes = busy.forwardedBytes[0]! - before.forwardedBytes[0]!;
    const reverseBytes = busy.forwardedBytes[1]! - before.forwardedBytes[1]!;
    link.setProfile({ bandwidthMbps: 1000, rttMs: 0 }); secondLink?.setProfile({ bandwidthMbps: 1000, rttMs: 0 });
    await t.tools.waitUntil(() => errors.length > 0 || (uploadBytes === upload.length && [...received.values()].every(row => row.bytes === size)), 30000);
    const exactForward = [...received].every(([owner, row]) => row.bytes === size && row.hash.digest("hex") === createHash("sha256").update(Buffer.alloc(size, 64 + owner)).digest("hex"));
    const exactReverse = uploadBytes === upload.length && uploadHash.digest("hex") === createHash("sha256").update(upload).digest("hex");
    t.note(JSON.stringify({ scope: "raw TCP receiver calibration; no encryption, RPC reply or media rendering certification", connections: busy.accepted, secondConnections: secondBusy?.accepted, secondWire: secondBusy, independentHops: twoHops ? 2 : 1, starts,
      profile: { bandwidthMbps: 2, rttMs: 200 }, shapeMs: Math.round(elapsedMs), forwardBytes, reverseBytes,
      uploadBytes, uploadFirstMs: Math.round(uploadFirst ?? -1), uploadReceiverMs: Math.round(uploadDone ?? -1), finishedAtUpload, exactForward, exactReverse, errors }));
    t.assertions.assert(errors.length === 0 && busy.accepted === 4 && starts.join(",") === "1,2,3" && exactForward && exactReverse, "raw fixture lost bytes or changed its four-source topology");
    t.assertions.assert(uploadDone !== null && uploadDone <= 10000 && uploadDone >= upload.length * 8 / 2000 * .85 && finishedAtUpload === 0, "reverse raw receiver did not observe the unchanged shared duplex rate/overlap");
    if (twoHops) {
      t.assertions.assert(secondBusy?.accepted === 4 && !!secondBefore, "raw reference did not traverse both four-socket WAN legs");
      const bound = 2_000_000 / 8 * (elapsedMs / 1000) * 1.15;
      for (const [now, prior] of ([[busy, before], [secondBusy!, secondBefore!]] as const)) t.assertions.assert(now.forwardedBytes.every((bytes, direction) => bytes - prior.forwardedBytes[direction]! <= bound), "raw channels multiplied one WAN leg's aggregate capacity");
    }
    t.assertions.assert(forwardBytes <= 2_000_000 / 8 * (elapsedMs / 1000) * 1.15, "four sockets multiplied the aggregate bottleneck bandwidth");
  } finally {
    stopped = true;
    for (const socket of sockets) socket.destroy();
    await link?.stop(); await secondLink?.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
