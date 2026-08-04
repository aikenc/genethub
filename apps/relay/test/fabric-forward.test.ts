import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { WebSocket } from "ws";

import { FABRIC_PATH } from "../src/contract/fabric-wire.js";
import { CLIENT_PATH, DAEMON_PATH } from "../src/contract/index.js";
import {
  decodeFabricFrame,
  encodeFabricFrame,
  encodeFabricOpenPayload,
  FabricKind,
  type FabricFrame,
  FabricReset,
} from "../src/forward/fabric-frame.js";
import { decode, Kind } from "../src/forward/frame.js";
import {
  closed,
  connect,
  FakeAuthority,
  FakeFabricAuthority,
  nextMessage,
  opened,
  startTestRelay,
  type TestRelay,
} from "./harness.js";

function id(value: number): string {
  return value.toString(16).padStart(32, "0");
}

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

describe("Fabric v2 over real WebSockets", () => {
  const legacy = new FakeAuthority();
  const authority = new FakeFabricAuthority();
  const sockets = new Set<WebSocket>();
  let stack: TestRelay;

  before(async () => {
    stack = await startTestRelay(legacy, authority);
  });

  afterEach(() => {
    for (const socket of sockets) socket.terminate();
    sockets.clear();
  });

  after(async () => {
    await stack.stop();
  });

  async function endpoint(
    credential: string,
    handle: string,
    options: { bearer?: boolean; revocationHandle?: string; expiresAt?: string | null } = {},
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
        value: 0n,
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
        value: 0n,
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
    const oldSource = await endpoint("credential:old-source", "endpoint:source");
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
    const replacement = await endpoint("credential:new-source", "endpoint:source");
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
  });

  it("rejects expired endpoint admission before creating a Fabric connection", async () => {
    authority.grantEndpoint("credential:expired", "endpoint:expired", {
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const result = await connect(`${stack.wsOrigin}${FABRIC_PATH}?ticket=credential:expired`);
    assert.deepEqual(result, { error: "403" });
    assert.equal(stack.relay.fabricForwarder?.stats().endpoints, 0);
  });

  it("keeps the complete v1 forwarding path alive beside Fabric v2", async () => {
    await endpoint("credential:v2", "endpoint:v2");

    legacy.grantDaemon("legacy-uplink", { machineId: "m_legacy", daemonId: "d_legacy" });
    const daemon = opened(
      await connect(`${stack.wsOrigin}${DAEMON_PATH}`, {
        headers: { authorization: "Bearer legacy-uplink" },
      }),
    );
    sockets.add(daemon);
    legacy.grantClient("legacy-client", { machineId: "m_legacy", clientId: "c_legacy" });
    const client = opened(await connect(`${stack.wsOrigin}${CLIENT_PATH}?ticket=legacy-client`));
    sockets.add(client);

    const openedFrame = decode(await nextMessage(daemon));
    assert.ok(openedFrame);
    assert.equal(openedFrame.kind, Kind.Open);

    const forwarded = nextMessage(daemon);
    client.send("legacy payload");
    const legacyFrame = decode(await forwarded);
    assert.ok(legacyFrame);
    assert.equal(legacyFrame.kind, Kind.Text);
    assert.equal(legacyFrame.channel, openedFrame.channel);
    assert.deepEqual(legacyFrame.payload, Buffer.from("legacy payload"));

    assert.equal(stack.relay.forwarder.stats().machines, 1);
    assert.equal(stack.relay.fabricForwarder?.stats().endpoints, 1);
  });
});
