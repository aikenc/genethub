import { spawn } from "node:child_process";
import { writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { ServicePreviewClient } from "@genehub/workbench/client";
import {
  allocatePort,
  BlockedError,
  defineSpecialty,
  daemonEndpoint,
  openPreviewBrowser,
} from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.preview.native-browser-media",
    title:
      "Native browser receives media after signalling through the registered service bridge",
    oracle:
      "Chromium decodes video and receives audio RTP from the real aiortc endpoint; selected pair has no relay; explicit stop releases backend session",
    catches: [
      "successful SDP mistaken for media connectivity",
      "media needs GeneHub DataChannel to decode",
      "browser never receives actual audio/video",
      "stop leaks backend media session",
    ],
    tags: ["network-risk-v2", "page-experience", "service-preview-media"],
    runner: "playwright",
    llm: { default: "none" },
    expectedDurationMs: 15000,
    timeoutMs: 120000,
    resources: {
      environments: 1,
      cpu: 2,
      memoryMb: 1024,
      io: 1,
      browser: 1,
      pool: "browser",
    },
    surfaces: ["browser", "daemon", "service-preview"],
    productInterfaces: ["@genehub/workbench/client"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  },
  async (t) => {
    if (!t.browser) throw new BlockedError("real browser required");
    const python = process.env.GENEHUB_PREVIEW_MEDIA_PYTHON;
    if (!python)
      throw new BlockedError(
        "set GENEHUB_PREVIEW_MEDIA_PYTHON to Python with apps/daemon/builtin-skills/genehub-service-preview/assets/demo/requirements.txt",
      );
    const opened = await t.flows.main.openWorkspace({
      openRoot: t.openRoot,
      lease: t.env,
    });
    const port = await allocatePort();
    const demoPort = await allocatePort();
    const config = join(t.env.workspace, "media.json");
    await copyFile(
      join(t.openRoot, "apps/daemon/builtin-skills/genehub-service-preview/assets/demo/index.html"),
      join(t.env.workspace, "index.html"),
    );
    await writeFile(
      config,
      JSON.stringify({
        entry: "index.html",
        backends: [
          {
            command: [
              process.execPath,
              join(t.openRoot, "apps/daemon/builtin-skills/genehub-service-preview/assets/demo/backend.mjs"),
            ],
            origin: `http://127.0.0.1:${demoPort}`,
            env: { PREVIEW_DEMO_PORT: String(demoPort) },
            health: "/health",
            routes: [{ prefix: "/api/demo/", websocket: true }],
          },
          {
            command: [
              python,
              join(t.openRoot, "apps/daemon/builtin-skills/genehub-service-preview/assets/demo/media.py"),
            ],
            origin: `http://127.0.0.1:${port}`,
            env: { PREVIEW_MEDIA_PORT: String(port) },
            health: "/health",
            routes: [{ prefix: "/api/media/" }],
          },
        ],
        media: {
          offerPath: "/api/media/offer",
          stopPath: "/api/media/stop",
          microphone: "none",
        },
      }),
    );
    const runner = spawn(
      process.execPath,
      [
        join(t.openRoot, "apps/daemon/builtin-skills/genehub-service-preview/assets/node-adapter/run.mjs"),
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
          throw new Error(`media runner exited: ${output}`);
        service = await ServicePreviewClient.discover(
          opened.client,
          opened.workspaceId,
          `${opened.rootHandle}/index.html`,
        );
        return service !== null;
      }, 30000);
      const active = service as unknown as ServicePreviewClient;
      const page = await t.browser.newPage();
      // A real browser application uses the public service client for signalling.
      // No mock SDP, decoded frame, ICE state or browser media object is supplied.
      await page.exposeFunction("signalMedia", async (body: unknown) => {
        const response = await active.fetch("/api/media/offer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`offer ${response.status}`);
        return response.json();
      });
      const result = await page.evaluate(async () => {
        const signal = (
          globalThis as unknown as {
            signalMedia: (
              body: unknown,
            ) => Promise<{ sdp: string; sessionId: string }>;
          }
        ).signalMedia;
        const pc = new RTCPeerConnection({ iceServers: [] });
        try {
          pc.addTransceiver("video", { direction: "recvonly" });
          pc.addTransceiver("audio", { direction: "recvonly" });
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise<void>((resolve) => {
            if (pc.iceGatheringState === "complete") {
              resolve();
              return;
            }
            pc.addEventListener("icegatheringstatechange", () => {
              if (pc.iceGatheringState === "complete") resolve();
            });
          });
          const answer = await signal({
            sdp: pc.localDescription!.sdp,
            type: "offer",
            iceServers: [],
          });
          await pc.setRemoteDescription({ sdp: answer.sdp, type: "answer" });
          const deadline = Date.now() + 20000;
          let frames = 0,
            audio = 0,
            relay = false;
          while (Date.now() < deadline) {
            const stats = await pc.getStats();
            const byId = new Map<string, any>();
            stats.forEach((row) => byId.set(row.id, row));
            stats.forEach((row) => {
              if (row.type === "inbound-rtp" && row.kind === "video")
                frames = row.framesDecoded ?? 0;
              if (row.type === "inbound-rtp" && row.kind === "audio")
                audio = row.bytesReceived ?? 0;
              if (row.type === "transport" && row.selectedCandidatePairId) {
                const pair = byId.get(row.selectedCandidatePairId);
                relay =
                  byId.get(pair.localCandidateId)?.candidateType === "relay" ||
                  byId.get(pair.remoteCandidateId)?.candidateType === "relay";
              }
            });
            if (frames >= 10 && audio > 1000)
              return { frames, audio, relay, sessionId: answer.sessionId };
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error(
            `no media frames=${frames} audio=${audio} connection=${pc.connectionState}`,
          );
        } finally {
          pc.close();
        }
      });
      t.assertions.assert(
        result.frames >= 10 && result.audio > 1000 && !result.relay,
        "real direct media not received",
      );
      await (
        await active.fetch("/api/media/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: result.sessionId }),
        })
      ).body?.cancel();
      const health = await (await active.fetch("/api/media/health")).json();
      t.assertions.assert(health.sessions === 0, "media session leaked");
      const uiPage = await t.browser.newPage();
      const consumer = await openPreviewBrowser({
        openRoot: t.openRoot,
        lease: t.env,
        page: uiPage,
        endpoint: daemonEndpoint(opened.daemon),
        workspaceId: opened.workspaceId,
        entryPath: `${opened.rootHandle}/index.html`,
      });
      try {
        await uiPage
          .getByRole("button", { name: "允许本次预览访问登记服务" })
          .click({ timeout: 30000 });
        const frame = uiPage.frameLocator("iframe").first();
        await frame
          .getByRole("button", { name: "请求后端", exact: true })
          .click();
        await t.tools.waitUntil(
          async () =>
            (await frame.locator("#output").innerText()).includes("true"),
          5000,
        );
        await frame
          .getByRole("button", { name: "WebSocket 回声", exact: true })
          .click();
        await t.tools.waitUntil(
          async () =>
            (await frame.locator("#output").innerText()) === "服务连接成功",
          5000,
        );
        await uiPage
          .getByRole("button", { name: "连接音视频", exact: true })
          .click();
        await uiPage.waitForFunction(
          () => {
            const video = document.querySelector("video");
            return video && video.videoWidth > 0 && video.currentTime > 0;
          },
          {},
          { timeout: 30000 },
        );
        await uiPage.getByRole("button", { name: "停止", exact: true }).click();
        await t.tools.waitUntil(async () => {
          const r = await active.fetch("/api/media/health");
          return (await r.json()).sessions === 0;
        }, 5000);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; page errors=${consumer.errors.join(";")}; page text=${(await uiPage.locator("body").innerText()).slice(0, 1000)}`,
        );
      } finally {
        await uiPage.close();
        await consumer.close();
      }
      t.note(
        `Chromium decoded ${result.frames} video frames; received ${result.audio} audio bytes; direct candidate pair.`,
      );
    } finally {
      (service as ServicePreviewClient | null)?.close();
      runner.kill("SIGTERM");
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
