import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  defineSpecialty, connectProductClient, daemonEndpoint, runGenet, parseJson, agentHostProcesses,
} from "../../framework/public.ts";

// Values are extracted from actual tool results, never minted by the fixture.
function field(value: unknown, name: string): unknown {
  if (Array.isArray(value)) {
    for (const part of [...value].reverse()) { const found = field(part, name); if (found !== undefined) return found; }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record[name] !== undefined) return record[name];
    return field(Object.values(record), name);
  } else if (typeof value === "string") {
    for (const line of [value, ...value.split("\n")]) {
      if (!line.trim().startsWith("{")) continue;
      try { const found = field(JSON.parse(line), name); if (found !== undefined) return found; } catch { /* non-JSON tool diagnostics */ }
    }
  }
  if (typeof value === "string") {
    const quoted = value.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`));
    if (quoted) return quoted[1];
    const numeric = value.match(new RegExp(`"${name}"\\s*:\\s*(\\d+)`));
    if (numeric) return Number(numeric[1]);
  }
  return undefined;
}
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

for (const window of ["waiting", "approved", "applied", "rejected", "canceled"] as const) {
  defineSpecialty({
    id: `specialty.agent-space.durable-approval-${window}`,
    title: `PM approval survives daemon crash at ${window}`,
    oracle: "A durable Human card has no live Agent, survives daemon SIGKILL, and the same Session resumes an approved mutation once with an independent Git repository and unchanged root round identity",
    catches: ["CLI keeps Agent alive waiting for Human", "daemon restart loses challenge or queued decision", "replayed approval changes action identity or repeats mutation", "restored continuation loses the user round"],
    tags: ["core", "agent-space", "durable-approval"],
    llm: { default: "mock" }, expectedDurationMs: 25_000, timeoutMs: 150_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["agent", "daemon", "genet-cli", "workbench-client"],
    productInterfaces: ["genet space approval request", "session.respondPermission", "session.get", "genet daemon start"],
  }, async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let client = opened.client;
    const projectRoot = path.join(opened.workspaceRoot, "empty-project");
    mkdirSync(projectRoot);
    const cli = (args: string[]) => {
      const result = runGenet(opened.daemon.genet, args, opened.daemon.env);
      if (result.code !== 0) throw new Error(`CLI ${args.join(" ")}: ${result.stderr || result.stdout}`);
      return parseJson(result.stdout);
    };
    let plan: { challenge: string; digest: string; revision: number } | undefined;
    let phase = 0;
    let paused = false;
    let restarted = false;
    let resumed = 0;
    let replayedApply = false;
    let committedHead = "";
    let stage = "starting";
    let lastSnapshot: unknown;
    let mockFailure = "";
    const respond = (request: unknown) => {
      const body = JSON.stringify(request);
      const bash = (command: string) => ({ tool: { name: "bash", arguments: { command } } });
      if (body.includes("The user rejected the interrupted plan")) return { text: "已拒绝，没有修改项目。" };
      if (body.includes("The user approved the interrupted plan")) {
        resumed += 1;
        if (!body.includes("DURABLE_APPROVAL_GOAL")) throw new Error("resumed Agent lost original conversation");
        if (!restarted && window === "approved") { paused = true; return { hang: true }; }
        if (existsSync(path.join(projectRoot, ".git"))) {
          if (!restarted && window === "applied") { paused = true; return { hang: true }; }
          if (restarted && window === "applied" && !replayedApply) {
            replayedApply = true;
          } else return { text: "接管结果已核验，任务完成。" };
        }
        if (!plan) throw new Error("missing real plan");
        return bash(`"$GENEHUB_CLI" space bootstrap apply --pack game-delivery-v1 --plan-digest ${quote(plan.digest)} --expected-revision ${plan.revision} --action-id ${quote(plan.challenge)}`);
      }
      if (phase++ === 0) return bash('"$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1');
      if (!plan) {
        const challenge = field(request, "challengeId"), digest = field(request, "planDigest"), revision = field(request, "expectedRevision");
        if (typeof challenge !== "string" || typeof digest !== "string" || typeof revision !== "number") { mockFailure = JSON.stringify((request as { messages?: unknown }).messages).slice(-5000); throw new Error("plan omitted approval facts"); }
        plan = { challenge, digest, revision };
        return bash(`"$GENEHUB_CLI" space approval request --challenge ${quote(challenge)}`);
      }
      // Continuing without a Human decision must never reach this model step.
      throw new Error("Agent remained active after submitting Human approval");
    };
    try {
      await t.flows.main.configureMockProvider(client, opened.mock);
      for (const [key, value] of [["user.name", "Approval Journey"], ["user.email", "approval@example.com"]]) {
        const result = spawnSync("git", ["config", "--global", key!, value!], { env: opened.daemon.env, encoding: "utf8" });
        t.assertions.assert(result.status === 0, "isolated Git identity failed");
      }
      opened.mock.script(...Array.from({ length: 20 }, () => ({ respond })));
      const project = await client.call({ type: "workspace.open", payload: { root: projectRoot } });
      if (project?.type !== "workspace") throw new Error("could not open project");
      const sessionId = await t.flows.main.createBuiltinSession(client, project.data.id);
      await t.flows.main.sendPrompt(client, sessionId, "DURABLE_APPROVAL_GOAL: 请初始化 PM 小游戏团队，完成接管即可。");
      let requestId = "";
      stage = "waiting for card";
      await t.tools.waitUntil(async () => {
        const snapshot = await client.call({ type: "session.get", payload: { sessionId } });
        lastSnapshot = snapshot;
        if (snapshot?.type === "snapshot" && snapshot.data.summary.status === "failed") throw new Error(`Agent failed: ${mockFailure}`);
        if (snapshot?.type !== "snapshot") return false;
        requestId = snapshot.data.pendingPermissions?.[0]?.id ?? "";
        return Boolean(requestId);
      }, 90_000);
      t.assertions.assert(!existsSync(path.join(projectRoot, ".git")), "plan mutated project before approval");
      t.assertions.assert(agentHostProcesses().filter((p) => p.environ.includes(t.env.data)).length === 0, "Human card retained an Agent process");
      const pausedSnapshot = await client.call({ type: "session.get", payload: { sessionId } });
      t.assertions.assert(pausedSnapshot?.type === "snapshot" && !pausedSnapshot.data.items.some(item => item.type === "turnSummary" && item.stats.outcome === "failed"), "intentional Human pause was shown as Agent failure");
      const roundsBefore = await client.call({ type: "session.rounds", payload: { sessionId, throughRoundId: null, cursor: null, limit: null } });
      const approve = async () => {
        const result = await client.call({ type: "session.respondPermission", payload: { sessionId, requestId, outcome: { outcome: "selected", optionId: window === "rejected" ? "reject" : "approve-once" } } });
        t.assertions.assert(result?.type === "ack", `Human response: ${JSON.stringify(result)}`);
      };
      if (window === "approved" || window === "applied") {
        await approve();
        stage = "waiting for crash window";
        await t.tools.waitUntil(() => paused, 60_000);
      }
      if (window === "rejected") await approve();
      if (window === "canceled") {
        const stopped = await client.call({ type: "session.interrupt", payload: { sessionId } });
        t.assertions.assert(stopped?.type === "ack", "stop failed");
      }
      if (window === "applied") committedHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim();
      stage = "restarting daemon";
      const pid = Number(cli(["daemon", "status"]).pid);
      client.close();
      process.kill(pid, "SIGKILL");
      await t.tools.waitUntil(() => cli(["daemon", "status"]).running === false, 15_000);
      restarted = true;
      cli(["daemon", "start"]);
      client = await connectProductClient(daemonEndpoint(opened.daemon));
      if (window === "waiting") await approve();
      stage = "waiting for recovered completion";
      // Retransmitted Human responses are idempotent, including after restart.
      if (window !== "canceled") await approve();
      else {
        await t.assertions.expectProtocolCode(
          () => client.call({ type: "session.respondPermission", payload: { sessionId, requestId, outcome: { outcome: "selected", optionId: "approve-once" } } }),
          "no pending interaction",
        );
      }
      const denied = window === "rejected" || window === "canceled";
      await t.tools.waitUntil(async () => {
        const snapshot = await client.call({ type: "session.get", payload: { sessionId } });
        lastSnapshot = snapshot;
        return snapshot?.type === "snapshot" && snapshot.data.summary.status === "idle" && (denied ? !existsSync(path.join(projectRoot, ".git")) : existsSync(path.join(projectRoot, ".git")));
      }, 90_000);
      t.assertions.assert(denied ? resumed === 0 : resumed > 0, "no approved adapter continuation occurred");
      const spaces = await client.call({ type: "workspace.list" });
      t.assertions.assert(spaces?.type === "workspaces" && spaces.data.length === (denied ? 2 : 7), "bootstrap did not create exactly five children");
      if (window === "applied") {
        const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim();
        t.assertions.assert(replayedApply && head === committedHead && Boolean(head), "replayed apply changed the commit");
      }
      const originalRound = field(roundsBefore, "roundId");
      t.assertions.assert(typeof originalRound === "string", "missing original user round");
      const roundsAfter = await client.call({ type: "session.rounds", payload: { sessionId, throughRoundId: null, cursor: null, limit: null } });
      t.assertions.assert(JSON.stringify(roundsAfter).includes(String(originalRound)), "approval recovery replaced the user round");
    } catch (error) {
      throw new Error(`${String(error)}; stage=${stage}; phase=${phase}; plan=${Boolean(plan)}; resumed=${resumed}; snapshot=${JSON.stringify(lastSnapshot)}`);
    } finally {
      client.close(); opened.daemon.stop(); await opened.mock.stop();
    }
  });
}

defineSpecialty({
  id: "specialty.agent-space.durable-native-plan",
  title: "Native ACP plan stops its process and resumes without a project grant",
  oracle: "Cursor create_plan cancellation follows the external protocol, Human acceptance survives as a new native turn, and no project grant is required for an ordinary Agent plan",
  catches: ["native plans are rejected as missing PM challenges", "ACP permission request stays unanswered on cancel", "Human wait retains Agent process", "acceptance resumes a fresh native session"],
  tags: ["core", "durable-approval", "agent", "native-plan"],
  // The three protocol waits allow up to 40 seconds in a healthy slow
  // environment (15s + 10s + 15s), so the unit timeout must exceed that
  // declared contract rather than force-cleaning a valid continuation.
  expectedDurationMs: 5_000, timeoutMs: 60_000,
  surfaces: ["daemon", "agent", "acp", "workbench-client"],
  productInterfaces: ["cursor/create_plan", "session/cancel", "session/resume", "session.respondPermission"],
}, async (t) => {
  const flow = await t.flows.branches.openControlledAgentSession({ openRoot: t.openRoot, lease: t.env, agent: { profile: "native-plan" } });
  try {
    await t.flows.main.sendPrompt(flow.client, flow.sessionId, "Please prepare your native plan.");
    let requestId = "";
    await t.tools.waitUntil(async () => {
      const snapshot = await flow.client.call({ type: "session.get", payload: { sessionId: flow.sessionId } });
      if (snapshot?.type !== "snapshot") return false;
      requestId = snapshot.data.pendingPermissions?.[0]?.id ?? "";
      return Boolean(requestId);
    }, 15_000);
    const started = flow.journal().filter(e => e.event === "start").map(e => e.pid);
    await t.tools.waitUntil(() => started.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), 10_000);
    t.assertions.assert(flow.journal().some(e => e.event === "plan-cancellation" && (e.result as { outcome?: { outcome?: string } })?.outcome?.outcome === "cancelled"), "ACP server request did not receive cancelled outcome");
    const result = await flow.client.call({ type: "session.respondPermission", payload: { sessionId: flow.sessionId, requestId, outcome: { outcome: "selected", optionId: "accept" } } });
    t.assertions.assert(result?.type === "ack", "native plan was refused as a PM challenge");
    await t.tools.waitUntil(() => flow.journal().some(e => e.event === "approved-continuation"), 15_000);
    const resume = flow.journal().find(e => e.event === "resumed");
    const continued = flow.journal().find(e => e.event === "approved-continuation");
    t.assertions.assert(Boolean(resume) && resume?.sessionId === continued?.sessionId, "native session identity changed");
  } finally { await flow.dispose(); }
});
