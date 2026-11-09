import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, parseJson, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-independent-result",
  title: "An older paused child cannot hide a completed independent batch result",
  oracle: "A valid restored Team ledger references a genuinely paused native child. The public Team send command holds ordinary notes but delivers an independent result once to an idle parent; original pause, pending input and writer reservation survive; a paused parent still requires explicit continuation",
  catches: ["old paused child suppresses every future result", "fix silently resumes paused work", "result replay reruns the parent", "notification wakes paused parent", "ordinary progress defeats the batch barrier"],
  tags: ["core", "expert", "team-result"], llm: { default: "mock" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  productInterfaces: ["tools/team.py send", "tools/team.py hook", "genet-cli", "Team persisted pending/writer ledger"],
  surfaces: ["team-template", "daemon", "filesystem"], expectedDurationMs: 20_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const python = process.env.GENEHUB_PYTHON!;
  const root = join(t.env.root, "independent-result-team");
  cpSync(join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/team-template"), root, { recursive: true });
  // A customized Team without automatic identity/timer work keeps this case
  // focused on the public durable inbox rather than unrelated maintenance.
  for (const dir of [root, ...readdirSync(join(root, "spaces")).map(name => join(root, "spaces", name))]) {
    const file = join(dir, "agent-space.genet.json"); if (!existsSync(file)) continue;
    const descriptor = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(descriptor, { skills: [], skillProviders: [] });
    delete descriptor.identity; delete descriptor.agentCwd;
    if (dir === root) descriptor.name = "independent-result-team";
    writeFileSync(file, JSON.stringify(descriptor));
  }
  mkdirSync(join(root, ".genethub"), { recursive: true });
  writeFileSync(join(root, ".genethub/open.env"), "TEAM_AGENT=genet\nTEAM_WAKE_ROUNDS=100000\n");
  const env = { ...o.daemon.env, GENEHUB_CLI: o.daemon.genet, GENEHUB_PYTHON: python };
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(o.daemon.genet, args, env);
    if (result.code !== 0) throw new Error(`Native ${args.slice(0, 2).join(" ")} failed: ${result.stderr}`);
    return (parseJson(result.stdout) as { data: any }).data;
  };
  const command = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(python, [join(root, "tools/team.py"), ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
  });
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    await cli(["space", "open", root]);
    const workspaces = (await cli(["workspace", "list"])).workspaces;
    const frontWorkspace = workspaces.find((w: any) => w.root === root);
    const childWorkspace = workspaces.find((w: any) => w.root === join(root, "spaces/qa"));
    t.assertions.assert(frontWorkspace && childWorkspace, "Actual Team workspaces absent");
    const parent = await t.flows.main.createBuiltinSession(o.client, frontWorkspace.id);
    const child = await t.flows.main.createBuiltinSession(o.client, childWorkspace.id);
    o.mock.script({ text: "Old work must remain paused", hang: true }, { text: "Independent result received", repeat: 8 });
    const beforeRequests = o.mock.requests.length;
    await cli(["session", "send", child, "Retained old task", "--message-id", "x.retained-old-task", "--no-wait"]);
    await t.tools.waitUntil(() => o.mock.requests.length > beforeRequests, 15_000);
    await cli(["session", "interrupt", child]);
    const summary = async (sid: string) => (await cli(["session", "get", sid])).summary;
    await t.tools.waitUntil(async () => { const s = await summary(child); return s.status === "idle" && s.inputSummary.paused; }, 15_000);
    const pausedInput = (await summary(child)).inputSummary.pendingMessageIds;
    t.assertions.assert(pausedInput.includes("x.retained-old-task"), "Original paused input missing");
    const pending = join(root, ".genethub/team/pending"); mkdirSync(pending, { recursive: true });
    const writer = join(root, "spaces/qa/.genethub/genet-writer.json"); mkdirSync(join(root, "spaces/qa/.genethub"), { recursive: true });
    const reservation = JSON.stringify({ session: child, expert: "independent-result-team", at: Date.now() }); writeFileSync(writer, reservation);
    // This is documented, user-owned restored project state, as in the real
    // Beta failure. It references an actual paused session, not a fake status.
    const record = JSON.stringify({ sessionId: child, requester: parent, batch: "restored-prior-batch", kind: "qa", desc: "retained paused work", createdAtMs: Date.now(), notified: ["stop"], lock: writer, baseline: null });
    writeFileSync(join(pending, child + ".json"), record);
    const note = await command(["send", "--to", parent, "--kind", "note", "Ordinary progress remains gated"]);
    t.assertions.assert(note.code === 0 && !(await summary(parent)).latestReply, "Ordinary note woke a parent waiting on unfinished work");
    const marker = "Independent batch result marker";
    const args = ["send", "--to", parent, "--kind", "result", marker];
    const delivered = await command(args); t.assertions.assert(delivered.code === 0, delivered.stderr);
    const inbox = join(root, ".genethub/team/inbox", parent + ".jsonl");
    // An accepted input is deliberately retained until the native queue
    // consumes it, preserving collaboration obligations across a crash. It
    // must already be accepted, rather than blocked behind the paused sibling.
    const waitingEntries = existsSync(inbox) ? readFileSync(inbox, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    t.assertions.assert(waitingEntries.filter(entry => String(entry.text).includes(marker)).every(entry => entry.accepted === true), "Completed independent result is still unaccepted behind an older paused child");
    await t.tools.waitUntil(async () => { const s = await summary(parent); return s.status === "idle" && !!s.latestReply; }, 15_000);
    const first = (await cli(["session", "narrative", parent, "--limit", "100"])).page;
    const matches = (s: any) => s.items.filter((item: any) => item.type === "userMessage" && String(item.text).includes(marker));
    t.assertions.assert(matches(first).length === 1, "Platform did not retain one independent result message");
    const firstReply = (await summary(parent)).latestReply.itemId;
    const replay = await command(args); t.assertions.assert(replay.code === 0, replay.stderr);
    const again = (await cli(["session", "narrative", parent, "--limit", "100"])).page;
    t.assertions.assert(matches(again).length === 1 && (await summary(parent)).latestReply.itemId === firstReply, "Same result replay created another input or response");
    const after = await summary(child);
    t.assertions.assert(after.inputSummary.paused && JSON.stringify(after.inputSummary.pendingMessageIds) === JSON.stringify(pausedInput), "Result delivery resumed or discarded the paused sibling");
    t.assertions.assert(readFileSync(writer, "utf8") === reservation && readFileSync(join(pending, child + ".json"), "utf8") === record, "Independent result released or rewrote the paused writer/ledger");
    await cli(["session", "interrupt", parent]);
    const held = await command(["send", "--to", parent, "--kind", "result", "Result for a paused parent"]);
    t.assertions.assert(held.code === 0 && (await summary(parent)).inputSummary.paused && readFileSync(inbox, "utf8").includes("Result for a paused parent"), "Independent result lifted the parent's Human pause");
    t.note("Public Team send delivered an independent result once; ordinary progress still gated; native child input, writer lock and paused parent preserved.");
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
