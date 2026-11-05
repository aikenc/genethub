import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.process-inventory.concurrent-live-descendants",
  title: "Concurrent process observers preserve actual live ownership across a hundred projects",
  oracle: "Eight real built-in Agents leave real OS descendants alive; concurrent global and scoped inventories retain each original PID/session/workspace while conversation reads complete, and public cleanup removes only those descendants before another native turn succeeds.",
  catches: ["empty process inventory makes catalog load falsely easy", "process ownership rescans unrelated projects for every observer", "scoped inventories borrow another project's processes", "retained inventory survives successful cleanup"],
  tags: ["core", "processes", "session-catalog", "process-inventory-load"],
  llm: { default: "mock" }, expectedDurationMs: 60000, timeoutMs: 240000,
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 4, memoryMb: 4096, io: 2, browser: 0 },
  surfaces: ["daemon", "agent", "filesystem", "workbench-client"],
  productInterfaces: ["workspace.open", "session.create", "session.send", "session.list", "process.list", "process.workspaceList", "process.killAll"],
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const projects = [{ id: o.workspaceId, root: t.env.workspace }];
  const owners: Array<{ id: string; workspace: string; pid: number; events: Array<{ type?: string; raw: unknown }> }> = [];
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    for (let i = 1; i < 100; i++) {
      const root = join(t.env.root, "inventory-project-" + i); mkdirSync(root);
      const opened = await o.client.call({ type: "workspace.open", payload: { root } });
      if (opened?.type !== "workspace") throw Error("inventory project did not open");
      projects.push({ id: opened.data.id, root });
    }
    for (const project of projects.slice(0, 8)) {
      const id = await t.flows.main.createBuiltinSession(o.client, project.id);
      const events = await t.flows.main.attachEventLog(o.client, id);
      o.mock.script({ tool: { name: "bash", arguments: {
        command: "sleep 150 > /dev/null 2>&1 & echo $! > inventory-child.pid",
      } } }, { text: "The background waiter is running." });
      await t.flows.main.sendPrompt(o.client, id, "Start one background waiter and finish this turn while it remains alive.");
      await t.tools.waitUntil(() => events.some(e => e.type === "turnCompleted"), 45000);
      const pid = Number(readFileSync(join(project.root, "inventory-child.pid"), "utf8").trim());
      t.assertions.assert(Number.isInteger(pid) && pid > 0, "native Agent did not write its real descendant PID");
      process.kill(pid, 0);
      owners.push({ id, workspace: project.id, pid, events });
    }
    const samples: number[] = [];
    // An existing registry directory with no registered applications must
    // still preserve actual Agent descendants without a second OS census.
    mkdirSync(join(t.env.data, "service-previews"), { recursive: true });
    for (let round = 0; round < 6; round++) {
      const start = performance.now();
      const global = Array.from({ length: 20 }, () => o.client.call({ type: "process.list" }));
      const scoped = owners.map(owner => o.client.call({ type: "process.workspaceList", payload: { workspaceId: owner.workspace } }));
      const catalogs = Array.from({ length: 10 }, () => o.client.call({ type: "session.list", payload: { workspaceId: null, includeArchived: true, lean: true } }));
      const [inventories, subsets, lists] = await Promise.all([Promise.all(global), Promise.all(scoped), Promise.all(catalogs)]);
      t.assertions.assert(inventories.every(reply => reply?.type === "processes" && owners.every(owner => reply.data.some(p => p.pid === owner.pid && p.sessionId === owner.id && p.workspaceId === owner.workspace))), "global inventory lost a real native descendant or its execution owner");
      t.assertions.assert(subsets.every((reply, i) => reply?.type === "processes" && reply.data.some(p => p.pid === owners[i]!.pid && p.sessionId === owners[i]!.id) && reply.data.every(p => p.workspaceId === owners[i]!.workspace)), "scoped inventory was empty or included another project");
      t.assertions.assert(lists.every(reply => reply?.type === "sessions" && owners.every(owner => reply.data.some(s => s.id === owner.id && s.workspaceId === owner.workspace))), "inventory observers starved or corrupted conversation reads");
      samples.push(Math.round(performance.now() - start));
      t.assertions.assert(samples.at(-1)! < 5000, "concurrent process/catalog batch exceeded five seconds: " + samples.at(-1));
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    for (const owner of owners) await o.client.call({ type: "process.killAll", payload: { sessionId: owner.id } });
    const after = await o.client.call({ type: "process.list" });
    t.assertions.assert(after?.type === "processes" && !after.data.some(p => owners.some(owner => owner.pid === p.pid)), "completed cleanup reused an old in-flight inventory");
    o.mock.script({ text: "Continued after cleanup." });
    await t.flows.main.sendPrompt(o.client, owners[0]!.id, "Record one more observation after the background waiter ended.");
    await t.tools.waitUntil(() => owners[0]!.events.filter(e => e.type === "turnCompleted").length === 2, 15000);
    t.note(JSON.stringify({ projects: projects.length, nativeOwners: owners.length, actualDescendants: owners.length, processObservers: 28, catalogReaders: 10, rounds: samples.length, batchMs: samples, cleanupFresh: true, agentContinued: true }));
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
