import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { defineSpecialty, openTeam, allocatePort, startHub, startRelay } from "../../framework/public.ts";

const common = {
  tags: ["core", "team-withdrawal"], llm: { default: "none" as const },
  requirements: [{ kind: "python" as const, env: "GENEHUB_PYTHON", minVersion: [3, 7] as [number, number], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  surfaces: ["team-template", "daemon", "filesystem"], productInterfaces: ["tools/run.py", "session.create", "session.send"],
  expectedDurationMs: 15000, timeoutMs: 180000,
};
function currentPackage(openRoot: string, source: string) {
  // Ordinary source-level compatible Team upgrade, then the real portable build.
  cpSync(join(openRoot, "apps/daemon/builtin-skills/genehub/references/team-template/tools/genet_builtin"),
    join(source, "tools/genet_builtin"), { recursive: true });
}
function write(file: string, value: unknown) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); }
function lastJson(text: string) { return JSON.parse(text.trim().split("\n").at(-1)!); }

defineSpecialty({ ...common, id: "specialty.daemon.team-withdrawal.receiver-fence",
  title: "Receiver withdrawal fences an absent prepare and preserves actual prepared or uncertain receipts",
  oracle: "Same original request replays one durable tombstone; late prepare cannot create a session, mismatched intent rejects, and prepared/unknown receipt and successor writer bytes remain unchanged.",
  catches: ["late prepare resurrects a concluded dispatch", "absence treated as negative acknowledgement without fencing", "withdrawal deletes an existing receipt or writer", "withdrawal replay changes intent"],
}, async t => {
  const r = await openTeam(t, "withdraw-receiver", [], { portable: true, configureSource: root => currentPackage(t.openRoot, root) });
  try {
    const role = r.spaces.find(x => x.name === "qa" && x.agentSpace?.parentWorkspaceId === r.project.id)!;
    const original = { id: "withdraw.absent", workspaceId: role.id, role: "qa", desc: "bounded prepare", text: "Never activate this prepared test", prepareOnly: true, tier: null, model: null, media: null };
    const withdraw = (request: typeof original) => r.command(["receive", JSON.stringify({ id: request.id, workspaceId: role.id, role: "qa", operation: "withdraw-prepare", originalRequest: request }), "--require-dispatch-fence"]);
    const path = (id: string) => join(r.root, "spaces/qa/.genethub/team/dispatch", createHash("sha256").update(id).digest("hex") + ".json");
    const first = withdraw(original);
    t.assertions.assert(first.code === 0 && lastJson(first.out).withdrawn === true, first.out + first.err);
    const saved = readFileSync(path(original.id), "utf8");
    const retry = withdraw(original);
    t.assertions.assert(retry.code === 0 && lastJson(retry.out).withdrawn === true && readFileSync(path(original.id), "utf8") === saved, "withdrawal replay changed tombstone");
    const late = r.command(["receive", JSON.stringify(original)]);
    t.assertions.assert(late.code !== 0 && lastJson(late.out).error?.state === "没有创建或激活会话" && readFileSync(path(original.id), "utf8") === saved, "late preparation bypassed fence");
    const conflict = withdraw({ ...original, text: "different business" });
    t.assertions.assert(conflict.code !== 0 && readFileSync(path(original.id), "utf8") === saved, "different intent replaced tombstone");
    const missingFlag = r.command(["receive", JSON.stringify({ id: "withdraw.no.flag", workspaceId: role.id, role: "qa", operation: "withdraw-prepare", originalRequest: { ...original, id: "withdraw.no.flag" } })]);
    t.assertions.assert(missingFlag.code !== 0 && !existsSync(path("withdraw.no.flag")), "withdrawal accepted missing mandatory protocol flag");

    const preparedRequest = { ...original, id: "withdraw.prepared" };
    const prepared = lastJson(r.ok(["receive", JSON.stringify(preparedRequest)]));
    t.assertions.assert(typeof prepared.sessionId === "string", "actual native prepare did not return SID");
    const nativeBefore = await r.snapshot(prepared.sessionId), preparedBytes = readFileSync(path(preparedRequest.id), "utf8");
    const retained = withdraw(preparedRequest);
    t.assertions.assert(retained.code === 0 && lastJson(retained.out).withdrawn === false && readFileSync(path(preparedRequest.id), "utf8") === preparedBytes, "existing native preparation was discarded");
    const nativeAfter = await r.snapshot(prepared.sessionId);
    t.assertions.assert(nativeAfter.items.length === nativeBefore.items.length && !nativeAfter.items.some(i => i.type === "assistantMessage"), "withdrawal activated prepared business");
    // Restore the real crash shape after losing a SID write; never replace native creation.
    const uncertain = JSON.parse(preparedBytes); delete uncertain.sessionId; uncertain.status = "unknown";
    write(path(preparedRequest.id), uncertain); const unknownBytes = readFileSync(path(preparedRequest.id), "utf8");
    const unknown = withdraw(preparedRequest);
    t.assertions.assert(unknown.code === 0 && !lastJson(unknown.out).withdrawn && readFileSync(path(preparedRequest.id), "utf8") === unknownBytes, "ambiguous receiver receipt was silently settled");
    const directory = join(r.root, "reserved"), lease = join(directory, ".genethub/genet-writer.json");
    const reserved = { ...original, id: "withdraw.reserved" }; write(lease, { requestId: reserved.id, session: null });
    writeFileSync(join(r.root, "spaces/qa/.genethub/open.env"), `WORKTREE_DIR=${directory}\n`);
    const leaseBefore = readFileSync(lease, "utf8"), reservation = withdraw(reserved);
    t.assertions.assert(reservation.code === 0 && !lastJson(reservation.out).withdrawn && !existsSync(path(reserved.id)) && readFileSync(lease, "utf8") === leaseBefore, "unrecorded own resource reservation was released");
    // Original incident: another native Session owns the busy workstation,
    // so the rejected prepare has no receipt. Fence it without touching that writer.
    write(lease, { requestId: "another.writer", session: prepared.sessionId });
    const successorBytes = readFileSync(lease, "utf8"), rejected = { ...original, id: "withdraw.busy.other-writer" };
    const busy = withdraw(rejected);
    t.assertions.assert(busy.code === 0 && lastJson(busy.out).withdrawn === true && readFileSync(lease, "utf8") === successorBytes,
      "fencing a rejected preparation changed another native writer");
    const busyLate = r.command(["receive", JSON.stringify(rejected)]);
    t.assertions.assert(busyLate.code !== 0 && readFileSync(lease, "utf8") === successorBytes,
      "late rejected prepare touched the successor writer");
  } finally { await r.dispose(); }
});

defineSpecialty({ ...common, requiredRepos: ["cloud"], id: "specialty.daemon.team-withdrawal.closed-parent",
  title: "Public timer fences an uncreated remote intent after the real Owner concluded and delivers the original task",
  oracle: "Actual task start/finish and native Owner run; restoring the incident creating-intent shape cannot leave the original task active forever once the receiver durably fences it; late prepare remains refused.",
  catches: ["concluded Owner blocked forever by rejected creation", "timer creates the old business while checking absence", "task result delivered before receiver fence"],
}, async t => {
  const port = await allocatePort(), token = randomBytes(32).toString("hex");
  const hub = await startHub({ databasePath: join(t.env.root, "withdraw-hub.sqlite"), relayOrigin: `http://127.0.0.1:${port}`, relayToken: token });
  const relay = await startRelay({ openRoot: t.openRoot, port, control: { origin: hub.origin, token } });
  t.env.env.GENEHUB_LOCAL_HUB_URL = hub.origin;
  let dispose = async () => {};
  try {
    const r = await openTeam(t, "withdraw-source", [{ id: "ctl-cli-command", profile: "cli-command" }],
      { portable: true, configureSource: root => currentPackage(t.openRoot, root) });
    dispose = r.dispose;
    const account = hub.browser(); await hub.signInOwner(account);
    const pair = await r.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: "withdraw-native" } });
    if (pair?.type !== "hubStatus" || pair.data.state !== "pairing") throw Error("native Hub pairing did not start");
    await hub.approvePairing(account, pair.data.userCode);
    let machine = "";
    await t.tools.waitUntil(async () => {
      const me = await account.json<{ machines: Array<{ id: string; online: boolean }> }>("/app/me");
      machine = me.machines.find(row => row.online)?.id ?? ""; return !!machine;
    }, 30000);
    const config = join(r.root, ".genethub/open.env"); writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_WAKE_GAP=999999\nTEAM_WAKE_ROUNDS=999999\nTEAM_BOARD_PORT=0\n");
    const front = await r.create("ctl-cli-command");
    const idle = (sid: string) => t.tools.waitUntil(async () => { const s = (await r.snapshot(sid)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length; }, 30000);
    const cli = async (sid: string, args: string[]) => {
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root })); await idle(sid);
      const reply = (await r.snapshot(sid)).items.filter(x => x.type === "assistantMessage").at(-1);
      if (reply?.type !== "assistantMessage") throw Error("native caller has no actual reply");
      const result = JSON.parse(reply.text); t.assertions.assert(result.code === 0, result.out + result.err); return lastJson(result.out);
    };
    const started = await cli(front, ["task", "start", "--space", "leader", "--desc", "original work", "--request-id", "original.A", "Conclude the original bounded work"]);
    const owner = started.owner.sessionId; await idle(owner);
    const qa = r.spaces.find(x => x.name === "qa" && x.agentSpace?.parentWorkspaceId === r.project.id)!;
    const operation = "taskop.restored.remote-rejection", target = { machineId: machine, workspaceId: qa.id, command: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py")] };
    const returnTo = { machineId: machine, workspaceId: r.project.id, role: "root", command: target.command };
    // Independent still-active tasks must not consume the bounded withdrawal
    // scan or prevent the concluded original from delivering its result.
    const liveIntentBytes: Array<[string, string]> = [];
    for (let i = 0; i < 2; i++) {
      const active = await cli(front, ["task", "start", "--space", "leader", "--desc", "independent active work", "--request-id", `active.${i}`, "Keep this separate task active"]);
      await idle(active.owner.sessionId);
      const file = r.state("task-dispatch", `taskop.active.${i}.json`);
      write(file, { version: 1, operationId: `taskop.active.${i}`, state: "creating", createdAtMs: Date.now(),
        prompt: "Active work must not be withdrawn", target, returnTo,
        request: { taskId: active.taskId, requester: active.owner.sessionId, role: "qa", desc: "active unknown support", machine } });
      liveIntentBytes.push([file, readFileSync(file, "utf8")]);
    }
    // Real incident fixture only: durable source intent survived a receiver preflight refusal.
    // No fake Session, callback, creation success or completion is written.
    const intentPath = r.state("task-dispatch", operation + ".json");
    write(intentPath, { version: 1, operationId: operation, state: "creating", createAttempted: true, recoverable: true,
      createdAtMs: Date.now(), prompt: "Do not start after parent conclusion", target, returnTo,
      request: { taskId: started.taskId, requester: owner, role: "qa", desc: "old rejected support", machine, directory: null, tier: null, model: null } });
    await cli(owner, ["task", "finish", started.taskId, "--outcome", "success", "Original work complete"]);
    // The real Hub runs on this Node loop; keep it serving while the native
    // Team timer waits for its actual remote shell ticket and receipt.
    const tick = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.env.GENEHUB_PYTHON!, [join(r.root, "tools/run.py"), "tick"],
        { cwd: r.root, env: r.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
      child.on("error", reject); child.on("close", code => resolve({ code, out, err }));
    });
    t.assertions.assert(tick.code === 0, tick.out + tick.err);
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    t.assertions.assert(intent.state === "withdrawn" && intent.withdrawReceipt.withdrawn && !intent.sessionId, JSON.stringify(intent));
    t.assertions.assert(existsSync(r.state("done", owner + ".json")), "original Owner result not settled after confirmed fence");
    t.assertions.assert(liveIntentBytes.every(([file, bytes]) => readFileSync(file, "utf8") === bytes), "active task preparation was touched during another task's withdrawal");
    const task = JSON.parse(readFileSync(r.state("tasks", started.taskId + ".json"), "utf8"));
    t.assertions.assert(task.state === "delivered" && task.owner.sessionId === owner, "original task was replaced or left active");
    const original = { id: operation, workspaceId: qa.id, role: "qa", desc: "old rejected support", text: "Do not start after parent conclusion", tier: null, model: null, media: null, prepareOnly: true, returnTo };
    const late = r.command(["receive", JSON.stringify(original)]);
    t.assertions.assert(late.code !== 0 && lastJson(late.out).error?.state === "没有创建或激活会话", "late original request restarted after conclusion");
  } finally { await dispose(); relay.stop(); await hub.stop(); }
});
