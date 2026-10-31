import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { createLease, defineSpecialty, genetEnv, locateGenet, parseJson, releaseLease, runGenetAsync, type CaseContext } from "../../framework/public.ts";

const meta = (name: string, title: string, oracle: string) => ({
  id: `specialty.cli.${name}`, title, oracle,
  catches: [title], tags: ["core", "daemon-control", "daemon-resource-isolation"], llm: { default: "none" as const },
  expectedDurationMs: 20_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 0 },
  surfaces: ["cli", "genehub-host", "daemon", "os-process", "filesystem"],
  productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
});

defineSpecialty(meta("daemon-start-outlives-tool-group", "An Agent shell can start an independent daemon",
  "The public Host shell finishes and its original process group disappears; the new daemon has SID=PGID=PID, cleans launcher context, and remains healthy after the parent daemon stops"), async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const childLease = createLease("daemon-independent-");
  const cli = locateGenet(t.openRoot), env = genetEnv(t.openRoot, childLease.env);
  const call = (args: string[]) => runGenetAsync(cli, args, env, { cwd: childLease.workspace });
  let parentStopped = false;
  try {
    const launched = await t.flows.main.runShell(opened.client, {
      workspaceId: opened.workspaceId,
      argv: ["/bin/sh", "-c", 'echo launcherPid=$$; exec "$@"', "launcher", cli, "daemon", "start"],
      env: { ...childLease.env, GENEHUB_SESSION_ID: "s_parent_fixture", GENEHUB_CONTROLLER_TOKEN: "fixture-only", GENEHUB_AGENT_PID: "123", GENEHUB_HOST_PID: "124" },
      timeoutMs: 90_000,
    });
    t.assertions.assert(t.flows.main.shellExit(launched.frames)?.code === 0, "start failed inside the real Host shell: " + t.flows.main.shellText(launched.frames, "stderr"));
    const stdout = t.flows.main.shellText(launched.frames, "stdout");
    const launcherPid = Number(/launcherPid=(\d+)/.exec(stdout)?.[1]);
    const started = parseJson(stdout), pid = Number(started.pid);
    t.assertions.assert(started.started === true && pid > 1 && launcherPid > 1, "start did not identify its daemon and launcher");
    await t.tools.waitUntil(() => {
      try { process.kill(-launcherPid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
    }, 5000);
    const { stdout: group } = await promisify(execFile)("ps", ["-o", "pid=,pgid=,sid=", "-p", String(pid)]);
    const ids = group.trim().split(/\s+/).map(Number);
    t.assertions.assert(ids.length === 3 && ids.every(id => id === pid), "daemon retained launcher SID/PGID");
    const status = parseJson((await call(["daemon", "status"])).stdout);
    t.assertions.assert(status.running === true && status.pid === pid, "daemon died during launcher group cleanup");
    const registered = await call(["space", "open", childLease.workspace]);
    t.assertions.assert(registered.code === 0, "could not register independent daemon workspace");
    const shell = await call(["shell", "--cwd", childLease.workspace, "--", "/bin/sh", "-c", 'test -z "$GENEHUB_SESSION_ID$GENEHUB_CONTROLLER_TOKEN$GENEHUB_AGENT_PID$GENEHUB_HOST_PID$GENET_WORKSPACE_ROOT"']);
    t.assertions.assert(shell.code === 0 && /"exitCode":0/.test(shell.stdout), "launcher context reached a daemon-owned command: " + JSON.stringify(shell));
    opened.client.close(); opened.daemon.stop(); parentStopped = true;
    const independent = parseJson((await call(["daemon", "status"])).stdout);
    t.assertions.assert(independent.running === true && independent.pid === pid, "parent daemon exit took down independent daemon");
    t.note("launcherGroupGone=true independentSid=true survivesParentExit=true");
  } finally {
    await call(["daemon", "stop"]);
    releaseLease(childLease);
    opened.client.close(); if (!parentStopped) opened.daemon.stop(); await opened.mock.stop();
  }
});

defineSpecialty(meta("daemon-run-session-guard", "Accidental foreground daemon launch refuses inherited Agent context",
  "Each Agent marker rejects daemon run before creating an endpoint; inherited INVOCATION_ID does not bypass the guard; explicit foreground consent can start and stop the real daemon"), async t => {
  const cli = locateGenet(t.openRoot), base = genetEnv(t.openRoot, t.env.env);
  for (const key of ["GENEHUB_AGENT_PID", "GENEHUB_HOST_PID", "GENEHUB_ALLOW_FOREGROUND_IN_SESSION"]) delete base[key];
  for (const key of ["GENEHUB_SESSION_ID", "GENEHUB_CONTROLLER_TOKEN", "GENEHUB_AGENT_PID", "GENEHUB_HOST_PID"]) {
    const refused = await runGenetAsync(cli, ["daemon", "run"], { ...base, [key]: "fixture", INVOCATION_ID: "inherited-service" });
    t.assertions.assert(refused.code !== 0 && /foregroundDaemonInSession/.test(refused.stdout) && /daemon start/.test(refused.stderr), `foreground launch did not refuse ${key}`);
  }
  const status = parseJson((await runGenetAsync(cli, ["daemon", "status"], base)).stdout);
  t.assertions.assert(status.running === false, "refused foreground launch started a daemon");
  // A supervisor deliberately owns this foreground process; it must remain
  // attached, unlike daemon start. The real entry cleans context in the Host.
  const { spawn } = await import("node:child_process");
  const child = spawn(cli, ["daemon", "run"], { env: { ...base, GENEHUB_SESSION_ID: "s_intentional", GENEHUB_ALLOW_FOREGROUND_IN_SESSION: "1" }, stdio: "ignore" });
  try {
    await t.tools.waitUntil(async () => parseJson((await runGenetAsync(cli, ["daemon", "status"], base)).stdout).running === true, 60_000);
    t.assertions.assert(child.exitCode === null, "explicit foreground supervisor could not run");
  } finally {
    await runGenetAsync(cli, ["daemon", "stop"], base);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});

function openLockDescriptors(pid: number, lock: string): number {
  return readdirSync(`/proc/${pid}/fd`).filter(fd => {
    try { const target = readlinkSync(`/proc/${pid}/fd/${fd}`); return target === lock || target === lock + " (deleted)"; }
    catch { return false; }
  }).length;
}

async function externalLock(t: CaseContext, lock: string): Promise<number> {
  // OS evidence plane: this contender must keep working after the product
  // workspace registration is removed, so do not route it through shell.
  try {
    await promisify(execFile)("flock", ["-n", "-x", lock, "true"], {
      cwd: t.env.workspace, env: genetEnv(t.openRoot, t.env.env),
    });
    return 0;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return 1;
    throw error;
  }
}

defineSpecialty(meta("session-locks-release-in-wasm", "Deleting sessions and detaching workspaces release Host locks",
  "Real WASM session creation holds writer/owner locks; deletion leaves no deleted writer descriptors; workspace removal frees both locks while the daemon remains alive"), async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const status = parseJson((await runGenetAsync(opened.daemon.genet, ["daemon", "status"], opened.daemon.env)).stdout), pid = Number(status.pid);
    const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const writer = path.join(opened.workspaceRoot, ".genethub", "sessions", id, "writer.lock");
    const owner = path.join(opened.workspaceRoot, ".genethub", "owner.lock");
    t.assertions.assert(openLockDescriptors(pid, writer) > 0 && await externalLock(t, writer) === 1, "writer lock positive control failed");
    await opened.client.call({ type: "session.delete", payload: { sessionId: id } });
    await t.tools.waitUntil(() => openLockDescriptors(pid, writer) === 0, 5000);
    const second = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const secondWriter = path.join(opened.workspaceRoot, ".genethub", "sessions", second, "writer.lock");
    t.assertions.assert(await externalLock(t, owner) === 1 && await externalLock(t, secondWriter) === 1, "live workspace locks did not exclude another process");
    await opened.client.call({ type: "workspace.remove", payload: { workspaceId: opened.workspaceId } });
    await t.tools.waitUntil(() => openLockDescriptors(pid, owner) === 0 && openLockDescriptors(pid, secondWriter) === 0, 5000);
    t.assertions.assert(await externalLock(t, owner) === 0 && await externalLock(t, secondWriter) === 0, "detached workspace still excludes another lock owner");
    t.assertions.assert((await opened.client.call({ type: "workspace.list" }))?.type === "workspaces", "daemon died to release its locks");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
