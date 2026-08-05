import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { WebSocket } from "ws";

import { CLIENT_PATH, DAEMON_PATH } from "../src/contract/index.js";
import { decode, encode, Kind } from "../src/forward/frame.js";
import {
  boundedCloseReason,
  MAX_LEGACY_PAYLOAD_BYTES,
} from "../src/forward/index.js";
import { config } from "../src/shared/config.js";
import { AuthorityHttpError } from "../src/shared/authority-error.js";
import { presenceRefreshDelaySeconds } from "../src/shared/presence-lease.js";
import {
  closed,
  connect,
  nextMessage,
  opened,
  startTestRelay,
  FakeAuthority,
  type TestRelay,
} from "./harness.js";

let relay: TestRelay;
let counter = 0;
let daemonGeneration = 0;

/** Enrols a machine as far as the relay is concerned, and dials its uplink. */
async function bringOnline(machineId = `m_${++counter}`): Promise<{
  machineId: string;
  connectionGeneration: number;
  uplink: WebSocket;
}> {
  const ticket = `uplink-${machineId}`;
  const connectionGeneration = ++daemonGeneration;
  relay.authority.grantDaemon(ticket, {
    machineId,
    daemonId: `dmn_${machineId}`,
    connectionGeneration,
  });
  const uplink = opened(
    await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
      headers: { authorization: `Bearer ${ticket}` },
    }),
  );
  // Presence is reported when the socket registers; give the write a tick.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { machineId, connectionGeneration, uplink };
}

async function attach(machineId: string, clientId = `dev_${counter + 1}`): Promise<WebSocket> {
  const ticket = `client-${machineId}-${++counter}`;
  relay.authority.grantClient(ticket, { machineId, clientId });
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
    const { machineId, connectionGeneration, uplink } = await bringOnline();
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

  it("returns 503, not invalid-ticket 403, when daemon authority is temporarily unavailable", async () => {
    relay.authority.failNextDaemonAuthorization();
    const result = await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
      headers: { authorization: "Bearer short-one-use-admission" },
    });
    assert.ok("error" in result && result.error.includes("503"), JSON.stringify(result));
  });

  it("returns 503 for transient client inspect and redemption failures, then recovers", async () => {
    const { machineId, uplink } = await bringOnline();
    const ticket = `client-transient-${++counter}`;
    relay.authority.grantClient(ticket, { machineId, clientId: `dev_${counter}` });

    relay.authority.failNextClientInspection();
    const inspectFailure = await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=${ticket}`);
    assert.ok(
      "error" in inspectFailure && inspectFailure.error.includes("503"),
      JSON.stringify(inspectFailure),
    );
    assert.ok(relay.authority.clientTickets.has(ticket));

    relay.authority.failNextClientAuthorization();
    const redeemFailure = await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=${ticket}`);
    assert.ok(
      "error" in redeemFailure && redeemFailure.error.includes("503"),
      JSON.stringify(redeemFailure),
    );
    assert.ok(relay.authority.clientTickets.has(ticket));

    const recovered = opened(await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=${ticket}`));
    recovered.close();
    uplink.close();
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

  it("revokes every channel for one client session without crossing into another", async () => {
    const firstMachine = await bringOnline();
    const secondMachine = await bringOnline();
    const revokedId = `dev_revoked_${++counter}`;
    const firstRevoked = await attach(firstMachine.machineId, revokedId);
    const firstRevokedOpen = decode(await nextMessage(firstMachine.uplink))!;
    const secondRevoked = await attach(secondMachine.machineId, revokedId);
    await nextMessage(secondMachine.uplink);
    const survivor = await attach(firstMachine.machineId, `dev_survivor_${counter}`);
    const survivorOpen = decode(await nextMessage(firstMachine.uplink))!;

    const detachedFrame = nextMessage(firstMachine.uplink);
    relay.authority.revokeClient(revokedId);

    assert.equal(await closed(firstRevoked), 4403);
    assert.equal(await closed(secondRevoked), 4403);
    assert.equal(firstMachine.uplink.readyState, firstMachine.uplink.OPEN);
    assert.equal(secondMachine.uplink.readyState, secondMachine.uplink.OPEN);
    assert.equal(survivor.readyState, survivor.OPEN);

    // The daemon is notified immediately, even if the revoked browser never
    // acknowledges its WebSocket close handshake.
    const detached = decode(await detachedFrame)!;
    assert.equal(detached.kind, Kind.Close);
    assert.equal(detached.channel, firstRevokedOpen.channel);

    const survivingFrame = nextMessage(firstMachine.uplink);
    survivor.send("still isolated");
    const forwarded = decode(await survivingFrame)!;
    assert.equal(forwarded.kind, Kind.Text);
    assert.equal(forwarded.channel, survivorOpen.channel);
    assert.equal(forwarded.payload.toString(), "still isolated");

    survivor.close();
    firstMachine.uplink.close();
    secondMachine.uplink.close();
  });

  it("does not resurrect a client whose revocation outran its authorization response", async () => {
    const { machineId, uplink } = await bringOnline();
    const clientId = `dev_inflight_${++counter}`;
    const ticket = `client-inflight-${counter}`;
    relay.authority.grantClient(ticket, { machineId, clientId });
    const gate = relay.authority.holdClientAuthorization(ticket);

    const connecting = connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=${ticket}`);
    await gate.started;
    relay.authority.revokeClient(clientId);
    gate.release();

    const refused = await connecting;
    assert.ok("error" in refused && refused.error.includes("403"), JSON.stringify(refused));
    assert.equal(relay.relay.forwarder.stats().channels, 0);
    uplink.close();
  });

  it("does not resurrect a machine whose revocation outran its authorization response", async () => {
    const machineId = `m_inflight_${++counter}`;
    const ticket = `uplink-inflight-${counter}`;
    relay.authority.grantDaemon(ticket, { machineId, daemonId: `dmn_${machineId}` });
    const gate = relay.authority.holdDaemonAuthorization(ticket);

    const connecting = connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
      headers: { authorization: `Bearer ${ticket}` },
    });
    await gate.started;
    relay.authority.revokeMachine(machineId);
    gate.release();

    const refused = await connecting;
    assert.ok("error" in refused && refused.error.includes("403"), JSON.stringify(refused));
    assert.equal(relay.relay.forwarder.isOnline(machineId), false);
  });

  it("fails every legacy socket closed when its revocation authority disconnects", async () => {
    const { machineId, uplink } = await bringOnline();
    const client = await attach(machineId);
    await nextMessage(uplink);
    const uplinkClosed = closed(uplink);
    const clientClosed = closed(client);

    relay.relay.forwarder.authorityDisconnected();

    assert.equal(await uplinkClosed, 1012);
    assert.equal(await clientClosed, 1012);
    assert.equal(relay.relay.forwarder.stats().machines, 0);
    const refused = await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
      headers: { authorization: "Bearer unavailable" },
    });
    assert.ok("error" in refused && refused.error.includes("503"), JSON.stringify(refused));

    // Tests use an in-memory authority, so explicitly restore readiness for
    // the remaining independent cases in this shared Relay.
    relay.relay.forwarder.authoritySynchronized();
  });

  it("replaces a machine's uplink when it reconnects", async () => {
    const first = await bringOnline();
    const staleClient = await attach(first.machineId);
    await nextMessage(first.uplink);
    const second = await bringOnline(first.machineId);

    assert.equal(await closed(first.uplink), 4000);
    assert.equal(await closed(staleClient), 4000);
    assert.equal(relay.relay.forwarder.isOnline(first.machineId), true);

    assert.equal(
      relay.authority.presence.some(
        (entry) =>
          entry.machineId === first.machineId &&
          entry.connectionGeneration === first.connectionGeneration &&
          entry.state === "offline",
      ),
      false,
      "the replaced generation must not report offline over its successor",
    );
    assert.ok(
      relay.authority.presence.some(
        (entry) =>
          entry.machineId === second.machineId &&
          entry.connectionGeneration === second.connectionGeneration &&
          entry.state === "online",
      ),
    );

    second.uplink.close();
  });

  it("does not let a delayed older authorization replace the newer uplink", async () => {
    const machineId = `m_reordered_${++counter}`;
    const olderTicket = `uplink-reordered-old-${counter}`;
    const newerTicket = `uplink-reordered-new-${counter}`;
    relay.authority.grantDaemon(olderTicket, {
      machineId,
      daemonId: `dmn_${machineId}`,
      connectionGeneration: 41,
    });
    relay.authority.grantDaemon(newerTicket, {
      machineId,
      daemonId: `dmn_${machineId}`,
      connectionGeneration: 42,
    });
    const gate = relay.authority.holdDaemonAuthorization(olderTicket);
    const olderConnecting = connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
      headers: { authorization: `Bearer ${olderTicket}` },
    });
    await gate.started;

    const newer = opened(
      await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: `Bearer ${newerTicket}` },
      }),
    );
    gate.release();
    const older = opened(await olderConnecting);

    assert.equal(await closed(older), 4409);
    assert.equal(newer.readyState, newer.OPEN);
    assert.equal(relay.relay.forwarder.isOnline(machineId), true);
    assert.equal(
      relay.authority.presence.some(
        (entry) =>
          entry.machineId === machineId &&
          entry.connectionGeneration === 41 &&
          entry.state === "online",
      ),
      false,
      "a rejected stale socket must never acquire a presence lease",
    );
    newer.close();
  });

  it("keeps the generation fence after the newer socket disconnects", async () => {
    const machineId = `m_reordered_closed_${++counter}`;
    const olderTicket = `uplink-reordered-closed-old-${counter}`;
    const newerTicket = `uplink-reordered-closed-new-${counter}`;
    relay.authority.grantDaemon(olderTicket, {
      machineId,
      daemonId: `dmn_${machineId}`,
      connectionGeneration: 70,
    });
    relay.authority.grantDaemon(newerTicket, {
      machineId,
      daemonId: `dmn_${machineId}`,
      connectionGeneration: 71,
    });
    const gate = relay.authority.holdDaemonAuthorization(olderTicket);
    const olderConnecting = connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
      headers: { authorization: `Bearer ${olderTicket}` },
    });
    await gate.started;
    const newer = opened(
      await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: `Bearer ${newerTicket}` },
      }),
    );
    const newerClosed = closed(newer);
    newer.close();
    await newerClosed;

    gate.release();
    const older = opened(await olderConnecting);
    assert.equal(await closed(older), 4409);
    assert.equal(relay.relay.forwarder.isOnline(machineId), false);
  });

  it("keeps the generation fence across an authority outage", async () => {
    const isolated = await startTestRelay();
    try {
      isolated.authority.grantDaemon("outage-new", {
        machineId: "m_fenced_outage",
        daemonId: "d_fenced_outage",
        connectionGeneration: 12,
      });
      const current = opened(
        await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
          headers: { authorization: "Bearer outage-new" },
        }),
      );
      const currentClosed = closed(current);
      isolated.relay.forwarder.authorityDisconnected();
      assert.equal(await currentClosed, 1012);
      isolated.relay.forwarder.authoritySynchronized();

      isolated.authority.grantDaemon("outage-stale", {
        machineId: "m_fenced_outage",
        daemonId: "d_fenced_outage",
        connectionGeneration: 11,
      });
      const stale = opened(
        await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
          headers: { authorization: "Bearer outage-stale" },
        }),
      );
      assert.equal(await closed(stale), 4409);
      assert.equal(isolated.relay.forwarder.isOnline("m_fenced_outage"), false);
    } finally {
      await isolated.stop();
    }
  });

  it("rejects an equal admission generation without disturbing the live uplink", async () => {
    const machineId = `m_equal_generation_${++counter}`;
    for (const ticket of ["first", "duplicate"]) {
      relay.authority.grantDaemon(`${ticket}-${machineId}`, {
        machineId,
        daemonId: `dmn_${machineId}`,
        connectionGeneration: 90,
      });
    }
    const first = opened(
      await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: `Bearer first-${machineId}` },
      }),
    );
    const duplicate = opened(
      await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: `Bearer duplicate-${machineId}` },
      }),
    );
    assert.equal(await closed(duplicate), 4409);
    assert.equal(first.readyState, first.OPEN);
    assert.equal(relay.relay.forwarder.isOnline(machineId), true);
    first.close();
  });

  it("fails unseen machines closed when the legacy generation fence budget is full", async () => {
    const limits = config.limits as { maxLegacyGenerationFences: number };
    const previousLimit = limits.maxLegacyGenerationFences;
    limits.maxLegacyGenerationFences = 1;
    const isolated = await startTestRelay();
    try {
      isolated.authority.grantDaemon("fence-first", {
        machineId: "m_fence_first",
        daemonId: "d_fence_first",
        connectionGeneration: 1,
      });
      const first = opened(
        await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
          headers: { authorization: "Bearer fence-first" },
        }),
      );
      const firstClosed = closed(first);
      first.close();
      await firstClosed;

      isolated.authority.grantDaemon("fence-unseen", {
        machineId: "m_fence_unseen",
        daemonId: "d_fence_unseen",
        connectionGeneration: 1,
      });
      const unseen = opened(
        await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
          headers: { authorization: "Bearer fence-unseen" },
        }),
      );
      assert.equal(await closed(unseen), 4429);

      // An existing identity may still advance; capacity never evicts its
      // security fence or turns a normal reconnect into a permanent outage.
      isolated.authority.grantDaemon("fence-first-new", {
        machineId: "m_fence_first",
        daemonId: "d_fence_first",
        connectionGeneration: 2,
      });
      const replacement = opened(
        await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
          headers: { authorization: "Bearer fence-first-new" },
        }),
      );
      assert.equal(replacement.readyState, replacement.OPEN);
      replacement.close();
    } finally {
      await isolated.stop();
      limits.maxLegacyGenerationFences = previousLimit;
    }
  });

  it("allows a same-machine replacement when the daemon table is full", async () => {
    const limits = config.limits as { maxDaemons: number };
    const previousLimit = limits.maxDaemons;
    limits.maxDaemons = 1;
    const isolated = await startTestRelay();
    try {
      const machineId = "m_only_slot";
      isolated.authority.grantDaemon("first", { machineId, daemonId: "d1" });
      const first = opened(
        await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
          headers: { authorization: "Bearer first" },
        }),
      );
      isolated.authority.grantDaemon("replacement", { machineId, daemonId: "d2" });
      const replacement = opened(
        await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
          headers: { authorization: "Bearer replacement" },
        }),
      );
      assert.equal(await closed(first), 4000);

      isolated.authority.grantDaemon("different", {
        machineId: "m_different",
        daemonId: "d3",
      });
      const refused = await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: "Bearer different" },
      });
      assert.ok("error" in refused && refused.error.includes("503"));
      replacement.close();
    } finally {
      await isolated.stop();
      limits.maxDaemons = previousLimit;
    }
  });

  it("enforces the frame limit before ws assembles an oversized message", async () => {
    const { machineId, uplink } = await bringOnline();
    const client = await attach(machineId);
    await nextMessage(uplink);

    client.send(Buffer.alloc(MAX_LEGACY_PAYLOAD_BYTES));
    const boundary = decode(await nextMessage(uplink))!;
    assert.equal(boundary.payload.length, MAX_LEGACY_PAYLOAD_BYTES);

    client.send(Buffer.alloc(MAX_LEGACY_PAYLOAD_BYTES + 1));
    assert.equal(await closed(client), 1009);
    uplink.close();
  });

  it("closes upgrades no forwarding transport owns", async () => {
    const result = await connect(`${relay.wsOrigin}/not-a-relay-path`);
    assert.ok("error" in result && result.error.includes("404"), JSON.stringify(result));
  });

  it("hangs up on an uplink that sends something that is not a frame", async () => {
    const { uplink } = await bringOnline();
    uplink.send("plain text is not the uplink protocol");
    assert.equal(await closed(uplink), 1003);
  });

  it("reports presence to the control plane, and takes it back", async () => {
    const { machineId, connectionGeneration, uplink } = await bringOnline();
    assert.deepEqual(relay.authority.presence.at(-1), {
      machineId,
      connectionGeneration,
      state: "online",
    });

    uplink.close();
    await closed(uplink);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(relay.authority.presence.at(-1), {
      machineId,
      connectionGeneration,
      state: "offline",
    });
  });

  it("serializes presence so a delayed online cannot overwrite offline", async () => {
    const gate = relay.authority.holdNextPresenceReport();
    const machineId = `m_presence_race_${++counter}`;
    const connectionGeneration = ++daemonGeneration;
    const ticket = `uplink-${machineId}`;
    relay.authority.grantDaemon(ticket, {
      machineId,
      daemonId: `dmn_${machineId}`,
      connectionGeneration,
    });
    const uplink = opened(
      await connect(`${relay.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: `Bearer ${ticket}` },
      }),
    );
    await gate.started;
    uplink.close();
    await closed(uplink);
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(
      relay.authority.presence.filter((entry) => entry.machineId === machineId),
      [
        { machineId, connectionGeneration, state: "online" },
        { machineId, connectionGeneration, state: "offline" },
      ],
    );
  });

  it("clamps attacker-controlled close reasons without crashing Relay", async () => {
    const { machineId, uplink } = await bringOnline();
    const clientId = `dev_long_reason_${++counter}`;
    const client = await attach(machineId, clientId);
    await nextMessage(uplink);
    relay.authority.revokeClient(clientId, "恶".repeat(10_000));
    assert.equal(await closed(client), 4403);
    assert.equal(uplink.readyState, uplink.OPEN);
    uplink.close();
  });

  it("contains a rejected presence report instead of emitting an unhandled rejection", async () => {
    relay.authority.failNextPresenceReport();
    const { machineId, connectionGeneration, uplink } = await bringOnline();
    assert.equal(relay.relay.forwarder.isOnline(machineId), true);
    uplink.close();
  });

  it("retries a failed presence report without another socket event", async () => {
    relay.authority.failNextPresenceReport();
    const { machineId, connectionGeneration, uplink } = await bringOnline();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(
      relay.authority.presence.some(
        (entry) => entry.machineId === machineId && entry.state === "online",
      ),
      "the control plane would otherwise believe a live machine is offline forever",
    );
    uplink.close();
  });

  it("refreshes the crash-safe presence lease on a low-frequency timer", async () => {
    const limits = config.limits as { presenceRefreshMaxSeconds: number };
    const previous = limits.presenceRefreshMaxSeconds;
    limits.presenceRefreshMaxSeconds = 0.01;
    const isolated = await startTestRelay();
    try {
      isolated.authority.grantDaemon("refresh", {
        machineId: "m_refresh",
        daemonId: "d_refresh",
        connectionGeneration: 17,
      });
      const uplink = opened(
        await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
          headers: { authorization: "Bearer refresh" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 35));
      assert.ok(
        isolated.authority.presence.filter(
          (entry) => entry.machineId === "m_refresh" && entry.state === "online",
        ).length >= 2,
      );
      uplink.close();
    } finally {
      await isolated.stop();
      limits.presenceRefreshMaxSeconds = previous;
    }
  });

  it("derives refresh cadence from Control's lease despite mismatched local config", () => {
    assert.equal(presenceRefreshDelaySeconds(90, 300), 45);
    assert.equal(presenceRefreshDelaySeconds(600, 60), 60);
    assert.equal(presenceRefreshDelaySeconds(60, 10), 10);
  });

  it("fails a machine closed when online presence is definitively refused", async () => {
    const authority = new FakeAuthority();
    authority.reportPresence = async (_machineId, _generation, state) => {
      if (state === "online") throw new AuthorityHttpError("refused", 403);
    };
    const isolated = await startTestRelay(authority);
    authority.grantDaemon("presence-refused", {
      machineId: "m_presence_refused",
      daemonId: "d_presence_refused",
    });
    const uplink = opened(
      await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: "Bearer presence-refused" },
      }),
    );
    try {
      assert.equal(await closed(uplink), 1012);
      assert.equal(isolated.relay.forwarder.isOnline("m_presence_refused"), false);
    } finally {
      await isolated.stop();
    }
  });

  it("treats Control's stale-generation conflict as a definitive presence refusal", async () => {
    const authority = new FakeAuthority();
    authority.reportPresence = async (_machineId, _generation, state) => {
      if (state === "online") throw new AuthorityHttpError("stale generation", 409);
    };
    const isolated = await startTestRelay(authority);
    authority.grantDaemon("presence-stale", {
      machineId: "m_presence_stale",
      daemonId: "d_presence_stale",
      connectionGeneration: 3,
    });
    const uplink = opened(
      await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: "Bearer presence-stale" },
      }),
    );
    try {
      assert.equal(await closed(uplink), 1012);
      assert.equal(isolated.relay.forwarder.isOnline("m_presence_stale"), false);
    } finally {
      await isolated.stop();
    }
  });

  it("retries transient presence failures only until the granted lease expires", async () => {
    const authority = new FakeAuthority();
    let onlineAttempts = 0;
    authority.reportPresence = async (_machineId, _generation, state) => {
      if (state === "online") {
        onlineAttempts += 1;
        throw new Error("Control unavailable");
      }
    };
    const isolated = await startTestRelay(authority);
    authority.grantDaemon("presence-expiry", {
      machineId: "m_presence_expiry",
      daemonId: "d_presence_expiry",
      // Injected authority used only to make the hard-deadline test fast.
      presenceLeaseSeconds: 0.05,
    });
    const uplink = opened(
      await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: "Bearer presence-expiry" },
      }),
    );
    try {
      assert.equal(await closed(uplink), 1012);
      assert.ok(onlineAttempts >= 2);
      assert.equal(isolated.relay.forwarder.isOnline("m_presence_expiry"), false);
    } finally {
      await isolated.stop();
    }
  });

  it("lets offline state wake and replace a delayed online retry", async () => {
    relay.authority.failNextPresenceReport();
    const { machineId, connectionGeneration, uplink } = await bringOnline();
    uplink.close();
    await closed(uplink);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reports = relay.authority.presence.filter(
      (entry) => entry.machineId === machineId,
    );
    assert.deepEqual(reports, [
      { machineId, connectionGeneration, state: "offline" },
    ]);
  });

  it("cancels presence retries when Relay closes", async () => {
    const isolated = await startTestRelay();
    isolated.authority.failNextPresenceReport();
    isolated.authority.grantDaemon("presence-close", {
      machineId: "m_presence_close",
      daemonId: "d_presence_close",
    });
    opened(
      await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: "Bearer presence-close" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await isolated.stop();
    assert.ok(
      isolated.authority.presence.some(
        (entry) =>
          entry.machineId === "m_presence_close" && entry.state === "offline",
      ),
      "graceful shutdown should not wait for the lease to expire",
    );
    const calls = isolated.authority.calls.filter(
      (call) => call === "reportPresence",
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      isolated.authority.calls.filter((call) => call === "reportPresence").length,
      calls,
    );
  });

  it("bounds graceful presence flush when Control remains unavailable", async () => {
    const authority = new FakeAuthority();
    authority.reportPresence = async () => {
      throw new Error("Control stays down");
    };
    const isolated = await startTestRelay(authority);
    authority.grantDaemon("shutdown-timeout", {
      machineId: "m_shutdown_timeout",
      daemonId: "d_shutdown_timeout",
      connectionGeneration: 1,
    });
    opened(
      await connect(`${isolated.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: "Bearer shutdown-timeout" },
      }),
    );
    const started = Date.now();
    await isolated.stop();
    assert.ok(Date.now() - started < 1_500, "shutdown waited indefinitely on Control");
  });

  it("bounds a multi-megabyte close reason in linear prefix work", () => {
    const ascii = boundedCloseReason("x".repeat(4 * 1024 * 1024));
    const unicode = boundedCloseReason("恶".repeat(2 * 1024 * 1024));
    assert.equal(Buffer.byteLength(ascii), 123);
    assert.ok(Buffer.byteLength(unicode) <= 123);
    assert.ok(!unicode.endsWith("�"));
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
    const health = await relay.json<{
      status: string;
      ready: boolean;
      forward: { machines: number; channels: number; authorityReady: boolean };
    }>(
      "/api/health",
    );
    assert.equal(health.status, "ok");
    assert.equal(health.ready, true);
    assert.equal(health.forward.authorityReady, true);
    assert.deepEqual(Object.keys(health.forward).sort(), [
      "authorityReady",
      "channels",
      "machines",
    ]);
  });
});
