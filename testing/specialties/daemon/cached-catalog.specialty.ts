import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.cached-catalog.background-reconciliation",
  title: "Cached pages stay responsive while external history and project changes converge",
  oracle: "512 real idle sessions and 13 concurrent readers retain their IDs; a newer writer changes 192 MiB of metadata and a project member, both become visible without a browser subscription, and foreground page p95 stays under 2s across repeated reconciliation periods",
  catches: ["cached page expiry waits for a global scan", "idle history loads poll absent update receipts", "CLI-only readers never see external edits", "cached project members never refresh"],
  tags: ["core", "session-catalog", "cached-catalog"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "filesystem", "workbench-client"],
  productInterfaces: ["workspace.open", "workspace.list", "session.create", "session.page"],
  resources: { environments: 1, cpu: 4, memoryMb: 4096, io: 2, browser: 0 },
  expectedDurationMs: 30000, timeoutMs: 120000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 512; i++) ids.push(await t.flows.main.createBuiltinSession(o.client, o.workspaceId));
    const expected = new Set(ids);
    const member = { machineId: o.client.identity!.machineId, workspaceId: o.workspaceId, name: "original" };
    const root = join(t.env.root, "descriptor-owner"); mkdirSync(root);
    const descriptor = join(root, "agent-space.genet.json");
    writeFileSync(descriptor, JSON.stringify({ name: "Descriptor owner", members: [member] }));
    const project = await o.client.call({ type: "workspace.open", payload: { root } });
    t.assertions.assert(project?.type === "workspace" && project.data.agentSpace?.members?.[0]?.name === "original", "explicit open did not validate the descriptor");
    const request = { type: "session.page" as const, payload: { requests: [{ workspaceId: o.workspaceId, cursor: null, limit: 20 }], includeArchived: true } };
    await o.client.call(request);
    const extension = "x".repeat(2 * 1024 * 1024);
    for (const id of ids.slice(0, 96)) {
      const file = join(o.workspaceRoot, ".genethub", "sessions", id, "meta.json");
      writeFileSync(file + ".next", JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), title: "Externally changed", futureExtension: extension }));
      renameSync(file + ".next", file);
    }
    writeFileSync(descriptor + ".next", JSON.stringify({ name: "Descriptor owner", members: [{ ...member, name: "externally-updated" }] }));
    renameSync(descriptor + ".next", descriptor);
    // No catalog/body subscription: discovery must also serve CLI-only use.
    const deadline = Date.now() + 15000, foreground: number[] = [];
    const reader = async (worker: number) => {
      while (Date.now() < deadline) {
        const at = performance.now();
        const reply = await o.client.call(request, { timeoutMs: 15000 });
        const elapsed = performance.now() - at;
        t.assertions.assert(reply?.type === "sessionPages" && !reply.data[0]?.error && reply.data[0]?.sessions.length === 20
          && reply.data[0].sessions.every(s => expected.has(s.id)), "concurrent page lost IDs, scope or readiness");
        if (worker === 0) foreground.push(elapsed);
        const projects = await o.client.call({ type: "workspace.list" });
        t.assertions.assert(projects?.type === "workspaces", "directory unavailable during reconciliation");
        await new Promise(resolve => setTimeout(resolve, worker === 0 ? 100 : 500));
      }
    };
    await Promise.all(Array.from({ length: 13 }, (_, n) => reader(n)));
    foreground.sort((a, b) => a - b);
    const p95 = foreground[Math.ceil(foreground.length * .95) - 1]!;
    t.assertions.assert(foreground.length >= 10 && p95 <= 2000, `foreground p95 exceeded 2s: ${Math.round(p95)}ms`);
    const found = new Set<string>(); let cursor: string | null = null; let edited = 0;
    do {
      const reply = await o.client.call({ type: "session.page", payload: { requests: [{ workspaceId: o.workspaceId, cursor, limit: 100 }], includeArchived: true } });
      if (reply?.type !== "sessionPages" || reply.data[0]?.error) throw Error("reconciled history unavailable");
      for (const s of reply.data[0]!.sessions) { t.assertions.assert(!found.has(s.id), "pagination duplicated an ID"); found.add(s.id); if (s.title === "Externally changed") edited++; }
      cursor = reply.data[0]!.nextCursor;
    } while (cursor);
    t.assertions.assert(found.size === 512 && ids.every(id => found.has(id)) && edited === 96, "external metadata never converged or lost original sessions");
    const projects = await o.client.call({ type: "workspace.list" });
    t.assertions.assert(projects?.type === "workspaces" && projects.data.some(w => w.agentSpace?.members?.some(m => m.name === "externally-updated")), "external descriptor never converged");
    t.note(JSON.stringify({ idleSessions: 512, readers: 13, externallyEdited: edited, samples: foreground.length, p95Ms: Math.round(p95), maxMs: Math.round(foreground.at(-1)!), bodySubscriptions: 0 }));
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
