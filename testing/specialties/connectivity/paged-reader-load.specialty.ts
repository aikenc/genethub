import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {defineSpecialty} from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.session-pages.concurrent-history-readers",
  title: "Concurrent CLI-shaped history readers preserve foreground control and fresh pages",
  oracle: "Twenty real clients page the same 2001 stored records without loss or duplicates; foreground identity reads remain responsive, disconnecting a reader does not strand survivors, and subsequent pages reflect a committed rename and archive immediately.",
  catches: ["concurrent paged CLI readers amplify summary projection", "background history delays foreground control", "cancelled initializer strands survivors", "shared page persists after a mutation"],
  tags: ["core", "session-pages", "catalog-pressure"], llm: {default: "none"},
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: {environments: 1, cpu: 2, memoryMb: 2048, io: 2, browser: 0},
  surfaces: ["daemon", "filesystem", "workbench-client"],
  productInterfaces: ["session.page", "connection.identity", "session.rename", "session.archive", "@genehub/workbench/client.close"],
  expectedDurationMs: 30000, timeoutMs: 180000,
}, async t => {
  const o = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
  const clients: Array<typeof o.client> = [];
  try {
    const seed = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    const home = join(o.workspaceRoot, ".genethub", "sessions");
    const model = JSON.parse(readFileSync(join(home, seed, "meta.json"), "utf8"));
    const roots = [{id: o.workspaceId, root: o.workspaceRoot}];
    for (let n = 1; n < 100; n++) {
      const root = join(t.env.root, `history-project-${n}`); mkdirSync(root);
      const reply = await o.client.call({type: "workspace.open", payload: {root}});
      if (reply?.type !== "workspace") throw Error("history project did not open");
      roots.push({id: reply.data.id, root});
    }
    const expected = new Set([seed]);
    for (let n = 0; n < 2000; n++) {
      const owner = roots[n % roots.length]!;
      const dir = join(owner.root, ".genethub", "sessions", `s_paged_reader_${n}`);
      const id = `s_paged_reader_${n}`; expected.add(id); mkdirSync(dir, {recursive: true});
      writeFileSync(join(dir, "meta.json"), JSON.stringify({...model, id, workspaceId: owner.id, title: `history ${n}`, titleLocked: true, updatedAtMs: 1000 + n}));
    }
    const page = async (client: typeof o.client, cursor: string | null = null, archived = true) => {
      const reply = await client.call({type: "session.page", payload: {
        requests: [{workspaceId: null, limit: 100, cursor}], includeArchived: archived,
      }}, {timeoutMs: 60000});
      if (reply?.type !== "sessionPages" || !reply.data[0] || reply.data[0].error) throw Error("history page did not complete");
      return reply.data[0];
    };
    const all = async (client: typeof o.client) => {
      const ids: string[] = []; let cursor: string | null = null;
      do {const value = await page(client, cursor); ids.push(...value.sessions.map(s => s.id)); cursor = value.nextCursor;} while (cursor);
      return ids;
    };
    // External writers reconcile within the existing catalog interval.
    await t.tools.waitUntil(async () => (await all(o.client)).length === expected.size, 15000);
    clients.push(...await Promise.all(Array.from({length: 20}, (_, n) => t.flows.main.openSecondClient(o, `paged-history-${n}`))));
    const began = performance.now();
    const reads = clients.map(client => all(client));
    // Attach handlers before any awaited control probe can fail.
    const completed = Promise.all(reads); void completed.catch(() => {});
    const controlMs: number[] = [];
    for (let n = 0; n < 20; n++) {
      const at = performance.now();
      const reply = await o.client.call({type: "connection.identity"}, {timeoutMs: 10000});
      t.assertions.assert(reply?.type === "hello", "foreground control failed under history pressure");
      controlMs.push(Math.round(performance.now() - at));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const results = await completed;
    t.assertions.assert(results.every(ids => ids.length === expected.size && new Set(ids).size === expected.size && ids.every(id => expected.has(id))), "concurrent pagination lost or duplicated a stored record");
    const p95 = [...controlMs].sort((a, b) => a - b)[Math.ceil(controlMs.length * .95) - 1]!;
    t.note(JSON.stringify({readers: clients.length, projects: roots.length, records: expected.size, historyMs: Math.round(performance.now() - began), controlP95Ms: p95, controlMaxMs: Math.max(...controlMs)}));
    t.assertions.assert(p95 < 2000, `foreground control p95 exceeded 2s under paged reads: ${p95}ms`);
    const abandoned = page(clients[0]!).catch(() => undefined);
    const surviving = page(clients[1]!);
    clients[0]!.close(); await abandoned;
    t.assertions.assert((await surviving).sessions.length === 100, "closing one reader stranded a surviving page");
    await o.client.call({type: "session.rename", payload: {sessionId: seed, title: "changed after shared history"}});
    const renamed = await page(o.client);
    t.assertions.assert(renamed.sessions.some(s => s.id === seed && s.title === "changed after shared history"), "completed shared page hid a committed rename");
    await o.client.call({type: "session.archive", payload: {sessionId: seed, archived: true}});
    t.assertions.assert(!(await page(o.client, null, false)).sessions.some(s => s.id === seed), "shared archived page leaked into an unarchived query");
  } finally {clients.forEach(client => client.close()); o.client.close(); o.daemon.stop(); await o.mock.stop();}
});
