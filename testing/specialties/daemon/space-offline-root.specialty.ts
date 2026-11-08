import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.space-offline-root-restart",
  title: "A registered Space keeps offline secondary roots across daemon startup",
  oracle: "A real restart with a detached secondary directory retains its registered root handle and readable local history; descriptor name, order and new roots still refresh, and removal remains final",
  catches: ["startup reopens unavailable registered roots", "discovery silently drops offline folders", "cached roots freeze descriptor edits", "scan resurrects a removed Space"],
  tags: ["core", "daemon", "space-discovery"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["workspace.list", "workspace.remove", "session.create", "session.get", "settings.get"],
  surfaces: ["daemon", "filesystem", "workbench-client"],
  resources: { environments: 1, cpu: 1, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 12_000, timeoutMs: 90_000,
}, async t => {
  const root = join(t.env.data, "spaces", "offline-fixture");
  const secondary = join(t.env.root, "detachable");
  mkdirSync(root, { recursive: true }); mkdirSync(secondary);
  const descriptor = join(root, "agent-space.genet.json");
  const lay = (name: string, folders: Array<{path: string; name?: string}>) =>
    writeFileSync(descriptor, JSON.stringify({ name, folders }));
  const external = { path: relative(root, secondary), name: "external" };
  lay("offline-fixture", [{path: "."}, external]);
  let o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const before = await o.client.call({ type: "workspace.list" });
    const w = before?.type === "workspaces" ? before.data.find(w => w.name === "offline-fixture") : undefined;
    if (!w || w.folders.length !== 2) throw Error("fixture was not registered with both real roots");
    const id = await t.flows.main.createBuiltinSession(o.client, w.id);
    o.client.close(); o.daemon.stop(); await o.mock.stop();
    // A detached mount is an OS/filesystem boundary, not a mocked product
    // callback. TCC waiting itself is covered by the separate real Mac canary.
    renameSync(secondary, secondary + "-detached");
    o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const after = await o.client.call({ type: "workspace.list" });
    const restored = after?.type === "workspaces" ? after.data.find(x => x.id === w.id) : undefined;
    t.assertions.assert(JSON.stringify(restored?.folders) === JSON.stringify(w.folders), "restart dropped or replaced an offline registered folder/handle");
    const session = await o.client.call({ type: "session.get", payload: { sessionId: id, recentRounds: 1 } });
    const settings = await o.client.call({ type: "settings.get" });
    t.assertions.assert(session?.type === "snapshot" && session.data.summary.workspaceId === w.id && settings?.type === "settings", "offline secondary root blocked local history or settings");
    mkdirSync(join(root, "new"));
    lay("offline-edited", [external, { path: ".", name: "local" }, { path: "new" }]);
    const saved = () => JSON.parse(readFileSync(join(t.env.data, "config.json"), "utf8")).workspaces as Array<{id: string; name: string}>;
    await t.tools.waitUntil(() => saved().some(x => x.id === w.id && x.name === "offline-edited"), 15_000);
    const edited = await o.client.call({ type: "workspace.list" });
    const current = edited?.type === "workspaces" ? edited.data.find(x => x.id === w.id) : undefined;
    t.assertions.assert(current?.folders.map(f => f.name).join(",") === "external,local,new" && current.folders[0]?.rootHandle === w.folders[1]?.rootHandle, "descriptor edits lost order, names, new root or stable handle");
    // Restore local as primary before removal, so removing is independent of
    // explicit filesystem operations against a detached primary root.
    lay("offline-local-first", [{path: "."}, external]);
    await t.tools.waitUntil(() => saved().some(x => x.id === w.id && x.name === "offline-local-first"), 15_000);
    const removed = await o.client.call({type: "workspace.remove", payload: {workspaceId: w.id}});
    t.assertions.assert(removed?.type === "workspaces" && !removed.data.some(x => x.id === w.id), "remove failed");
    lay("must-stay-removed", [{path: "."}, external]);
    // A sibling's registration witnesses a subsequent discovery pass.
    const sibling = join(t.env.data, "spaces", "scan-witness"); mkdirSync(sibling);
    writeFileSync(join(sibling, "agent-space.genet.json"), JSON.stringify({name: "scan-witness"}));
    await t.tools.waitUntil(() => saved().some(x => x.name === "scan-witness"), 15_000);
    const final = await o.client.call({type: "workspace.list"});
    t.assertions.assert(final?.type === "workspaces" && !final.data.some(x => x.id === w.id), "discovery resurrected removed offline project");
    t.note("real restart retained offline folder handles and local history; descriptor edits, new root and removal passed");
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
