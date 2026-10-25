import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { defineSpecialty, startHub, enrollCatalogSource } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.team-scale.hub-catalog", title: "Hub directory with 200 enrolled metadata sources and 2000 projects",
  oracle: "Real HTTP enrollment and catalog synchronization produce a complete, owner-isolated path-free directory; repeated concurrent reads and revision/removal remain consistent",
  catches: ["directory query amplification", "catalog leaks across accounts", "large directory truncation", "removed source project remains routable"],
  tags: ["team-scale", "capacity", "cloud"], llm: { default: "none" },
  expectedDurationMs: 60000, timeoutMs: 240000,
  stages: ["enroll-200-sources", "concurrent-directory-reads"],
  resources: { environments: 1, cpu: 4, memoryMb: 2048, io: 2, browser: 0, pool: "exclusive" },
  surfaces: ["hub", "http", "sqlite"], productInterfaces: ["Cloud HTTP enrollment/catalog/workspaces"], retention: true,
}, async t => {
  // Only onboarding capacity is raised to seed the isolated large fixture.
  // Endpoint issuance uses its production default 60 / ten minutes.
  process.env.HUB_CHANNEL = "stable";
  process.env.HUB_DEVICE_AUTH_PER_HOUR = "1000";
  process.env.HUB_CONNECT_PER_WINDOW = "60";
  const hub = await startHub({ databasePath: join(t.env.data, "hub.sqlite") });
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  try {
    const owner = hub.browser(); await hub.signInOwner(owner);
    const outsider = hub.browser(); await hub.signInOwner(outsider);
    const sources: Awaited<ReturnType<typeof enrollCatalogSource>>[] = [];
    await t.stage("enroll-200-sources", async () => {
      for (let i = 0; i < 200; i++) { const source = await enrollCatalogSource(hub, owner, `Team ${Math.floor(i/20)} member ${i%20}`); sources.push(source); await source.sync(1, 10); }
    });
    const samples: number[] = []; let bytes = 0; let complete = 0;
    const begin = performance.now();
    await t.stage("concurrent-directory-reads", async () => {
      for (let burst = 0; burst < 5; burst++) await Promise.all(Array.from({ length: 20 }, async () => {
        const start = performance.now();
        const response = await owner.fetch("/app/workspaces");
        const text = await response.text(); const data = JSON.parse(text) as { workspaces: Array<{ id: string; name: string; availability: string }> };
        samples.push(performance.now() - start); bytes += Buffer.byteLength(text);
        if (response.ok && data.workspaces.length === 2000 && new Set(data.workspaces.map(w => w.id)).size === 2000 && data.workspaces.every(w => w.availability === "offline") && !/localWorkspaceId|machineId|\/home\/|\/tmp\//.test(text)) complete++;
      }));
    });
    const readMs = performance.now() - begin;
    const initial = await owner.fetch("/app/workspaces");
    const etag = initial.headers.get("etag"); await initial.arrayBuffer();
    let conditionalBytes = 0; const conditionalStatus: Record<number, number> = {};
    for (let i = 0; i < 20; i++) {
      const response = await owner.fetch("/app/workspaces", { headers: { "if-none-match": etag ?? '"unknown-baseline"' } });
      conditionalStatus[response.status] = (conditionalStatus[response.status] ?? 0) + 1;
      conditionalBytes += (await response.arrayBuffer()).byteLength;
    }
    t.assertions.assert(etag ? conditionalStatus[304] === 20 && conditionalBytes === 0 : conditionalStatus[200] === 20,
      "directory validator did not match its actual representation");
    if (etag) {
      const weak = await owner.fetch("/app/workspaces", { headers: { "if-none-match": `"other", W/${etag}` } });
      t.assertions.assert(weak.status === 304 && (await weak.arrayBuffer()).byteLength === 0, "GET validator ignored a weak match in a tag list");
    }
    const unsigned = await hub.browser().fetch("/app/workspaces", { headers: { "if-none-match": etag ?? "*" } });
    t.assertions.assert(unsigned.status === 401, "directory validator bypassed authentication"); await unsigned.arrayBuffer();
    const foreign = await outsider.json<{ workspaces: unknown[] }>("/app/workspaces");
    t.assertions.assert(foreign.workspaces.length === 0 && complete === 100, "directory mixed accounts, paths, presence or omitted projects");
    await sources[0]!.sync(2, 9);
    const updated = await owner.json<{ workspaces: unknown[] }>("/app/workspaces");
    t.assertions.assert(updated.workspaces.length === 1999, "catalog removal did not remove a placement from the directory");
    const invalidated = await owner.fetch("/app/workspaces", { headers: { "if-none-match": etag ?? '"unknown-baseline"' } });
    t.assertions.assert(invalidated.status === 200, "a changed directory falsely reused an old ETag"); await invalidated.arrayBuffer();
    const foreignTag = await outsider.fetch("/app/workspaces", { headers: { "if-none-match": etag ?? '"unknown-baseline"' } });
    t.assertions.assert(foreignTag.status === 200, "foreign owner reused another account's directory validator"); await foreignTag.arrayBuffer();
    const issuance: Record<number, number> = {};
    for (let i = 0; i < 65; i++) {
      const response = await owner.fetch("/app/fabric/endpoints", { method: "POST", body: "{}" });
      issuance[response.status] = (issuance[response.status] ?? 0) + 1;
      // Credentials deliberately discarded, never put into notes or evidence.
      await response.arrayBuffer();
    }
    samples.sort((a,b) => a-b);
    t.note(JSON.stringify({ metadataSources: 200, nativeDaemonsInThisCase: 0, logicalProjects: 2000, concurrentReaders: 20, requests: 100,
      complete, bytes, elapsedMs: Math.round(readMs), requestsPerSecond: +(100000/readMs).toFixed(2),
      directoryMs: { p50: Math.round(samples[49]!), p95: Math.round(samples[94]!), max: Math.round(samples[99]!) },
      eventLoopMaxMs: Math.round(lag.max/1e6), rssMiB: Math.round(process.memoryUsage().rss/1048576),
      ownerIsolation: true, removalCount: updated.workspaces.length, endpointIssuance: issuance,
      conditional: { etagPresent: !!etag, requests: 20, bytes: conditionalBytes, status: conditionalStatus, removalInvalidated: true, foreignIsolated: true },
      fixtureOverride: "HUB_DEVICE_AUTH_PER_HOUR=1000; no directory or endpoint quota override" }));
    t.assertions.assert(issuance[200] === 60 && issuance[429] === 5, "default endpoint issuance budget changed unexpectedly");
  } finally { lag.disable(); await hub.stop(); }
});
