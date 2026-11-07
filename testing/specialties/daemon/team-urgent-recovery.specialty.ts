import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-urgent-recovery.internal-notes-and-successor",
  title: "Real Team failures stay internal and late released receipts leave successor leases untouched",
  oracle: "Actual identity compilation errors aggregate into one internal note without a front turn; a late original released receipt retires while the successor writer bytes remain identical and an independent real result arrives.",
  catches: ["mechanism errors wake the front", "changing failure detail produces unbounded notes", "late predecessor deletes successor lock", "one old receipt blocks independent results"],
  tags: ["core", "team-urgent-recovery"], llm: { default: "none" },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  surfaces: ["team-template", "daemon", "filesystem"], productInterfaces: ["tools/run.py tick", "session.create", "session.send", "Team durable receipts"],
  expectedDurationMs: 20000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "urgent-team", [], { configureSource(root) {
    mkdirSync(join(root, "tools/acceptance"), { recursive: true });
    writeFileSync(join(root, "tools/acceptance/__init__.py"), "");
    writeFileSync(join(root, "tools/acceptance/quiet.py"), "from genet_builtin.api import ReflectionPolicy, Decision\nclass Quiet(ReflectionPolicy):\n def evaluate(self, context, snapshot): return Decision.hold('acceptance keeps reflection explicitly controlled')\n");
    const file = join(root, "agent-space.genet.json"), desc = JSON.parse(readFileSync(file, "utf8"));
    desc.team = { reflection_class: "acceptance.quiet:Quiet" }; writeFileSync(file, JSON.stringify(desc));
  } });
  const write = (file: string, value: unknown) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
  try {
    await r.send(r.front, "Keep coordinating the accepted user goal");
    await t.tools.waitUntil(async () => { const s = (await r.snapshot(r.front)).summary; return s.status === "idle" && !!s.latestReply; }, 15000);
    const before = (await r.snapshot(r.front)).items.length;
    const descriptor = join(r.root, "agent-space.genet.json"), original = readFileSync(descriptor, "utf8");
    const notes = () => existsSync(r.state("notes")) ? readdirSync(r.state("notes")).filter(x => x.endsWith(".json")).map(x => JSON.parse(readFileSync(r.state("notes", x), "utf8"))) : [];
    // A normal explicit-build configuration must not manufacture anomaly work.
    // Keep the actual Builder refusal: no publishing or identity edits on tick.
    const soul = join(r.root, "soul.md"), savedSoul = readFileSync(soul, "utf8");
    const identity = join(r.root, "front/AGENTS.md"), savedIdentity = readFileSync(identity, "utf8");
    const published = join(r.root, "unexpected-publication");
    const guarded = JSON.parse(original);
    guarded.buildHooks = { post: [{ args: ["{python}", "-c", "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('published')", published] }] };
    writeFileSync(descriptor, JSON.stringify(guarded)); writeFileSync(soul, savedSoul + "\nExplicit build required.\n");
    for (let i = 0; i < 2; i++) r.ok(["tick"], { TEAM_BOARD_PORT: "0", TEAM_PLATFORM_CHECK: "999999" });
    t.assertions.assert(!existsSync(published) && readFileSync(identity, "utf8") === savedIdentity, "guarded timer ran a deployment or changed identity");
    t.assertions.assert(!notes().some(x => x.from === "system:team-hook"), "expected explicit-build mode created anomaly work");
    t.assertions.assert((await r.snapshot(r.front)).items.length === before, "guarded timer woke the front");
    writeFileSync(descriptor, original); writeFileSync(soul, savedSoul);
    r.ok(["tick"], { TEAM_BOARD_PORT: "0", TEAM_PLATFORM_CHECK: "999999" });
    const desc = JSON.parse(original); desc.identity = ["missing-identity.md"]; writeFileSync(descriptor, JSON.stringify(desc));
    for (let i = 0; i < 3; i++) {
      desc.identity = [`missing-identity-${i}.md`]; writeFileSync(descriptor, JSON.stringify(desc));
      r.ok(["tick"], { TEAM_BOARD_PORT: "0", TEAM_PLATFORM_CHECK: "999999" });
    }
    t.assertions.assert(notes().filter(x => x.from === "system:team-hook").length === 1, "one unresolved identity fault multiplied notes");
    t.assertions.assert((await r.snapshot(r.front)).items.length === before, "internal mechanism error woke the real front");
    const first = notes().find(x => x.from === "system:team-hook")!.id;
    writeFileSync(descriptor, original);
    write(r.state("health-check.json"), { atMs: 0 });
    r.ok(["tick"], { TEAM_BOARD_PORT: "0", TEAM_PLATFORM_CHECK: "999999" });
    r.ok(["notes", "done", first, "--result", "source restored and actual hook health checked"]);
    desc.identity = ["missing-again.md"]; writeFileSync(descriptor, JSON.stringify(desc));
    r.ok(["tick"], { TEAM_BOARD_PORT: "0", TEAM_PLATFORM_CHECK: "999999" });
    t.assertions.assert(notes().some(x => x.from === "system:team-hook" && x.id !== first), "verified recovery permanently suppressed a new occurrence");
    writeFileSync(descriptor, original);

    const role = r.spaces.find(x => x.name === "leader" && x.agentSpace?.parentWorkspaceId === r.project.id)!;
    const old = await r.create("ctl-normal", role.id), uncertain = await r.create("ctl-normal", role.id), good = await r.create("ctl-normal", role.id);
    await r.send(good, "Produce the independent acceptance result once");
    await t.tools.waitUntil(async () => { const s = (await r.snapshot(good)).summary; return s.status === "idle" && !!s.latestReply; }, 15000);
    const newHolder = await r.create("ctl-normal", role.id), lock = join(r.root, "successor/.genethub/genet-writer.json");
    const lease = JSON.stringify({ session: newHolder, requestId: "taskop.successor", custom: "must survive byte for byte" });
    mkdirSync(join(lock, ".."), { recursive: true }); writeFileSync(lock, lease);
    // Restored incident data, not a replacement dispatcher. Public tick must
    // honor the original release fact and still deliver the unrelated result.
    write(r.state("task-dispatch", "taskop.predecessor.json"), { operationId: "taskop.predecessor", sessionId: old, resourceBinding: { directory: join(r.root, "successor") }, resourceReleased: true, state: "accepted" });
    write(r.state("task-dispatch", "taskop.uncertain.json"), { operationId: "taskop.uncertain", sessionId: uncertain, resourceReleased: false, state: "accepted" });
    for (const [sid, extra] of [[old, { taskId: "task.absent.after.cleanup", operationId: "taskop.predecessor", lock, superseded: true }], [uncertain, { taskId: "task.absent.after.cleanup", operationId: "taskop.uncertain", lock, superseded: true }], [good, {}]] as const) {
      write(r.state("pending", sid + ".json"), { sessionId: sid, requester: r.front, batch: sid, kind: "research", desc: "restored acceptance", createdAtMs: Date.now(), baseline: null, notified: [], ...extra });
    }
    r.ok(["tick"], { TEAM_BOARD_PORT: "0", TEAM_PLATFORM_CHECK: "999999" });
    t.assertions.assert(existsSync(r.state("done", old + ".json")) && !existsSync(r.state("pending", old + ".json")), "released old receipt did not retire");
    t.assertions.assert(readFileSync(lock, "utf8") === lease, "old receipt changed successor lease bytes");
    t.assertions.assert(JSON.parse(readFileSync(r.state("pending", uncertain + ".json"), "utf8")).lastReconcileError, "unknown release was silently settled or removed");
    await t.tools.waitUntil(async () => (await r.snapshot(r.front)).summary.status === "idle", 15000);
    t.assertions.assert((await r.snapshot(r.front)).items.some(x => x.type === "userMessage" && x.text.includes(`ghref:item:${good}:`)), "independent real result was blocked by old receipt");
    t.note("One internal incident note, no front turn, original released receipt settled, successor bytes unchanged, independent native result consumed");
  } finally { await r.dispose(); }
});
