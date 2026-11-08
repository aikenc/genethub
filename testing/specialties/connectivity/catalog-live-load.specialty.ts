import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.session-catalog.live-pumps-and-fifty-readers",
  title: "Fifty catalog readers stay responsive with a hundred projects and real resident Agent pumps",
  oracle: "The signed guest retains all 400 public-created sessions across repeated 50-way reads while four real built-in Agent processes remain resident; quiet metadata is not rewritten, a later turn completes, and post-batch mutations are immediately visible.",
  catches: ["overlapping complete scans amplify background load", "quiet Agent pumps fsync identical metadata", "shared reads become a stale cache", "load prevents a new native turn completing"],
  tags: ["core", "session-catalog", "catalog-live-load"], llm: { default: "mock" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 4, memoryMb: 4096, io: 2, browser: 0 },
  surfaces: ["daemon", "agent", "filesystem", "workbench-client"],
  productInterfaces: ["workspace.open", "session.create", "session.send", "session.list", "session.rename", "session.archive", "session.delete", "process.workspaceList"],
  expectedDurationMs: 90000, timeoutMs: 240000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    const workspaces = [o.workspaceId], ids: string[] = [];
    for (let i = 1; i < 100; i++) {
      const root = join(t.env.root, `live-project-${i}`); mkdirSync(root);
      const opened = await o.client.call({ type: "workspace.open", payload: { root } });
      if (opened?.type !== "workspace") throw Error("workspace did not open");
      workspaces.push(opened.data.id);
    }
    for (const workspace of workspaces) {
      ids.push(...await Promise.all(Array.from({ length: 4 }, () => t.flows.main.createBuiltinSession(o.client, workspace))));
    }
    // Four source-project sessions keep their real built-in Agent subprocesses
    // and pumps alive after completion. Only the remote LLM endpoint is mocked.
    const residents = ids.slice(0, 4);
    o.mock.script(...residents.map(() => ({ text: "Recorded the requested observation." })));
    const logs = await Promise.all(residents.map(id => t.flows.main.attachEventLog(o.client, id)));
    await Promise.all(residents.map(id => t.flows.main.sendPrompt(o.client, id, "Record a brief observation and finish this turn.")));
    await t.tools.waitUntil(() => logs.every(events => events.some(e => e.type === "turnCompleted")), 45000);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const files = residents.map(id => join(t.env.workspace, ".genethub", "sessions", id, "meta.json"));
    const quiet = files.map(file => statSync(file, { bigint: true }).mtimeNs);
    await new Promise(resolve => setTimeout(resolve, 4000));
    t.assertions.assert(files.every((file, i) => statSync(file, { bigint: true }).mtimeNs === quiet[i]), "quiet completed Agent metadata was rewritten");
    const residentPids = files.map(file => JSON.parse(readFileSync(file, "utf8")).agentPid as number);
    t.assertions.assert(residentPids.every(pid => Number.isInteger(pid) && pid > 0), "resident Agents have no native process identity");
    for (const pid of residentPids) process.kill(pid, 0);
    const expected = new Set(ids);
    const samples: number[] = [];
    for (let round = 0; round < 12; round++) {
      if (round === 3) {
        o.mock.script({ text: "Finished the later request.", delayMs: 2000 });
        await t.flows.main.sendPrompt(o.client, residents[0]!, "Record one further observation and finish.");
      }
      const at = performance.now();
      const bulk = Array.from({ length: 50 }, (_, i) => o.client.call({
        type: "session.list", payload: { workspaceId: null, includeArchived: true, lean: i % 2 === 0 },
      }));
      const scoped = workspaces.slice(0, 10).map(workspaceId => o.client.call({
        type: "session.list", payload: { workspaceId, includeArchived: true, lean: true },
      }));
      const [all, subsets, processes] = await Promise.all([
        Promise.all(bulk), Promise.all(scoped),
        o.client.call({ type: "process.workspaceList", payload: { workspaceId: o.workspaceId } }),
      ]);
      t.assertions.assert(all.every(reply => reply?.type === "sessions" && reply.data.length === 400 && reply.data.every(s => expected.has(s.id)) && new Set(reply.data.map(s => s.id)).size === 400), "a complete catalog lost rows under resident Agent load");
      t.assertions.assert(subsets.every((reply, i) => reply?.type === "sessions" && reply.data.length === 4 && reply.data.every(s => s.workspaceId === workspaces[i])), "scoped readers received another project snapshot");
      t.assertions.assert(processes?.type === "processes", "process query failed during catalog load");
      samples.push(Math.round(performance.now() - at));
      t.assertions.assert(samples.at(-1)! < 10000, `61-way read batch exceeded 10s: ${samples.at(-1)}ms`);
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
    await t.tools.waitUntil(() => logs[0]!.filter(e => e.type === "turnCompleted").length === 2, 10000);
    for (const pid of residentPids) process.kill(pid, 0);
    const fresh = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    await o.client.call({ type: "session.rename", payload: { sessionId: fresh, title: "New after shared reads" } });
    await o.client.call({ type: "session.archive", payload: { sessionId: fresh, archived: true } });
    const visible = await o.client.call({ type: "session.list", payload: { workspaceId: o.workspaceId, includeArchived: false, lean: true } });
    const archived = await o.client.call({ type: "session.list", payload: { workspaceId: o.workspaceId, includeArchived: true, lean: false } });
    t.assertions.assert(visible?.type === "sessions" && !visible.data.some(s => s.id === fresh) && archived?.type === "sessions" && archived.data.some(s => s.id === fresh && s.title === "New after shared reads" && s.archived), "post-batch creation/rename/archive was hidden by a retained snapshot");
    await o.client.call({ type: "session.delete", payload: { sessionId: fresh } });
    const deleted = await o.client.call({ type: "session.list", payload: { workspaceId: null, includeArchived: true, lean: true } });
    t.assertions.assert(deleted?.type === "sessions" && deleted.data.length === 400 && !deleted.data.some(s => s.id === fresh), "post-batch deletion reused a stale catalog");
    t.note(JSON.stringify({ sessions: 400, projects: 100, realResidentAgents: residents.length, globalReaders: 50, rounds: samples.length, batchMs: samples, quietMetadataRewrites: 0, laterTurnCompleted: true }));
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});

defineSpecialty({
  id: "specialty.session-catalog.cancelled-readers-recover",
  title: "Closing the initial or every registry-refresh consumer leaves later real reads usable",
  oracle: "A real carrier closes during a large signed-guest read; another consumer still receives the full catalog, and after all consumers disconnect the next query completes with the same native IDs.",
  catches: ["cancelled initializer strands shared-read waiters", "abandoned shared read stays permanently cached", "one client disconnect aborts another consumer"],
  tags: ["core", "session-catalog", "catalog-live-load"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 2, browser: 0 },
  surfaces: ["daemon", "filesystem", "workbench-client"], productInterfaces: ["session.create", "session.list", "@genehub/workbench/client.close"],
  expectedDurationMs: 15000, timeoutMs: 120000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const clients: Array<typeof o.client> = [];
  try {
    const ids: string[] = [];
    for (let i = 0; i < 64; i++) ids.push(await t.flows.main.createBuiltinSession(o.client, o.workspaceId));
    // Real disk metadata extension, as a newer compatible writer may add.
    // No daemon/client method is replaced to fabricate a pending operation.
    const extension = "x".repeat(2 * 1024 * 1024);
    for (const id of ids) {
      const file = join(t.env.workspace, ".genethub", "sessions", id, "meta.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), futureExtension: extension }));
    }
    const request = { type: "session.list" as const, payload: { workspaceId: null, includeArchived: true, lean: true } };
    const first = await t.flows.main.openSecondClient(o, "catalog-initializer"); clients.push(first);
    // A new registered home requires a genuinely cold read set. A warm cached
    // read is now correctly fast, so expiry alone cannot prove cancellation.
    const coldRoot = join(t.env.root, "cold-registry"); mkdirSync(coldRoot);
    await o.client.call({type:"workspace.open",payload:{root:coldRoot}});
    let settled = false;
    const abandoned = first.call(request).then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    t.assertions.assert(!settled, "fixture read finished before carrier cancellation");
    const surviving = o.client.call(request);
    first.close(); await abandoned;
    const result = await surviving;
    t.assertions.assert(result?.type === "sessions" && result.data.length === 64 && result.data.every(s => ids.includes(s.id)), "surviving consumer lost the catalog after initializer disconnect");
    const abandonedClients = await Promise.all(Array.from({ length: 4 }, (_, i) => t.flows.main.openSecondClient(o, `catalog-abandon-${i}`)));
    clients.push(...abandonedClients);
    const nextRoot = join(t.env.root, "cold-registry-again"); mkdirSync(nextRoot);
    await o.client.call({type:"workspace.open",payload:{root:nextRoot}});
    const pending = abandonedClients.map(client => client.call(request).catch(() => undefined));
    await new Promise(resolve => setTimeout(resolve, 20));
    abandonedClients.forEach(client => client.close()); await Promise.all(pending);
    const next = await o.client.call(request);
    t.assertions.assert(next?.type === "sessions" && next.data.length === 64, "all-consumer cancellation stranded later reads");
    t.note("Real carrier cancellation preserved the surviving consumer and the later fresh read; no RPC error was injected.");
  } finally { clients.forEach(client => client.close()); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
