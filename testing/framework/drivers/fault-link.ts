import { createConnection, createServer, type Socket } from "node:net";

/** Opaque TCP fault boundary: never parses or rewrites product records. */
export async function startFaultLink(target: string) {
  const url = new URL(target);
  const upstream = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) };
  const sockets = new Set<Socket>();
  let blocked = false, accepted = 0, established = 0, clientBytes = 0, serverBytes = 0, cuts = 0;
  let lastError = "";
  let dropClient = false, dropServer = false, heldClient = 0, heldServer = 0;
  const held = new Set<{ socket: Socket; target: Socket; bytes: Buffer; direction: "client" | "server" }>();
  let cutAt: number | null = null;
  let serverCutAt: number | null = null;
  const server = createServer((front) => {
    accepted++;
    if (blocked) { front.destroy(); return; }
    const back = createConnection(upstream);
    back.once("connect", () => { established++; });
    sockets.add(front); sockets.add(back);
    const close = () => { front.destroy(); back.destroy(); sockets.delete(front); sockets.delete(back); for (const item of held) if (item.socket === front || item.socket === back) held.delete(item); };
    front.on("error", close); back.on("error", (e: NodeJS.ErrnoException) => { lastError = e.code ?? "upstream-error"; close(); });
    front.on("close", close); back.on("close", close);
    front.on("data", bytes => {
      clientBytes += bytes.length;
      if (cutAt !== null && clientBytes >= cutAt) { cutAt = null; cuts++; close(); return; }
      if (dropClient) { heldClient += bytes.length; front.pause(); held.add({ socket: front, target: back, bytes, direction: "client" }); return; }
      if (!back.write(bytes)) { front.pause(); back.once("drain", () => front.resume()); }
    });
    back.on("data", bytes => {
      serverBytes += bytes.length;
      if (serverCutAt !== null && serverBytes >= serverCutAt) { serverCutAt = null; cuts++; close(); return; }
      if (dropServer) { heldServer += bytes.length; back.pause(); held.add({ socket: back, target: front, bytes, direction: "server" }); return; }
      if (!front.write(bytes)) { back.pause(); front.once("drain", () => back.resume()); }
    });
    front.on("end", () => back.end()); back.on("end", () => front.end());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fault link did not bind");
  url.hostname = "127.0.0.1"; url.port = String(address.port);
  return {
    url: url.toString(),
    urlFor(fresh: string) { const next = new URL(fresh); next.hostname = "127.0.0.1"; next.port = String(address.port); return next.toString(); },
    connections: () => established,
    attempts: () => accepted,
    failure: () => lastError,
    cutAfterClientBytes(bytes: number) { if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("positive fault byte threshold required"); cutAt = clientBytes + bytes; },
    injectedCuts: () => cuts,
    cutAfterServerBytes(bytes: number) { if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("positive fault byte threshold required"); serverCutAt = serverBytes + bytes; },
    bytes: () => ({ client: clientBytes, server: serverBytes }),
    heldBytes: () => ({ client: heldClient, server: heldServer }),
    blackhole(direction: "client" | "server" | "both") { dropClient = direction !== "server"; dropServer = direction !== "client"; },
    clearBlackhole() {
      dropClient = false; dropServer = false;
      for (const item of held) {
        if (!item.target.destroyed && !item.socket.destroyed) {
          if (item.target.write(item.bytes)) item.socket.resume();
          else item.target.once("drain", () => item.socket.resume());
        }
      }
      held.clear();
    },
    cut() { for (const socket of sockets) socket.destroy(); },
    block() { blocked = true; for (const socket of sockets) socket.destroy(); },
    unblock() { blocked = false; },
    async stop() { blocked = true; for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
