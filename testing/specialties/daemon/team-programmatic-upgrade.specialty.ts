import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-upgrade-unrelated-history",
  title: "An unrelated template history is one conflict across reflection-only commits",
  oracle: "Real independent Git roots reproduce the DS/HY upgrade failure. The public upgrader preserves the source and reports conflict; subsequent memory and reflection-report commits keep the same failure generation and note count. A real tool change permits a fresh attempt without rewriting either history.",
  catches: ["missing ancestor reported as test failure", "reflection report triggers another upgrade failure", "same failed cause repeatedly wakes reflection", "relevant source correction cannot retry"],
  tags: ["core", "team-upgrade"], llm: { default: "none" },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["tools/run.py upgrade", "tools/run.py snapshot", "filesystem", "git"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 }, expectedDurationMs: 10000, timeoutMs: 90000,
}, async t => {
  const r = await openTeam(t, "upgrade-unrelated-history");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", r.root, "-c", "user.name=Upgrade Case", "-c", "user.email=upgrade-case@example.invalid", ...args], { encoding: "utf8", timeout: 10000 });
    t.assertions.assert(result.status === 0, result.stderr); return result.stdout.trim();
  };
  const platform = join(t.env.root, "platform-template"); cpSync(r.template, platform, { recursive: true });
  const status = () => JSON.parse(r.ok(["upgrade", "--status"], { TEAM_TEMPLATE: platform }));
  const settle = async () => {
    let value: any;
    await t.tools.waitUntil(async () => { value = status(); return !value.workerPid && value.status !== "waiting-safe-point"; }, 30000);
    return value;
  };
  const notes = () => readdirSync(r.state("notes")).filter(x => x.endsWith(".json")).length;
  try {
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    const originalHead = git("rev-parse", "HEAD"), originalTool = readFileSync(join(r.root, "tools/run.py"));
    // Case-owned real Git history, matching the missing-ancestor relation;
    // no fabricated merge-base result or production function replacement.
    const orphan = git("commit-tree", "platform^{tree}", "-m", "fixture independent platform root");
    git("update-ref", "refs/heads/platform", orphan);
    mkdirSync(join(platform, "docs"), { recursive: true }); writeFileSync(join(platform, "docs/new-platform.txt"), "latest\n");
    r.ok(["upgrade"], { TEAM_TEMPLATE: platform });
    const failed = await settle(), noteCount = notes();
    t.assertions.assert(failed.status === "conflict" && failed.reason.includes("no-common-ancestor")
      && git("rev-parse", "HEAD") === originalHead && readFileSync(join(r.root, "tools/run.py")).equals(originalTool),
      "unrelated history was changed or misclassified as a failed regression: " + JSON.stringify(failed));
    writeFileSync(join(r.root, "memory.md"), readFileSync(join(r.root, "memory.md"), "utf8") + "\nRecorded the existing conflict.\n");
    mkdirSync(join(r.root, "docs/reflection"), { recursive: true });
    writeFileSync(join(r.root, "docs/reflection/existing-conflict.md"), "Same unresolved ancestry, no source correction.\n");
    mkdirSync(join(r.root, "spaces/team-reflect"), { recursive: true });
    writeFileSync(join(r.root, "spaces/team-reflect/index.md"), "Recorded the same unresolved conflict.\n");
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    r.ok(["upgrade"], { TEAM_TEMPLATE: platform }); const same = await settle();
    t.assertions.assert(same.generation === failed.generation && notes() === noteCount,
      "reflection-only commit created another upgrade generation or note");
    writeFileSync(join(r.root, "tools/local-upgrade-check.py"), "# A real source correction warrants revalidation.\n");
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    r.ok(["upgrade"], { TEAM_TEMPLATE: platform }); const retried = await settle();
    t.assertions.assert(retried.generation !== failed.generation && retried.status === "conflict"
      && git("rev-parse", "platform~1") === orphan, "relevant source change was ignored or history was replaced");
  } finally { await r.dispose(); }
});

defineSpecialty({
  id: "specialty.daemon.team-programmatic-upgrade",
  title: "Automatic upgrade validates one latest Git candidate, preserves local patches and wakes only on actionable failure",
  oracle: "Actual Team CLI adopts only the latest verified Git candidate. Dirty source bytes/HEAD stay intact and reach existing native reflection once per target despite further edits. Identical builtin changes integrate without a false conflict; different builtin patches remain protected, with the current public maintainer argv in the handoff. No live Team or project is changed.",
  catches: ["one manual upgrade per release", "platform baseline mistaken for adoption", "dirty source overwritten or silently abandoned", "source edits repeatedly wake reflection", "identical builtin bytes treated as incompatible", "local resultDelivery-style builtin patch silently merged", "successful upgrade wakes reflection", "conflict leaves a legacy caller without a usable maintenance entry"],
  tags: ["core", "team-upgrade"], llm: { default: "none" },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["tools/run.py upgrade", "tools/run.py snapshot", "tools/run.py hook", "session.get", "filesystem", "git"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 70000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "automatic-upgrade");
  let templatePath = "";
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", r.root, ...args], { encoding: "utf8", timeout: 10000 });
    t.assertions.assert(result.status === 0, result.stderr); return result.stdout.trim();
  };
  const execute = (args: string[]) => {
    const result = spawnSync(process.env.GENEHUB_PYTHON!, [join(r.root, "tools/run.py"), ...args],
      { cwd: r.root, env: { ...r.env, TEAM_TEMPLATE: templatePath }, encoding: "utf8", timeout: 30000 });
    t.assertions.assert(result.status === 0, result.stderr + result.stdout); return JSON.parse(result.stdout);
  };
  const notes = () => existsSync(r.state("notes")) ? readdirSync(r.state("notes")).filter(x => x.endsWith(".json")) : [];
  const seesNote = (view: Awaited<ReturnType<typeof r.snapshot>>, id: string) => view.items.some(item => {
    if (item.type !== "userMessage") return false;
    const brief = /^简报:\s*(.+)$/m.exec(item.text)?.[1];
    return Boolean(brief && dirname(brief) === r.state("briefings") && readFileSync(brief, "utf8").includes(id));
  });
  const settle = async () => {
    let value: any;
    await t.tools.waitUntil(async () => {
      value = execute(["upgrade", "--status"]);
      return !value.workerPid && (value.status !== "waiting-safe-point" || value.reason !== "validating-candidate");
    }, 90000);
    return value;
  };
  try {
    // Explicit case-owned installed-template fixture. The public override is
    // not a claim that any of these nine revisions was a real platform release.
    const platform = join(t.env.root, "platform-template"); cpSync(r.template, platform, { recursive: true });
    templatePath = platform;
    const marker = "docs/upgrade-case-version.txt";
    mkdirSync(join(platform, "docs"), { recursive: true }); writeFileSync(join(platform, marker), "baseline\n");
    mkdirSync(join(r.root, "docs"), { recursive: true }); writeFileSync(join(r.root, marker), "baseline\n");
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + `\nTEAM_TEMPLATE=${platform}\nTEAM_BOARD_PORT=0\nTEAM_WAKE_ROUNDS=999999\nTEAM_WAKE_GAP=999999\n`);
    // The baseline is a real public Team snapshot with ordinary user inputs.
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    const firstHead = git("rev-parse", "HEAD"), beforeNotes = notes().length;
    const historical = JSON.parse(readFileSync(join(t.openRoot, "testing/fixtures/team-upgrade-hy-notifications-20261111.json"), "utf8"));
    t.assertions.assert(historical.notes.length === 9, "frozen historical notification input is incomplete");
    mkdirSync(r.state("notes"), { recursive: true });
    for (const note of historical.notes) writeFileSync(r.state("notes", note.id + ".json"), JSON.stringify(note));
    for (let n = 1; n <= 9; n++) writeFileSync(join(platform, marker), `available-${n}\n`);
    execute(["upgrade"]);
    const adopted = await settle();
    t.assertions.assert(adopted.status === "adopted", JSON.stringify(adopted));
    t.assertions.assert(readFileSync(join(r.root, marker), "utf8") === "available-9\n", "latest candidate source content missing: " + JSON.stringify(adopted));
    t.assertions.assert(Number(git("rev-list", "--count", "platform")) === 2,
      "latest-only platform history did not contain exactly baseline + one selected update");
    t.assertions.assert(git("rev-parse", "HEAD") !== firstHead && notes().length === beforeNotes,
      "upgrade did not merge or woke reflection on success");
    t.assertions.assert(existsSync(join(adopted.output, ".spacebuilder/output-lock.json"))
      && !existsSync(r.state("template-adoption.json")),
      "portable artifact missing or custom template acquired an invented platform release label");
    for (const note of historical.notes) {
      const archived = JSON.parse(readFileSync(r.state("notes-done", note.id + ".json"), "utf8"));
      t.assertions.assert(archived.id === note.id && archived.at === note.at && archived.text === note.text
        && archived.result.includes("delegated-to-automatic-upgrade") && !existsSync(r.state("notes", note.id + ".json")),
        "historical upgrade input was dropped, rewritten or left to wake manual per-version reflection");
    }
    const duplicate = execute(["upgrade"]);
    t.assertions.assert(duplicate.status === "adopted" && !duplicate.workerPid && notes().length === beforeNotes,
      "completed upgrade started another worker or sent another notification");
    const memoryCommit = join(r.root, "memory.md");
    writeFileSync(memoryCommit, readFileSync(memoryCommit, "utf8") + "\nAn ordinary team memory update.\n");
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    const afterMemory = execute(["upgrade"]);
    t.assertions.assert(afterMemory.status === "adopted" && !afterMemory.workerPid
      && afterMemory.generation === duplicate.generation && notes().length === beforeNotes,
      "ordinary memory commit restarted an unchanged platform package upgrade");
    r.ok(["reflect", "now", "Observe this explicit request before a later upgrade blocker"]);
    const recentReflect = JSON.parse(readFileSync(r.state("reflect.json"), "utf8"));
    await t.tools.waitUntil(async () => (await r.snapshot(recentReflect.sessionId)).summary.status === "idle", 20000);
    const memory = join(r.root, "memory.md"), original = readFileSync(memory);
    writeFileSync(memory, Buffer.concat([original, Buffer.from("\nUncommitted user definition change.\n")]));
    writeFileSync(join(platform, marker), "available-10\n");
    const stableHead = git("rev-parse", "HEAD"), waiting = execute(["upgrade"]);
    t.assertions.assert(waiting.status === "waiting-safe-point" && waiting.reason === "uncommitted-source-changes"
      && git("rev-parse", "HEAD") === stableHead && readFileSync(join(r.root, marker), "utf8") === "available-9\n"
      && notes().length === beforeNotes + 1, "dirty source was applied or its actionable blocker never reached reflection");
    const dirtyNote = notes().map(name => JSON.parse(readFileSync(r.state("notes", name), "utf8")))
      .find(note => note.kind === "upgrade" && JSON.parse(note.context || "{}").reason === "uncommitted-source-changes");
    t.assertions.assert(Boolean(dirtyNote), "source blocker has no durable handoff note");
    const dirtyContext = JSON.parse(dirtyNote.context);
    t.assertions.assert(dirtyContext.dirtyPaths.includes("memory.md")
      && JSON.stringify(dirtyContext.maintenanceArgv.slice(2, 6)) === JSON.stringify([join(platform, "tools/run.py"), "--team-root", r.root, "upgrade"]),
      "dirty-source handoff lacks the actual public maintainer or changed paths");
    writeFileSync(memory, Buffer.concat([original, Buffer.from("\nFurther uncommitted user work.\n")]));
    const editedBytes = readFileSync(memory);
    execute(["upgrade"]); execute(["upgrade"]);
    t.assertions.assert(notes().length === beforeNotes + 1 && git("rev-parse", "HEAD") === stableHead
      && readFileSync(memory).equals(editedBytes), "further edits duplicate the target handoff or change uncommitted work");
    r.ok(["hook"], { TEAM_TEMPLATE: platform });
    const dirtyReflect = JSON.parse(readFileSync(r.state("reflect.json"), "utf8"));
    t.assertions.assert(dirtyReflect.sessionId !== recentReflect.sessionId && dirtyReflect.notifiedNotes?.includes(dirtyNote.id),
      "source blocker waited behind the ordinary reflection gap instead of using the existing urgent upgrade channel");
    await t.tools.waitUntil(async () => (await r.snapshot(dirtyReflect.sessionId)).summary.status === "idle", 20000);
    const dirtyView = await r.snapshot(dirtyReflect.sessionId);
    t.assertions.assert(seesNote(dirtyView, dirtyNote.id),
      "source blocker note never reached a real native reflection input");
    execute(["upgrade"]); r.ok(["hook"], { TEAM_TEMPLATE: platform });
    t.assertions.assert(JSON.parse(readFileSync(r.state("reflect.json"), "utf8")).sessionId === dirtyReflect.sessionId
      && notes().length === beforeNotes + 1, "handled source-blocker notification wakes another reflection without new work");
    t.assertions.assert(git("rev-parse", "HEAD") === stableHead && readFileSync(memory).equals(editedBytes),
      "reflection startup committed or discarded uncommitted user work");
    writeFileSync(memory, original);
    const relative = "tools/genet_builtin/quality_events.py", tool = join(r.root, relative);
    const identical = readFileSync(tool, "utf8") + "\n# Identical change on both branches.\n";
    writeFileSync(tool, identical); writeFileSync(join(platform, relative), identical);
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    execute(["upgrade"]); const sameBytes = await settle();
    t.assertions.assert(sameBytes.status === "adopted" && readFileSync(tool, "utf8") === identical
      && notes().length === beforeNotes + 1, "identical builtin blob/mode created a false protected conflict or success wake");
    writeFileSync(tool, readFileSync(tool, "utf8") + "\n# case-owned legacy resultDelivery compatibility patch\n");
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    const patchedBytes = readFileSync(tool), patchedHead = git("rev-parse", "HEAD");
    writeFileSync(join(platform, relative), readFileSync(join(platform, relative), "utf8") + "\n# new platform routing protocol\n");
    execute(["upgrade"]);
    const conflict = await settle();
    t.assertions.assert(conflict.status === "conflict" && conflict.conflictFiles.includes(relative)
      && git("rev-parse", "HEAD") === patchedHead && readFileSync(tool).equals(patchedBytes),
      "overlapping builtin semantic patch was not preserved as an explicit conflict");
    const conflictNotes = notes().length;
    execute(["upgrade"]);
    t.assertions.assert(notes().length === conflictNotes && conflictNotes === beforeNotes + 2,
      "unchanged conflict generated repeated reflection notes");
    const conflictNote = notes().map(name => JSON.parse(readFileSync(r.state("notes", name), "utf8")))
      .find(note => note.kind === "upgrade-conflict");
    t.assertions.assert(conflictNote && JSON.parse(conflictNote.context).maintenanceArgv.includes("--team-root"),
      "conflict handoff sends maintainers back to an obsolete private entry");
    r.ok(["hook"], { TEAM_TEMPLATE: platform });
    const reflect = JSON.parse(readFileSync(r.state("reflect.json"), "utf8"));
    const view = await r.snapshot(reflect.sessionId);
    t.assertions.assert(reflect.notifiedNotes?.includes(conflictNote.id) && seesNote(view, conflictNote.id),
      "actionable upgrade conflict never reached a real native reflection session");
    t.note("Actual isolated Git merge/build/verify, latest-only adoption, dirty bytes/HEAD retained with one native reflection handoff despite content churn, identical builtin integration and protected different patches. Current public maintenance argv is supplied. Historical nine notices remain delegated, not falsely adopted. No live Team or formal-hour claim.");
  } finally { await r.dispose(); }
});

defineSpecialty({
  id: "specialty.daemon.team-programmatic-upgrade-settings",
  title: "A clean textual platform merge cannot silently change an active Task's bound settings",
  oracle: "An actual native Team Task retains its original framework settings. A platform template changes only those settings on different lines from the Team name, so Git can merge it; the public upgrader must report a settings compatibility conflict before changing the source, original Task or Owner identity.",
  catches: ["Class/API checks omit settings identity", "clean Git merge accepted as semantic compatibility", "active Task silently rebound to new settings"],
  tags: ["core", "team-upgrade"], llm: { default: "none" },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["tools/run.py task start", "tools/run.py upgrade", "tools/run.py snapshot", "filesystem", "git"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 }, expectedDurationMs: 20000, timeoutMs: 120000,
}, async t => {
  const r = await openTeam(t, "upgrade-settings-boundary", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const platform = join(t.env.root, "platform-template"); cpSync(r.template, platform, { recursive: true });
    const writeSettings = (root: string, value: string) => {
      const file = join(root, "agent-space.genet.json"), d = JSON.parse(readFileSync(file, "utf8"));
      d.team = { settings: { workflow: { businessContract: value } } }; writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
    };
    writeSettings(platform, "original"); writeSettings(r.root, "original");
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    const front = await r.create("ctl-cli-command");
    await r.send(front, JSON.stringify({ requestId: "upgrade.original-task", cwd: r.root,
      argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), "task", "start", "--space", "leader",
        "--desc", "retain original binding", "--request-id", "upgrade.original-task", "Keep the original Task settings"] }));
    let native: any;
    await t.tools.waitUntil(async () => {
      const view = await r.snapshot(front);
      const reply = view.items.findLast(x => x.type === "assistantMessage" && x.text.includes('"upgrade.original-task"'));
      if (reply?.type === "assistantMessage") native = JSON.parse(reply.text);
      return view.summary.status === "idle" && Boolean(native);
    }, 20000);
    t.assertions.assert(native.code === 0, "original native Agent could not create Task: " + native.err);
    const started = JSON.parse(native.out);
    const taskPath = r.state("tasks", started.taskId + ".json"), originalTask = readFileSync(taskPath);
    const descriptorPath = join(r.root, "agent-space.genet.json"), originalDescriptor = readFileSync(descriptorPath);
    writeSettings(platform, "changed"); r.ok(["upgrade"], { TEAM_TEMPLATE: platform });
    let value: any;
    await t.tools.waitUntil(async () => {
      value = JSON.parse(r.ok(["upgrade", "--status"], { TEAM_TEMPLATE: platform })); return !value.workerPid && value.status !== "waiting-safe-point";
    }, 60000);
    t.assertions.assert(value.status === "conflict" && value.reason.includes("settings")
      && readFileSync(descriptorPath).equals(originalDescriptor) && readFileSync(taskPath).equals(originalTask),
      "active Task settings changed or compatibility was inferred from a clean textual merge: " + JSON.stringify(value));
    const owner = await r.snapshot(started.owner.sessionId);
    t.assertions.assert(owner.summary.id === started.owner.sessionId, "settings conflict replaced the original Owner");
  } finally { await r.dispose(); }
});

defineSpecialty({
  id: "specialty.daemon.team-programmatic-upgrade-failure",
  title: "A real candidate regression failure leaves the current Team source and task receipts unchanged",
  oracle: "A Team's explicitly configured regression command reads actual candidate files and rejects the new template. The upgrader reports test-failure without merging the candidate, preserves the original Git HEAD/file bytes and existing durable operation evidence, and deduplicates the failure signal.",
  catches: ["failed regression still applies candidate", "test failure erased task evidence", "failed candidate retried without a source change", "Team regression configuration ignored"],
  tags: ["core", "team-upgrade"], llm: { default: "none" },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["tools/run.py upgrade", "tools/run.py snapshot", "filesystem", "git"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 15000, timeoutMs: 120000,
}, async t => {
  const r = await openTeam(t, "upgrade-rejected-regression");
  try {
    const platform = join(t.env.root, "platform-template"); cpSync(r.template, platform, { recursive: true });
    const relative = "docs/upgrade-case-version.txt";
    mkdirSync(join(platform, "docs"), { recursive: true }); writeFileSync(join(platform, relative), "baseline\n");
    mkdirSync(join(r.root, "docs"), { recursive: true }); writeFileSync(join(r.root, relative), "baseline\n");
    const regression = "tools/upgrade-regression.py";
    writeFileSync(join(r.root, regression), "from pathlib import Path\nassert Path('docs/upgrade-case-version.txt').read_text().strip() != 'rejected-version', 'candidate rejected by Team regression'\n");
    const descriptor = join(r.root, "agent-space.genet.json"), info = JSON.parse(readFileSync(descriptor, "utf8"));
    info.team = { ...(info.team || {}), settings: { upgrade: { regressionCommands: [[process.env.GENEHUB_PYTHON!, regression]] } } };
    writeFileSync(descriptor, JSON.stringify(info));
    const config = join(r.root, ".genethub/open.env"); writeFileSync(config, readFileSync(config, "utf8") + `\nTEAM_TEMPLATE=${platform}\n`);
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    const head = spawnSync("git", ["-C", r.root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const retained = r.state("upgrade-case-retained-evidence.json");
    // Explicit persisted evidence fixture, not a fabricated native receipt.
    const bytes = Buffer.from(JSON.stringify({ fixture: "case-owned retained evidence", original: "do-not-modify" }));
    writeFileSync(retained, bytes);
    writeFileSync(join(platform, relative), "rejected-version\n");
    r.ok(["upgrade"], { TEAM_TEMPLATE: platform });
    let value: any;
    await t.tools.waitUntil(async () => {
      value = JSON.parse(r.ok(["upgrade", "--status"], { TEAM_TEMPLATE: platform })); return !value.workerPid && (value.status === "test-failure" || value.status === "conflict");
    }, 60000);
    t.assertions.assert(value.status === "test-failure" && value.reason.includes("candidate rejected by Team regression")
      && spawnSync("git", ["-C", r.root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() === head
      && readFileSync(join(r.root, relative), "utf8") === "baseline\n" && readFileSync(retained).equals(bytes),
      "candidate test failure was hidden, applied or changed retained operation evidence");
    const failure = JSON.stringify(value); r.ok(["upgrade"], { TEAM_TEMPLATE: platform });
    const again = JSON.parse(r.ok(["upgrade", "--status"], { TEAM_TEMPLATE: platform }));
    t.assertions.assert(again.status === "test-failure" && !again.workerPid && JSON.stringify(again) === failure,
      "unchanged failing candidate started another worker or rewrote its durable result");
    writeFileSync(join(r.root, "memory.md"), readFileSync(join(r.root, "memory.md"), "utf8") + "\nRecorded the rejected candidate.\n");
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform }); r.ok(["upgrade"], { TEAM_TEMPLATE: platform });
    const afterMemory = JSON.parse(r.ok(["upgrade", "--status"], { TEAM_TEMPLATE: platform }));
    t.assertions.assert(afterMemory.generation === again.generation && !afterMemory.workerPid,
      "recording a real regression failure reran the same candidate");
  } finally { await r.dispose(); }
});


defineSpecialty({
  id: "specialty.daemon.team-upgrade-reviewed-baseline",
  title: "Explicit legacy baseline integrates validated source without rewriting either history",
  oracle: "A real Team with independent Git roots rejects a nonancestor baseline and retains dirty user edits. Its maintainer then selects the original ancestor explicitly through the installed runner. A validated three-way integration keeps both original parents, custom source and durable evidence, produces a portable artifact and resumes idempotently.",
  catches: ["unrelated history has no recovery path", "baseline inferred from a commit label", "nonancestor baseline accepted", "installed maintenance entry operates on its own template", "validated tree differs from applied tree", "legacy recovery rewrites original history"],
  tags: ["core", "team-upgrade"], llm: { default: "none" },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["tools/run.py --team-root upgrade", "tools/run.py snapshot", "filesystem", "git"],
  surfaces: ["daemon", "team-template", "filesystem"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 15000, timeoutMs: 120000,
}, async t => {
  const r = await openTeam(t, "upgrade-reviewed-baseline");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", r.root, "-c", "user.name=Upgrade Case", "-c", "user.email=upgrade-case@example.invalid", ...args], { encoding: "utf8", timeout: 10000 });
    t.assertions.assert(result.status === 0, result.stderr); return result.stdout.trim();
  };
  const platform = join(t.env.root, "platform-template"); cpSync(r.template, platform, { recursive: true });
  const execute = (args: string[]) => {
    const result = spawnSync(process.env.GENEHUB_PYTHON!, [join(r.template, "tools/run.py"), "--team-root", r.root, "upgrade", ...args],
      { cwd: t.env.root, env: { ...r.env, TEAM_TEMPLATE: platform }, encoding: "utf8", timeout: 30000 });
    t.assertions.assert(result.status === 0, result.stderr + result.stdout); return JSON.parse(result.stdout);
  };
  const settle = async () => {
    let value: any;
    await t.tools.waitUntil(async () => { value = execute(["--status"]); return !value.workerPid && value.reason !== "validating-candidate"; }, 60000);
    return value;
  };
  try {
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform });
    const baseline = git("rev-parse", "platform"); let originalHead = git("rev-parse", "HEAD");
    const orphan = git("commit-tree", "platform^{tree}", "-m", "fixture independent template history");
    git("update-ref", "refs/heads/platform", orphan);
    mkdirSync(join(platform, "docs"), { recursive: true }); writeFileSync(join(platform, "docs/new-platform.txt"), "new platform content\n");
    execute([]); const conflict = await settle();
    t.assertions.assert(conflict.status === "conflict" && conflict.reason.includes("no-common-ancestor"), JSON.stringify(conflict));
    // Legacy durable upgrader result, matching the observed pre-fingerprint
    // DS shape. This is a migration input, never a native delivery receipt.
    const legacy = { ...conflict, status: "test-failure", reason: "legacy git merge-base failed" };
    delete legacy.sourceIdentity;
    writeFileSync(r.state("upgrade/latest.json"), JSON.stringify(legacy));
    execute([]); const refreshed = await settle();
    t.assertions.assert(refreshed.status === "conflict" && refreshed.reason.includes("no-common-ancestor")
      && Boolean(refreshed.sourceIdentity) && git("rev-parse", "HEAD") === originalHead,
      "installed maintenance reused an unverified legacy failure: " + JSON.stringify(refreshed));
    const teamDoc = join(r.root, "docs/team-context.txt");
    mkdirSync(join(r.root, "docs"), { recursive: true }); writeFileSync(teamDoc, "Team-owned context, never a platform removal.\n");
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform }); originalHead = git("rev-parse", "HEAD");
    // Actual legacy repos contain full Team trees with platform-looking labels.
    const contaminated = git("commit-tree", "HEAD^{tree}", "-p", originalHead, "-m", git("show", "-s", "--format=%s", baseline));
    git("update-ref", "HEAD", contaminated, originalHead); originalHead = contaminated;
    execute(["--base", contaminated]); const rejected = await settle();
    t.assertions.assert(rejected.status === "conflict" && rejected.reason.includes("unverified-platform-baseline")
      && git("rev-parse", "HEAD") === originalHead && readFileSync(teamDoc, "utf8") === "Team-owned context, never a platform removal.\n",
      "an unverified platform-looking Team ancestor reached the merge instead of being rejected: " + JSON.stringify(rejected));
    const originalMemory = readFileSync(join(r.root, "memory.md"));
    writeFileSync(join(r.root, "memory.md"), Buffer.concat([originalMemory, Buffer.from("\nUncommitted user work.\n")]));
    const dirty = execute(["--base", baseline]);
    t.assertions.assert(dirty.status === "waiting-safe-point" && dirty.reason === "uncommitted-source-changes"
      && git("rev-parse", "HEAD") === originalHead && !existsSync(join(r.root, "docs/new-platform.txt")), "dirty source was changed");
    writeFileSync(join(r.root, "memory.md"), originalMemory);
    execute(["--base", orphan]); const invalid = await settle();
    t.assertions.assert(invalid.status === "conflict" && invalid.reason.includes("baseline-not-ancestor")
      && git("rev-parse", "HEAD") === originalHead, "unrelated baseline was applied: " + JSON.stringify(invalid));
    const custom = join(r.root, "tools/retained-local.txt"); writeFileSync(custom, "local customization\n");
    r.ok(["snapshot"], { TEAM_TEMPLATE: platform }); const sourceHead = git("rev-parse", "HEAD");
    const evidence = r.state("retained-operation.json"), retained = Buffer.from('{"fixture":"original durable operation"}'); writeFileSync(evidence, retained);
    execute(["--base", baseline]); const adopted = await settle();
    t.assertions.assert(adopted.status === "adopted", JSON.stringify(adopted));
    const parents = git("show", "-s", "--format=%P", adopted.appliedCommit).split(" ");
    t.assertions.assert(parents[0] === sourceHead && parents[1] === git("rev-parse", "platform")
      && git("rev-parse", "platform~1") === orphan && git("rev-parse", "HEAD^{tree}") === adopted.tree,
      "integration rewrote history or applied an unverified tree");
    t.assertions.assert(readFileSync(join(r.root, "docs/new-platform.txt"), "utf8") === "new platform content\n"
      && readFileSync(custom, "utf8") === "local customization\n" && readFileSync(evidence).equals(retained)
      && existsSync(join(adopted.output, ".spacebuilder/output-lock.json")), "adoption lost custom source, evidence or portable verification");
    const again = execute([]);
    t.assertions.assert(again.status === "adopted" && !again.workerPid && again.generation === adopted.generation,
      "maintenance entry repeated a completed integration");
    t.note("Explicit baseline selection and installed runner verified on isolated real Git/daemon. Live Team adoption and Mac deployment remain separate acceptance.");
  } finally { await r.dispose(); }
});
