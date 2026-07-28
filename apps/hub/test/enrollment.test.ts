import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { enrollMachine, signIn, startTestHub, type TestHub } from "./harness.js";

describe("pairing a machine with an account", () => {
  let hub: TestHub;

  before(async () => {
    hub = await startTestHub();
  });
  after(async () => {
    await hub.stop();
  });

  it("takes a machine from a printed code to a machine in the owner's list", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub, { name: "书房台式机" });

    const me = await hub.json<{ machines: Array<{ id: string; name: string; online: boolean }> }>(
      "/app/me",
    );
    const listed = me.machines.find((m) => m.id === machine.machineId);
    assert.ok(listed, "the machine the user just approved is the one they see");
    assert.equal(listed.name, "书房台式机");
    assert.equal(listed.online, false, "enrolled is not the same as connected");
    assert.match(machine.uplinkUrl, /^ws:\/\/127\.0\.0\.1:\d+\/forward\/daemon$/);
  });

  it("does not hand out an enrollment token before a human approves", async () => {
    const started = await hub.json<{ deviceCode: string }>("/api/device-authorizations", {
      method: "POST",
      body: JSON.stringify({ displayName: "未批准的电脑" }),
    });
    const polled = await hub.json<{ status: string; enrollmentToken?: string }>(
      "/api/device-authorizations/poll",
      { method: "POST", body: JSON.stringify({ deviceCode: started.deviceCode }) },
    );
    assert.equal(polled.status, "pending");
    assert.equal(polled.enrollmentToken, undefined);
  });

  it("refuses enrollment with a token nobody issued", async () => {
    const response = await hub.fetch("/api/machines/enroll", {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({
        daemonId: "dmn_forged",
        publicKey: "aaa",
        credentialVerifier: "bbb",
      }),
    });
    assert.equal(response.status, 401);
  });

  it("keeps a denied code denied", async () => {
    await signIn(hub);
    const started = await hub.json<{ deviceCode: string; userCode: string }>(
      "/api/device-authorizations",
      { method: "POST", body: JSON.stringify({ displayName: "别人的电脑" }) },
    );

    const denied = await hub.json<{ status: string }>(`/app/activations/${started.userCode}`, {
      method: "POST",
      body: JSON.stringify({ action: "deny" }),
    });
    assert.equal(denied.status, "denied");

    const polled = await hub.json<{ status: string }>("/api/device-authorizations/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    });
    assert.equal(polled.status, "denied");

    const again = await hub.fetch(`/app/activations/${started.userCode}`, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(again.status, 410, "a denial cannot be walked back by re-approving");
  });

  it("re-enrolling the same machine updates it instead of duplicating it", async () => {
    await signIn(hub);
    const first = await enrollMachine(hub, { name: "笔记本" });
    const second = await enrollMachine(hub, { name: "笔记本（重装后）", daemonId: first.daemonId });

    assert.equal(second.machineId, first.machineId);
    const me = await hub.json<{ machines: Array<{ id: string; name: string }> }>("/app/me");
    const matching = me.machines.filter((m) => m.id === first.machineId);
    assert.equal(matching.length, 1);
    assert.equal(matching[0]!.name, "笔记本（重装后）");
  });

  it("lets a machine unenroll itself with its own credential, and only its own", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);

    const wrong = await hub.fetch(`/api/machines/${machine.daemonId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer someone-elses-secret" },
    });
    assert.equal(wrong.status, 403);

    const secret = machine.uplinkTicket.slice(machine.uplinkTicket.indexOf(".") + 1);
    const right = await hub.fetch(`/api/machines/${machine.daemonId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(right.status, 204);

    const me = await hub.json<{ machines: Array<{ id: string }> }>("/app/me");
    assert.equal(me.machines.some((m) => m.id === machine.machineId), false);
  });
});
