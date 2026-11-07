import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { connectProductClient, daemonEndpoint, defineSpecialty, parseJson, runGenetAsync } from "../../framework/public.ts";

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
}

defineSpecialty({
  id: "specialty.cli.daemon-crash-recovery",
  title: "Manual daemon survives Host SIGKILL without leaving detached work or replaying history",
  oracle: "Without another start request, the real CLI restores a new healthy Host with the same machine and saved conversation; a double-forked TERM-resistant process started through public shell disappears, a foreign sentinel survives, concurrent starts return the same Host, and explicit stop stays stopped",
  catches: ["manual daemon never recovers after kernel kill", "detached tool survives Host death", "completed orphan remains a zombie while Host lives", "recovery kills unrelated work", "recovery loses identity or history", "stop is undone by recovery", "concurrent starts duplicate the Host"],
  tags: ["core", "daemon-control", "daemon-crash-recovery"], llm: { default: "none" },
  expectedDurationMs: 35_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 0 },
  surfaces: ["cli", "genehub-host", "daemon", "os-process", "filesystem"],
  productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cli = (args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env);
  const status = async () => parseJson((await cli(["daemon", "status"])).stdout);
  const first = await status(), oldPid = Number(first.pid);
  const initialEndpoint = daemonEndpoint(opened.daemon);
  const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
  await opened.client.call({ type: "session.rename", payload: { sessionId, title: "Saved before real Host crash" } });
  const pidFile = path.join(t.env.workspace, "detached.pid");
  const sentinel = spawn("/bin/sleep", ["120"], { env: opened.daemon.env, stdio: "ignore" });
  let detachedPid = 0;
  let recoveredClient: Awaited<ReturnType<typeof connectProductClient>> | undefined;
  try {
    // OS fault fixture, launched through the actual product shell. Like an
    // offscreen browser it leaves the original group twice and ignores TERM.
    const source = (file: string, body: string) => [
      "import os,signal,time,sys",
      "p=os.fork()",
      "if p:", " os.waitpid(p,0); sys.exit(0)",
      "os.setsid()", "p=os.fork()", "if p: os._exit(0)",
      "fd=os.open(os.devnull,os.O_RDWR)",
      "for n in (0,1,2): os.dup2(fd,n)",
      "signal.signal(signal.SIGTERM,signal.SIG_IGN)",
      `open(${JSON.stringify(file)},'w').write(str(os.getpid()))`,
      body,
    ].join("\n");
    const completedFile = path.join(t.env.workspace, "completed-orphan.pid");
    const completed = await t.flows.main.runShell(opened.client, {
      workspaceId: opened.workspaceId,
      argv: [process.env.GENEHUB_PYTHON!, "-c", source(completedFile, "time.sleep(0.5)")], timeoutMs: 10_000,
    });
    t.assertions.assert(t.flows.main.shellExit(completed.frames)?.code === 0, "completed orphan fixture failed to start");
    await t.tools.waitUntil(() => existsSync(completedFile), 5000);
    const completedPid = Number(readFileSync(completedFile, "utf8"));
    t.assertions.assert(completedPid > 1, "completed orphan PID absent");
    const completedReaped = await t.tools.waitUntil(() => !existsSync(`/proc/${completedPid}`), 3000).then(() => true, () => false);
    t.note(`completedOrphanReaped=${completedReaped}`);
    t.assertions.assert(completedReaped && (await status()).pid === oldPid, "completed orphan was not reaped while original Host remained alive");
    const shell = await t.flows.main.runShell(opened.client, {
      workspaceId: opened.workspaceId, argv: [process.env.GENEHUB_PYTHON!, "-c", source(pidFile, "while True: time.sleep(1)")], timeoutMs: 10_000,
    });
    t.assertions.assert(t.flows.main.shellExit(shell.frames)?.code === 0, "detached OS fixture failed to start");
    await t.tools.waitUntil(() => existsSync(pidFile), 5000);
    detachedPid = Number(readFileSync(pidFile, "utf8"));
    t.assertions.assert(detachedPid > 1 && alive(detachedPid) && sentinel.pid && alive(sentinel.pid), "positive process controls failed");
    opened.client.close();
    process.kill(oldPid, "SIGKILL");
    const cleaned = await t.tools.waitUntil(() => !alive(detachedPid), 8000).then(() => true, () => false);
    let replacement = first;
    const recovered = await t.tools.waitUntil(async () => {
      replacement = await status();
      return replacement.running === true && Number(replacement.pid) !== oldPid && typeof replacement.port === "number";
    }, 20_000).then(() => true, () => false);
    t.note(`detachedCleaned=${cleaned} automaticRecovery=${recovered}`);
    t.assertions.assert(cleaned && recovered, `Host SIGKILL: detachedCleaned=${cleaned} automaticRecovery=${recovered}`);
    t.assertions.assert(alive(sentinel.pid!), "recovery killed a foreign process");
    const nextEndpoint = daemonEndpoint(opened.daemon);
    t.assertions.assert(nextEndpoint.localServerProof.machineId === initialEndpoint.localServerProof.machineId, "recovery replaced machine identity");
    recoveredClient = await connectProductClient(nextEndpoint);
    const snapshot = await recoveredClient.call({ type: "session.get", payload: { sessionId } });
    t.assertions.assert(snapshot?.type === "snapshot" && snapshot.data.summary.title === "Saved before real Host crash", "saved conversation did not survive crash");
    t.assertions.assert(snapshot?.type === "snapshot" && snapshot.data.summary.status === "idle", "idle history was unexpectedly executed on recovery");
    const starts = await Promise.all(Array.from({ length: 4 }, () => cli(["daemon", "start"])));
    t.assertions.assert(starts.every(r => r.code === 0 && Number(parseJson(r.stdout).pid) === Number(replacement.pid)), "concurrent starts did not preserve one Host");
    recoveredClient.close(); recoveredClient = undefined;
    t.assertions.assert((await cli(["daemon", "stop"])).code === 0, "explicit stop failed");
    await new Promise(resolve => setTimeout(resolve, 2200));
    t.assertions.assert((await status()).running === false, "supervision undid explicit stop");
    t.assertions.assert((await cli(["daemon", "start"])).code === 0, "explicit restart after stop failed");
    // A stop arriving while the old Host is already dead must also cancel
    // pending recovery, rather than reporting success and resurrecting it.
    process.kill(Number((await status()).pid), "SIGKILL");
    await t.tools.waitUntil(async () => (await status()).running === false, 3000);
    t.assertions.assert((await cli(["daemon", "stop"])).code === 0, "stop during recovery failed");
    await new Promise(resolve => setTimeout(resolve, 2200));
    t.assertions.assert((await status()).running === false, "stop during recovery was undone");
  } finally {
    recoveredClient?.close(); opened.client.close();
    await cli(["daemon", "stop"]);
    if (detachedPid > 1 && alive(detachedPid)) process.kill(detachedPid, "SIGKILL");
    sentinel.kill("SIGKILL");
    await opened.mock.stop();
  }
});
