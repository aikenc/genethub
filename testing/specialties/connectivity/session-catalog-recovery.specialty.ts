import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.session-catalog.thousand-session-parallel-reads",
  title: "A thousand actual conversations stay readable alongside scoped Team and process queries",
  oracle: "The signed guest returns every original session and each exact workspace subset during parallel global/scoped/process reads without reading bodies; no empty success or missing rows hides a slow catalog.",
  catches: ["global catalog times out under Team queries", "scoped list includes another project", "process ownership forces complete conversation rehydration", "empty or partial catalog reported as success"],
  tags: ["core", "session-catalog", "team-urgent-recovery"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["daemon", "filesystem", "workbench-client"], productInterfaces: ["session.create", "session.list", "process.workspaceList", "workspace.open"],
  expectedDurationMs: 45000, timeoutMs: 180000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const workspaces = [o.workspaceId], expected = new Map<string, Set<string>>();
    for (let n = 0; n < 9; n++) {
      const root = join(t.env.root, `catalog-project-${n}`); mkdirSync(root);
      const opened = await o.client.call({ type: "workspace.open", payload: { root } });
      if (opened?.type !== "workspace") throw Error("project did not open");
      workspaces.push(opened.data.id);
    }
    for (const workspace of workspaces) {
      const ids = new Set<string>(); expected.set(workspace, ids);
      for (let batch = 0; batch < 10; batch++) {
        await Promise.all(Array.from({ length: 10 }, async () => ids.add(await t.flows.main.createBuiltinSession(o.client, workspace))));
      }
    }
    const samples: number[] = [], counts: number[] = [];
    for (let round = 0; round < 5; round++) {
      const at = performance.now();
      const global = o.client.call({ type: "session.list", payload: { workspaceId: null, includeArchived: true, lean: true } });
      const scoped = Promise.all(workspaces.map(async workspaceId => {
        const reply = await o.client.call({ type: "session.list", payload: { workspaceId, includeArchived: true, lean: true } });
        t.assertions.assert(reply?.type === "sessions" && reply.data.length === 100 && reply.data.every(s => expected.get(workspaceId)!.has(s.id)), "scoped catalog lost or borrowed a conversation");
      }));
      const processes = o.client.call({ type: "process.workspaceList", payload: { workspaceId: o.workspaceId } });
      const [catalog] = await Promise.all([global, scoped, processes]);
      if (catalog?.type !== "sessions") throw Error("global catalog did not return sessions");
      const all = new Set([...expected.values()].flatMap(v => [...v]));
      t.assertions.assert(catalog.data.length === 1000 && catalog.data.every(s => all.has(s.id)), "global catalog reported incomplete rows as success");
      const ms = performance.now() - at; samples.push(Math.round(ms)); counts.push(catalog.data.length);
      t.assertions.assert(ms < 10000, `isolated thousand-session query batch exceeded 10s: ${Math.round(ms)}ms`);
    }
    t.note(JSON.stringify({ actualSessions: 1000, simultaneousQueries: 12, rounds: 5, elapsedMs: samples, counts, maxMs: Math.max(...samples) }));
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
