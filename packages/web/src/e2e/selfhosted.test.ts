// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { claimMachine } from "../devices/claim";
import type { PairedMachine } from "../devices/machines";
import { Client, type WebSocketLike } from "../protocol/client";
import { assetPreviewUrl, parseAssetPreviewPath } from "../preview/url";
import {
  applySequenced,
  assistantText,
  emptyTimeline,
} from "../session/timeline";
import { startMockModel, type MockModel } from "./mock-model";
import { builtBinary, daemonEnvironment, missingArtifacts } from "./artifacts";

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const DAEMON = builtBinary(
  REPO,
  ["genet-dev", "genet-beta", "genet-alpha", "genet"],
  process.env.GENET_E2E_DAEMON,
);
const AGENT = builtBinary(
  REPO,
  ["genet-agent-dev", "genet-agent-beta", "genet-agent-alpha", "genet-agent"],
  process.env.GENET_E2E_AGENT,
);
const RELAY = path.join(REPO, "apps/relay/dist/main.js");
const JOIN_TOKEN = "e2e-join-token";
const REPLY = "已经看过了，这个仓库编译得过。";

const socketFactory = (url: string) =>
  new WebSocket(url) as unknown as WebSocketLike;

/**
 * The whole self-hosted product, with nothing from the closed side in it: a
 * relay that only introduces sockets, a machine that decides for itself who
 * gets in, and the browser's own code doing the pairing.
 *
 * The claim covered here is the one the open-source repository exists to make —
 * that a relay and a folder of static files are enough. Unit tests cannot make
 * it: each piece can be perfectly correct on its own while the three of them
 * fail to add up to a usable product.
 */
describe.skipIf(
  missingArtifacts({ daemon: DAEMON, agent: AGENT, relay: RELAY }),
)("reaching a machine with nothing but open-source pieces", () => {
  let relay: ChildProcess;
  let relayOrigin: string;
  let daemon: ChildProcess;
  let owner: Client;
  let model: MockModel;
  let dataDir: string;
  let homeDir: string;
  let rendezvous: string;

  beforeAll(async () => {
    const started = await startRelay();
    relay = started.process;
    relayOrigin = started.origin;

    dataDir = mkdtempSync(path.join(tmpdir(), "genehub-selfhost-data-"));
    homeDir = mkdtempSync(path.join(tmpdir(), "genehub-selfhost-home-"));
    model = await startMockModel(REPLY);
    writeConfig(dataDir, model.baseUrl);
    const local = await startDaemon(dataDir, path.join(homeDir, "GeneHub"));
    daemon = local.process;

    owner = new Client({
      url: local.url,
      localServerProof: local.localServerProof,
      socketFactory,
      clientName: "owner",
    });
    owner.connect();
    await waitFor(() => owner.connectionState === "ready");

    const attached = await owner.call({
      type: "device.remoteAttach",
      payload: { relayUrl: relayOrigin, joinToken: JOIN_TOKEN },
    });
    if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) {
      throw new Error("the machine would not attach to the relay");
    }
    rendezvous = attached.data.rendezvousUrl;

    // Dialling out is asynchronous, and a client cannot be introduced to a
    // machine that has not arrived yet.
    await waitFor(async () => {
      const status = await owner.call({ type: "device.list" });
      return status?.type === "devices" && status.data.remote.online;
    }, 15_000);
  }, 40_000);

  afterAll(async () => {
    owner?.close();
    daemon?.kill("SIGKILL");
    relay?.kill("SIGKILL");
    await model?.close();
    // beforeAll can fail before the temporary roots are allocated (for
    // example when the real Relay cannot start). Teardown must preserve that
    // first actionable error instead of masking it with rmSync(undefined).
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  });

  /** Everything a new browser does on its own: claim an invite, then connect. */
  async function pairedClient(name: string): Promise<Client> {
    const invite = await owner.call({ type: "device.invite", payload: null });
    if (invite?.type !== "invite") throw new Error("no invite was minted");
    const machine = await claimMachine(
      rendezvous,
      invite.data.code,
      name,
      socketFactory,
    );
    const client = new Client({
      url: rendezvous,
      credential: { deviceId: machine.deviceId, secret: machine.secret },
      socketFactory,
      clientName: name,
    });
    client.connect();
    await waitFor(() => client.connectionState === "ready", 20_000);
    return client;
  }

  it("lets a paired device in and keeps everyone else out", async () => {
    const invite = await owner.call({ type: "device.invite", payload: null });
    if (invite?.type !== "invite") throw new Error("no invite was minted");
    expect(invite.data.rendezvousUrl).toBe(rendezvous);

    const machine: PairedMachine = await claimMachine(
      rendezvous,
      invite.data.code,
      "另一台电脑上的 Chrome",
      socketFactory,
    );
    expect(machine.fingerprint).toMatch(/\w/);

    const paired = new Client({
      url: rendezvous,
      credential: { deviceId: machine.deviceId, secret: machine.secret },
      socketFactory,
      clientName: "paired",
    });
    paired.connect();
    await waitFor(() => paired.connectionState === "ready");

    // Being in means being all the way in: the same workbench, over a relay
    // that was never asked whether this was allowed.
    const workspaces = await paired.call({ type: "workspace.list" });
    expect(workspaces?.type).toBe("workspaces");
    expect(paired.identity?.fingerprint).toBe(machine.fingerprint);

    const stranger = new Client({
      url: rendezvous,
      socketFactory,
      clientName: "stranger",
    });
    stranger.connect();
    await waitFor(() => stranger.connectionState === "closed", 15_000);
    expect(stranger.failure?.code).toBe("unauthorized");

    paired.close();
    stranger.close();
  }, 40_000);

  it("previews one workspace-relative link from two paired browsers", async () => {
    const relative = "docs/preview.md";
    const source = "# Portable preview\n\n来自 daemon 文件系统。\n";
    const workspaceRoot = path.join(homeDir, "GeneHub");
    mkdirSync(path.join(workspaceRoot, "docs"), { recursive: true });
    writeFileSync(path.join(workspaceRoot, relative), source);

    const first = await pairedClient("预览浏览器一");
    const workspaces = await first.call({ type: "workspace.list" });
    if (workspaces?.type !== "workspaces" || !workspaces.data[0]) {
      throw new Error("the machine offered no preview workspace");
    }
    const workspace = workspaces.data[0].id;
    const rootHandle = workspaces.data[0].folders[0]!.rootHandle;
    const locator = `${rootHandle}/${relative}`;
    const device = first.identity?.machineId;
    if (!device) throw new Error("the preview peer returned no device handle");
    const url = assetPreviewUrl(
      device,
      workspace,
      locator,
      "https://viewer.example",
    );
    expect(parseAssetPreviewPath(new URL(url).pathname)).toEqual({
      deviceHandle: device,
      workspaceHandle: workspace,
      path: locator,
    });

    const second = await pairedClient("预览浏览器二");
    const [one, two] = await Promise.all([
      first.preview(workspace, locator),
      second.preview(workspace, locator),
    ]);
    for (const preview of [one, two]) {
      expect(preview.metadata.kind).toBe("markdown");
      expect(new TextDecoder().decode(preview.bytes)).toBe(source);
    }
    first.close();
    second.close();
  }, 50_000);

  it("holds a conversation over the relay, streamed the whole way", async () => {
    // The point of the product, over the only path a self-hosted deployment
    // has. Every test above stops at "the socket was allowed", which is a
    // long way short of "someone can use this": the relay has to carry
    // subscriptions and streamed deltas, not just a request and a reply.
    const guest = await pairedClient("远程浏览器");

    const workspaces = await guest.call({ type: "workspace.list" });
    if (workspaces?.type !== "workspaces" || !workspaces.data[0]) {
      throw new Error("the machine offered no workspace to work in");
    }

    const created = await guest.call({
      type: "session.create",
      payload: {
        workspaceId: workspaces.data[0].id,
        agentId: "genet",
        modelId: null,
        modeId: null,
        title: null,
        cwd: null,
      },
    });
    if (created?.type !== "session") throw new Error("no session was created");
    const sessionId = created.data.id;

    // Reduced with the same code the workbench uses, so what is asserted is
    // what someone would have seen on screen.
    let timeline = emptyTimeline();
    let deltas = 0;
    await guest.subscribe(sessionId, {
      onEvent: (event) => {
        if (event.event.type === "itemDelta") deltas += 1;
        timeline = applySequenced(timeline, event);
      },
      onResync: () => {},
    });

    await guest.call({
      type: "session.send",
      payload: {
        sessionId,
        text: "这个仓库能编译吗？",
        attachments: [],
        artifactPreviewBaseUrl: null,
        continuesRound: null,
      },
    });
    await waitFor(
      () => timeline.status === "idle" && timeline.items.length > 1,
      30_000,
    );

    expect(timeline.lastError).toBeNull();
    expect(assistantText(timeline)).toContain(REPLY);
    // Arriving in pieces is the part a request/response transport would
    // quietly break: it would still "work", just with nothing to watch.
    expect(deltas).toBeGreaterThan(1);

    // And the history is on the machine, not in that browser: a second device
    // opening the same session sees the conversation that already happened.
    const second = await pairedClient("另一台设备");
    const { snapshot } = await second.subscribe(sessionId, {
      onEvent: () => {},
      onResync: () => {},
    });
    const said = JSON.stringify(snapshot);
    expect(said).toContain("这个仓库能编译吗？");
    expect(said).toContain(REPLY);

    guest.close();
    second.close();
  }, 60_000);

  it("comes back on its own after the relay restarts", async () => {
    // A self-hosted relay is someone's small server: it gets restarted, and
    // it gets restarted without anyone touching the machine. If coming back
    // needs a visit to the desktop app, remote access is not dependable.
    relay.kill("SIGKILL");
    await waitFor(async () => {
      const status = await owner.call({ type: "device.list" });
      return status?.type === "devices" && !status.data.remote.online;
    }, 20_000);

    const restarted = await startRelay(Number(new URL(relayOrigin).port));
    relay = restarted.process;

    await waitFor(async () => {
      const status = await owner.call({ type: "device.list" });
      return status?.type === "devices" && status.data.remote.online;
    }, 30_000);

    // Not just dialled in: usable, by a device paired before the outage.
    const guest = await pairedClient("重连后的浏览器");
    expect((await guest.call({ type: "workspace.list" }))?.type).toBe(
      "workspaces",
    );
    guest.close();
  }, 70_000);

  it("cuts off a revoked device while it is using the connection", async () => {
    const invite = await owner.call({ type: "device.invite", payload: null });
    if (invite?.type !== "invite") throw new Error("no invite was minted");

    const machine = await claimMachine(
      rendezvous,
      invite.data.code,
      "临时设备",
      socketFactory,
    );
    const guest = new Client({
      url: rendezvous,
      credential: { deviceId: machine.deviceId, secret: machine.secret },
      socketFactory,
      clientName: "guest",
    });
    guest.connect();
    await waitFor(() => guest.connectionState === "ready");

    await owner.call({
      type: "device.revoke",
      payload: { deviceId: machine.deviceId },
    });

    // The connection has to drop now. "Cannot come back later" is not what
    // anyone pressing revoke has in mind.
    await waitFor(() => guest.connectionState !== "ready", 15_000);
    guest.close();
  }, 40_000);
});

// ---------------------------------------------------------------------------

/**
 * Providers live in the daemon's config file, so a conversation can be held
 * without a key to a real model. Written before the daemon starts: it reads
 * this once.
 */
function writeConfig(dataDir: string, modelBaseUrl: string): void {
  writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      agents: {
        providers: { deepseek: { apiKey: "sk-mock", baseUrl: modelBaseUrl } },
      },
    }),
  );
}

async function startRelay(
  port = 0,
): Promise<{ process: ChildProcess; origin: string }> {
  const child = spawn("node", [RELAY], {
    env: {
      ...process.env,
      RELAY_MODE: "rendezvous",
      RELAY_HOST: "127.0.0.1",
      RELAY_PORT: String(port),
      RELAY_JOIN_TOKEN: JOIN_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the relay never said where it was")),
      15_000,
    );
    const read = (chunk: Buffer) => {
      const found = /http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (!found) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${found[1]}`);
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
  });

  return { process: child, origin };
}

function startDaemon(
  dataDir: string,
  defaultWorkspace: string,
): Promise<{
  process: ChildProcess;
  url: string;
  localServerProof: {
    proof: string;
    challenge: string;
    pid: number;
    machineId: string;
    fingerprint: string;
    expiresAt: number;
  };
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(DAEMON, ["daemon", "run"], {
      env: {
        ...process.env,
        // Installed side by side in production; in a test the agent is wherever
        // cargo put it.
        ...daemonEnvironment(DAEMON, {
          dataDir,
          workspaceDir: defaultWorkspace,
          log: "warn",
          agent: AGENT,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the daemon never reported a port"));
    }, 60_000);
    child.stderr?.on("data", (chunk) =>
      process.stderr.write(`[daemon] ${chunk}`),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const frame = JSON.parse(line) as {
          event: string;
          url: string;
          serverProof: string;
          admission: {
            challenge: string;
            pid: number;
            machineId: string;
            fingerprint: string;
            expiresAt: number;
          };
        };
        if (frame.event !== "listening") continue;
        clearTimeout(timer);
        resolve({
          process: child,
          url: frame.url,
          localServerProof: { proof: frame.serverProof, ...frame.admission },
        });
      }
    });
  });
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the machine to get there");
}
