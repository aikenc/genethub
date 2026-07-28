import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { WebSocket } from "ws";

import { connect, enrollMachine, opened, signIn, startTestHub, type TestHub } from "./harness.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DAEMON = path.join(REPO, "target/debug/genet-daemon");

/**
 * The one path that cannot be checked from either side alone: a browser that
 * has never heard of the machine's address, reaching a daemon that has no
 * address, through a forwarder that reads seventeen bytes of each frame.
 *
 * Needs `cargo build -p genet-daemon` first. Skipped rather than failed when
 * the binary is absent, so `npm test` still works in a checkout with no Rust
 * toolchain — CI builds it.
 */
const available = existsSync(DAEMON);

describe("reaching a machine through the forwarding layer", { skip: !available && "run cargo build -p genet-daemon first" }, () => {
  let hub: TestHub;
  let daemon: ChildProcess | null = null;
  let dataDir: string;

  before(async () => {
    hub = await startTestHub();
    dataDir = mkdtempSync(path.join(tmpdir(), "genehub-daemon-"));
  });

  after(async () => {
    daemon?.kill("SIGKILL");
    await hub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("carries a whole conversation from a browser to a daemon and back", async () => {
    await signIn(hub);

    // Enroll through the real flow, then hand the daemon the result the way
    // its own enrollment would have written it.
    const secret = "uplink-secret-for-the-test";
    const daemonId = "dmn_relay_test";
    const verifier = createHash("sha256").update(secret).digest("base64url");

    const started = await hub.json<{ deviceCode: string; userCode: string }>(
      "/api/device-authorizations",
      { method: "POST", body: JSON.stringify({ displayName: "中转测试机" }) },
    );
    await hub.fetch(`/app/activations/${started.userCode}`, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    const polled = await hub.json<{ enrollmentToken: string }>(
      "/api/device-authorizations/poll",
      { method: "POST", body: JSON.stringify({ deviceCode: started.deviceCode }) },
    );
    const enrolled = await hub.json<{ machineId: string; uplinkUrl: string }>(
      "/api/machines/enroll",
      {
        method: "POST",
        headers: { authorization: `Bearer ${polled.enrollmentToken}` },
        body: JSON.stringify({ daemonId, publicKey: "dGVzdA==", credentialVerifier: verifier }),
      },
    );

    writeFileSync(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        machineId: "m_relay_test",
        secret: "local-secret",
        enrollment: {
          hubUrl: hub.origin,
          machineId: enrolled.machineId,
          uplinkUrl: enrolled.uplinkUrl,
          daemonId,
          secret,
        },
      }),
    );

    daemon = spawn(DAEMON, {
      env: { ...process.env, GENEHUB_DATA_DIR: dataDir, RUST_LOG: "warn" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stderr?.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));

    const online = await waitFor(async () => {
      const me = await hub.json<{ machines: Array<{ id: string; online: boolean }> }>("/app/me");
      return me.machines.find((m) => m.id === enrolled.machineId)?.online === true;
    });
    assert.ok(online, "the daemon should dial the Hub on its own");

    const ticket = await hub.json<{ url: string }>(
      `/app/machines/${enrolled.machineId}/connect`,
      { method: "POST" },
    );
    const client = opened(await connect(ticket.url));

    const hello = await request(client, {
      id: "1",
      type: "hello",
      payload: { clientName: "relay-test", protocolVersion: 1 },
    });
    assert.equal(hello.ok, true, `hello was refused: ${JSON.stringify(hello)}`);
    const greeting = hello.payload as { type: string; data: { transport: string } };
    assert.equal(greeting.type, "hello");
    assert.equal(
      greeting.data.transport,
      "forwarded",
      "the daemon should know this client came in over the relay",
    );

    // Something with a real reply body, to prove it is not just the handshake
    // that survives the trip.
    const agents = await request(client, { id: "2", type: "agent.list" });
    assert.equal(agents.ok, true, JSON.stringify(agents));
    const listed = agents.payload as { type: string; data: unknown[] };
    assert.equal(listed.type, "agents");
    assert.ok(Array.isArray(listed.data));
    assert.ok(
      listed.data.length > 0,
      "the built-in agent should be discoverable over the relay too",
    );

    client.close();
  });
});

interface Result {
  type: string;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
}

function request(socket: WebSocket, envelope: unknown, timeoutMs = 5000): Promise<Result> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a reply")), timeoutMs);
    const onMessage = (data: unknown) => {
      const frame = JSON.parse(String(data)) as Result;
      // Notices and events share the socket; only a result answers a request.
      if (frame.type !== "result") return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify(envelope));
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
