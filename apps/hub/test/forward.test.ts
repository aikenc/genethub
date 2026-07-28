import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { WebSocket } from "ws";

import { decode, encode, Kind } from "../src/forward/frame.js";
import {
  closed,
  connect,
  enrollMachine,
  nextMessage,
  opened,
  signIn,
  startTestHub,
  type EnrolledMachine,
  type TestHub,
} from "./harness.js";

/** Brings a machine online: enrolled, plus a live uplink. */
async function bringOnline(
  hub: TestHub,
  machine: EnrolledMachine,
): Promise<WebSocket> {
  const uplink = opened(
    await connect(machine.uplinkUrl, {
      headers: { authorization: `Bearer ${machine.uplinkTicket}` },
    }),
  );
  // Presence is reported when the socket registers; give the write a tick so
  // the ticket endpoint does not race it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return uplink;
}

async function ticketFor(hub: TestHub, machineId: string): Promise<string> {
  const response = await hub.fetch(`/app/machines/${machineId}/connect`, { method: "POST" });
  assert.equal(response.status, 200, `expected a ticket, got ${response.status}`);
  const body = (await response.json()) as { url: string };
  return body.url;
}

describe("forwarding between a machine and a browser", () => {
  let hub: TestHub;

  before(async () => {
    hub = await startTestHub();
  });
  after(async () => {
    await hub.stop();
  });

  it("carries bytes both ways without looking at them", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const uplink = await bringOnline(hub, machine);

    const client = opened(await connect(await ticketFor(hub, machine.machineId)));

    // The machine learns a channel exists.
    const open = decode(await nextMessage(uplink))!;
    assert.equal(open.kind, Kind.Open);

    // Something that is emphatically not JSON: the pipe must not care.
    const payload = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01]);
    client.send(payload);
    const forwarded = decode(await nextMessage(uplink))!;
    assert.equal(forwarded.kind, Kind.Binary);
    assert.equal(forwarded.channel, open.channel);
    assert.deepEqual(forwarded.payload, payload);

    uplink.send(encode(Kind.Text, open.channel, '{"type":"hello"}'));
    assert.equal((await nextMessage(client)).toString(), '{"type":"hello"}');

    client.close();
    uplink.close();
  });

  it("keeps two clients on the same machine apart", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const uplink = await bringOnline(hub, machine);

    const first = opened(await connect(await ticketFor(hub, machine.machineId)));
    const firstOpen = decode(await nextMessage(uplink))!;
    const second = opened(await connect(await ticketFor(hub, machine.machineId)));
    const secondOpen = decode(await nextMessage(uplink))!;

    assert.notEqual(firstOpen.channel, secondOpen.channel);

    uplink.send(encode(Kind.Text, secondOpen.channel, "for the second"));
    assert.equal((await nextMessage(second)).toString(), "for the second");

    // The first client must not have received it. Nothing arrived, so the only
    // honest check is that a read times out.
    await assert.rejects(nextMessage(first, 200), /timed out/);

    first.close();
    second.close();
    uplink.close();
  });

  it("turns away an uplink with no credential, and one with the wrong one", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);

    const bare = await connect(machine.uplinkUrl);
    assert.ok("error" in bare && bare.error.includes("401"), `got ${JSON.stringify(bare)}`);

    const wrong = await connect(machine.uplinkUrl, {
      headers: { authorization: `Bearer ${machine.daemonId}.wrong-secret` },
    });
    assert.ok("error" in wrong && wrong.error.includes("403"), `got ${JSON.stringify(wrong)}`);
  });

  it("spends a channel ticket exactly once", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const uplink = await bringOnline(hub, machine);

    const url = await ticketFor(hub, machine.machineId);
    const first = opened(await connect(url));
    const second = await connect(url);
    assert.ok("error" in second && second.error.includes("403"), `got ${JSON.stringify(second)}`);

    first.close();
    uplink.close();
  });

  it("will not mint a ticket for a machine that is not connected", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const response = await hub.fetch(`/app/machines/${machine.machineId}/connect`, {
      method: "POST",
    });
    assert.equal(response.status, 409);
  });

  it("will not mint a ticket for someone else's machine", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const uplink = await bringOnline(hub, machine);

    // A different browser, a different temporary identity.
    hub.session = null;
    await signIn(hub);
    const response = await hub.fetch(`/app/machines/${machine.machineId}/connect`, {
      method: "POST",
    });
    assert.equal(response.status, 404, "a stranger should not learn the machine exists");

    uplink.close();
  });

  it("drops every attached client when the machine goes away", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const uplink = await bringOnline(hub, machine);
    const client = opened(await connect(await ticketFor(hub, machine.machineId)));
    await nextMessage(uplink);

    uplink.close();
    assert.equal(await closed(client), 4004);
  });

  it("tells the machine when a client detaches", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const uplink = await bringOnline(hub, machine);
    const client = opened(await connect(await ticketFor(hub, machine.machineId)));
    const open = decode(await nextMessage(uplink))!;

    client.close();
    const close = decode(await nextMessage(uplink))!;
    assert.equal(close.kind, Kind.Close);
    assert.equal(close.channel, open.channel);

    uplink.close();
  });

  it("cuts the machine loose the moment its owner revokes it", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const uplink = await bringOnline(hub, machine);
    const client = opened(await connect(await ticketFor(hub, machine.machineId)));
    await nextMessage(uplink);

    const revoked = await hub.fetch(`/app/machines/${machine.machineId}/revoke`, { method: "POST" });
    assert.equal(revoked.status, 200);

    assert.equal(await closed(client), 4403);
    assert.equal(await closed(uplink), 4403);
  });

  it("replaces a machine's uplink when it reconnects", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const first = await bringOnline(hub, machine);
    const second = await bringOnline(hub, machine);

    assert.equal(await closed(first), 4000);
    assert.equal(hub.hub.forwarder!.isOnline(machine.machineId), true);

    second.close();
  });

  it("hangs up on an uplink that sends something that is not a frame", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);
    const uplink = await bringOnline(hub, machine);

    uplink.send("plain text is not the uplink protocol");
    assert.equal(await closed(uplink), 1003);
  });

  it("reports presence to the control plane, and takes it back", async () => {
    await signIn(hub);
    const machine = await enrollMachine(hub);

    const uplink = await bringOnline(hub, machine);
    let me = await hub.json<{ machines: Array<{ id: string; online: boolean }> }>("/app/me");
    assert.equal(me.machines.find((m) => m.id === machine.machineId)?.online, true);

    uplink.close();
    await closed(uplink);
    await new Promise((resolve) => setTimeout(resolve, 50));
    me = await hub.json<{ machines: Array<{ id: string; online: boolean }> }>("/app/me");
    assert.equal(me.machines.find((m) => m.id === machine.machineId)?.online, false);
  });
});
