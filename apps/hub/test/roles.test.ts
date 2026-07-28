import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { RemoteAuthority } from "../src/forward/remote-authority.js";
import { rolesFromEnv } from "../src/shared/config.js";
import {
  connect,
  enrollMachine,
  signIn,
  startTestHub,
  type TestHub,
} from "./harness.js";
import { startHub } from "../src/main.js";

describe("running one role at a time", () => {
  it("reads ROLES, and refuses nonsense rather than silently running everything", () => {
    assert.deepEqual([...rolesFromEnv(undefined)], ["control", "forward"]);
    assert.deepEqual([...rolesFromEnv("forward")], ["forward"]);
    assert.deepEqual([...rolesFromEnv("control, forward")], ["control", "forward"]);
    assert.throws(() => rolesFromEnv("frontend"), /unknown role/);
    assert.throws(() => rolesFromEnv(" "), /at least one role/);
  });

  it("starts the control plane alone, with no forwarding endpoints", async () => {
    const hub = await startTestHub({ roles: ["control"] });
    try {
      const health = await hub.json<{ roles: string[]; forward: unknown }>("/api/health");
      assert.deepEqual(health.roles, ["control"]);
      assert.equal(health.forward, null);

      await signIn(hub);
      const machine = await enrollMachine(hub);
      const attempt = await connect(machine.uplinkUrl, {
        headers: { authorization: `Bearer ${machine.uplinkTicket}` },
      });
      assert.ok("error" in attempt, "there is nothing listening for uplinks in this process");
    } finally {
      await hub.stop();
    }
  });

  /**
   * The check that matters: the forwarding role has to come up with no database
   * and no control plane in the process, serve traffic, and fail authorization
   * honestly rather than crashing (`docs/architecture.md` §6.5).
   */
  it("starts the forwarding role alone and refuses what it cannot verify", async () => {
    const hub = await startHub({
      roles: new Set(["forward"]),
      port: 0,
      host: "127.0.0.1",
      // No control plane in this process; point it at somewhere unreachable.
      controlOrigin: "http://127.0.0.1:9",
    });
    try {
      const health = await fetch(`http://127.0.0.1:${hub.port}/api/health`);
      assert.equal(health.status, 200);
      const body = (await health.json()) as { roles: string[]; forward: { machines: number } };
      assert.deepEqual(body.roles, ["forward"]);
      assert.deepEqual(body.forward, { machines: 0, channels: 0 });

      const attempt = await connect(`ws://127.0.0.1:${hub.port}/forward/daemon`, {
        headers: { authorization: "Bearer dmn_x.secret" },
      });
      assert.ok(
        "error" in attempt && attempt.error.includes("403"),
        `unverifiable is not the same as allowed: ${JSON.stringify(attempt)}`,
      );
    } finally {
      await hub.close();
    }
  });

  it("speaks the contract over HTTP when the control plane is elsewhere", async () => {
    const control = await startTestHub({ roles: ["control"], internalToken: "shared-secret" });
    try {
      await signIn(control);
      const machine = await enrollMachine(control);

      const remote = new RemoteAuthority(control.origin, "shared-secret");
      const grant = await remote.authorizeDaemon(machine.uplinkTicket);
      assert.deepEqual(grant, { machineId: machine.machineId, daemonId: machine.daemonId });

      assert.equal(await remote.authorizeDaemon(`${machine.daemonId}.wrong`), null);

      await remote.reportPresence(machine.machineId, "online");
      const me = await control.json<{ machines: Array<{ id: string; online: boolean }> }>("/app/me");
      assert.equal(me.machines.find((m) => m.id === machine.machineId)?.online, true);

      const unauthenticated = new RemoteAuthority(control.origin, "wrong-secret");
      assert.equal(await unauthenticated.authorizeDaemon(machine.uplinkTicket), null);
    } finally {
      await control.stop();
    }
  });
});

describe("the internal contract endpoints", () => {
  let hub: TestHub;
  before(async () => {
    hub = await startTestHub({ roles: ["control"] });
  });
  after(async () => {
    await hub.stop();
  });

  it("are not mounted unless a token is configured", async () => {
    const response = await hub.fetch("/internal/authorize-daemon", {
      method: "POST",
      body: JSON.stringify({ ticket: "anything" }),
    });
    assert.equal(response.status, 404);
  });
});
