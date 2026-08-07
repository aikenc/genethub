import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { WebSocket } from "ws";

import { FABRIC_PATH } from "../src/contract/fabric-wire.js";
import {
  decodeFabricFrame,
  encodeFabricFrame,
  encodeFabricOpenPayload,
  FabricKind,
  type FabricFrame,
  FABRIC_INITIAL_STREAM_CREDIT,
  FabricReset,
} from "../src/forward/fabric-frame.js";
import { AuthorityHttpError } from "../src/shared/authority-error.js";
import { config } from "../src/shared/config.js";
import {
  closed,
  connect,
  FakeFabricAuthority,
  nextMessage,
  opened,
  startTestRelay,
  type TestRelay,
} from "./harness.js";

function id(value: number): string {
  return value.toString(16).padStart(32, "0");
}

const CREDIT = BigInt(FABRIC_INITIAL_STREAM_CREDIT);

function wire(frame: FabricFrame): Buffer {
  return encodeFabricFrame(frame);
}

function data(streamId: string, sequence: bigint, payload: string): Buffer {
  return wire({
    kind: FabricKind.Data,
    streamId,
    value: sequence,
    payload: Buffer.from(payload),
  });
}

async function nextFabric(socket: WebSocket): Promise<FabricFrame> {
  const decoded = decodeFabricFrame(await nextMessage(socket));
  assert.ok(decoded, "expected a valid Fabric frame");
  return decoded;
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

describe("Fabric v2 over real WebSockets", () => {
  const authority = new FakeFabricAuthority();
  const sockets = new Set<WebSocket>();
  let stack: TestRelay;

  beforeEach(async () => {
    stack = await startTestRelay(authority);
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    await stack.stop();
  });

  async function endpoint(
    credential: string,
    handle: string,
    options: {
      bearer?: boolean;
      revocationHandle?: string;
      expiresAt?: string | null;
      connectionGeneration?: number;
      presenceLeaseSeconds?: number;
    } = {},
  ): Promise<WebSocket> {
    authority.grantEndpoint(credential, handle, options);
    const result = options.bearer
      ? await connect(`${stack.wsOrigin}${FABRIC_PATH}`, {
          headers: { authorization: `Bearer ${credential}` },
        })
      : await connect(`${stack.wsOrigin}${FABRIC_PATH}?ticket=${credential}`);
    const socket = opened(result);
    sockets.add(socket);
    return socket;
  }

  async function openRoute(
    source: WebSocket,
    target: WebSocket,
    sourceStreamId: string,
    ticket: string,
    targetHandle: string,
    routeHandle = `route:${ticket}`,
  ): Promise<string> {
    authority.grantRoute(ticket, targetHandle, { routeHandle });
    const incomingPromise = nextFabric(target);
    source.send(
      wire({
        kind: FabricKind.Open,
        streamId: sourceStreamId,
        value: CREDIT,
        payload: encodeFabricOpenPayload(ticket, Buffer.from(`hello:${ticket}`)),
      }),
    );
    const incoming = await incomingPromise;
    assert.equal(incoming.kind, FabricKind.Incoming);
    assert.deepEqual(incoming.payload, Buffer.from(`hello:${ticket}`));

    const acceptedPromise = nextFabric(source);
    target.send(
      wire({
        kind: FabricKind.Accept,
        streamId: incoming.streamId,
        value: CREDIT,
        payload: Buffer.from(`accepted:${ticket}`),
      }),
    );
    const accepted = await acceptedPromise;
    assert.equal(accepted.kind, FabricKind.Accept);
    assert.equal(accepted.streamId, sourceStreamId);
    assert.deepEqual(accepted.payload, Buffer.from(`accepted:${ticket}`));
    return incoming.streamId;
  }

  it("uses one endpoint WS for two targets and lets a receiving endpoint OPEN back", async () => {
    const browser = await endpoint("credential:browser", "endpoint:browser");
    const nodeA = await endpoint("credential:node-a", "endpoint:node-a", { bearer: true });
    const nodeB = await endpoint("credential:node-b", "endpoint:node-b", { bearer: true });

    const atA = await openRoute(browser, nodeA, id(1), "ticket:browser-a", "endpoint:node-a");
    const atB = await openRoute(browser, nodeB, id(2), "ticket:browser-b", "endpoint:node-b");

    const aData = nextFabric(nodeA);
    const bData = nextFabric(nodeB);
    browser.send(data(id(1), 1n, "only node a"));
    browser.send(data(id(2), 1n, "only node b"));
    assert.deepEqual(await aData, {
      kind: FabricKind.Data,
      flags: 0,
      streamId: atA,
      value: 1n,
      payload: Buffer.from("only node a"),
    });
    assert.deepEqual(await bData, {
      kind: FabricKind.Data,
      flags: 0,
      streamId: atB,
      value: 1n,
      payload: Buffer.from("only node b"),
    });

    // nodeA is already the responder of browser's first stream. Its same socket
    // can initiate another operation; endpoint kind never determines direction.
    const atNodeB = await openRoute(
      nodeA,
      nodeB,
      id(3),
      "ticket:node-a-b",
      "endpoint:node-b",
    );
    const reverse = nextFabric(nodeB);
    nodeA.send(data(id(3), 1n, "node a to node b"));
    assert.deepEqual(await reverse, {
      kind: FabricKind.Data,
      flags: 0,
      streamId: atNodeB,
      value: 1n,
      payload: Buffer.from("node a to node b"),
    });

    assert.deepEqual(stack.relay.fabricForwarder?.stats(), {
      endpoints: 3,
      streams: 3,
      pendingOpens: 0,
    });
  });

  it("scopes equal and guessed stream ids to the actual socket", async () => {
    const sourceA = await endpoint("credential:source-a", "endpoint:source-a");
    const sourceB = await endpoint("credential:source-b", "endpoint:source-b");
    const target = await endpoint("credential:target", "endpoint:target");
    const attacker = await endpoint("credential:attacker", "endpoint:attacker");
    const sameLocalId = id(10);

    const peerA = await openRoute(
      sourceA,
      target,
      sameLocalId,
      "ticket:source-a",
      "endpoint:target",
    );
    const peerB = await openRoute(
      sourceB,
      target,
      sameLocalId,
      "ticket:source-b",
      "endpoint:target",
    );
    assert.notEqual(peerA, peerB, "the relay gives the target independent local ids");

    const guessedSourceReset = nextFabric(attacker);
    attacker.send(data(sameLocalId, 1n, "guessed source leg"));
    assert.deepEqual(await guessedSourceReset, {
      kind: FabricKind.Reset,
      flags: 0,
      streamId: sameLocalId,
      value: BigInt(FabricReset.UnknownStream),
      payload: Buffer.alloc(0),
    });

    const guessedTargetReset = nextFabric(attacker);
    attacker.send(data(peerA, 1n, "guessed target leg"));
    assert.equal((await guessedTargetReset).value, BigInt(FabricReset.UnknownStream));

    const fromA = nextFabric(target);
    sourceA.send(data(sameLocalId, 1n, "really a"));
    assert.deepEqual(await fromA, {
      kind: FabricKind.Data,
      flags: 0,
      streamId: peerA,
      value: 1n,
      payload: Buffer.from("really a"),
    });

    const fromB = nextFabric(target);
    sourceB.send(data(sameLocalId, 1n, "really b"));
    assert.deepEqual(await fromB, {
      kind: FabricKind.Data,
      flags: 0,
      streamId: peerB,
      value: 1n,
      payload: Buffer.from("really b"),
    });
  });

  it("cleans old epochs, route revocations, and endpoint revocations", async () => {
    const oldSource = await endpoint("credential:old-source", "endpoint:source", {
      connectionGeneration: 3,
    });
    const target = await endpoint("credential:reconnect-target", "endpoint:target");
    await openRoute(
      oldSource,
      target,
      id(20),
      "ticket:old-route",
      "endpoint:target",
      "route:old",
    );

    const oldClosed = closed(oldSource);
    const targetReset = nextFabric(target);
    const replacement = await endpoint("credential:new-source", "endpoint:source", {
      connectionGeneration: 4,
    });
    assert.equal(await oldClosed, 4000);
    assert.equal((await targetReset).value, BigInt(FabricReset.EndpointClosed));

    await openRoute(
      replacement,
      target,
      id(20),
      "ticket:new-route",
      "endpoint:target",
      "route:new",
    );
    const sourceReset = nextFabric(replacement);
    const peerReset = nextFabric(target);
    authority.revoke({ target: "route", handle: "route:new" });
    assert.equal((await sourceReset).value, BigInt(FabricReset.Revoked));
    assert.equal((await peerReset).value, BigInt(FabricReset.Revoked));

    const replacementClosed = closed(replacement);
    authority.revoke({ target: "endpoint", handle: "revoke:endpoint:source" });
    assert.equal(await replacementClosed, 4403);
    assert.equal(stack.relay.fabricForwarder?.stats().streams, 0);
    assert.ok(
      authority.presence.some(
        (presence) =>
          presence.endpointHandle === "endpoint:source" &&
          presence.connectionGeneration === 3 &&
          presence.state === "online",
      ),
    );
    assert.ok(
      authority.presence.some(
        (presence) =>
          presence.endpointHandle === "endpoint:source" &&
          presence.connectionGeneration === 4 &&
          presence.state === "online",
      ),
      "presence carries the authority-issued reconnect fence",
    );
  });

  it("does not let a delayed stale or equal admission replace the newest socket", async () => {
    const staleCredential = "credential:delayed-stale";
    authority.grantEndpoint(staleCredential, "endpoint:generation-fence", {
      connectionGeneration: 12,
    });
    const held = authority.holdEndpointAuthorization(staleCredential);
    const delayedStale = connect(`${stack.wsOrigin}${FABRIC_PATH}?ticket=${staleCredential}`);
    await held.started;

    const current = await endpoint(
      "credential:generation-current",
      "endpoint:generation-fence",
      { connectionGeneration: 13 },
    );
    held.release();
    const stale = opened(await delayedStale);
    sockets.add(stale);
    assert.equal(await closed(stale), 4409);

    const equal = await endpoint(
      "credential:generation-equal",
      "endpoint:generation-fence",
      { connectionGeneration: 13 },
    );
    assert.equal(await closed(equal), 4409);

    const pong = nextFabric(current);
    current.send(
      wire({
        kind: FabricKind.Ping,
        streamId: id(0),
        value: 41n,
        payload: Buffer.alloc(0),
      }),
    );
    assert.deepEqual(await pong, {
      kind: FabricKind.Pong,
      flags: 0,
      streamId: id(0),
      value: 41n,
      payload: Buffer.alloc(0),
    });
    assert.equal(stack.relay.fabricForwarder?.stats().endpoints, 1);
  });

  it("never installs an admission that crossed an authority outage", async () => {
    const heldCredential = "credential:held-across-outage";
    authority.grantEndpoint(heldCredential, "endpoint:outage-fence", {
      connectionGeneration: 21,
    });
    const held = authority.holdEndpointAuthorization(heldCredential);
    const staleAttempt = connect(
      `${stack.wsOrigin}${FABRIC_PATH}?ticket=${heldCredential}`,
    );
    await held.started;

    stack.relay.fabricForwarder?.authorityDisconnected();
    stack.relay.fabricForwarder?.authoritySynchronized();
    held.release();

    const staleResult = await staleAttempt;
    assert.ok("error" in staleResult, "the pre-outage raw upgrade must be destroyed");
    assert.equal(stack.relay.fabricForwarder?.stats().endpoints, 0);

    const fresh = await endpoint(
      "credential:fresh-after-outage",
      "endpoint:outage-fence",
      { connectionGeneration: 22 },
    );
    const pong = nextFabric(fresh);
    fresh.send(
      wire({
        kind: FabricKind.Ping,
        streamId: id(0),
        value: 42n,
        payload: Buffer.alloc(0),
      }),
    );
    assert.equal((await pong).kind, FabricKind.Pong);
    assert.equal(stack.relay.fabricForwarder?.stats().endpoints, 1);
  });

  it("drops every active operation when the revocation authority disconnects", async () => {
    const source = await endpoint("credential:authority-source", "endpoint:authority-source", {
      connectionGeneration: 11,
    });
    const target = await endpoint("credential:authority-target", "endpoint:authority-target", {
      connectionGeneration: 5,
    });
    await openRoute(
      source,
      target,
      id(30),
      "ticket:authority-route",
      "endpoint:authority-target",
    );

    const sourceClosed = closed(source);
    const targetClosed = closed(target);
    stack.relay.fabricForwarder?.authorityDisconnected();
    assert.equal(await sourceClosed, 1012);
    assert.equal(await targetClosed, 1012);
    assert.deepEqual(stack.relay.fabricForwarder?.stats(), {
      endpoints: 0,
      streams: 0,
      pendingOpens: 0,
    });

    authority.grantEndpoint("credential:during-outage", "endpoint:during-outage");
    assert.deepEqual(
      await connect(`${stack.wsOrigin}${FABRIC_PATH}?ticket=credential:during-outage`),
      { error: "503" },
    );
    stack.relay.fabricForwarder?.authoritySynchronized();
    const reopened = await endpoint(
      "credential:after-authority-sync",
      "endpoint:after-authority-sync",
    );
    assert.equal(reopened.readyState, reopened.OPEN);
  });

  it("coalesces a presence storm to one in-flight and one latest state", async () => {
    const originalReport = authority.reportEndpointPresence.bind(authority);
    const attempts: Array<{
      endpointHandle: string;
      connectionGeneration: number;
      state: "online" | "offline";
    }> = [];
    const releases: Array<() => void> = [];
    authority.reportEndpointPresence = async (
      endpointHandle,
      connectionGeneration,
      state,
    ) => {
      attempts.push({ endpointHandle, connectionGeneration, state });
      await new Promise<void>((resolve) => releases.push(resolve));
    };

    try {
      const socket = await endpoint(
        "credential:presence-storm",
        "endpoint:presence-storm",
        { connectionGeneration: 77 },
      );
      await waitFor(() => attempts.length === 1, "initial presence report did not start");

      for (let index = 0; index < 10_000; index += 1) {
        stack.relay.fabricForwarder?.resyncPresence();
      }
      const didClose = closed(socket);
      socket.close();
      await didClose;
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(
        attempts.length,
        1,
        "slow Control must not create one Promise/request per heartbeat",
      );
      releases.shift()!();
      await waitFor(() => attempts.length === 2, "latest presence report did not start");
      assert.deepEqual(attempts[1], {
        endpointHandle: "endpoint:presence-storm",
        connectionGeneration: 77,
        state: "offline",
      });

      releases.shift()!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(attempts.length, 2);
    } finally {
      for (const release of releases.splice(0)) release();
      authority.reportEndpointPresence = originalReport;
    }
  });

  it("retries transient Fabric presence failure without endpoint traffic", async () => {
    const originalReport = authority.reportEndpointPresence.bind(authority);
    let onlineAttempts = 0;
    authority.reportEndpointPresence = async (handle, generation, state) => {
      if (state === "online" && ++onlineAttempts === 1) {
        throw new Error("Control unavailable");
      }
      await originalReport(handle, generation, state);
    };
    try {
      const socket = await endpoint("credential:presence-retry", "endpoint:presence-retry");
      await waitFor(() => onlineAttempts >= 2, "presence retry did not run");
      assert.equal(socket.readyState, socket.OPEN);
    } finally {
      authority.reportEndpointPresence = originalReport;
    }
  });

  it("refreshes Fabric from the granted lease independently of heartbeat traffic", async () => {
    const limits = config.limits as { fabricPresenceRefreshMaxSeconds: number };
    const previous = limits.fabricPresenceRefreshMaxSeconds;
    limits.fabricPresenceRefreshMaxSeconds = 0.01;
    try {
      await endpoint("credential:presence-refresh", "endpoint:presence-refresh", {
        presenceLeaseSeconds: 60,
      });
      await waitFor(
        () =>
          authority.presence.filter(
            (entry) =>
              entry.endpointHandle === "endpoint:presence-refresh" &&
              entry.state === "online",
          ).length >= 2,
        "Fabric presence refresh did not run",
      );
    } finally {
      limits.fabricPresenceRefreshMaxSeconds = previous;
    }
  });

  it("fails Fabric closed on definitive refusal or a missed lease deadline", async () => {
    const originalReport = authority.reportEndpointPresence.bind(authority);
    const definitiveAttempts: Array<"online" | "offline"> = [];
    authority.reportEndpointPresence = async (_handle, _generation, state) => {
      definitiveAttempts.push(state);
      throw new AuthorityHttpError("stale generation", 409);
    };
    try {
      const refused = await endpoint("credential:presence-refused", "endpoint:presence-refused");
      assert.equal(await closed(refused), 1012);
      await waitFor(
        () => definitiveAttempts.length === 2,
        "the fenced endpoint did not report its final offline state",
      );
      await waitFor(
        () =>
          (
            stack.relay.fabricForwarder as unknown as {
              presenceReports: Map<string, unknown>;
            }
          ).presenceReports.size === 0,
        "a definitive offline refusal retained a presence retry queue",
      );
      assert.deepEqual(
        definitiveAttempts,
        ["online", "offline"],
        "the definitive offline refusal must complete without another retry",
      );
    } finally {
      authority.reportEndpointPresence = originalReport;
    }

    const realNow = Date.now;
    let now = realNow();
    let attempts = 0;
    Date.now = () => now;
    authority.reportEndpointPresence = async (_handle, _generation, state) => {
      if (state === "online") {
        attempts += 1;
        now += 61_000;
        throw new Error("Control unavailable beyond lease");
      }
    };
    try {
      const expired = await endpoint("credential:presence-expired", "endpoint:presence-expired", {
        presenceLeaseSeconds: 60,
      });
      assert.equal(await closed(expired), 1012);
      assert.equal(attempts, 1);
    } finally {
      Date.now = realNow;
      authority.reportEndpointPresence = originalReport;
    }
  });

  it("rejects expired endpoint admission before creating a Fabric connection", async () => {
    authority.grantEndpoint("credential:expired", "endpoint:expired", {
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const result = await connect(`${stack.wsOrigin}${FABRIC_PATH}?ticket=credential:expired`);
    assert.deepEqual(result, { error: "403" });
    assert.equal(stack.relay.fabricForwarder?.stats().endpoints, 0);
  });

});
