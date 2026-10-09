// Every script Agent runs on the platform Python: a pinned CPython that the
// installers (and the dev tooling) put on the machine by running the shipped
// `scripts/python-runtime/install-python.sh`. The script downloads the pinned
// archive from `$GENEHUB_PYTHON_MIRRORS` and then its built-in URLs, checks its
// SHA-256, unpacks it, marks it as not a place to install packages into, and
// records the interpreter in `<data>/agents/runtime/python.json`. The daemon
// never installs anything: it reads that record (docs/agent-serve-protocol.md).
// Every other script Agent case is seeded with that build so it does not
// download (by default, when a daemon is started); these cases opt out.
//
// Each lease is fresh and unseeded. The URLs, archive name, mirror layout and
// hash are read from the shipped pin and script (`pinnedScriptAgentRuntime`).

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import {
  BlockedError,
  defineSpecialty,
  hideHostAgentClis,
  keepScriptAgentRuntimeUnseeded,
  pinnedScriptAgentRuntime,
  processesMatching,
  scriptAgentRuntimeIdentity,
  type CaseContext,
  type PinnedScriptAgentRuntime,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type AgentInfo = Awaited<ReturnType<CaseContext["flows"]["branches"]["listAgents"]>>[number];

const BUILTIN_SCRIPT_AGENTS = ["codex", "cursor"];

const mirrorDouble = {
  component: "python-mirror",
  reason:
    "a mirror that serves a counterfeit archive and public mirrors that cannot be reached cannot be arranged on the real hosts; the case serves GENEHUB_PYTHON_MIRRORS from a local static HTTP server and refuses CONNECT to the built-in hosts through the standard proxy variables curl honours",
  canary: "specialty.agent.install.runtime-from-default-mirror",
  expiresWhen:
    "the installer stops reading GENEHUB_PYTHON_MIRRORS or fetching with curl/wget, or pinnedScriptAgentRuntime can no longer read the URL list from install-python.sh",
};

function installCase(
  id: string,
  meta: { title: string; oracle: string; catches: string[]; tags: string[]; expectedDurationMs: number; timeoutMs: number; double?: boolean },
  run: (t: CaseContext, pinned: PinnedScriptAgentRuntime) => Promise<void>,
): void {
  defineSpecialty(
    {
      id: `specialty.agent.install.${id}`,
      title: meta.title,
      oracle: meta.oracle,
      catches: meta.catches,
      tags: ["agent", "script-agent", "script-agent-install", ...meta.tags],
      llm: { default: "none" },
      expectedDurationMs: meta.expectedDurationMs,
      timeoutMs: meta.timeoutMs,
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 2, browser: 0, pool: "standard" },
      surfaces: ["daemon", "agent-adapter", "script-agent", "python-runtime", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agent-serve-protocol-1"],
      doubleExceptions: meta.double ? [mirrorDouble] : undefined,
    },
    async (t) => {
      // The serve process's executable is read from /proc.
      if (process.platform !== "linux") throw new BlockedError("these cases read serve process executables from /proc");
      hideHostAgentClis(t.env);
      keepScriptAgentRuntimeUnseeded(t.env);
      await run(t, pinnedScriptAgentRuntime(t.openRoot));
    },
  );
}

async function withDaemon(t: CaseContext, run: (opened: Opened) => Promise<void>): Promise<void> {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await run(opened);
  } catch (error) {
    for (const id of BUILTIN_SCRIPT_AGENTS) {
      const logs = await t.flows.branches.agentLogs(opened.client, id, 15).catch((e: unknown) => [`agent.logs failed: ${String(e)}`]);
      t.note(`${id} logs: ${logs.join(" | ")}`);
    }
    throw error;
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

const runtimeRoot = (t: CaseContext) => path.join(t.env.data, "agents", "runtime");
/** Install trees and staging directories the installer leaves under its root. */
const installEntries = (t: CaseContext) =>
  existsSync(runtimeRoot(t)) ? readdirSync(runtimeRoot(t)).filter((name) => name.startsWith("python-") || name.startsWith(".staging")) : [];
const primary = (agent: AgentInfo) => agent.actions?.find((action) => action.primary)?.id;
/** Past start-up: a serve process answered and said what it needs, or is ready. */
const settled = (agent: AgentInfo) => agent.source === "builtin" && (agent.probe.state === "ready" || primary(agent) !== undefined);

async function waitBuiltinsSettled(t: CaseContext, opened: Opened, timeoutMs: number): Promise<AgentInfo[]> {
  const settledAgents: AgentInfo[] = [];
  for (const id of BUILTIN_SCRIPT_AGENTS) {
    settledAgents.push(await t.flows.branches.waitForAgent(opened.client, id, settled, { timeoutMs, what: "settled on its runtime" }));
  }
  return settledAgents;
}

interface InstallerRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the shipped install script against this lease's runtime directory.
 * Asynchronous: the mirror double lives in this process. */
async function runInstaller(t: CaseContext, env: Record<string, string>): Promise<InstallerRun> {
  const script = path.join(t.openRoot, "scripts", "python-runtime", "install-python.sh");
  try {
    const { stdout, stderr } = await promisify(execFile)("sh", [script, runtimeRoot(t)], {
      env: { ...process.env, ...env },
      timeout: 600_000,
      maxBuffer: 1 << 20,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string };
    return { status: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** What the installer recorded for the daemon, if anything. */
function recordedPython(t: CaseContext): string | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(runtimeRoot(t), "python.json"), "utf8")) as { python?: string }).python;
  } catch {
    return undefined;
  }
}

/** The installed tree refuses a global `pip install` with the platform's own
 * text, while a virtual environment made from it installs normally. */
function assertPackagesStayOutOfThePlatformPython(t: CaseContext, python: string): void {
  const global = spawnSync(python, ["-m", "pip", "install", "--no-input", "nothing-xyz-genehub"], { encoding: "utf8", timeout: 60_000 });
  t.assertions.assert(global.status !== 0 && /externally-managed-environment/.test(global.stderr), `a global pip install was not refused: ${global.stderr.slice(-300)}`);
  t.assertions.assert(/GENEHUB_PYTHON/.test(global.stderr) && /venv/.test(global.stderr), `the refusal does not say what to do: ${global.stderr.slice(-300)}`);
  const venv = path.join(t.env.root, "venv-from-platform-python");
  const made = spawnSync(python, ["-m", "venv", venv], { encoding: "utf8", timeout: 120_000 });
  t.assertions.assert(made.status === 0, `venv could not be created: ${made.stderr.slice(-300)}`);
  const inside = spawnSync(path.join(venv, "bin", "pip"), ["install", "--no-input", "--no-index", "nothing-xyz-genehub"], { encoding: "utf8", timeout: 60_000 });
  t.assertions.assert(!/externally-managed/.test(inside.stderr), "the venv inherited the platform Python's refusal");
}

/** The script Agent serve processes of this lease, with argv and the binary
 * the kernel actually runs. */
function serveProcesses(t: CaseContext): Array<{ pid: number; argv: string[]; exe: string }> {
  const boot = path.join(t.env.data, "agents", "sdk", "boot.py");
  return processesMatching(boot).flatMap(({ pid }) => {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      return argv.includes(boot) && argv.at(-1) === "serve" ? [{ pid, argv, exe: readlinkSync(`/proc/${pid}/exe`) }] : [];
    } catch {
      return [];
    }
  });
}

function reportedVersion(python: string): string {
  const probe = spawnSync(python, ["-I", "-c", "import sys; print(sys.version.split()[0])"], { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0 ? probe.stdout.trim() : `exit ${probe.status}`;
}

/** Every serve process runs the installed pinned interpreter, by the path the
 * installer reported and by the binary the kernel executes. */
function assertServesOnInstalled(t: CaseContext, tree: string, expected: number): void {
  const serving = serveProcesses(t);
  t.assertions.assert(serving.length >= expected, `expected ${expected} serve processes, found ${serving.length}`);
  const real = realpathSync(tree) + path.sep;
  for (const proc of serving) {
    t.assertions.assert(proc.argv[0] === path.join(tree, "bin", "python3"), `serve ${proc.pid} was started as ${proc.argv[0]}`);
    t.assertions.assert(proc.exe.startsWith(real) && path.basename(proc.exe).startsWith("python3"),
      `serve ${proc.pid} runs ${proc.exe}, not the installed interpreter`);
  }
}

interface MirrorRequest {
  method: string;
  target: string;
}

/** A static mirror (GET by path) that also refuses every CONNECT, so as
 * `https_proxy` it makes the installer's built-in https URLs unreachable. */
async function startMirror(routes: Record<string, Buffer>) {
  const requests: MirrorRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", target: req.url ?? "" });
    const body = routes[req.url ?? ""];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
  });
  server.on("connect", (req, socket) => {
    requests.push({ method: "CONNECT", target: req.url ?? "" });
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    gets: (prefix: string) => requests.filter((item) => item.method === "GET" && item.target.startsWith(prefix)).length,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Points the installer at `mirrors` and sends its https traffic to `proxy`,
 * which refuses it. Loopback stays direct for the mirror. */
function routedInstallerEnv(mirrors: string[], proxy: string): Record<string, string> {
  return {
    GENEHUB_PYTHON_MIRRORS: mirrors.join(" "),
    https_proxy: proxy,
    HTTPS_PROXY: proxy,
    all_proxy: proxy,
    ALL_PROXY: proxy,
    http_proxy: "",
    HTTP_PROXY: "",
    no_proxy: "127.0.0.1,localhost",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

/** A well-formed archive of the expected layout whose `python3` passes the
 * installer's `usable` check. Only the hash can stop it; if it is ever run,
 * it leaves `ran`. */
function counterfeitArchive(t: CaseContext): { archive: Buffer; ran: string } {
  const root = path.join(t.env.root, "counterfeit");
  const ran = path.join(t.env.root, "counterfeit-ran");
  mkdirSync(path.join(root, "python", "bin"), { recursive: true });
  writeFileSync(path.join(root, "python", "bin", "python3"), `#!/bin/sh\necho "$0" >> '${ran}'\nexit 0\n`, { mode: 0o755 });
  writeFileSync(path.join(root, "python", "COUNTERFEIT"), "");
  const archive = path.join(t.env.root, "counterfeit.tar.gz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", root, "python"], { encoding: "utf8" });
  if (tar.status !== 0) throw new BlockedError(`tar could not build the counterfeit archive: ${tar.stderr}`);
  return { archive: readFileSync(archive), ran };
}

/** The genuine archive, fetched from the installer's own built-in URLs. */
async function genuineArchive(pinned: PinnedScriptAgentRuntime): Promise<Buffer> {
  const failures: string[] = [];
  for (const url of pinned.upstream) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        failures.push(`${new URL(url).host}: HTTP ${response.status}`);
        continue;
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(body).digest("hex") === pinned.sha256) return body;
      failures.push(`${new URL(url).host}: SHA-256 mismatch`);
    } catch (error) {
      failures.push(`${new URL(url).host}: ${(error as Error).message}`);
    }
  }
  throw new BlockedError(`the pinned Python archive could not be fetched from the installer's URLs (${failures.join("; ")})`);
}

/** Network is a declared dependency: no reachable built-in URL is blocked. */
async function requireReachableUpstream(pinned: PinnedScriptAgentRuntime): Promise<void> {
  const failures: string[] = [];
  for (const url of pinned.upstream) {
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (response.ok) return;
      failures.push(`${new URL(url).host}: HTTP ${response.status}`);
    } catch (error) {
      failures.push(`${new URL(url).host}: ${(error as Error).message}`);
    }
  }
  throw new BlockedError(`no built-in Python mirror is reachable from this host (${failures.join("; ")})`);
}

installCase(
  "runtime-from-default-mirror",
  {
    title: "The install script downloads the pinned Python from its built-in URLs, protects it from global installs, and every script Agent runs on it",
    oracle:
      "on a fresh data dir the daemon has installed nothing; running install-python.sh with no configured mirror downloads from one of its built-in URLs, leaves only python-<version>-<release> and python.json whose interpreter reports the pinned version in -I mode, a global pip install on it is refused with the platform's own text while a venv made from it is not, a second run downloads nothing and keeps the same inode; a daemon started on that data dir settles built-in codex and cursor with source builtin and every serve process was started as that bin/python3 and executes a binary inside that tree, and after a daemon restart the tree is unchanged and the serve processes run on it again",
    catches: [
      "the default download URLs or checksum pin are broken for this platform",
      "the daemon installs the runtime itself instead of reading python.json",
      "a script Agent is started on the system Python instead of the pinned build",
      "the platform Python accepts a global package install",
      "the installer downloads again although the pinned build is installed",
      "a restart loses or replaces the installed runtime",
    ],
    tags: ["network"],
    expectedDurationMs: 60_000,
    timeoutMs: 600_000,
  },
  async (t, pinned) => {
    await requireReachableUpstream(pinned);
    const tree = path.join(runtimeRoot(t), pinned.dirName);
    const python = path.join(tree, "bin", "python3");

    // Nothing installs it but the installer.
    let identity = "";
    await withDaemon(t, async (opened) => {
      await t.flows.branches.listAgents(opened.client);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      t.assertions.assert(installEntries(t).length === 0, `the daemon installed a runtime: ${installEntries(t).join(",")}`);
      t.assertions.assert(serveProcesses(t).length === 0, "a script Agent started without a runtime");
    });
    await t.tools.waitUntil(() => serveProcesses(t).length === 0, 15_000)
      .catch(() => { throw new Error("serve processes outlived the stopped daemon"); });

    // What is tested is the built-in URL list, whatever this host configures.
    const first = await runInstaller(t, { GENEHUB_PYTHON_MIRRORS: "" });
    t.assertions.assert(first.status === 0, `the installer failed (${first.status}): ${first.stderr.slice(-500)}`);
    const used = pinned.upstream.filter((url) => first.stdout.includes(url));
    t.assertions.assert(used.length > 0, `no download from a built-in URL was reported: ${first.stdout}`);
    t.assertions.assert(installEntries(t).join(",") === pinned.dirName, `runtime directory holds ${installEntries(t).join(",")}`);
    t.assertions.assert(recordedPython(t) === python, `python.json records ${recordedPython(t)}`);
    t.assertions.assert(reportedVersion(python) === pinned.version, `installed python3 reports ${reportedVersion(python)}`);
    assertPackagesStayOutOfThePlatformPython(t, python);
    identity = scriptAgentRuntimeIdentity(tree);

    const second = await runInstaller(t, { GENEHUB_PYTHON_MIRRORS: "" });
    t.assertions.assert(second.status === 0, `the second run failed: ${second.stderr.slice(-500)}`);
    t.assertions.assert(!second.stdout.includes("downloading"), `the second run downloaded again: ${second.stdout}`);
    t.assertions.assert(scriptAgentRuntimeIdentity(tree) === identity, "the second run replaced the installed runtime");

    await withDaemon(t, async (opened) => {
      const agents = await waitBuiltinsSettled(t, opened, 120_000);
      assertServesOnInstalled(t, tree, BUILTIN_SCRIPT_AGENTS.length);
      t.note(`downloaded via ${used.map((url) => new URL(url).host).join(",")}; ${agents.map((agent) => `${agent.id}:${agent.probe.state}/${primary(agent) ?? "-"}`).join(" ")}`);
    });
    await t.tools.waitUntil(() => serveProcesses(t).length === 0, 15_000)
      .catch(() => { throw new Error("serve processes outlived the stopped daemon"); });

    await withDaemon(t, async (opened) => {
      await waitBuiltinsSettled(t, opened, 60_000);
      t.assertions.assert(scriptAgentRuntimeIdentity(tree) === identity, "the restart replaced the installed runtime");
      t.assertions.assert(installEntries(t).join(",") === pinned.dirName, `runtime directory holds ${installEntries(t).join(",")}`);
      assertServesOnInstalled(t, tree, BUILTIN_SCRIPT_AGENTS.length);
    });
  },
);

installCase(
  "runtime-mirror-fallback-and-checksum",
  {
    title: "A mirror serving a counterfeit archive is rejected by its hash and the next mirror installs the runtime",
    oracle:
      "with GENEHUB_PYTHON_MIRRORS = a mirror serving a well-formed counterfeit archive (whose python3 would pass the installer's usable check) followed by a mirror serving the genuine archive, and the built-in hosts refused, install-python.sh succeeds, the counterfeit is requested first, the genuine mirror next, no built-in host is contacted, the installed tree holds none of the counterfeit's files and its python3 reports the pinned version, the counterfeit python3 never ran, nothing is left staged, python.json records the installed interpreter, and a daemon started on it runs the serve processes on that interpreter",
    catches: [
      "an archive is unpacked without its SHA-256 matching",
      "a configured mirror that fails is not followed by the next one",
      "GENEHUB_PYTHON_MIRRORS is ignored or tried after the built-in URLs",
      "a rejected download leaves staged files behind",
    ],
    tags: ["network"],
    expectedDurationMs: 50_000,
    timeoutMs: 300_000,
    double: true,
  },
  async (t, pinned) => {
    const genuine = await genuineArchive(pinned);
    const counterfeit = counterfeitArchive(t);
    const mirror = await startMirror({
      [`/counterfeit/${pinned.mirrorPath}`]: counterfeit.archive,
      [`/genuine/${pinned.mirrorPath}`]: genuine,
    });
    try {
      const tree = path.join(runtimeRoot(t), pinned.dirName);
      const run = await runInstaller(t, routedInstallerEnv([`${mirror.origin}/counterfeit`, `${mirror.origin}/genuine/`], mirror.origin));
      t.assertions.assert(run.status === 0, `the installer failed (${run.status}): ${run.stderr.slice(-500)}`);
      const order = mirror.requests.map((item) => `${item.method} ${item.target.split("/")[1]}`);
      t.assertions.assert(order[0] === "GET counterfeit", `first request ${order[0]}; all: ${order.join(", ")}`);
      t.assertions.assert(mirror.gets("/counterfeit/") === 1 && mirror.gets("/genuine/") === 1, `mirror requests: ${order.join(", ")}`);
      t.assertions.assert(!mirror.requests.some((item) => item.method === "CONNECT"), `a built-in host was contacted: ${order.join(", ")}`);
      t.assertions.assert(installEntries(t).join(",") === pinned.dirName, `runtime directory holds ${installEntries(t).join(",")}`);
      t.assertions.assert(!existsSync(path.join(tree, "COUNTERFEIT")), "the counterfeit archive was unpacked");
      t.assertions.assert(!existsSync(counterfeit.ran), "the counterfeit python3 ran");
      t.assertions.assert(reportedVersion(path.join(tree, "bin", "python3")) === pinned.version, "the installed python3 is not the pinned build");
      t.assertions.assert(recordedPython(t) === path.join(tree, "bin", "python3"), `python.json records ${recordedPython(t)}`);
      const counterfeitLine = run.stdout.indexOf(`${mirror.origin}/counterfeit/`);
      const genuineLine = run.stdout.indexOf(`${mirror.origin}/genuine/`);
      t.assertions.assert(counterfeitLine >= 0 && genuineLine > counterfeitLine, `install progress: ${run.stdout}`);
      await withDaemon(t, async (opened) => {
        await waitBuiltinsSettled(t, opened, 120_000);
        assertServesOnInstalled(t, tree, BUILTIN_SCRIPT_AGENTS.length);
      });
      t.note(`mirror requests: ${order.join(", ")}`);
    } finally {
      await mirror.close();
    }
  },
);

installCase(
  "runtime-all-mirrors-bad",
  {
    title: "When no mirror yields the pinned archive the installer fails clearly, and script Agents say the runtime is not installed",
    oracle:
      "with GENEHUB_PYTHON_MIRRORS = a counterfeit-archive mirror and a 404 mirror and every built-in host refused, install-python.sh exits non-zero naming Python and the pinned version, every built-in host was attempted, the second configured mirror was tried, nothing is installed or staged, python.json does not exist and the counterfeit never ran; a daemon started on that data dir lists built-in codex and cursor unavailable with a message saying the Python runtime is not installed, agent.list keeps answering within 3s with native genet still listed, no installer runs and no serve process starts",
    catches: [
      "a failed runtime install leaves a half-installed tree or a stale python.json",
      "a failure is shown without a reason",
      "a counterfeit archive is installed once every genuine source failed",
      "a missing runtime crashes or wedges the daemon",
      "agent.list blocks on a missing runtime",
    ],
    tags: ["core"],
    expectedDurationMs: 40_000,
    timeoutMs: 180_000,
    double: true,
  },
  async (t, pinned) => {
    const counterfeit = counterfeitArchive(t);
    const mirror = await startMirror({ [`/counterfeit/${pinned.mirrorPath}`]: counterfeit.archive });
    try {
      const run = await runInstaller(t, routedInstallerEnv([`${mirror.origin}/counterfeit`, `${mirror.origin}/missing`], mirror.origin));
      t.assertions.assert(run.status !== 0, "the installer succeeded although no mirror had the genuine archive");
      t.assertions.assert(run.stderr.includes(`Python ${pinned.version}`), `the failure does not name the pinned Python: ${run.stderr}`);
      const hosts = [...new Set(pinned.upstream.map((url) => `${new URL(url).hostname}:443`))];
      const connected = new Set(mirror.requests.filter((item) => item.method === "CONNECT").map((item) => item.target));
      t.assertions.assert(hosts.every((host) => connected.has(host)), `built-in hosts attempted: ${[...connected].join(",")}`);
      t.assertions.assert(mirror.gets("/missing/") >= 1, "the second configured mirror was never tried");
      t.assertions.assert(installEntries(t).length === 0, `runtime directory holds ${installEntries(t).join(",")}`);
      t.assertions.assert(recordedPython(t) === undefined, "python.json exists although nothing was installed");
      t.assertions.assert(!existsSync(counterfeit.ran), "the counterfeit python3 ran");

      await withDaemon(t, async (opened) => {
        const failedAgents: AgentInfo[] = [];
        for (const id of BUILTIN_SCRIPT_AGENTS) {
          failedAgents.push(await t.flows.branches.waitForAgent(opened.client, id,
            (agent) => agent.probe.state === "unavailable" && (agent.message ?? "").includes("Python 运行时未安装"),
            { timeoutMs: 60_000, what: "reporting the missing runtime" }));
        }
        for (const agent of failedAgents) t.assertions.assert(agent.source === "builtin", `${agent.id}: ${agent.message}`);
        const latencies: number[] = [];
        const until = Date.now() + 5_000;
        while (Date.now() < until) {
          const started = Date.now();
          const listed = await t.flows.branches.listAgents(opened.client);
          latencies.push(Date.now() - started);
          t.assertions.assert(listed.some((agent) => agent.id === "genet"), "the native Agent vanished while the runtime was missing");
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const slowest = Math.max(...latencies);
        t.assertions.assert(slowest < 3_000, `agent.list took ${slowest}ms while the runtime was missing`);
        t.assertions.assert(installEntries(t).length === 0, `the daemon installed something: ${installEntries(t).join(",")}`);
        t.assertions.assert(mirror.gets("/counterfeit/") === 1, `the daemon fetched an archive: ${mirror.gets("/counterfeit/")} counterfeit requests in total`);
        t.assertions.assert(serveProcesses(t).length === 0, "a serve process started without a runtime");
        t.note(`slowest agent.list ${slowest}ms; ${failedAgents[0]!.id}: ${failedAgents[0]!.message}`);
      });
    } finally {
      await mirror.close();
    }
  },
);
