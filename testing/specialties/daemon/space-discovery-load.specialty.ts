import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

// P01/P04/P08/P11: public production client + signed Guest; persistent files
// and actual callback output are independent oracles, with no internal mocks.
defineSpecialty({
  id: "specialty.daemon.space-discovery-with-session-load",
  title: "Independent Space discovery keeps lists and Timer progressing with thousand-session history",
  oracle: "192 three-directory Spaces register without any workspace query; concurrent public lists retain 1001 sessions, small requests stay responsive, Timer writes continue, and edited/removed Space identities remain correct",
  catches: ["workspace queries still own discovery", "multi-root discovery monopolizes the Guest", "partial history returned as complete", "discovery restores removed projects", "directory refresh changes identity or parent"],
  tags: ["core", "daemon", "performance", "space-discovery", "session-read"],
  llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["workspace.list", "workspace.remove", "session.create", "session.list", "session.get", "settings.get", "timer hook files"],
  surfaces: ["daemon", "filesystem", "workbench-client"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 2, browser: 0, pool: "standard" },
  expectedDurationMs: 35_000, timeoutMs: 180_000,
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const target = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const sessions = join(t.env.workspace, ".genethub", "sessions");
    const original = JSON.parse(readFileSync(join(sessions, target, "meta.json"), "utf8"));
    const expected = new Set([target]);
    // Compatible external writers use the native disk format. Each copy has a
    // distinct ID; preserve ownership from the real publicly created record.
    for (let i = 0; i < 1000; i++) {
      const id = `s_discovery_${i}`;
      mkdirSync(join(sessions, id));
      writeFileSync(join(sessions, id, "meta.json"), JSON.stringify({ ...original,
        id, title: `History ${i}`, titleLocked: true, updatedAtMs: original.updatedAtMs - i - 1 }));
      expected.add(id);
    }
    const hooks = join(t.env.workspace, ".genethub", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "load-witness.genet.json"), JSON.stringify({ event: "timer", every: "1s",
      exec: [process.execPath, "-e", "require('fs').appendFileSync('timer-witness.log','tick\\n')"] }));
    const roots: string[] = [];
    const lay = (root: string, name: string, folders = ["src", "assets", "out"]) => {
      for (const folder of folders) mkdirSync(join(root, folder), { recursive: true });
      writeFileSync(join(root, "agent-space.genet.json"), JSON.stringify({ name,
        folders: folders.map(folder => ({ path: folder, name: folder })) }));
    };
    for (let i = 0; i < 64; i++) {
      const root = join(t.env.data, "spaces", `load-${i}`); roots.push(root);
      lay(root, `load-${i}`);
      lay(join(root, "spaces", "actor"), `load-${i}-actor`);
      lay(join(root, "spaces", "qa"), `load-${i}-qa`);
    }
    type Saved = { id: string; name: string; removed?: boolean; workspaceFile?: string };
    const saved = (): Saved[] => JSON.parse(readFileSync(join(t.env.data, "config.json"), "utf8")).workspaces;
    const discovered = () => saved().filter(w => w.name.startsWith("load-") && !w.removed);
    // Deliberately do not call workspace.list/open here. A query-triggered
    // implementation cannot pass just by being fast on the fixture machine.
    await t.tools.waitUntil(() => discovered().length === 192, 60_000);
    const first = discovered().find(w => w.name === "load-0")!;
    const removed = discovered().find(w => w.name === "load-1")!;
    const samples: number[] = [];
    const started = performance.now();
    const small = (async () => {
      do {
        const before = performance.now();
        const [settings, detail] = await Promise.all([
          opened.client.call({ type: "settings.get" }),
          opened.client.call({ type: "session.get", payload: { sessionId: target, recentRounds: 1 } }),
        ]);
        samples.push(performance.now() - before);
        t.assertions.assert(settings?.type === "settings" && detail?.type === "snapshot" && detail.data.summary.id === target, "small request lost its result");
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (performance.now() - started < 12_000);
    })();
    let completedLists = 0;
    const readers = Array.from({ length: 3 }, async () => {
      do {
        const [spaces, list] = await Promise.all([
          opened.client.call({ type: "workspace.list" }),
          opened.client.call({ type: "session.list", payload: { workspaceId: null, includeArchived: true, lean: true } }),
        ]);
        t.assertions.assert(spaces?.type === "workspaces" && spaces.data.some(w => w.id === first.id), "registered project disappeared");
        t.assertions.assert(list?.type === "sessions" && list.data.length === expected.size && list.data.every(s => expected.has(s.id)), "parallel query returned partial or wrong history");
        completedLists++;
        await new Promise(resolve => setTimeout(resolve, 150));
      } while (performance.now() - started < 12_000);
    });
    await Promise.all([small, ...readers]);
    const ticks = join(t.env.workspace, "timer-witness.log");
    const count = existsSync(ticks) ? readFileSync(ticks, "utf8").trim().split("\n").length : 0;
    t.assertions.assert(count >= 3, "Timer did not progress alongside discovery and list readers");
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    t.note(`spaces=192 declaredDirectories=576 history=${expected.size} lists=${completedLists} smallSamples=${samples.length} smallP95Ms=${Math.round(p95)} smallMaxMs=${Math.round(samples.at(-1)!)} timerTicks=${count}`);
    t.assertions.assert(samples.length >= 10 && p95 < 1000 && samples.at(-1)! < 3000, "small requests stalled under catalog load");

    await opened.client.call({ type: "workspace.remove", payload: { workspaceId: removed.id } });
    lay(roots[0]!, "load-0-edited", ["assets", "src", "new"]);
    await t.tools.waitUntil(() => saved().some(w => w.id === first.id && w.name === "load-0-edited"), 30_000);
    // Force another observable scan by changing a different descriptor, then
    // inspect the removed entry after that scan instead of sleeping blindly.
    lay(roots[2]!, "load-2-edited");
    await t.tools.waitUntil(() => saved().some(w => w.name === "load-2-edited"), 30_000);
    const final = await opened.client.call({ type: "workspace.list" });
    t.assertions.assert(final?.type === "workspaces", "workspace list missing after edits");
    if (final?.type !== "workspaces") return;
    const refreshed = final.data.find(w => w.id === first.id);
    const child = final.data.find(w => w.name === "load-0-actor");
    t.assertions.assert(refreshed?.name === "load-0-edited" && refreshed.folders.map(f => f.name).join(",") === "assets,src,new", "descriptor edit lost identity, names or order");
    t.assertions.assert(child?.agentSpace?.parentWorkspaceId === first.id, "directory edit lost child parent");
    t.assertions.assert(!final.data.some(w => w.id === removed.id || w.agentSpace?.parentWorkspaceId === removed.id), "background discovery resurrected a removed team");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
