import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServicePreviewClient } from "@genehub/workbench/client";
import { BlockedError, defineSpecialty } from "../../framework/public.ts";

// A process-only backend (no origin) is how an offscreen app such as a game is
// started beside its signalling service. The viewer limit is what keeps a second
// person from driving the same instance.
defineSpecialty(
  {
    id: "specialty.preview.offscreen-runner-viewer-limit",
    title: "A runner starts origin-less app processes and admits one viewer per limited route",
    oracle:
      "the origin-less process runs and is stopped with the runner; the first WS echoes; a second WS is closed with viewer_limit while the first stays usable; after the first closes a new viewer is admitted",
    catches: [
      "an app process with no HTTP port cannot be declared",
      "a second viewer reaches an instance that allows one",
      "the viewer slot leaks after a disconnect",
      "the app process outlives the runner",
    ],
    tags: ["network-risk-v2", "core", "service-preview"],
    llm: { default: "none" },
    expectedDurationMs: 20000,
    timeoutMs: 120000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "workbench", "service-preview"],
    productInterfaces: ["@genehub/workbench/client"],
    requiredRepos: ["cloud"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  },
  async (t) => {
    const example = join(t.env.workspace, "service-example");
    for (const folder of ["node-adapter", "demo"]) cpSync(
      join(t.openRoot, "apps/daemon/builtin-skills/genehub-preview/assets", folder),
      join(example, folder), { recursive: true, filter: source => !source.split(/[\\/]/).includes("node_modules") },
    );
    const installed = spawnSync("npm", ["--prefix", join(example, "node-adapter"), "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"],
      { encoding: "utf8", timeout: 30_000 });
    if (installed.status !== 0) throw new BlockedError(`the copied preview example dependencies could not be installed (exit ${installed.status})`);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const entry = join(t.env.workspace, "index.html"),
      config = join(t.env.workspace, "application.json"),
      marker = join(t.env.workspace, "app-process.pid"),
      appScript = join(t.env.workspace, "app-process.mjs");
    await writeFile(entry, "<!doctype html><title>Offscreen app</title>");
    await writeFile(appScript, `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
    await writeFile(config, JSON.stringify({
      entry: "index.html",
      backends: [
        {
          command: [process.execPath, join(example, "demo/backend.mjs")],
          origin: `http://127.0.0.1:${port}`,
          env: { PREVIEW_DEMO_PORT: String(port) },
          health: "/health",
          routes: [{ prefix: "/api/demo/", websocket: true, maxViewers: 1 }],
        },
        { command: [process.execPath, appScript] },
      ],
    }));
    const runner = spawn(process.execPath, [join(example, "node-adapter/run.mjs"), "--config", config, "--daemon-root", t.env.data], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [runner.stdout, runner.stderr]) stream.on("data", (b) => { output = (output + b).slice(-4096); });
    let service: ServicePreviewClient | null = null;
    let appPid = 0;
    try {
      await t.tools.waitUntil(async () => {
        if (runner.exitCode !== null) throw new Error(`runner exited: ${output}`);
        service = await ServicePreviewClient.discover(opened.client, opened.workspaceId, `${opened.rootHandle}/index.html`);
        return service !== null;
      }, 20000);
      const active = service as unknown as ServicePreviewClient;
      await t.tools.waitUntil(() => existsSync(marker), 5000);
      appPid = Number(await readFile(marker, "utf8"));
      t.assertions.assert(appPid > 0, "origin-less app process did not start");
      const inventory = await opened.client.call({ type: "process.workspaceList", payload: { workspaceId: opened.workspaceId } });
      t.assertions.assert(inventory?.type === "processes" && inventory.data.some(p => p.pid === appPid), "origin-less app process missing from the runner process tree");

      const open = async () => {
        const received: Uint8Array[] = [];
        const socket = await active.websocket("/api/demo/ws", async (packet) => { received.push(packet); });
        return { socket, received };
      };
      const text = (p: Uint8Array) => new TextDecoder().decode(p.slice(1));
      const first = await open();
      await t.tools.waitUntil(() => first.received.some(p => p[0] === 0 && text(p).includes('"open"')), 5000);
      const second = await open();
      await t.tools.waitUntil(() => second.received.some(p => p[0] === 0 && text(p).includes("viewer_limit")), 5000);
      t.assertions.assert(!second.received.some(p => p[0] === 0 && text(p).includes('"open"')), "the second viewer was admitted");
      await first.socket.send({ kind: "text", text: "still mine" });
      await t.tools.waitUntil(() => first.received.some(p => text(p).includes("still mine")), 5000);
      second.socket.close();
      first.socket.close();
      // The slot is released when the first viewer's bridge closes.
      let admitted = false;
      await t.tools.waitUntil(async () => {
        const next = await open();
        admitted = await t.tools.waitUntil(() => next.received.some(p => p[0] === 0 && text(p).includes('"open"')), 1500).then(() => true, () => false);
        next.socket.close();
        return admitted;
      }, 15000);
      t.assertions.assert(admitted, "the viewer slot was not released after disconnect");

      await opened.client.call({ type: "process.serviceStop", payload: { workspaceId: opened.workspaceId, entryPath: `${opened.rootHandle}/index.html`, runId: active.descriptor.runId } });
      await t.tools.waitUntil(() => runner.exitCode !== null, 10000);
      await t.tools.waitUntil(() => { try { process.kill(appPid, 0); return false; } catch { return true; } }, 10000);
    } finally {
      (service as ServicePreviewClient | null)?.close();
      runner.kill("SIGTERM");
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
