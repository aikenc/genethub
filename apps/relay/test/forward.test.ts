import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { WebSocket } from "ws";

import { CLIENT_PATH, DAEMON_PATH } from "../src/contract/index.js";
import { decode, encode, Kind } from "../src/forward/frame.js";
import {
  closed,
  connect,
  nextMessage,
  opened,
  startTestRelay,
  type TestRelay,
} from "./harness.js";

let relay: TestRelay;
let counter = 0;

/** Enrols a machine as far as the relay is concerned, and dials its uplink. */
async function bringOnline(machineId = `m_${++counter}`): Promise<{
  machineId: string;
  uplink: WebSocket;
}> {
  const ticket = `uplink-${machineId}`;
  relay.authority.grantDaemon(ticket, { machineId, daemonId: `dmn_${machineId}` });
  const uplink = opened(
    await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
      headers: { authorization: `Bearer ${ticket}` },
    }),
  );
  // Presence is reported when the socket registers; give the write a tick.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { machineId, uplink };
}

async function attach(machineId: string): Promise<WebSocket> {
  const ticket = `client-${machineId}-${++counter}`;
  relay.authority.grantClient(ticket, { machineId, clientId: `dev_${counter}` });
  return opened(await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=${ticket}`));
}

describe("forwarding between a machine and a browser", () => {
  before(async () => {
    relay = await startTestRelay();
  });
  after(async () => {
    await relay.stop();
  });

  it("carries bytes both ways without looking at them", async () => {
    const { machineId, uplink } = await bringOnline();
    const client = await attach(machineId);

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
    const { machineId, uplink } = await bringOnline();

    const first = await attach(machineId);
    const firstOpen = decode(await nextMessage(uplink))!;
    const second = await attach(machineId);
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

  it("turns away an uplink with no credential, and one the control plane refuses", async () => {
    const bare = await connect(`${relay.wsOrigin}${DAEMON_PATH}`);
    assert.ok("error" in bare && bare.error.includes("401"), `got ${JSON.stringify(bare)}`);

    const wrong = await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
      headers: { authorization: "Bearer nobody-issued-this" },
    });
    assert.ok("error" in wrong && wrong.error.includes("403"), `got ${JSON.stringify(wrong)}`);
  });

  it("leaves single use up to the control plane and honours the answer", async () => {
    const { machineId, uplink } = await bringOnline();
    const ticket = `one-shot-${machineId}`;
    relay.authority.grantClient(ticket, { machineId, clientId: "dev_1" });

    const first = opened(await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=${ticket}`));
    const second = await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=${ticket}`);
    assert.ok("error" in second && second.error.includes("403"), `got ${JSON.stringify(second)}`);

    first.close();
    uplink.close();
  });

  it("refuses a client whose machine has no uplink without spending the ticket", async () => {
    const ticket = "client-for-an-absent-machine";
    relay.authority.grantClient(ticket, { machineId: "m_absent", clientId: "dev_1" });
    const result = await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=${ticket}`);
    assert.ok("error" in result && result.error.includes("409"), `got ${JSON.stringify(result)}`);
    // The ticket must still be there — burning it on a 409 is what made a
    // brief offline blip look like a permanent「已断开」on the desktop.
    assert.ok(relay.authority.clientTickets.has(ticket), "offline refusal spent the ticket");
  });

  it("drops every attached client when the machine goes away", async () => {
    const { machineId, uplink } = await bringOnline();
    const client = await attach(machineId);
    await nextMessage(uplink);

    uplink.close();
    assert.equal(await closed(client), 4004);
  });

  it("tells the machine when a client detaches", async () => {
    const { machineId, uplink } = await bringOnline();
    const client = await attach(machineId);
    const open = decode(await nextMessage(uplink))!;

    client.close();
    const close = decode(await nextMessage(uplink))!;
    assert.equal(close.kind, Kind.Close);
    assert.equal(close.channel, open.channel);

    uplink.close();
  });

  it("cuts the machine loose the moment the control plane revokes it", async () => {
    const { machineId, uplink } = await bringOnline();
    const client = await attach(machineId);
    await nextMessage(uplink);

    relay.authority.revokeMachine(machineId);

    assert.equal(await closed(client), 4403);
    assert.equal(await closed(uplink), 4403);
  });

  it("replaces a machine's uplink when it reconnects", async () => {
    const first = await bringOnline();
    const second = await bringOnline(first.machineId);

    assert.equal(await closed(first.uplink), 4000);
    assert.equal(relay.relay.forwarder.isOnline(first.machineId), true);

    second.uplink.close();
  });

  it("hangs up on an uplink that sends something that is not a frame", async () => {
    const { uplink } = await bringOnline();
    uplink.send("plain text is not the uplink protocol");
    assert.equal(await closed(uplink), 1003);
  });

  it("reports presence to the control plane, and takes it back", async () => {
    const { machineId, uplink } = await bringOnline();
    assert.deepEqual(relay.authority.presence.at(-1), { machineId, state: "online" });

    uplink.close();
    await closed(uplink);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(relay.authority.presence.at(-1), { machineId, state: "offline" });
  });

  it("re-reports every machine it holds when the control plane comes back", async () => {
    // The control plane boots every machine to offline, and presence is
    // otherwise only reported on change — without this a restart of it
    // strands live machines as "offline" until each reconnects on its own.
    const first = await bringOnline();
    const second = await bringOnline();
    const already = relay.authority.presence.length;

    relay.relay.forwarder.resyncPresence();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fresh = relay.authority.presence.slice(already);
    const reported = fresh.map((entry) => entry.machineId);
    assert.ok(reported.includes(first.machineId), `${first.machineId} was not re-reported`);
    assert.ok(reported.includes(second.machineId), `${second.machineId} was not re-reported`);
    assert.ok(
      fresh.every((entry) => entry.state === "online"),
      "a resync must not take anything offline: it cannot see other relays' machines",
    );

    first.uplink.close();
    second.uplink.close();
  });

  it("says how many machines and channels it holds, and nothing about them", async () => {
    const health = await relay.json<{ status: string; forward: Record<string, number> }>(
      "/api/health",
    );
    assert.equal(health.status, "ok");
    assert.deepEqual(Object.keys(health.forward).sort(), ["channels", "machines"]);
  });
});
