import { defineSpecialty, startTcpPayloadServer, measureTcpTransfer, startSharedBottleneck } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.team-scale.link-calibration", title: "Ten raw TCP consumers share one 5Mbps bottleneck without gaining bandwidth",
  oracle: "Ten exact payload hashes cross one aggregate shaper; measured aggregate throughput is below 5.25Mbps and above 1.5Mbps",
  catches: ["per-socket shapers silently multiply capacity", "opaque proxy drops data", "test proxy stalls independently of the product"],
  tags: ["team-scale", "capacity", "calibration"], llm: { default: "none" }, expectedDurationMs: 10000, timeoutMs: 30000,
  resources: { environments: 1, cpu: 2, memoryMb: 512, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["tcp"], retention: true,
}, async t => {
  const source = await startTcpPayloadServer(256*1024);
  const link = await startSharedBottleneck(source.url, { bandwidthMbps: 5, rttMs: 200 });
  try {
    const start = performance.now();
    const samples = await Promise.all(Array.from({ length: 10 }, () => measureTcpTransfer({ url: link.urlFor(source.url), expectedBytes: source.sizeBytes, expectedSha256: source.sha256, timeoutMs: 25000 })));
    const elapsedMs = performance.now() - start;
    const bytes = samples.reduce((sum,s) => sum+s.bytes,0); const actualMbps = bytes*8/elapsedMs/1000;
    t.note(JSON.stringify({ tcpConsumers: 10, configuredAggregateMbps: 5, rttMs: 200, actualMbps: +actualMbps.toFixed(3), elapsedMs: Math.round(elapsedMs), bytes, hashesVerified: samples.length, link: link.stats(), limits: "Node packet scheduler is a bandwidth/latency model, not kernel loss or radio emulation; small-record timer costs differ" }));
    t.assertions.assert(samples.length === 10 && actualMbps > 1.5 && actualMbps < 5.25, "shaper failed conservation or minimum raw capacity calibration");
  } finally { await link.stop(); await source.stop(); }
});
