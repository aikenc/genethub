import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createLease, defineSpecialty, genetEnv, locateGenet, parseJson, releaseLease,
  runGenetAsync,
} from "../../framework/public.ts";

const meta = (name: string, title: string, oracle: string, ms: number) => ({
  id: `specialty.cli.supervisor.${name}`, title, oracle,
  catches: [title], tags: ["core", "daemon-control", "supervisor-hardening"],
  llm: { default: "none" as const }, expectedDurationMs: ms, timeoutMs: 360_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["genet-cli", "genehub-host", "daemon", "os-process", "filesystem"],
  productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
});

function parent(pid: number): number {
  return Number(/^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
}
function priority(pid: number): number {
  return Number(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim());
}
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
}

defineSpecialty(meta("observer-timeout", "An observer start timeout cannot stop an existing daemon owner",
  "With a real Host SIGSTOPed past the production start deadline, a second start fails without writing a stop intention; after SIGCONT the original PID and public client remain usable", 65_000), async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cli = (args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env);
  const pid = Number(parseJson((await cli(["daemon", "status"])).stdout).pid);
  let suspended = false;
  try {
    process.kill(pid, "SIGSTOP"); suspended = true;
    const observation = await cli(["daemon", "start"]);
    const stopRequested = existsSync(path.join(t.env.data, "daemon-supervisor.stop"));
    process.kill(pid, "SIGCONT"); suspended = false;
    t.note(`observerFailed=${observation.code !== 0} stopRequested=${stopRequested}`);
    t.assertions.assert(observation.code !== 0 && !stopRequested, "an observer start timeout requested stopping the existing owner");
    await t.tools.waitUntil(async () => {
      const value = parseJson((await cli(["daemon", "status"])).stdout);
      return value.running === true && value.pid === pid;
    }, 5000);
    t.assertions.assert((await opened.client.call({ type: "workspace.list" }))?.type === "workspaces", "original client did not recover after observer timeout");
  } finally {
    if (suspended && alive(pid)) process.kill(pid, "SIGCONT");
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

defineSpecialty(meta("legacy-independent-owner", "Legacy unsupervised independent daemon survives parent crash and stop",
  "A real foreground Host launched as its own OS session through public shell has the old manual-daemon topology and no supervisor lease; its authenticated endpoint and original PID survive parent Host SIGKILL/recovery and normal stop", 55_000), async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const legacy = createLease("legacy-independent-");
  const cli = locateGenet(t.openRoot), env = genetEnv(t.openRoot, legacy.env);
  const call = (args: string[]) => runGenetAsync(cli, args, env);
  const parentStatus = async () => parseJson((await runGenetAsync(cli, ["daemon", "status"], opened.daemon.env)).stdout);
  const detachedPidFile = path.join(legacy.root, "detached.pid");
  try {
    // The Host artifact is unchanged by the supervisor work. This actual
    // foreground entry recreates old manual start's unsupervised OS topology,
    // without pretending a newer CLI is a historical release binary.
    const launched = await t.flows.main.runShell(opened.client, {
      workspaceId: opened.workspaceId,
      argv: ["/bin/sh", "-c", `
        pidfile=$1
        shift
        setsid /bin/sh -c 'printf "%s\\n" "$$" > "$1"; shift; exec "$@"' legacy "$pidfile" "$@" </dev/null >/dev/null 2>&1 &
        # Wait until setsid has detached before the enclosing shell exits.
        attempt=0
        while [ ! -s "$pidfile" ] && [ "$attempt" -lt 100 ]; do
          attempt=$((attempt + 1))
          sleep .05
        done
        test -s "$pidfile"
      `, "launch-legacy", detachedPidFile, cli, "daemon", "run"],
      env: { ...legacy.env, GENEHUB_ALLOW_FOREGROUND_IN_SESSION: "1" }, timeoutMs: 10_000,
    });
    t.assertions.assert(t.flows.main.shellExit(launched.frames)?.code === 0, "legacy Host did not create an independent OS session");
    const detachedPid = Number(readFileSync(detachedPidFile, "utf8"));
    let old = {} as Record<string, unknown>;
    await t.tools.waitUntil(async () => {
      old = parseJson((await call(["daemon", "status"])).stdout);
      return old.running === true && typeof old.port === "number";
    }, 45_000);
    t.assertions.assert(old.pid === detachedPid, "legacy Host did not keep the PID of the detached foreground process");
    t.assertions.assert(!existsSync(path.join(legacy.data, "daemon-supervisor.lock")), "legacy fixture unexpectedly acquired a supervisor lease");
    const parentPid = Number((await parentStatus()).pid);
    opened.client.close(); process.kill(parentPid, "SIGKILL");
    await t.tools.waitUntil(async () => {
      const now = await parentStatus();
      return now.running === true && now.pid !== parentPid && typeof now.port === "number";
    }, 25_000);
    const afterCrash = parseJson((await call(["daemon", "status"])).stdout);
    t.assertions.assert(afterCrash.running === true && afterCrash.pid === old.pid, "parent crash cleanup killed the legacy independent daemon");
    opened.daemon.stop();
    const afterStop = parseJson((await call(["daemon", "status"])).stdout);
    t.assertions.assert(afterStop.running === true && afterStop.pid === old.pid, "parent stop killed the legacy independent daemon");
    t.note("legacySupervisorLease=false survivesParentCrash=true survivesParentStop=true");
  } finally {
    await call(["daemon", "stop"]); releaseLease(legacy);
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});

defineSpecialty(meta("repeated-kill-recovery", "Repeated Host kills retain a protected guardian and recover past five failures",
  "The real Host has higher OOM victim priority than its guardian; six consecutive SIGKILLs each restore a healthy new Host within bounded cooldown, then explicit stop during the next recovery remains stopped", 180_000), async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cli = (args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env);
  const status = async () => parseJson((await cli(["daemon", "status"])).stdout);
  const first = await status(), guardian = parent(Number(first.pid));
  const guardianPriority = priority(guardian), hostPriority = priority(Number(first.pid));
  opened.client.close();
  try {
    t.note(`guardianOomAdj=${guardianPriority} hostOomAdj=${hostPriority}`);
    let current = first;
    for (let crash = 1; crash <= 6; crash++) {
      const pid = Number(current.pid);
      process.kill(pid, "SIGKILL");
      const restored = await t.tools.waitUntil(async () => {
        current = await status();
        return current.running === true && current.pid !== pid && typeof current.port === "number";
      }, 50_000).then(() => true, () => false);
      t.note(`kill=${crash} restored=${restored}`);
      t.assertions.assert(restored && alive(guardian), `automatic recovery abandoned after kill ${crash}`);
    }
    t.assertions.assert(hostPriority > guardianPriority, "Host and guardian share the same OOM victim priority");
    process.kill(Number(current.pid), "SIGKILL");
    const stopped = await cli(["daemon", "stop"]);
    t.note(`cooldownStopCode=${stopped.code} ${stopped.stderr.slice(-500)}`);
    t.assertions.assert(stopped.code === 0, "stop during repeated-failure cooldown failed");
    await new Promise(resolve => setTimeout(resolve, 2200));
    t.assertions.assert((await status()).running === false && !alive(guardian), "stop was undone by repeated-failure recovery");
  } finally {
    await cli(["daemon", "stop"]); await opened.mock.stop();
  }
});

defineSpecialty(meta("restart-headroom", "Recovery waits for memory headroom and remains cancellable",
  "With an operator restart reserve above the visible container memory limit (or physical capacity if unconstrained), the first Host can run but after SIGKILL its guardian logs a memory wait and spawns no replacement; explicit stop exits the waiting guardian", 30_000), async t => {
  const memory = readFileSync("/proc/meminfo", "utf8");
  const physicalKb = Number(/^MemTotal:\s+(\d+)/m.exec(memory)?.[1]);
  const physicalAvailableKb = Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]);
  let capacity = physicalKb * 1024;
  // Independent kernel evidence on this test machine, not an imitation of
  // the product's mount/ancestor resolver. A container cap below physical
  // availability catches a gate that incorrectly reads only host RAM.
  for (const file of ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory.max"]) {
    if (existsSync(file)) {
      const limit = Number(readFileSync(file, "utf8").trim());
      if (Number.isFinite(limit) && limit > 0) capacity = Math.min(capacity, limit);
    }
  }
  const reserveMb = Math.ceil(capacity / (1024 * 1024)) + 1;
  const env = genetEnv(t.openRoot, { ...t.env.env, GENEHUB_DAEMON_RESTART_HEADROOM_MB: String(reserveMb) });
  const genet = locateGenet(t.openRoot);
  const cli = (args: string[]) => runGenetAsync(genet, args, env);
  let guardian = 0;
  try {
    const started = await cli(["daemon", "start"]);
    t.assertions.assert(started.code === 0, "initial manual start failed with a restart-only reserve");
    const pid = Number(parseJson(started.stdout).pid); guardian = parent(pid);
    process.kill(pid, "SIGKILL");
    const log = path.join(t.env.data, "logs", "cli-start.log");
    const waiting = await t.tools.waitUntil(() => readFileSync(log, "utf8").includes("waiting for memory headroom"), 10_000).then(() => true, () => false);
    t.assertions.assert(waiting, "recovery did not observe the configured memory headroom reserve");
    await new Promise(resolve => setTimeout(resolve, 2200));
    const children = readFileSync(`/proc/${guardian}/task/${guardian}/children`, "utf8").trim();
    t.assertions.assert(alive(guardian) && children === "", "memory wait still launched a replacement Host");
    t.assertions.assert((await cli(["daemon", "stop"])).code === 0 && !alive(guardian), "memory wait ignored explicit stop");
    t.note(`memoryWait=true replacementCount=0 stopCancelledWait=true reserveMb=${reserveMb} physicalMb=${Math.floor(physicalKb / 1024)} physicalAvailableMb=${Math.floor(physicalAvailableKb / 1024)}`);
  } finally { await cli(["daemon", "stop"]); }
});

defineSpecialty(
  {
    id: "specialty.cli.supervisor.service-activation-rollback",
    title: "The CLI restores its service definition after systemd rejects activation",
    oracle: "A fresh daemon start fails truthfully, removes the abandoned unit and disables its restart policy. Reinstalling an explicitly stopped service does not activate it.",
    catches: ["failed installation leaves an enabled unit", "install restarts an intentionally stopped daemon"],
    tags: ["core", "daemon-control", "supervisor-hardening"],
    llm: { default: "none" },
    expectedDurationMs: 3_000,
    timeoutMs: 20_000,
    surfaces: ["genet-cli", "filesystem", "os-process"],
    requiredArtifacts: ["genet"],
  },
  async (t) => {
    if (process.platform !== "linux") return;
    const tools = path.join(t.env.root, "service-tools");
    const unit = path.join(t.env.env.XDG_CONFIG_HOME, "systemd/user/genehub-local.service");
    const calls = path.join(tools, "calls");
    const captured = path.join(tools, "definition");
    mkdirSync(tools);
    const systemctl = path.join(tools, "systemctl");
    // Substitute the external systemd command to inject an activation error.
    // The CLI's lifecycle logic, unit writes and process lock are real.
    writeFileSync(systemctl, `#!/bin/sh
set -eu
[ "$1" = --user ]
shift
printf '%s\\n' "$*" >> "$SERVICE_TEST_CALLS"
case "$1" in
  show-environment|daemon-reload|enable|disable) ;;
  show) printf 'LoadState=not-found\\nMainPID=0\\n' ;;
  start)
    cp "$SERVICE_TEST_UNIT" "$SERVICE_TEST_CAPTURE"
    echo 'activation rejected by fixture' >&2
    exit 1 ;;
  *) exit 78 ;;
esac
`);
    chmodSync(systemctl, 0o700);
    const env = genetEnv(t.openRoot, {
      ...t.env.env,
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      SERVICE_TEST_CALLS: calls,
      SERVICE_TEST_UNIT: unit,
      SERVICE_TEST_CAPTURE: captured,
    });
    delete env.GENEHUB_LOCAL_DATA_DIR;
    const cli = locateGenet(t.openRoot);
    const failed = await runGenetAsync(cli, ["daemon", "start"], env);
    t.assertions.assert(failed.code !== 0 && failed.stderr.includes("activation rejected by fixture"), failed.stderr);
    t.assertions.assert(!existsSync(unit), "failed activation left a persistent service definition");
    const actions = readFileSync(calls, "utf8");
    t.assertions.assert(actions.includes("disable --now genehub-local.service"), "failed activation left restart enabled");
    const definition = readFileSync(captured, "utf8");
    t.assertions.assert(definition.includes(" daemon run") && definition.includes("Restart=always"), definition);

    writeFileSync(unit, definition);
    const stopped = await runGenetAsync(cli, ["daemon", "stop"], env);
    t.assertions.assert(stopped.code === 0, stopped.stderr);
    const beforeInstall = readFileSync(calls, "utf8");
    const install = await runGenetAsync(cli, ["daemon", "__install", "--refresh"], env);
    t.assertions.assert(install.code === 0 && parseJson(install.stdout).desiredState === "stopped", install.stdout);
    const extra = readFileSync(calls, "utf8").slice(beforeInstall.length);
    t.assertions.assert(!/^(?:start|restart|enable) /m.test(extra), extra);
  },
);
