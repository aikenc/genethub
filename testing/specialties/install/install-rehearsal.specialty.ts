// An install rehearsal: what a person gets when they run the shipped `scripts/install.sh`, with nothing stubbed.
//
// The tarball is packed the way `.github/workflows/release.yml` packs it (CLI, host, guest component and
// `python-runtime/`) from the real binaries of this tree, and served by a real HTTPS server on localhost. The
// real `curl` runs with the installer's own pinned flags and trusts that server through CURL_CA_BUNDLE (the
// system roots plus one self-signed certificate, because the installer must also reach GitHub for Python). The
// install runs with an empty environment, its own HOME and data directory, and a `systemctl` that fails so the
// machine's real user services are never touched. Then the installed daemon is started and looked at the way
// a new user would: are the Agents usable, did the administrator appear, does its timer run, and does a second
// install over the running daemon leave it running.
//
// Not covered: the systemd and launchd service paths (they need a real user manager), macOS, and the musl-static
// build (this packs the tree's own native build).

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import https from "node:https";
import path from "node:path";

import {
  BlockedError,
  defineSpecialty,
  locateGenet,
  tryLocateDaemonComponent,
  tryLocateHost,
} from "../../framework/public.ts";

const SYSTEM_ROOTS = ["/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/certs/ca-certificates.crt"];
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Async on purpose: the HTTPS server lives in this process, and a blocking spawn would starve it. */
function run(command: string, args: string[], env: Record<string, string>, cwd?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function lastJson(text: string): Record<string, any> {
  const line = text.split("\n").filter((entry) => entry.trim() !== "").at(-1);
  return line ? JSON.parse(line) : {};
}

function platformAsset(): string {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new BlockedError("the install rehearsal packs a Linux x64 tarball");
  }
  return "genet-local-linux-x64.tar.gz";
}

defineSpecialty(
  {
    id: "specialty.install.rehearsal",
    title: "the shipped installer installs a working GeneHub that a new user can use",
    oracle:
      "install.sh run in an empty environment against a real HTTPS download of a release-shaped tarball puts the three files in place and a runnable pinned Python under the data directory; the installed daemon starts; no Agent reports a missing Python runtime and the script Agents are materialized; the machine's administrator is built with its children and its timer runs successfully; installing again over the running daemon succeeds and leaves it running",
    catches: [
      "a dev or CI path that has a Python runtime the installed product does not",
      "a tarball that omits python-runtime/, so every script Agent is unavailable after install",
      "an installer that cannot be re-run over a running daemon",
      "the administrator failing to build on a machine that only has what the installer put there",
      "the installer's pinned curl flags failing against a real HTTPS server",
    ],
    tags: ["core", "install", "rehearsal"],
    llm: { default: "none" },
    expectedDurationMs: 90_000,
    timeoutMs: 420_000,
    surfaces: ["install", "daemon", "genet-cli", "spacebuilder"],
    productInterfaces: ["scripts/install.sh", "genet agent list", "genet hook list"],
  },
  async (t) => {
    const asset = platformAsset();
    const openRoot = t.openRoot;
    const cli = locateGenet(openRoot);
    const host = tryLocateHost(openRoot);
    const component = tryLocateDaemonComponent(openRoot);
    if (!host || !component) throw new BlockedError("the host binary or the guest component is not built");
    const roots = SYSTEM_ROOTS.find((file) => existsSync(file));
    if (!roots || spawnSync("openssl", ["version"]).status !== 0) {
      throw new BlockedError("a system CA bundle and openssl are needed to rehearse the HTTPS download");
    }

    const base = path.join(t.env.root, "rehearsal");
    const at = (name: string): string => path.join(base, name);
    const dirs = {
      stage: at("stage"),
      release: at("release"),
      home: at("home"),
      bin: at("bin"),
      data: at("data"),
      tools: at("tools"),
      workspace: at("workspace"),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

    // The release, packed as the workflow packs it.
    copyFileSync(cli, path.join(dirs.stage, "genet-local"));
    copyFileSync(host, path.join(dirs.stage, "genehub-host-local"));
    copyFileSync(component, path.join(dirs.stage, "genehub_guest.wasm"));
    const pack = (withPython: boolean): void => {
      const members = ["genet-local", "genehub-host-local", "genehub_guest.wasm"];
      if (withPython) {
        spawnSync("cp", ["-r", path.join(openRoot, "scripts", "python-runtime"), path.join(dirs.stage, "python-runtime")]);
        members.push("python-runtime");
      }
      const tar = spawnSync("tar", ["-czf", path.join(dirs.release, asset), "-C", dirs.stage, ...members], { encoding: "utf8" });
      t.assertions.assert(tar.status === 0, `tar: ${tar.stderr}`);
      const sums = spawnSync("sha256sum", [asset], { cwd: dirs.release, encoding: "utf8" });
      writeFileSync(path.join(dirs.release, "SHA256SUMS"), sums.stdout);
    };
    pack(true);

    // A real HTTPS server with a throwaway certificate.
    const key = path.join(base, "key.pem");
    const cert = path.join(base, "cert.pem");
    const made = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { encoding: "utf8" });
    t.assertions.assert(made.status === 0, `openssl: ${made.stderr}`);
    writeFileSync(path.join(base, "ca.pem"), readFileSync(roots, "utf8") + readFileSync(cert, "utf8"));
    const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
      const file = path.join(dirs.release, path.basename(request.url ?? ""));
      if (existsSync(file)) response.end(readFileSync(file));
      else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    // A user service manager this rehearsal must not touch.
    writeFileSync(path.join(dirs.tools, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const pythonCache = path.join(homedir(), ".cache", "genehub-install-rehearsal-python");
    const installEnv = {
      PATH: `${dirs.tools}:${SAFE_PATH}`,
      HOME: dirs.home,
      CURL_CA_BUNDLE: path.join(base, "ca.pem"),
      GENEHUB_LOCAL_DOWNLOAD_BASE: `https://localhost:${port}`,
      GENEHUB_LOCAL_BIN_DIR: dirs.bin,
      GENEHUB_LOCAL_DATA_DIR: dirs.data,
      GENEHUB_PYTHON_CACHE: pythonCache,
    };
    const daemonEnv = {
      PATH: SAFE_PATH,
      HOME: dirs.home,
      GENEHUB_LOCAL_DATA_DIR: dirs.data,
      GENEHUB_LOCAL_WORKSPACE_DIR: dirs.workspace,
    };
    const installed = path.join(dirs.bin, "genet-local");
    const genet = (...args: string[]) => run(installed, args, daemonEnv);
    const install = () => run("sh", [path.join(openRoot, "scripts", "install.sh")], installEnv);

    try {
      // 1. The install.
      const first = await install();
      if (first.code !== 0 && /could not download Python/.test(first.stderr)) {
        throw new BlockedError(`the pinned Python could not be downloaded here: ${first.stderr.slice(-200)}`);
      }
      t.assertions.assert(first.code === 0, `install.sh: exit ${first.code}\n${first.stdout.slice(-600)}\n${first.stderr.slice(-600)}`);
      for (const file of ["genet-local", "genehub-host-local", "genehub_guest.wasm"]) {
        t.assertions.assert(existsSync(path.join(dirs.bin, file)), `${file} was not installed`);
      }
      const pinFile = path.join(dirs.data, "agents", "runtime", "python.json");
      t.assertions.assert(existsSync(pinFile), "the install finished but left no platform Python (no agents/runtime/python.json): the tarball or the installer skipped it");
      const pin = JSON.parse(readFileSync(pinFile, "utf8")) as { python: string };
      const version = spawnSync(pin.python, ["-I", "-c", "import sys;print(sys.version.split()[0])"], { encoding: "utf8" });
      t.assertions.assert(version.status === 0 && /^3\.\d+\.\d+$/.test(version.stdout.trim()), `the installed Python does not run: ${version.stderr}`);

      // 2. The installed daemon and its Agents.
      const started = await genet("daemon", "start");
      t.assertions.assert(started.code === 0 && lastJson(started.stdout).running === true, `daemon start: ${started.stdout.slice(-300)} ${started.stderr.slice(-300)}`);
      type Agent = { id: string; message?: string; builtin?: boolean };
      let agents: Agent[] = [];
      await t.tools.waitUntil(async () => {
        const listed = await genet("agent", "list");
        agents = (lastJson(listed.stdout).data?.agents ?? []) as Agent[];
        return agents.length >= 4 && agents.every((agent) => !(agent.message ?? "").includes("正在启动"));
      }, 90_000);
      const python = agents.filter((agent) => /Python/.test(agent.message ?? ""));
      t.assertions.assert(python.length === 0, `Agents report a missing Python runtime after install: ${JSON.stringify(python.map((a) => [a.id, a.message]))}`);
      t.assertions.assert(
        existsSync(path.join(dirs.data, "agents", "builtin", "claude")) && existsSync(path.join(dirs.data, "builtin-skills", ".entrypoints")),
        "the script Agents or the built-in Skills were not materialized",
      );

      // 3. The administrator, built on a machine that only has what the installer put there.
      const listedSpaces = lastJson((await genet("workspace", "list")).stdout).data?.workspaces as Array<{ id: string; name: string; agentSpace?: { parentWorkspaceId?: string } }>;
      const admin = listedSpaces.find((space) => space.name.endsWith("管理员"));
      t.assertions.assert(admin, `no administrator in ${JSON.stringify(listedSpaces.map((s) => s.name))}`);
      for (const child of ["think", "work"]) {
        t.assertions.assert(listedSpaces.some((space) => space.name === child && space.agentSpace?.parentWorkspaceId === admin!.id), `${child} is not under the administrator`);
      }
      const adminDir = path.join(dirs.data, "spaces", "admin");
      t.assertions.assert(existsSync(path.join(adminDir, "front", "AGENTS.md")) && !existsSync(path.join(adminDir, "AGENTS.md")), "the administrator was not built into front/");
      let timer: { valid?: boolean; runs?: number; lastExitCode?: number; consecutiveFailures?: number; lastError?: string } | undefined;
      await t.tools.waitUntil(async () => {
        const hooks = lastJson((await genet("hook", "list", "--workspace", admin!.id)).stdout).data?.hooks as Array<{ id: string } & NonNullable<typeof timer>>;
        timer = hooks?.find((hook) => hook.id === "expert-front.timer");
        return (timer?.runs ?? 0) >= 1;
      }, 40_000);
      t.assertions.assert(
        timer?.valid === true && timer.lastExitCode === 0 && timer.consecutiveFailures === 0,
        `the administrator's timer does not run cleanly on the installed Python: ${JSON.stringify(timer)}`,
      );

      // 4. Installing again over the running daemon.
      const second = await install();
      t.assertions.assert(second.code === 0, `second install.sh: exit ${second.code}\n${second.stderr.slice(-600)}`);
      const status = await genet("daemon", "status");
      t.assertions.assert(lastJson(status.stdout).running === true, `the daemon is not running after a re-install: ${status.stdout.slice(-300)}`);
    } finally {
      await genet("daemon", "stop").catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(base, { recursive: true, force: true });
    }
  },
);
