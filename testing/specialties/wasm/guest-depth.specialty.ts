import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BlockedError,
  defineSpecialty,
  genetEnv,
  locateGenet,
  parseJson,
  procCmdline,
  processesMatching,
  agentHostProcesses,
  runGenet,
  tryLocateDaemonComponent,
  tryLocateHost,
  type CaseContext,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function requireWasmArtifacts(openRoot: string): {
  host: string;
  component: string;
} {
  const host = tryLocateHost(openRoot);
  const component = tryLocateDaemonComponent(openRoot);
  if (!host || !component) {
    throw new BlockedError(
      `wasm artifacts missing: host=${host ?? "no"} component=${component ?? "no"}`,
    );
  }
  return { host, component };
}

function wasmMeta(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  extra: { llm?: "mock" | "none"; ms?: number; cpu?: number; memoryMb?: number } = {},
) {
  return {
    id,
    title,
    oracle,
    catches,
    tags: ["core", "wasm-guest", "v2-shell"],
    llm: { default: extra.llm ?? "none" as const },
    expectedDurationMs: extra.ms ?? 25_000,
    timeoutMs: 150_000,
    resources: {
      environments: 1,
      cpu: extra.cpu ?? 2,
      memoryMb: extra.memoryMb ?? 768,
      io: 1,
      browser: 0,
      pool: "standard" as const,
    },
    surfaces: ["genehub-host", "daemon", "agent"],
    productInterfaces: ["genet-cli", "@genehub/web/client"],
    requiredArtifacts: ["genehub-host-dev", "genehub_guest.wasm"],
  };
}

async function withOpened(
  t: CaseContext,
  run: (opened: Opened) => Promise<void>,
  configureMock = false,
): Promise<void> {
  requireWasmArtifacts(t.openRoot);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    if (configureMock) await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await run(opened);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

function cliJson(t: CaseContext, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Record<string, unknown> {
  const genet = locateGenet(t.openRoot);
  const env = genetEnv(t.openRoot, { ...t.env.env, ...extraEnv });
  const result = runGenet(genet, args, env);
  if (result.code !== 0) {
    throw new Error(`genet ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return parseJson(result.stdout);
}

defineSpecialty(
  wasmMeta(
    "specialty.wasm.guest-identity.daemon-is-host-component",
    "The running daemon is the host loading genehub_guest.wasm, not genet daemon run",
    "status pid cmdline contains genehub-host-dev and genehub_guest.wasm and does not contain 'daemon run'",
    [
      "native genet-dev is still the listener",
      "wrapper script leftover as the pid",
      "status pid is the guest-less CLI",
    ],
  ),
  async (t) => {
    const artifacts = requireWasmArtifacts(t.openRoot);
    await withOpened(t, async (opened) => {
      const status = cliJson(t, ["daemon", "status"]);
      t.assertions.assert(status.running === true, `not running: ${JSON.stringify(status)}`);
      const pid = Number(status.pid);
      t.assertions.assert(Number.isInteger(pid) && pid > 1, `implausible pid ${status.pid}`);
      const cmd = procCmdline(pid);
      t.assertions.assert(cmd.includes("genehub-host-dev"), `pid ${pid} is not the host: ${cmd}`);
      t.assertions.assert(cmd.includes("genehub_guest.wasm"), `pid ${pid} did not load the component: ${cmd}`);
      t.assertions.assert(!cmd.includes("daemon run"), `pid ${pid} still looks like native daemon run: ${cmd}`);
      t.assertions.assert(
        cmd.includes(path.basename(artifacts.component)) || cmd.includes(artifacts.component),
        `host loaded a different component: ${cmd}`,
      );
      const listed = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", `workspace.list returned ${listed?.type}`);
    });
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.guest-identity.host-pid-not-inherited",
    "A pre-set GENEHUB_DEV_HOST_PID does not become the advertised daemon pid",
    "status.pid is the live host pid, not the inherited value 1",
    [
      "inherit_env wins over the shell assertion",
      "guest reports pid 1",
      "local admission binds the wrong process",
    ],
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const genet = locateGenet(t.openRoot);
    const env = genetEnv(t.openRoot, { ...t.env.env, GENEHUB_DEV_HOST_PID: "1" });
    const started = runGenet(genet, ["daemon", "start"], env);
    t.assertions.assert(started.code === 0, `start failed: ${started.stderr || started.stdout}`);
    try {
      const status = parseJson(runGenet(genet, ["daemon", "status"], env).stdout);
      t.assertions.assert(status.running === true, `not running: ${JSON.stringify(status)}`);
      t.assertions.assert(status.pid !== 1 && status.pid !== "1", `inherited fake pid leaked: ${JSON.stringify(status)}`);
      const pid = Number(status.pid);
      t.assertions.assert(procCmdline(pid).includes("genehub-host-dev"), "live pid is not the host");
    } finally {
      runGenet(genet, ["daemon", "stop"], env);
    }
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.guest-identity.agent-is-second-host-process",
    "A builtin session is a second host process running the same component's agent entry",
    "after session.create, a live pid other than the daemon runs genehub-host-dev with --entry agent on the same genehub_guest.wasm",
    [
      "agent runs inside the daemon instance",
      "native genet-agent-dev is spawned instead",
      "session.create succeeds without an agent process",
      "agent entry loads a different component than the daemon",
    ],
    { llm: "mock", ms: 40_000 },
  ),
  async (t) => {
    const artifacts = requireWasmArtifacts(t.openRoot);
    await withOpened(
      t,
      async (opened) => {
        const daemonPid = Number(cliJson(t, ["daemon", "status"]).pid);
        const daemonCmd = procCmdline(daemonPid);
        opened.mock.script({ text: "agent process alive" });
        const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
        const events = await t.flows.main.attachEventLog(opened.client, sessionId);
        await t.flows.main.sendPrompt(opened.client, sessionId, "Reply with a short acknowledgement.");
        await t.tools.waitUntil(
          () => events.some((event) => event.type === "turnCompleted" || event.type === "turnFailed"),
          45_000,
        );
        t.assertions.assert(
          events.some((event) => event.type === "turnCompleted"),
          `turn did not complete: ${events.map((event) => event.type).join(",")}`,
        );
        const agents = agentHostProcesses().filter((row) => row.environ.includes(t.env.data));
        t.assertions.assert(agents.length > 0, `no nested host --entry agent process: ${JSON.stringify(agents)}`);
        t.assertions.assert(
          agents.some((row) => row.pid !== daemonPid),
          `agent shares the daemon pid ${daemonPid}: ${JSON.stringify(agents)}`,
        );
        t.assertions.assert(
          agents.every((row) => row.cmd.includes("genehub-host-dev") || row.cmd.includes(path.basename(artifacts.host))),
          `agent is not the host: ${JSON.stringify(agents)}`,
        );
        t.assertions.assert(
          agents.some((row) => row.cmd.includes("--entry agent") && row.cmd.includes("genehub_guest.wasm")),
          `nested host is not the agent entry of the component: ${JSON.stringify(agents.map((row) => ({ pid: row.pid, cmd: row.cmd })))}`,
        );
        t.assertions.assert(
          agents.some((row) => {
            const component = row.cmd.match(/--component\s+(\S+)/)?.[1];
            return component != null && daemonCmd.includes(component);
          }),
          `agent entry loaded a different component than the daemon: ${JSON.stringify(agents.map((row) => row.cmd))}`,
        );
        t.assertions.assert(
          !agents.some((row) => /(^|\s)genet-agent-dev(\s|$)/.test(row.cmd) && !row.cmd.includes("genehub-host-dev")),
          `native agent binary was spawned: ${JSON.stringify(agents)}`,
        );
      },
      true,
    );
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.lifecycle.stop-reaps-host-pid",
    "daemon stop returns only after the host pid is gone",
    "immediately after stop, /proc/<pid> does not exist and status.pid is null",
    ["guest released the lock but the shell lingered", "status still reports the old pid", "stop is asynchronous"],
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const genet = locateGenet(t.openRoot);
    const env = genetEnv(t.openRoot, t.env.env);
    const started = parseJson(runGenet(genet, ["daemon", "start"], env).stdout);
    const pid = Number(started.pid);
    t.assertions.assert(pid > 1, `start pid ${started.pid}`);
    const stopped = runGenet(genet, ["daemon", "stop"], env);
    t.assertions.assert(stopped.code === 0, `stop failed: ${stopped.stderr}`);
    t.assertions.assert(!existsSync(`/proc/${pid}`), `host pid ${pid} still in /proc after stop returned`);
    const status = parseJson(runGenet(genet, ["daemon", "status"], env).stdout);
    t.assertions.assert(status.running === false && status.pid == null, `final status ${JSON.stringify(status)}`);
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.lifecycle.second-start-same-datadir-is-idempotent",
    "A second start against the same data directory adopts the live host, it does not fork another guest",
    "alreadyRunning is true and the pid/cmdline are unchanged",
    ["file-lock import is a no-op", "two hosts listen", "second start kills the first"],
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const genet = locateGenet(t.openRoot);
    const env = genetEnv(t.openRoot, t.env.env);
    const first = parseJson(runGenet(genet, ["daemon", "start"], env).stdout);
    try {
      const cmd = procCmdline(Number(first.pid));
      const second = parseJson(runGenet(genet, ["daemon", "start"], env).stdout);
      t.assertions.assert(second.alreadyRunning === true, `second start ${JSON.stringify(second)}`);
      t.assertions.assert(second.pid === first.pid, `pid changed ${first.pid} -> ${second.pid}`);
      t.assertions.assert(procCmdline(Number(second.pid)) === cmd, "cmdline changed under the adopted pid");
    } finally {
      runGenet(genet, ["daemon", "stop"], env);
    }
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.lifecycle.missing-component-fails-closed",
    "A CLI copied away from the artifacts refuses to start a native daemon",
    "daemon start exits non-zero and no genehub-host-dev child appears under that data dir",
    ["silent fallback to genet daemon run", "start succeeds without a component"],
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const genet = locateGenet(t.openRoot);
    const isolated = path.join(t.env.root, "isolated-cli");
    mkdirSync(isolated, { recursive: true });
    const clone = path.join(isolated, path.basename(genet));
    copyFileSync(genet, clone);
    chmodSync(clone, 0o755);
    const env = genetEnv(t.openRoot, {
      ...t.env.env,
      GENEHUB_DEV_DATA_DIR: path.join(t.env.root, "isolated-data"),
    });
    delete env.GENEHUB_DEV_DAEMON_COMMAND;
    delete env.GENEHUB_DEV_COMPONENT;
    delete env.GENEHUB_DEV_DAEMON_COMPONENT;
    delete env.GENEHUB_HOST;
    const result = runGenet(clone, ["daemon", "start"], env);
    t.assertions.assert(result.code !== 0, `isolated CLI started without artifacts: ${result.stdout}`);
    t.assertions.assert(
      /genehub-host-dev is missing|genehub_guest\.wasm is missing/i.test(`${result.stderr}\n${result.stdout}`),
      `failure did not name the missing artifact: ${result.stderr || result.stdout}`,
    );
    t.assertions.assert(
      processesMatching(path.join(t.env.root, "isolated-data")).length === 0,
      "a daemon process appeared for the isolated data dir",
    );
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.permissions.umask-does-not-leak",
    "Sensitive files are owner-only even when umask is 0",
    "state.json, endpoint.json and daemon.lock have no group/other bits after start",
    ["guest no-op permissions", "umask 000 leaves 666", "restart does not retighten"],
  ),
  async (t) => {
    if (process.platform === "win32") return;
    requireWasmArtifacts(t.openRoot);
    const genet = locateGenet(t.openRoot);
    const env = genetEnv(t.openRoot, t.env.env);
    const previous = process.umask(0);
    try {
      const started = runGenet(genet, ["daemon", "start"], env);
      t.assertions.assert(started.code === 0, `start failed: ${started.stderr}`);
      try {
        for (const relative of ["state.json", "endpoint.json", "daemon.lock"]) {
          const file = path.join(t.env.data, relative);
          t.assertions.assert(existsSync(file), `${relative} missing`);
          const mode = statSync(file).mode & 0o777;
          t.assertions.assert((mode & 0o077) === 0, `${relative} mode ${mode.toString(8)} exposes group/other`);
        }
        chmodSync(path.join(t.env.data, "endpoint.json"), 0o644);
        const restarted = runGenet(genet, ["daemon", "restart"], env);
        t.assertions.assert(restarted.code === 0, `restart failed: ${restarted.stderr}`);
        const tightened = statSync(path.join(t.env.data, "endpoint.json")).mode & 0o777;
        t.assertions.assert((tightened & 0o077) === 0, `restart left endpoint ${tightened.toString(8)}`);
      } finally {
        runGenet(genet, ["daemon", "stop"], env);
      }
    } finally {
      process.umask(previous);
    }
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.process.nonzero-exit-is-not-zero",
    "A command that exits 17 is reported as 17, not success",
    "shell exit frame code is 17",
    ["wasip2 ExitStatus::code is always Some(0)", "guest maps every child to success"],
  ),
  async (t) => {
    await withOpened(t, async (opened) => {
      const result = await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/sh", "-c", "exit 17"],
      });
      t.assertions.assert(result.status === 200, `status ${result.status}`);
      const exit = t.flows.main.shellExit(result.frames);
      t.assertions.assert(exit?.code === 17, `exit ${JSON.stringify(exit)} frames=${JSON.stringify(result.frames)}`);
    });
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.process.timeout-honours-term-trap",
    "A timed-out command is asked with SIGTERM before SIGKILL",
    "the TERM trap creates tidied-up.txt",
    ["host kill reaches only the direct child", "timeout is SIGKILL only", "timeout is not enforced"],
    { ms: 20_000 },
  ),
  async (t) => {
    await withOpened(t, async (opened) => {
      const marker = path.join(opened.workspaceRoot, "tidied-up.txt");
      const started = Date.now();
      await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/sh", "-c", `trap 'echo tidy > ${marker}; exit 0' TERM; while true; do sleep 0.05; done`],
        timeoutMs: 500,
      });
      t.assertions.assert(Date.now() - started < 15_000, "limit was not enforced");
      t.assertions.assert(readFileSync(marker, "utf8").trim() === "tidy", "command was killed outright");
    });
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.process.grandchild-dies-with-caller",
    "A background loop started by the command dies when the caller disconnects",
    "the marker file stops growing after the device client closes",
    ["kill does not cover the process group", "setsid never ran in the host spawn"],
    { ms: 20_000 },
  ),
  async (t) => {
    await withOpened(t, async (opened) => {
      const marker = path.join(opened.workspaceRoot, "still-running.txt");
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, []);
      const started = t.flows.main.startShell(device.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/sh", "-c", `(while true; do echo alive >> ${marker}; sleep 0.05; done) & sleep 20`],
      });
      await t.tools.waitUntil(() => {
        try {
          return readFileSync(marker, "utf8").length > 0;
        } catch {
          return false;
        }
      }, 15_000);
      device.client.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = readFileSync(marker, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 800));
      const later = readFileSync(marker, "utf8");
      t.assertions.assert(after.length === later.length, "command kept running after disconnect");
      await started.result.catch(() => undefined);
    });
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.http.host-header-present",
    "Outbound LLM HTTP from the guest includes a Host header",
    "the mock LLM recorded a Host header matching 127.0.0.1:<port> on a completions request",
    [
      "wasmtime p2 path omits Host",
      "guest cannot set the forbidden header and the shell does not fill it",
      "request never reached the mock",
    ],
    { llm: "mock", ms: 40_000 },
  ),
  async (t) => {
    await withOpened(
      t,
      async (opened) => {
        opened.mock.script({ text: "host header reached me" });
        const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
        const events = await t.flows.main.attachEventLog(opened.client, sessionId);
        await t.flows.main.sendPrompt(opened.client, sessionId, "Say hello.");
        await t.tools.waitUntil(
          () => events.some((event) => event.type === "turnCompleted" || event.type === "turnFailed"),
          45_000,
        );
        t.assertions.assert(
          events.some((event) => event.type === "turnCompleted"),
          `turn failed: ${events.map((event) => event.type).join(",")}`,
        );
        const origin = new URL(opened.mock.origin);
        const withHost = opened.mock.inboundHeaders.filter((headers) => headers.host);
        t.assertions.assert(withHost.length > 0, `no Host header on ${JSON.stringify(opened.mock.inboundHeaders)}`);
        t.assertions.assert(
          withHost.some((headers) => headers.host === origin.host || headers.host === `127.0.0.1:${origin.port}`),
          `Host was ${withHost.map((headers) => headers.host).join(",")} expected ${origin.host}`,
        );
      },
      true,
    );
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.agent.relative-bash-uses-session-cwd",
    "A bash tool with a relative path reads the file in the session cwd, not WASI /",
    "notes.txt is read and the turn completes; a file is not reported missing",
    [
      "guest cwd is the preopen root",
      "GENEHUB_DEV_CWD is the daemon directory rather than the workspace",
      "tool output is No such file or directory",
    ],
    { llm: "mock", ms: 45_000 },
  ),
  async (t) => {
    mkdirSync(path.join(t.env.workspace, "nested"), { recursive: true });
    writeFileSync(path.join(t.env.workspace, "nested", "notes.txt"), "guest-cwd-marker\n");
    await withOpened(
      t,
      async (opened) => {
        opened.mock.script(
          { tool: { name: "bash", arguments: { command: "cat notes.txt" } } },
          { text: "read notes" },
        );
        const sessionId = await t.flows.main.createBuiltinSession(
          opened.client,
          opened.workspaceId,
          "nested",
        );
        const events = await t.flows.main.attachEventLog(opened.client, sessionId);
        await t.flows.main.sendPrompt(opened.client, sessionId, "Read notes.txt with bash and stop.");
        await t.tools.waitUntil(
          () => events.some((event) => event.type === "turnCompleted" || event.type === "turnFailed"),
          45_000,
        );
        t.assertions.assert(
          events.some((event) => event.type === "turnCompleted"),
          `turn did not complete: ${JSON.stringify(events.map((event) => event.type))}`,
        );
        const raw = JSON.stringify(opened.mock.requests);
        t.assertions.assert(
          !raw.toLowerCase().includes("no such file"),
          `model saw a missing file: ${raw.slice(0, 800)}`,
        );
      },
      true,
    );
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.concurrency.sleep-does-not-stall-control-plane",
    "A long shell command does not freeze workspace.list on another connection",
    "workspace.list from a second client returns while sleep 8 is still running, in under 2s",
    [
      "a blocking process import parks the guest fiber",
      "one session serializes the whole daemon",
      "second client waits for the sleep",
    ],
    { ms: 25_000 },
  ),
  async (t) => {
    await withOpened(t, async (opened) => {
      const sleeper = t.flows.main.startShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/sleep", "8"],
      });
      const other = await t.flows.main.openSecondClient(opened);
      const began = Date.now();
      const listed = await other.call({ type: "workspace.list" });
      const elapsed = Date.now() - began;
      other.close();
      t.assertions.assert(listed?.type === "workspaces", `second client ${listed?.type}`);
      t.assertions.assert(elapsed < 2_000, `workspace.list blocked ${elapsed}ms behind the sleep`);
      await sleeper.result;
    });
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.concurrency.pty-and-session-together",
    "A PTY and an agent turn can run on the same guest without one starving the other",
    "pty.open echoes a marker and a concurrent mock turn completes",
    ["PTY still bails in the guest", "pty reader blocks the instance", "session waits for the terminal"],
    { llm: "mock", ms: 50_000 },
  ),
  async (t) => {
    await withOpened(
      t,
      async (opened) => {
        const pty = await opened.client.call({
          type: "pty.open",
          payload: { workspaceId: opened.workspaceId, cols: 80, rows: 24 },
        });
        t.assertions.assert(pty?.type === "pty", `pty.open returned ${pty?.type}`);
        const ptyId = pty?.type === "pty" ? pty.data.ptyId : "";
        opened.mock.script({ text: "concurrent with pty" });
        const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
        const events = await t.flows.main.attachEventLog(opened.client, sessionId);
        const prompt = t.flows.main.sendPrompt(opened.client, sessionId, "Say concurrent.");
        await opened.client.call({ type: "pty.write", payload: { ptyId, data: "echo wasm-pty-marker\n" } });
        await prompt;
        await t.tools.waitUntil(
          () => events.some((event) => event.type === "turnCompleted" || event.type === "turnFailed"),
          45_000,
        );
        t.assertions.assert(
          events.some((event) => event.type === "turnCompleted"),
          "agent turn did not complete beside the PTY",
        );
        await opened.client.call({ type: "pty.close", payload: { ptyId } });
      },
      true,
    );
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.remote.does-not-fake-uplink",
    "Without Hub enrolment the guest does not claim a live remote uplink",
    "device.list remote.online is false and hub.status is unpaired",
    ["fabric stub reports online:true", "unenrolled daemon invents a rendezvous"],
  ),
  async (t) => {
    await withOpened(t, async (opened) => {
      const hub = await opened.client.call({ type: "hub.status" });
      t.assertions.assert(hub?.type === "hubStatus" && hub.data.state === "unpaired", `hub ${JSON.stringify(hub)}`);
      const devices = await opened.client.call({ type: "device.list" });
      t.assertions.assert(devices?.type === "devices", `device.list ${devices?.type}`);
      if (devices?.type !== "devices") throw new Error("device.list failed");
      t.assertions.assert(devices.data.remote.online !== true, `fabric claimed online: ${JSON.stringify(devices.data.remote)}`);
      t.assertions.assert(!devices.data.remote.relayUrl, `unenrolled relayUrl ${devices.data.remote.relayUrl}`);
    });
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.fs.symlink-write-stays-inside",
    "A symlink that points outside the workspace is not a write escape",
    "writing through the symlink either fails or does not change the outside target",
    ["guest follows the symlink", "workspace root is the host /"],
  ),
  async (t) => {
    const outside = path.join(t.env.root, "outside.txt");
    writeFileSync(outside, "untouched\n");
    const link = path.join(t.env.workspace, "escape");
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, link);
    } catch (error) {
      throw new BlockedError(`cannot create symlink: ${error}`);
    }
    await withOpened(t, async (opened) => {
      try {
        await opened.client.call({
          type: "file.write",
          payload: {
            workspaceId: opened.workspaceId,
            path: `${opened.rootHandle}/escape`,
            content: "escaped\n",
          },
        });
      } catch {
        // refusing the write is the safe answer
      }
      t.assertions.assert(readFileSync(outside, "utf8") === "untouched\n", "write escaped through the symlink");
    });
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.fs.outside-cwd-shell-refused",
    "A shell cwd outside the workspace is 403 rather than running in /",
    "cwd /tmp returns 403 and no frames",
    ["guest cwd is / so /tmp looks inside", "cwd silently rewritten"],
  ),
  async (t) => {
    await withOpened(t, async (opened) => {
      const result = await t.flows.main.runShell(opened.client, {
        workspaceId: opened.workspaceId,
        argv: ["/bin/pwd"],
        cwd: "/tmp",
      });
      t.assertions.assert(result.status === 403, `status ${result.status}`);
      t.assertions.assert(result.frames.length === 0, "outside cwd still ran");
    });
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.preview.large-payload-does-not-wedge-list",
    "A multi-megabyte preview does not freeze workspace.list",
    "workspace.list from a second client returns in under 2s while preview of an 8MiB file is in flight",
    ["preview hashes on the guest fiber without yielding", "spawn_blocking panic", "second client waits for the preview"],
    { memoryMb: 1024, ms: 30_000 },
  ),
  async (t) => {
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x61);
    writeFileSync(path.join(t.env.workspace, "blob.bin"), payload);
    await withOpened(t, async (opened) => {
      const preview = opened.client.preview(opened.workspaceId, `${opened.rootHandle}/blob.bin`);
      const other = await t.flows.main.openSecondClient(opened);
      const began = Date.now();
      const listed = await other.call({ type: "workspace.list" });
      const elapsed = Date.now() - began;
      other.close();
      const body = await preview;
      t.assertions.assert(listed?.type === "workspaces", `list ${listed?.type}`);
      t.assertions.assert(elapsed < 2_000, `workspace.list blocked ${elapsed}ms behind preview`);
      t.assertions.assert(body.bytes.byteLength === payload.length, `preview size ${body.bytes.byteLength}`);
    });
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.cli.agent-serve-runs-the-agent-entry",
    "genet agent-serve --mode rpc answers a JSONL command through the component's agent entry",
    "a get_commands line gets a success response with the same id, stdin close exits 0, and no --mode exits 2",
    [
      "agent-serve hits the client verb instead of the guest",
      "agent entry never wired into the component",
      "guest argv is swallowed by the shell",
    ],
    { ms: 30_000 },
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const genet = locateGenet(t.openRoot);
    const env = genetEnv(t.openRoot, t.env.env);
    const { spawnSync } = await import("node:child_process");
    const answered = spawnSync(genet, ["agent-serve", "--mode", "rpc"], {
      env,
      encoding: "utf8",
      input: '{"id":"1","type":"get_commands"}\n',
      timeout: 60_000,
    });
    t.assertions.assert(answered.status === 0, `agent-serve exited ${answered.status}: ${answered.stderr}`);
    const frames = answered.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const response = frames.find((frame) => frame.id === "1");
    t.assertions.assert(
      response?.type === "response" && response.command === "get_commands" && response.success === true,
      `no success response for get_commands: ${answered.stdout.slice(0, 400)}`,
    );
    const refused = runGenet(genet, ["agent-serve"], env);
    t.assertions.assert(refused.code === 2, `agent-serve without --mode exited ${refused.code}`);
    t.assertions.assert(
      refused.stderr.includes("--mode rpc"),
      `refusal did not explain --mode rpc: ${refused.stderr}`,
    );
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.lifecycle.compiled-guest-stays-in-memory",
    "The host compiles the guest in memory and never writes a .cwasm beside the data dir",
    "after start, <data>/wasm-cache does not exist or holds no .cwasm; a restart still serves /health",
    [
      "a compiled image is written next to user data",
      "a built-in agent deserializes a cache file",
      "a restart cannot come back without a disk cache",
    ],
    { ms: 40_000 },
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const genet = locateGenet(t.openRoot);
    const env = genetEnv(t.openRoot, t.env.env);
    const started = runGenet(genet, ["daemon", "start"], env);
    t.assertions.assert(started.code === 0, `cold start failed: ${started.stderr || started.stdout}`);
    runGenet(genet, ["daemon", "stop"], env);
    const cacheDir = path.join(t.env.data, "wasm-cache");
    const entries = existsSync(cacheDir) ? readdirSync(cacheDir) : [];
    t.assertions.assert(
      !entries.some((name) => name.endsWith(".cwasm")),
      `compiled guest leaked onto disk in ${cacheDir}: ${entries.join(",")}`,
    );
    const restarted = runGenet(genet, ["daemon", "start"], env);
    try {
      t.assertions.assert(restarted.code === 0, `restart failed: ${restarted.stderr || restarted.stdout}`);
      const status = parseJson(runGenet(genet, ["daemon", "status"], env).stdout);
      t.assertions.assert(status.running === true, `not running after restart: ${JSON.stringify(status)}`);
    } finally {
      runGenet(genet, ["daemon", "stop"], env);
    }
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.lifecycle.component-change-reloads-in-place",
    "Replacing the component on disk reloads the daemon inside the same host process",
    "touching the watched component file makes the daemon log 'reloading in place', start again, and keep the same pid",
    [
      "update requires a process restart",
      "watcher fires on the daemon's own reads",
      "reload comes back as a different pid",
      "daemon never comes back after a reload",
    ],
    { ms: 45_000 },
  ),
  async (t) => {
    const { component } = requireWasmArtifacts(t.openRoot);
    const genet = locateGenet(t.openRoot);
    // A private copy: the shared artifact must not be touched — sixteen other
    // environments run daemons off it right now. The lease runs the log filter
    // at warn; the reload lines are info, so this daemon opts into info.
    const copy = path.join(t.env.data, "genehub_guest.wasm");
    copyFileSync(component, copy);
    const env = genetEnv(t.openRoot, { ...t.env.env, GENEHUB_DEV_COMPONENT: copy, GENEHUB_DEV_LOG: "info" });
    const started = runGenet(genet, ["daemon", "start"], env);
    t.assertions.assert(started.code === 0, `start failed: ${started.stderr || started.stdout}`);
    const logFile = path.join(t.env.data, "logs", "daemon.log");
    try {
      const before = parseJson(runGenet(genet, ["daemon", "status"], env).stdout);
      t.assertions.assert(before.running === true, `not running: ${JSON.stringify(before)}`);
      const pid = String(before.pid);
      // A future mtime, not "now": coarse filesystem timestamps could otherwise
      // equal the stamp the watcher took at start.
      const future = new Date(Date.now() + 60_000);
      utimesSync(copy, future, future);
      const deadline = Date.now() + 40_000;
      let log = "";
      while (Date.now() < deadline) {
        log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
        const starts = log.split("\n").filter((line) => line.includes("daemon_started")).length;
        if (log.includes("reloading in place") && starts >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      t.assertions.assert(
        log.includes("reloading in place"),
        `the daemon never noticed the replaced component:\n${log.slice(-800)}`,
      );
      t.assertions.assert(
        log.split("\n").filter((line) => line.includes("daemon_started")).length >= 2,
        `the daemon did not come up again after the reload:\n${log.slice(-800)}`,
      );
      // The endpoint is republished at the end of the reload; status can race it.
      let after: Record<string, unknown> = {};
      const statusDeadline = Date.now() + 20_000;
      while (Date.now() < statusDeadline) {
        const probe = runGenet(genet, ["daemon", "status"], env);
        try {
          after = parseJson(probe.stdout);
          if (after.running === true) break;
        } catch {
          after = {};
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      t.assertions.assert(after.running === true, `not serving after reload: ${JSON.stringify(after)}`);
      t.assertions.assert(
        String(after.pid) === pid,
        `reload changed the pid (${pid} -> ${after.pid}); the point of reload is the same process`,
      );
    } finally {
      runGenet(genet, ["daemon", "stop"], env);
    }
  },
);

defineSpecialty(
  wasmMeta(
    "specialty.wasm.persistence.history-survives-host-restart",
    "Killing the host and starting it again restores the same session timeline",
    "after restart the session is listable and both turns' rows survive on disk, not just the last batch",
    [
      "endpoint.json pid is stale",
      "guest store is only in linear memory",
      "restart starts a native daemon",
      "wasip2 append regression: each save overwrites chat.jsonl from offset 0",
    ],
    { llm: "mock", ms: 60_000 },
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let sessionId = "";
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "first-reply-marker" });
      sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Remember this turn.");
      await t.tools.waitUntil(
        () => events.some((event) => event.type === "turnCompleted" || event.type === "turnFailed"),
        45_000,
      );
      opened.mock.script({ text: "second-reply-marker" });
      await t.flows.main.sendPrompt(opened.client, sessionId, "And this one.");
      await t.tools.waitUntil(
        () => events.filter((event) => event.type === "turnCompleted" || event.type === "turnFailed").length >= 2,
        45_000,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
    const again = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const cmd = procCmdline(Number(cliJson(t, ["daemon", "status"]).pid));
      t.assertions.assert(cmd.includes("genehub_guest.wasm"), `restarted as native: ${cmd}`);
      const listed = await again.client.call({ type: "session.list", payload: { workspaceId: again.workspaceId, includeArchived: false } });
      t.assertions.assert(listed?.type === "sessions", `session.list ${listed?.type}`);
      const ids = listed?.type === "sessions" ? listed.data.map((row: { id: string }) => row.id) : [];
      t.assertions.assert(ids.includes(sessionId), `session ${sessionId} missing after restart: ${ids.join(",")}`);
      const got = await again.client.call({ type: "session.get", payload: { sessionId } });
      t.assertions.assert(got?.type === "snapshot", `session.get ${got?.type}`);
      const timeline = JSON.stringify(got?.type === "snapshot" ? got.data : {});
      t.assertions.assert(
        timeline.includes("first-reply-marker") && timeline.includes("second-reply-marker"),
        `restart kept only the last written batch: ${timeline.slice(0, 400)}`,
      );
    } finally {
      again.client.close();
      again.daemon.stop();
      await again.mock.stop();
    }
  },
);
