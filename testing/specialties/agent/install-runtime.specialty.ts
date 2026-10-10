// Every script Agent runs on a pinned CPython the daemon installs itself: it
// runs the shipped `agents/runtime/install.sh` before every serve start, which
// downloads the pinned archive from `$GENEHUB_PYTHON_MIRRORS` and then its
// built-in URLs, checks its SHA-256, unpacks it and reports the interpreter
// (docs/agent-serve-protocol.md). Every other script Agent case is seeded with
// that build so it does not download (by default, when a daemon is started);
// these cases opt out.
//
// Each lease is fresh and unseeded. The URLs, archive name, mirror layout and
// hash are read from the shipped scripts (`pinnedScriptAgentRuntime`).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  BlockedError,
  defineSpecialty,
  hideHostAgentClis,
  keepScriptAgentRuntimeUnseeded,
  pinnedScriptAgentRuntime,
  processesMatching,
  runtimeInstallerLines,
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
    "the installer stops reading GENEHUB_PYTHON_MIRRORS or fetching with curl/wget, or pinnedScriptAgentRuntime can no longer read the URL list from install-common.sh",
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

async function installerLines(t: CaseContext, opened: Opened): Promise<string[]> {
  const lines: string[] = [];
  for (const id of BUILTIN_SCRIPT_AGENTS) lines.push(...runtimeInstallerLines(await t.flows.branches.agentLogs(opened.client, id, 500)));
  return lines;
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

/** Points the daemon's installer at `mirrors` and sends its https traffic
 * to `proxy`, which refuses it. Loopback stays direct for the mirror and the
 * daemon's own local endpoints. */
function routeInstaller(t: CaseContext, mirrors: string[], proxy: string): void {
  Object.assign(t.env.env, {
    GENEHUB_PYTHON_MIRRORS: mirrors.join(" "),
    https_proxy: proxy,
    HTTPS_PROXY: proxy,
    all_proxy: proxy,
    ALL_PROXY: proxy,
    http_proxy: "",
    HTTP_PROXY: "",
    no_proxy: "127.0.0.1,localhost",
    NO_PROXY: "127.0.0.1,localhost",
  });
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
    title: "A fresh install downloads the pinned Python on first use, runs every script Agent on it, and does not download again",
    oracle:
      "on a fresh data dir nothing is installed after daemon start until the first agent.list; that list makes the shipped installer download from one of its built-in URLs (progress in agent.logs), built-in codex and cursor settle with source builtin, <data>/agents/runtime holds only python-<version>-<release> whose bin/python3 reports the pinned version in -I mode, and every serve process was started as that bin/python3 and executes a binary inside that tree; after a daemon restart on the same data dir the tree is the same inode, no install progress is logged and the serve processes run on it again",
    catches: [
      "the default download URLs or checksum pin are broken for this platform",
      "the runtime is installed eagerly at daemon start instead of on first use",
      "a script Agent is started on the system Python instead of the pinned build",
      "the installer downloads again although the pinned build is installed",
      "a restart loses or replaces the installed runtime",
    ],
    tags: ["network"],
    expectedDurationMs: 45_000,
    timeoutMs: 600_000,
  },
  async (t, pinned) => {
    await requireReachableUpstream(pinned);
    // What is tested is the built-in URL list, whatever this host configures.
    t.env.env.GENEHUB_PYTHON_MIRRORS = "";
    const tree = path.join(runtimeRoot(t), pinned.dirName);
    let identity = "";
    await withDaemon(t, async (opened) => {
      // Long enough for an eager start at boot to have begun.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      t.assertions.assert(installEntries(t).length === 0, `installed before any Agent was asked for: ${installEntries(t).join(",")}`);
      t.assertions.assert(serveProcesses(t).length === 0, "a script Agent was started before any Agent was asked for");

      const agents = await waitBuiltinsSettled(t, opened, 300_000);
      const lines = await installerLines(t, opened);
      const used = pinned.upstream.filter((url) => lines.some((line) => line.includes(url)));
      t.assertions.assert(used.length > 0, `no download from a built-in URL was reported: ${lines.join(" | ")}`);
      t.assertions.assert(installEntries(t).join(",") === pinned.dirName, `runtime directory holds ${installEntries(t).join(",")}`);
      t.assertions.assert(reportedVersion(path.join(tree, "bin", "python3")) === pinned.version,
        `installed python3 reports ${reportedVersion(path.join(tree, "bin", "python3"))}`);
      assertServesOnInstalled(t, tree, BUILTIN_SCRIPT_AGENTS.length);
      identity = scriptAgentRuntimeIdentity(tree);
      t.note(`first start: downloaded via ${used.map((url) => new URL(url).host).join(",")}; ${agents.map((agent) => `${agent.id}:${agent.probe.state}/${primary(agent) ?? "-"}`).join(" ")}`);
    });
    await t.tools.waitUntil(() => serveProcesses(t).length === 0, 15_000)
      .catch(() => { throw new Error("serve processes outlived the stopped daemon"); });

    await withDaemon(t, async (opened) => {
      await waitBuiltinsSettled(t, opened, 60_000);
      const lines = await installerLines(t, opened);
      t.assertions.assert(lines.length === 0, `the restarted daemon installed again: ${lines.join(" | ")}`);
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
      "with GENEHUB_PYTHON_MIRRORS = a mirror serving a well-formed counterfeit archive (whose python3 would pass the installer's usable check) followed by a mirror serving the genuine archive, and the built-in hosts refused, the counterfeit is requested first, the genuine mirror next, no built-in host is contacted, the installed tree holds none of the counterfeit's files and its python3 reports the pinned version, the counterfeit python3 never ran, nothing is left staged, and the serve processes run on the installed interpreter",
    catches: [
      "an archive is unpacked without its SHA-256 matching",
      "a configured mirror that fails is not followed by the next one",
      "GENEHUB_PYTHON_MIRRORS is ignored or tried after the built-in URLs",
      "a rejected download leaves staged files behind",
    ],
    tags: ["network"],
    expectedDurationMs: 40_000,
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
      routeInstaller(t, [`${mirror.origin}/counterfeit`, `${mirror.origin}/genuine/`], mirror.origin);
      const tree = path.join(runtimeRoot(t), pinned.dirName);
      await withDaemon(t, async (opened) => {
        await waitBuiltinsSettled(t, opened, 120_000);
        const order = mirror.requests.map((item) => `${item.method} ${item.target.split("/")[1]}`);
        t.assertions.assert(order[0] === "GET counterfeit", `first request ${order[0]}; all: ${order.join(", ")}`);
        t.assertions.assert(mirror.gets("/counterfeit/") === 1 && mirror.gets("/genuine/") === 1,
          `mirror requests: ${order.join(", ")}`);
        t.assertions.assert(!mirror.requests.some((item) => item.method === "CONNECT"), `a built-in host was contacted: ${order.join(", ")}`);
        t.assertions.assert(installEntries(t).join(",") === pinned.dirName, `runtime directory holds ${installEntries(t).join(",")}`);
        t.assertions.assert(!existsSync(path.join(tree, "COUNTERFEIT")), "the counterfeit archive was unpacked");
        t.assertions.assert(!existsSync(counterfeit.ran), "the counterfeit python3 ran");
        t.assertions.assert(reportedVersion(path.join(tree, "bin", "python3")) === pinned.version, "the installed python3 is not the pinned build");
        assertServesOnInstalled(t, tree, BUILTIN_SCRIPT_AGENTS.length);
        const lines = await installerLines(t, opened);
        const counterfeitLine = lines.findIndex((line) => line.includes(`${mirror.origin}/counterfeit/`));
        const genuineLine = lines.findIndex((line) => line.includes(`${mirror.origin}/genuine/`));
        t.assertions.assert(counterfeitLine >= 0 && genuineLine > counterfeitLine, `install progress: ${lines.join(" | ")}`);
        t.note(`mirror requests: ${order.join(", ")}`);
      });
    } finally {
      await mirror.close();
    }
  },
);

installCase(
  "runtime-all-mirrors-bad",
  {
    title: "When no mirror yields the pinned archive, script Agents report a runtime failure without a restart storm",
    oracle:
      "with GENEHUB_PYTHON_MIRRORS = a counterfeit-archive mirror and a 404 mirror and every built-in host refused, built-in codex and cursor end unavailable with a message naming Python and the pinned version, every built-in host was attempted, nothing is installed or staged and the counterfeit never ran; over the following 20s agent.list keeps answering within 3s (native genet still listed) and the installer is retried with backoff (at most 12 counterfeit fetches), not in a loop",
    catches: [
      "a failed runtime install crashes or wedges the daemon",
      "agent.list blocks on a failing install",
      "a runtime failure is shown without a reason",
      "a failing install is retried in a tight loop against the network",
      "a counterfeit archive is installed once every genuine source failed",
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
      routeInstaller(t, [`${mirror.origin}/counterfeit`, `${mirror.origin}/missing`], mirror.origin);
      await withDaemon(t, async (opened) => {
        const failedAgents: AgentInfo[] = [];
        for (const id of BUILTIN_SCRIPT_AGENTS) {
          failedAgents.push(await t.flows.branches.waitForAgent(opened.client, id,
            (agent) => agent.probe.state === "unavailable" && (agent.message ?? "").includes(`Python ${pinned.version}`),
            { timeoutMs: 60_000, what: "reporting the runtime failure" }));
        }
        for (const agent of failedAgents) {
          t.assertions.assert(agent.source === "builtin" && /python/i.test(agent.message ?? ""), `${agent.id}: ${agent.message}`);
        }
        const hosts = [...new Set(pinned.upstream.map((url) => `${new URL(url).hostname}:443`))];
        const connected = new Set(mirror.requests.filter((item) => item.method === "CONNECT").map((item) => item.target));
        t.assertions.assert(hosts.every((host) => connected.has(host)), `built-in hosts attempted: ${[...connected].join(",")}`);
        t.assertions.assert(mirror.gets("/missing/") >= 1, "the second configured mirror was never tried");

        const latencies: number[] = [];
        const until = Date.now() + 20_000;
        while (Date.now() < until) {
          const started = Date.now();
          const listed = await t.flows.branches.listAgents(opened.client);
          latencies.push(Date.now() - started);
          t.assertions.assert(listed.some((agent) => agent.id === "genet"), "the native Agent vanished while the runtime failed");
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const slowest = Math.max(...latencies);
        const fetches = mirror.gets("/counterfeit/");
        t.assertions.assert(slowest < 3_000, `agent.list took ${slowest}ms while the runtime failed`);
        t.assertions.assert(fetches <= 12, `${fetches} counterfeit fetches in ~25s: the install is retried in a loop`);
        t.assertions.assert(installEntries(t).length === 0, `runtime directory holds ${installEntries(t).join(",")}`);
        t.assertions.assert(!existsSync(counterfeit.ran), "the counterfeit python3 ran");
        t.assertions.assert(serveProcesses(t).length === 0, "a serve process started without a runtime");
        t.note(`counterfeit fetches ${fetches}; slowest agent.list ${slowest}ms; ${failedAgents[0]!.id}: ${failedAgents[0]!.message}`);
      });
    } finally {
      await mirror.close();
    }
  },
);
