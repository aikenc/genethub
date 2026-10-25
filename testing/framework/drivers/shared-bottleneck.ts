import { createConnection, createServer, type Socket } from "node:net";
import type { NetworkLinkProfile } from "./network-link.ts";

interface Lane {
  id: number;
  source: Socket;
  destination: Socket;
  queue: Array<{ bytes: Buffer; ready: number }>;
  queued: number;
  writable: boolean;
  ended: boolean;
  closed: boolean;
}

/** Opaque per-flow FIFO, packet round-robin, ONE aggregate rate per direction.
 * Unlike independent shapers, opening a second TCP cannot double the link.
 * This is a fair bottleneck model, not an OS TCP/loss/congestion emulator. */
export async function startSharedBottleneck(targetUrl: string, initial: NetworkLinkProfile) {
  let profile = checked(initial);
  const target = new URL(targetUrl);
  const sockets = new Set<Socket>();
  const connections = new Map<number, { front: Socket; back: Socket; bytes: number[]; closed: boolean }>();
  const blocked = [new Set<number>(), new Set<number>()];
  const stats = { accepted: 0, receivedBytes: [0, 0], forwardedBytes: [0, 0], peakQueuedBytes: [0, 0] };
  let stopped = false;
  const groups = [0, 1].map(direction => {
    const lanes: Lane[] = [];
    let cursor = 0, availableAt = 0, timer: NodeJS.Timeout | undefined;
    function wake() {
      if (timer || stopped) return;
      timer = setTimeout(pump, Math.max(0, availableAt - performance.now()));
    }
    function pump() {
      timer = undefined;
      if (stopped) return;
      // Retain serialization time across timer wakeups. Resetting to `now`
      // per packet artificially capped small records at one packet per timer.
      for (let batch = 0; batch < 64; batch++) {
      const now = performance.now();
      if (availableAt > now) { wake(); return; }
      let nextReady = Infinity;
      for (let n = 0; n < lanes.length; n++) {
        const index = (cursor + n) % lanes.length;
        const lane = lanes[index]!;
        if (lane.closed || blocked[direction]!.has(lane.id) || !lane.writable || !lane.queue.length) continue;
        const item = lane.queue[0]!;
        nextReady = Math.min(nextReady, item.ready);
        if (item.ready > now) continue;
        lane.queue.shift(); lane.queued -= item.bytes.length;
        lane.writable = lane.destination.write(item.bytes);
        stats.forwardedBytes[direction]! += item.bytes.length;
        connections.get(lane.id)!.bytes[direction]! += item.bytes.length;
        // One packet is serialized at a time; backlog on one lane cannot
        // reserve seconds of future service ahead of a different socket.
        availableAt = Math.max(availableAt, now - 5) + item.bytes.length * 8 / (profile.bandwidthMbps * 1000);
        cursor = (index + 1) % lanes.length;
        if (lane.source.isPaused() && lane.queued < 512 * 1024) lane.source.resume();
        if (!lane.queue.length && lane.ended) lane.destination.end();
        break;
      }
      if (!Number.isFinite(nextReady)) { availableAt = now; return; }
      if (nextReady > now) { availableAt = now; timer = setTimeout(pump, Math.max(1, nextReady - now)); return; }
      }
      wake();
    }
    return {
      add(source: Socket, destination: Socket, id: number) {
        const lane: Lane = { id, source, destination, queue: [], queued: 0, writable: true, ended: false, closed: false };
        lanes.push(lane);
        source.on("data", (bytes: Buffer) => {
          stats.receivedBytes[direction]! += bytes.length;
          for (let offset = 0; offset < bytes.length; offset += 1440) {
            const chunk = Buffer.from(bytes.subarray(offset, offset + 1440));
            lane.queue.push({ bytes: chunk, ready: performance.now() + profile.rttMs / 2 });
            lane.queued += chunk.length;
          }
          stats.peakQueuedBytes[direction] = Math.max(stats.peakQueuedBytes[direction]!, lanes.reduce((sum, l) => sum + l.queued, 0));
          if (lane.queued >= 1024 * 1024) source.pause();
          wake();
        });
        source.on("end", () => { lane.ended = true; if (!lane.queue.length) destination.end(); });
        source.on("close", () => { lane.closed = true; lane.queue.length = 0; lane.queued = 0; });
        destination.on("drain", () => { lane.writable = true; wake(); });
      },
      changed() { availableAt = Math.min(availableAt, performance.now() + 100); wake(); },
      stop() { if (timer) clearTimeout(timer); for (const lane of lanes) lane.queue.length = 0; },
    };
  });
  const server = createServer({ allowHalfOpen: true }, front => {
    const id = ++stats.accepted; front.pause(); front.setNoDelay(true);
    const back = createConnection({ host: target.hostname, port: Number(target.port || 80), allowHalfOpen: true });
    back.setNoDelay(true); sockets.add(front); sockets.add(back);
    const connection = { front, back, bytes: [0, 0], closed: false }; connections.set(id, connection);
    const close = () => { connection.closed = true; front.destroy(); back.destroy(); sockets.delete(front); sockets.delete(back); };
    front.on("error", close); back.on("error", close);
    // A normal FIN is drained by the direction first; errors abort both.
    front.on("close", () => { if (!front.readableEnded) close(); });
    back.on("close", () => { if (!back.readableEnded) close(); });
    back.once("connect", () => { groups[0]!.add(front, back, id); groups[1]!.add(back, front, id); front.resume(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("shared bottleneck did not bind");
  return {
    urlFor(input: string) { const u = new URL(input); u.hostname = "127.0.0.1"; u.port = String(address.port); return u.toString(); },
    setProfile(next: NetworkLinkProfile) { profile = checked(next); for (const group of groups) group.changed(); },
    stats() { return { ...stats, receivedBytes: [...stats.receivedBytes], forwardedBytes: [...stats.forwardedBytes], peakQueuedBytes: [...stats.peakQueuedBytes] }; },
    connections() { return [...connections].map(([id, value]) => ({ id, bytes: [...value.bytes], closed: value.closed })); },
    cutConnection(id: number) { const c = connections.get(id); if (c) { c.closed = true; c.front.destroy(); c.back.destroy(); } },
    holdConnection(id: number, direction: "forward" | "reverse" | "both") { if (direction !== "reverse") blocked[0]!.add(id); if (direction !== "forward") blocked[1]!.add(id); },
    releaseConnections() { blocked[0]!.clear(); blocked[1]!.clear(); for (const group of groups) group.changed(); },
    async stop() { stopped = true; for (const group of groups) group.stop(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

function checked(profile: NetworkLinkProfile): NetworkLinkProfile {
  if (!Number.isFinite(profile.rttMs) || profile.rttMs < 0 || profile.rttMs > 5000 ||
      !Number.isFinite(profile.bandwidthMbps) || profile.bandwidthMbps <= 0 || profile.bandwidthMbps > 100000) throw new RangeError("invalid aggregate bottleneck profile");
  return { ...profile };
}
