import { createConnection, createServer } from "node:net";
import { defineSpecialty, startFaultLink } from "../../framework/public.ts";

for (const direction of ["client", "server", "both"] as const) defineSpecialty({
  id: "specialty.contracts.fault-blackhole-" + direction,
  title: "Opaque " + direction + " blackhole stalls real bytes without closing TCP",
  oracle: "Independent echo server and TCP client observe directional held-byte counters, no connection replacement, and successful traffic after restoration",
  catches: ["fault silently bypassed", "one-way injection affects both directions", "blackhole is actually disconnect"],
  tags: ["contract", "network-audit-fix"], llm: { default: "none" }, expectedDurationMs: 500, timeoutMs: 10000,
  surfaces: ["tcp"],
}, async t => {
  let received = "";
  const server = createServer(s => { s.on("data", b => { received += b.toString(); s.write(b); }); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
  const link = await startFaultLink("tcp://127.0.0.1:" + address.port);
  const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(link.url).port) });
  let echoed = ""; socket.on("data", b => { echoed += b.toString(); });
  try {
    await new Promise<void>(r => socket.once("connect", r));
    socket.write("before"); await t.tools.waitUntil(() => echoed === "before", 3000);
    link.blackhole(direction); socket.write("lost");
    await t.tools.waitUntil(() => direction === "server" ? link.heldBytes().server === 4 : link.heldBytes().client === 4, 3000);
    t.assertions.assert(echoed === "before" && !socket.destroyed && link.connections() === 1, "blackhole closed or leaked data");
    t.assertions.assert(received === (direction === "server" ? "beforelost" : "before"), "wrong side was blocked");
    link.clearBlackhole(); socket.write("after"); await t.tools.waitUntil(() => echoed === "beforelostafter", 3000);
  } finally { socket.destroy(); await link.stop(); await new Promise<void>(r => server.close(() => r())); }
});
