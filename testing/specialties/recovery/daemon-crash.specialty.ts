import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  defineSpecialty,
  genetEnv,
  locateGenet,
  parseJson,
  runGenet,
  type CaseContext,
} from "../../framework/public.ts";

interface Cli {
  genet: string;
  env: NodeJS.ProcessEnv;
  run(args: string[]): ReturnType<typeof runGenet>;
  json(args: string[]): Record<string, unknown>;
}

function cliFor(t: CaseContext, dataDir = t.env.data): Cli {
  const genet = locateGenet(t.openRoot);
  const env = genetEnv(t.openRoot, { ...t.env.env, GENEHUB_LOCAL_DATA_DIR: dataDir });
  return {
    genet,
    env,
    run: (args) => runGenet(genet, args, env),
    json(args) {
      const result = runGenet(genet, args, env);
      if (result.code !== 0) throw new Error(`genet ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      return parseJson(result.stdout);
    },
  };
}

function pidOf(value: Record<string, unknown>): number {
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
    throw new Error(`invalid daemon pid: ${JSON.stringify(value)}`);
  }
  return value.pid;
}

async function hardKill(t: CaseContext, cli: Cli, pid: number): Promise<void> {
  process.kill(pid, "SIGKILL");
  await t.tools.waitUntil(() => cli.json(["daemon", "status"]).running === false, 15_000);
}

function admission(value: Record<string, unknown>): Record<string, unknown> {
  const found = value.admission;
  if (!found || typeof found !== "object") throw new Error(`endpoint has no admission: ${JSON.stringify(value)}`);
  return found as Record<string, unknown>;
}

function recoveryCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext) => Promise<void>,
  expectedDurationMs = 25_000,
  needsMockLlm = false,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "recovery-depth"],
      llm: { default: needsMockLlm ? "mock" : "none" },
      expectedDurationMs,
      timeoutMs: 120_000,
      resources: { environments: 1, cpu: 2, memoryMb: 768, io: 2, browser: 0, pool: "standard" },
      surfaces: ["genet-cli", "daemon", "agent", "workbench-client"],
      productInterfaces: ["genet-cli", "@genehub/workbench/client"],
    },
    run,
  );
}

recoveryCase(
  "specialty.recovery.sigkill-status-restart",
  "A SIGKILLed daemon is reported cold and can restart",
  "status stops naming the killed pid, start publishes a different live pid, and endpoint admission works",
  ["pid existence cached after death", "stale lock blocks restart", "restart adopts stale endpoint"],
  async (t) => {
    const cli = cliFor(t);
    cli.run(["daemon", "stop"]);
    try {
      const started = cli.json(["daemon", "start"]);
      const oldPid = pidOf(started);
      await hardKill(t, cli, oldPid);
      const cold = cli.json(["daemon", "status"]);
      t.assertions.assert(cold.running === false && cold.pid == null, `after kill ${JSON.stringify(cold)}`);
      const restarted = cli.json(["daemon", "start"]);
      t.assertions.assert(restarted.running === true && pidOf(restarted) !== oldPid, `restart ${JSON.stringify(restarted)}`);
      const endpoint = cli.json(["daemon", "endpoint"]);
      t.assertions.assert(typeof endpoint.wsUrl === "string" && admission(endpoint).pid === restarted.pid, "endpoint did not recover");
    } finally {
      cli.run(["daemon", "stop"]);
    }
  },
);

recoveryCase(
  "specialty.recovery.workspace-survives-sigkill",
  "Workspace registration and user bytes survive a daemon crash",
  "after SIGKILL and restart, workspace.list contains the same id/root and a sentinel retains exact bytes",
  ["workspace registry only in memory", "crash truncates user file", "restart silently creates a replacement workspace"],
  async (t) => {
    const first = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let firstMockLive = true;
    let second: Awaited<ReturnType<typeof t.flows.main.openWorkspace>> | undefined;
    try {
      const sentinel = path.join(first.workspaceRoot, "crash-sentinel.txt");
      writeFileSync(sentinel, "durable bytes\n");
      const originalId = first.workspaceId;
      const cli = cliFor(t);
      const pid = pidOf(cli.json(["daemon", "status"]));
      first.client.close();
      await hardKill(t, cli, pid);
      await first.mock.stop();
      firstMockLive = false;
      second = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      const listed = await second.client.call({ type: "workspace.list" });
      const found = listed?.type === "workspaces" ? listed.data.find((item) => item.id === originalId) : undefined;
      t.assertions.assert(found?.folders.some((folder) => folder.root === first.workspaceRoot) === true, "workspace identity was lost");
      t.assertions.assert(readFileSync(sentinel, "utf8") === "durable bytes\n", "user bytes changed across crash");
    } finally {
      if (second) {
        second.client.close();
        second.daemon.stop();
        await second.mock.stop();
      }
      first.client.close();
      first.daemon.stop();
      if (firstMockLive) await first.mock.stop();
    }
  },
);

recoveryCase(
  "specialty.recovery.session-metadata-survives-sigkill",
  "Session title and archive state survive a daemon crash",
  "the same session id/title returns after restart and remains excluded from the live-only list",
  ["session metadata buffered only in memory", "archive transaction lost", "restart duplicates session"],
  async (t) => {
    const first = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let firstMockLive = true;
    let second: Awaited<ReturnType<typeof t.flows.main.openWorkspace>> | undefined;
    try {
      const sessionId = await t.flows.main.createBuiltinSession(first.client, first.workspaceId);
      await first.client.call({ type: "session.rename", payload: { sessionId, title: "survives hard crash" } });
      await first.client.call({ type: "session.archive", payload: { sessionId, archived: true } });
      const cli = cliFor(t);
      first.client.close();
      await hardKill(t, cli, pidOf(cli.json(["daemon", "status"])));
      await first.mock.stop();
      firstMockLive = false;
      second = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      const snapshot = await second.client.call({ type: "session.get", payload: { sessionId } });
      t.assertions.assert(snapshot?.type === "snapshot", `session.get returned ${snapshot?.type}`);
      t.assertions.assert(snapshot?.type === "snapshot" && snapshot.data.summary.id === sessionId, "session id changed");
      t.assertions.assert(snapshot?.type === "snapshot" && snapshot.data.summary.title === "survives hard crash", "title was lost");
      const live = await second.client.call({
        type: "session.list",
        payload: { workspaceId: first.workspaceId, includeArchived: false },
      });
      t.assertions.assert(live?.type === "sessions" && !live.data.some((item) => item.id === sessionId), "archive state was lost");
    } finally {
      if (second) {
        second.client.close();
        second.daemon.stop();
        await second.mock.stop();
      }
      first.client.close();
      first.daemon.stop();
      if (firstMockLive) await first.mock.stop();
    }
  },
);

recoveryCase(
  "specialty.recovery.interrupted-agent-session-recovers",
  "A session whose Agent dies with the daemon can accept a new turn after restart",
  "after crashing during a delayed model request, the same session id accepts and completes a fresh mocked turn",
  ["persisted session remains permanently busy", "orphan Agent owns the session", "crash makes session unreadable"],
  async (t) => {
    const first = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let firstMockLive = true;
    let second: Awaited<ReturnType<typeof t.flows.main.openWorkspace>> | undefined;
    try {
      await t.flows.main.configureMockProvider(first.client, first.mock);
      first.mock.script({ text: "reply that should never arrive", delayMs: 10_000 });
      const sessionId = await t.flows.main.createBuiltinSession(first.client, first.workspaceId);
      const firstEvents = await t.flows.main.attachEventLog(first.client, sessionId);
      await t.flows.main.sendPrompt(first.client, sessionId, "Crash during this turn.");
      await t.tools.waitUntil(() => firstEvents.some((item) => item.type === "turnStarted"), 30_000);
      const cli = cliFor(t);
      first.client.close();
      await hardKill(t, cli, pidOf(cli.json(["daemon", "status"])));
      await first.mock.stop();
      firstMockLive = false;

      second = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      await t.flows.main.configureMockProvider(second.client, second.mock);
      second.mock.script({ text: "recovered after crash" });
      const events = await t.flows.main.attachEventLog(second.client, sessionId);
      await t.flows.main.sendPrompt(second.client, sessionId, "A fresh turn after recovery.");
      await t.tools.waitUntil(
        () => events.some((item) => item.type === "turnCompleted" || item.type === "turnFailed"),
        45_000,
      );
      t.assertions.assert(events.some((item) => item.type === "turnCompleted"), `recovery events ${events.map((item) => item.type)}`);
    } finally {
      if (second) {
        second.client.close();
        second.daemon.stop();
        await second.mock.stop();
      }
      first.client.close();
      first.daemon.stop();
      if (firstMockLive) await first.mock.stop();
    }
  },
  45_000,
  true,
);

recoveryCase(
  "specialty.recovery.repeated-crash-preserves-identity",
  "Repeated hard crashes preserve one durable machine identity",
  "across four SIGKILL/start cycles every endpoint has the original machineId and fingerprint but a fresh pid",
  ["crash rotates machine identity", "stale endpoint pid reused", "later restart stops recovering"],
  async (t) => {
    const cli = cliFor(t);
    cli.run(["daemon", "stop"]);
    try {
      cli.json(["daemon", "start"]);
      const first = cli.json(["daemon", "endpoint"]);
      const identity = admission(first);
      let previousPid = pidOf(first);
      for (let cycle = 0; cycle < 4; cycle += 1) {
        await hardKill(t, cli, previousPid);
        cli.json(["daemon", "start"]);
        const current = cli.json(["daemon", "endpoint"]);
        const currentAdmission = admission(current);
        const currentPid = pidOf(current);
        t.assertions.assert(currentPid !== previousPid, `cycle ${cycle} reused pid ${currentPid}`);
        t.assertions.assert(currentAdmission.machineId === identity.machineId, `cycle ${cycle} changed machineId`);
        t.assertions.assert(currentAdmission.fingerprint === identity.fingerprint, `cycle ${cycle} changed fingerprint`);
        previousPid = currentPid;
      }
    } finally {
      cli.run(["daemon", "stop"]);
    }
  },
  45_000,
);

recoveryCase(
  "specialty.recovery.stale-endpoint-replaced",
  "Restart after SIGKILL replaces stale endpoint credentials",
  "the new endpoint file has a different token and pid while machine identity remains stable",
  ["reusable bearer survives crash", "new process adopts stale pid", "endpoint replacement rotates machine"],
  async (t) => {
    const cli = cliFor(t);
    cli.run(["daemon", "stop"]);
    try {
      cli.json(["daemon", "start"]);
      const beforePublic = cli.json(["daemon", "endpoint"]);
      const endpointPath = path.join(t.env.data, "endpoint.json");
      const beforePrivate = JSON.parse(readFileSync(endpointPath, "utf8")) as { token: string; pid: number };
      await hardKill(t, cli, beforePrivate.pid);
      cli.json(["daemon", "start"]);
      const afterPublic = cli.json(["daemon", "endpoint"]);
      const afterPrivate = JSON.parse(readFileSync(endpointPath, "utf8")) as { token: string; pid: number };
      t.assertions.assert(afterPrivate.pid !== beforePrivate.pid, "endpoint pid was not replaced");
      t.assertions.assert(afterPrivate.token !== beforePrivate.token, "endpoint bearer was reused");
      t.assertions.assert(admission(afterPublic).machineId === admission(beforePublic).machineId, "machine identity changed");
    } finally {
      cli.run(["daemon", "stop"]);
    }
  },
);

recoveryCase(
  "specialty.recovery.malformed-stale-endpoint-repaired",
  "A malformed stale endpoint cannot block crash recovery",
  "after SIGKILL and endpoint corruption, start succeeds and publishes valid JSON for a new live pid",
  ["startup trusts malformed endpoint", "stale file blocks publication", "status reports corrupt endpoint running"],
  async (t) => {
    const cli = cliFor(t);
    cli.run(["daemon", "stop"]);
    try {
      const started = cli.json(["daemon", "start"]);
      const oldPid = pidOf(started);
      await hardKill(t, cli, oldPid);
      writeFileSync(path.join(t.env.data, "endpoint.json"), "{truncated");
      const recovered = cli.json(["daemon", "start"]);
      t.assertions.assert(recovered.running === true && pidOf(recovered) !== oldPid, `recovery ${JSON.stringify(recovered)}`);
      const stored = JSON.parse(readFileSync(path.join(t.env.data, "endpoint.json"), "utf8")) as { pid?: number; token?: string };
      t.assertions.assert(stored.pid === recovered.pid && typeof stored.token === "string", "endpoint file was not repaired");
    } finally {
      cli.run(["daemon", "stop"]);
    }
  },
);

recoveryCase(
  "specialty.recovery.sensitive-files-owner-only",
  "Daemon credentials and state are owner-only on Unix",
  "data/log directories and every existing sensitive file have no group or other permission bits",
  ["endpoint bearer world-readable", "state inherits permissive umask", "restart loosens prior files"],
  async (t) => {
    const cli = cliFor(t);
    cli.run(["daemon", "stop"]);
    try {
      cli.json(["daemon", "start"]);
      if (process.platform === "win32") {
        t.assertions.assert(existsSync(path.join(t.env.data, "endpoint.json")), "Windows endpoint missing");
        return;
      }
      const paths = [
        t.env.data,
        path.join(t.env.data, "logs"),
        path.join(t.env.data, "state.json"),
        path.join(t.env.data, "daemon.lock"),
        path.join(t.env.data, "endpoint.json"),
        path.join(t.env.data, "logs", "daemon.log"),
        path.join(t.env.data, "logs", "cli-start.log"),
      ].filter(existsSync);
      t.assertions.assert(paths.length >= 6, `sensitive fixture incomplete: ${paths}`);
      for (const sensitive of paths) {
        const mode = statSync(sensitive).mode & 0o777;
        t.assertions.assert((mode & 0o077) === 0, `${sensitive} mode ${mode.toString(8)} exposes group/other bits`);
      }
      chmodSync(path.join(t.env.data, "endpoint.json"), 0o644);
      cli.json(["daemon", "restart"]);
      const tightened = statSync(path.join(t.env.data, "endpoint.json")).mode & 0o777;
      t.assertions.assert((tightened & 0o077) === 0, `restart left endpoint mode ${tightened.toString(8)}`);
    } finally {
      cli.run(["daemon", "stop"]);
    }
  },
  30_000,
);

recoveryCase(
  "specialty.recovery.crashing-one-daemon-spares-another",
  "Crashing one isolated daemon does not disturb another",
  "after SIGKILLing daemon A, daemon B keeps the same live pid/port and A restarts independently",
  ["global process ownership", "shared lock or endpoint", "crash cleanup kills sibling daemon"],
  async (t) => {
    const first = cliFor(t, path.join(t.env.root, "crash-a"));
    const second = cliFor(t, path.join(t.env.root, "crash-b"));
    try {
      const startedA = first.json(["daemon", "start"]);
      const startedB = second.json(["daemon", "start"]);
      await hardKill(t, first, pidOf(startedA));
      const liveB = second.json(["daemon", "status"]);
      t.assertions.assert(liveB.running === true && liveB.pid === startedB.pid && liveB.port === startedB.port, "daemon B changed");
      const recoveredA = first.json(["daemon", "start"]);
      t.assertions.assert(recoveredA.running === true && recoveredA.pid !== startedA.pid, "daemon A did not recover");
      const stillB = second.json(["daemon", "status"]);
      t.assertions.assert(stillB.pid === startedB.pid && stillB.port === startedB.port, "A recovery replaced daemon B");
    } finally {
      first.run(["daemon", "stop"]);
      second.run(["daemon", "stop"]);
    }
  },
  35_000,
);
