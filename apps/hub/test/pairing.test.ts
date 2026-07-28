import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { WebSocket } from "ws";

import { connect, opened, signIn, startTestHub, type TestHub } from "./harness.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DAEMON = path.join(REPO, "target/debug/genet-daemon");
const available = existsSync(DAEMON);

/**
 * The journey a real user takes, with nothing pre-arranged: install, pair by
 * reading a code off the screen and approving it in a browser, then open the
 * machine from that browser and talk to it.
 *
 * `relay.test.ts` checks the forwarding path with the enrollment written by
 * hand. This one refuses that shortcut: the daemon has to run the device code
 * flow itself and bring its own uplink up, because that is the step a user
 * cannot work around when it breaks.
 */
describe(
  "pairing a machine the way a person would",
  { skip: !available && "run cargo build -p genet-daemon first" },
  () => {
    let hub: TestHub;
    let daemon: ChildProcess | null = null;
    let dataDir: string;
    let local: WebSocket;

    before(async () => {
      hub = await startTestHub();
      dataDir = mkdtempSync(path.join(tmpdir(), "genehub-pairing-"));
    });

    after(async () => {
      local?.close();
      daemon?.kill("SIGKILL");
      await hub.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("goes from a fresh install to a session in a browser", async () => {
      await signIn(hub);

      const endpoint = await startDaemon();
      local = opened(await connect(`ws://127.0.0.1:${endpoint.port}/ws?token=${endpoint.token}`));
      const hello = await request(local, {
        id: "1",
        type: "hello",
        payload: { clientName: "desktop", protocolVersion: 1 },
      });
      assert.equal(hello.ok, true, JSON.stringify(hello));

      // A machine nobody paired says so plainly, rather than erroring: working
      // locally without a Hub is a supported way to use it.
      const before = await hubStatus(local, "2");
      assert.equal(before.state, "unpaired");

      const pairing = await hubStatus(local, "3", {
        type: "hub.pair",
        payload: { hubUrl: hub.origin, displayName: "厨房里的台式机" },
      });
      assert.equal(pairing.state, "pairing");
      assert.match(String(pairing.userCode), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.ok(
        String(pairing.verificationUriComplete).includes(String(pairing.userCode)),
        "the complete address should carry the code, so a QR code is enough",
      );

      // The human half: approve the code in a signed-in browser.
      const approved = await hub.fetch(`/app/activations/${pairing.userCode}`, {
        method: "POST",
        body: JSON.stringify({ action: "approve" }),
      });
      assert.equal(approved.status, 200);

      const paired = await until(async () => {
        const status = await hubStatus(local, `poll-${Date.now()}`);
        return status.state === "paired" && status.online === true ? status : null;
      });
      assert.ok(paired, "the daemon should enroll itself and dial the Hub without being told again");

      // The owner sees it, and the Hub agrees it is reachable.
      const me = await hub.json<{ machines: Array<{ id: string; name: string; online: boolean }> }>(
        "/app/me",
      );
      const machine = me.machines.find((entry) => entry.id === paired.machineId);
      assert.ok(machine, "the machine should be in the owner's list");
      assert.equal(machine.name, "厨房里的台式机");
      assert.equal(machine.online, true);

      // And the browser can now reach it through the forwarder.
      const ticket = await hub.json<{ url: string }>(`/app/machines/${machine.id}/connect`, {
        method: "POST",
      });
      const browser = opened(await connect(ticket.url));
      const remote = await request(browser, {
        id: "1",
        type: "hello",
        payload: { clientName: "browser", protocolVersion: 1 },
      });
      assert.equal(remote.ok, true, JSON.stringify(remote));
      assert.equal(
        (remote.payload as { data: { transport: string } }).data.transport,
        "forwarded",
      );
      browser.close();

      // The credential the daemon minted stays on the machine: the Hub only
      // ever received its hash.
      const state = JSON.parse(readFileSync(path.join(dataDir, "state.json"), "utf8")) as {
        enrollment: { secret: string; hubUrl: string };
      };
      assert.ok(state.enrollment.secret.length > 0);
      assert.equal(state.enrollment.hubUrl, hub.origin);
    });

    it("lets the owner unpair, and stops being reachable when they do", async () => {
      const before = await hubStatus(local, "u0");
      assert.equal(before.state, "paired", "this follows on from the pairing above");

      const after = await hubStatus(local, "u1", { type: "hub.unpair" });
      assert.equal(after.state, "unpaired");

      const gone = await until(async () => {
        const me = await hub.json<{ machines: Array<{ id: string }> }>("/app/me");
        return me.machines.every((entry) => entry.id !== before.machineId) ? true : null;
      });
      assert.ok(gone, "the machine should disappear from the owner's list");

      const state = JSON.parse(readFileSync(path.join(dataDir, "state.json"), "utf8")) as {
        enrollment?: unknown;
      };
      assert.equal(state.enrollment ?? null, null, "the enrollment should be off the disk too");
    });

    /** Starts the daemon and reads back the endpoint it prints on stdout. */
    function startDaemon(): Promise<{ port: number; token: string }> {
      return new Promise((resolve, reject) => {
        daemon = spawn(DAEMON, {
          env: { ...process.env, GENEHUB_DATA_DIR: dataDir, GENEHUB_LOG: "warn" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const timer = setTimeout(() => reject(new Error("the daemon never reported a port")), 10_000);
        daemon.stderr?.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));
        daemon.stdout?.on("data", (chunk) => {
          for (const line of String(chunk).split("\n").filter(Boolean)) {
            const frame = JSON.parse(line) as { event: string; port: number; token: string };
            if (frame.event !== "listening") continue;
            clearTimeout(timer);
            resolve({ port: frame.port, token: frame.token });
          }
        });
      });
    }
  },
);

type Status = Record<string, unknown> & { state: string };

async function hubStatus(socket: WebSocket, id: string, envelope?: unknown): Promise<Status> {
  const reply = await request(socket, {
    id,
    ...((envelope as { type: string; payload?: unknown }) ?? { type: "hub.status" }),
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const payload = reply.payload as { type: string; data: Status };
  assert.equal(payload.type, "hubStatus");
  return payload.data;
}

interface Result {
  type: string;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
}

function request(
  socket: WebSocket,
  envelope: { id: string; type: string; payload?: unknown },
  timeoutMs = 8000,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a reply")), timeoutMs);
    const onMessage = (data: unknown) => {
      const frame = JSON.parse(String(data)) as Result;
      if (frame.type !== "result" || frame.id !== envelope.id) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify(envelope));
  });
}

async function until<T>(check: () => Promise<T | null>, timeoutMs = 15_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}
