import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServicePreviewClient } from "@genehub/workbench/client";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.preview.registered-service-http-ws",
    title:
      "Registered foreground services carry HTTP, streams and WebSocket through the real daemon",
    oracle:
      "201 response preserves exact binary input; SSE delivers multiple increments; WS echoes text and binary; stopping runner retires the entry",
    catches: [
      "HTTP bridge discards method/body/status",
      "stream bridge buffers or loses bytes",
      "WebSocket loses binary message boundaries",
      "stopped runs remain discoverable",
    ],
    tags: ["core", "service-preview"],
    llm: { default: "none" },
    expectedDurationMs: 20000,
    timeoutMs: 120000,
    resources: {
      environments: 1,
      cpu: 2,
      memoryMb: 768,
      io: 1,
      browser: 0,
      pool: "standard",
    },
    surfaces: ["daemon", "workbench", "service-preview"],
    productInterfaces: ["@genehub/workbench/client"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({
      openRoot: t.openRoot,
      lease: t.env,
    });
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const entry = join(t.env.workspace, "index.html"),
      config = join(t.env.workspace, "application.json");
    await writeFile(entry, "<!doctype html><title>Service preview</title>");
    await writeFile(
      config,
      JSON.stringify({
        entry: "index.html",
        backends: [
          {
            command: [
              process.execPath,
              join(t.openRoot, "examples/service-preview/backend.mjs"),
            ],
            origin: `http://127.0.0.1:${port}`,
            env: { PREVIEW_DEMO_PORT: String(port) },
            health: "/health",
            routes: [{ prefix: "/api/demo/", websocket: true }],
          },
        ],
      }),
    );
    const runner = spawn(
      process.execPath,
      [
        join(t.openRoot, "packages/service-preview/run.mjs"),
        "--config",
        config,
        "--daemon-root",
        t.env.data,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    runner.stdout.on("data", (b) => {
      output = (output + b).slice(-4096);
    });
    runner.stderr.on("data", (b) => {
      output = (output + b).slice(-4096);
    });
    let service: ServicePreviewClient | null = null;
    try {
      await t.tools.waitUntil(async () => {
        if (runner.exitCode !== null)
          throw new Error(`runner exited: ${output}`);
        service = await ServicePreviewClient.discover(
          opened.client,
          opened.workspaceId,
          `${opened.rootHandle}/index.html`,
        );
        return service !== null;
      }, 20000);
      const active = service as unknown as ServicePreviewClient;
      const narrow = await t.flows.main.pairDevice(
        opened.client,
        opened.daemon,
        ["read", "files"],
        "files-only",
      );
      try {
        const probe = narrow.client.openServicePreview({
          workspaceHandle: opened.workspaceId,
          entryPath: `${opened.rootHandle}/index.html`,
          operation: "describe",
        });
        const head = await probe.responseHead;
        t.assertions.assert(
          head.status === 403,
          "files-only grant gained service access",
        );
        probe.reset(1);
      } finally {
        narrow.client.close();
      }
      const body = new Uint8Array(90000);
      for (let i = 0; i < body.length; i++) body[i] = i % 251;
      const response = await active.fetch("/api/demo/echo", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      t.assertions.assert(
        response.status === 201,
        `unexpected HTTP status ${response.status}`,
      );
      const result = new Uint8Array(await response.arrayBuffer());
      t.assertions.assert(
        result.length === body.length && result.every((v, i) => v === body[i]),
        "binary HTTP response changed",
      );
      const stream = await active.fetch("/api/demo/stream");
      const reader = stream.body!.getReader();
      let text = "",
        chunks = 0;
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        text += new TextDecoder().decode(read.value);
        chunks++;
      }
      t.assertions.assert(
        chunks >= 2 && text.includes("data:"),
        "SSE did not stream",
      );
      const received: Uint8Array[] = [];
      const socket = await active.websocket("/api/demo/ws", async (packet) => {
        received.push(packet);
      });
      await t.tools.waitUntil(
        () =>
          received.some(
            (p) =>
              p[0] === 0 &&
              new TextDecoder().decode(p.slice(1)).includes('"open"'),
          ),
        5000,
      );
      await socket.send({ kind: "text", text: "hello preview" });
      await socket.send(new Uint8Array([0, 255, 42]));
      await t.tools.waitUntil(
        () =>
          received.some((p) => p[0] === 1 && p.length === 4) &&
          received.some((p) =>
            new TextDecoder().decode(p.slice(1)).includes("hello preview"),
          ),
        5000,
      );
      const binary = received.find((p) => p[0] === 1)!;
      t.assertions.assert(
        binary[1] === 0 && binary[2] === 255 && binary[3] === 42,
        "WS binary payload changed",
      );
      socket.close();
      let denied = false;
      try {
        await active.fetch("/api/unregistered/");
      } catch {
        denied = true;
      }
      t.assertions.assert(denied, "undeclared route accepted");
      runner.kill("SIGTERM");
      await t.tools.waitUntil(async () => {
        try {
          const remaining=await ServicePreviewClient.discover(opened.client,opened.workspaceId,`${opened.rootHandle}/index.html`);
          remaining?.close();return remaining===null;
        } catch { return false; } // Closed socket may precede unlink; only 404/null is success.
      },10000);
    } finally {
      (service as ServicePreviewClient | null)?.close();
      runner.kill("SIGTERM");
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
