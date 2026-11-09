import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.cached-catalog.background-reconciliation",
  title: "Cached pages stay responsive while external history and project changes converge",
  oracle: "512 real sessions and 13 concurrent readers retain their IDs while shipped Team hook/board processes and a real builtin Agent finish; 192 MiB of external metadata edits and a project member converge without subscriptions, and foreground page p95 stays under 2s",
  catches: ["cached page expiry waits for a global scan", "idle history loads poll absent update receipts", "CLI-only readers never see external edits", "cached project members never refresh"],
  tags: ["core", "session-catalog", "cached-catalog"], llm: { default: "mock" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  surfaces: ["daemon", "filesystem", "workbench-client", "team-template", "agent"],
  productInterfaces: ["workspace.open", "workspace.list", "session.create", "session.page", "session.send", "tools/team.py hook", "tools/team.py board refresh"],
  resources: { environments: 1, cpu: 4, memoryMb: 4096, io: 2, browser: 0 },
  expectedDurationMs: 30000, timeoutMs: 120000,
}, async t => {
  const o = await openTeam(t, "catalog-load-team");
  try {
    await o.client.call({ type: "session.delete", payload: { sessionId: o.front } });
    mkdirSync(o.state(), { recursive: true });
    writeFileSync(join(o.root, ".genethub/open.env"), "TEAM_AGENT=genet\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=100000\nTEAM_WAKE_GAP=0\nTEAM_WAKE_CHECK=60\n");
    writeFileSync(o.state("platform-check.json"), JSON.stringify({ atMs: Date.now() }));
    const teamEnv = { ...o.env, TEAM_AGENT: "genet", TEAM_BOARD_PORT: "0" };
    const ids: string[] = [];
    for (let i = 0; i < 512; i++) ids.push(await t.flows.main.createBuiltinSession(o.client, o.project.id));
    await t.flows.main.configureMockProvider(o.client, o.mock);
    const events = await t.flows.main.attachEventLog(o.client, ids[0]!);
    const expected = new Set(ids);
    const member = { machineId: o.client.identity!.machineId, workspaceId: o.workspaceId, name: "original" };
    const root = join(t.env.root, "descriptor-owner"); mkdirSync(root);
    const descriptor = join(root, "agent-space.genet.json");
    writeFileSync(descriptor, JSON.stringify({ name: "Descriptor owner", members: [member] }));
    const project = await o.client.call({ type: "workspace.open", payload: { root } });
    t.assertions.assert(project?.type === "workspace", "descriptor project did not open");
    // Older artifacts enrich the opened project on workspace.list. Wait for
    // this public readiness contract before timing either implementation.
    await t.tools.waitUntil(async () => {
      const reply = await o.client.call({ type: "workspace.list" });
      return reply?.type === "workspaces" && reply.data.some(w => w.root === root && w.agentSpace?.members?.[0]?.name === "original");
    }, 15000);
    const request = { type: "session.page" as const, payload: { requests: [{ workspaceId: o.project.id, cursor: null, limit: 20 }], includeArchived: true } };
    await o.client.call(request);
    const extension = "x".repeat(2 * 1024 * 1024);
    for (const id of ids.slice(1, 97)) {
      const file = join(o.root, ".genethub", "sessions", id, "meta.json");
      writeFileSync(file + ".next", JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), title: "Externally changed", futureExtension: extension }));
      renameSync(file + ".next", file);
    }
    writeFileSync(descriptor + ".next", JSON.stringify({ name: "Descriptor owner", members: [{ ...member, name: "externally-updated" }] }));
    renameSync(descriptor + ".next", descriptor);
    // Ordinary Timer cadence between reflection checks. Exhaustive per-hook
    // round enumeration is a separate load contract, not a directory read.
    writeFileSync(o.state("reflect.json"), JSON.stringify({ atMs: Date.now(), checkedAtMs: Date.now() }));
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
    let hooks = 0, boards = 0;
    const cadence = async () => {
      // One ordinary Timer owner; overlapping projection publishers are
      // deliberately refused by Team and are a different contract.
      for (let cycle = 0; cycle < 9; cycle++) {
        for (const args of [["hook"], ["board", "refresh"]]) {
          const done = await runGenetAsync(process.env.GENEHUB_PYTHON!, [join(o.root, "tools/team.py"), ...args], teamEnv, { cwd: o.root });
          t.assertions.assert(done.code === 0, `real Team ${args.join(" ")} failed: ${done.stderr.slice(-500)}`);
          if (args[0] === "hook") hooks++; else boards++;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    };
    o.mock.script({ text: "Recorded the requested observation." });
    await Promise.all([
      ...Array.from({ length: 13 }, (_, n) => reader(n)),
      cadence(),
      (async () => {
        await t.flows.main.sendPrompt(o.client, ids[0]!, "Record one brief observation and finish.");
        await t.tools.waitUntil(() => events.some(e => e.type === "turnCompleted"), 30000);
      })(),
    ]);
    t.assertions.assert(hooks === 9 && boards === 9 && events.some(e => e.type === "turnCompleted"), `Team cadence or real builtin Agent incomplete: hooks=${hooks}, boards=${boards}`);
    foreground.sort((a, b) => a - b);
    const p95 = foreground[Math.ceil(foreground.length * .95) - 1]!;
    t.assertions.assert(foreground.length >= 10 && p95 <= 2000, `foreground p95 exceeded 2s: ${Math.round(p95)}ms`);
    const found = new Set<string>(); let cursor: string | null = null; let edited = 0;
    do {
      const reply = await o.client.call({ type: "session.page", payload: { requests: [{ workspaceId: o.project.id, cursor, limit: 100 }], includeArchived: true } });
      if (reply?.type !== "sessionPages" || reply.data[0]?.error) throw Error("reconciled history unavailable");
      for (const s of reply.data[0]!.sessions) { t.assertions.assert(!found.has(s.id), "pagination duplicated an ID"); found.add(s.id); if (s.title === "Externally changed") edited++; }
      cursor = reply.data[0]!.nextCursor;
    } while (cursor);
    t.assertions.assert(found.size === 512 && ids.every(id => found.has(id)) && edited === 96, "external metadata never converged or lost original sessions");
    const projects = await o.client.call({ type: "workspace.list" });
    t.assertions.assert(projects?.type === "workspaces" && projects.data.some(w => w.agentSpace?.members?.some(m => m.name === "externally-updated")), "external descriptor never converged");
    t.note(JSON.stringify({ sessions: 512, readers: 13, externallyEdited: edited, samples: foreground.length, p95Ms: Math.round(p95), maxMs: Math.round(foreground.at(-1)!), catalogSubscriptions: 0, hooks, boards, builtinAgentCompleted: true, reflectionCheckSeconds: 60 }));
  } finally { await o.dispose(); }
});
