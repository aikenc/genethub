import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  FabricAuthority,
  FabricEndpointGrant,
  FabricPresenceState,
  FabricRevocation,
  FabricRouteGrant,
} from "../src/contract/fabric.js";
import {
  FabricCore,
  type FabricEndpointConnection,
  type FabricEndpointContext,
  type FabricStreamLeg,
} from "../src/forward/fabric-core.js";
import {
  encodeFabricOpenPayload,
  FabricKind,
  type FabricFrame,
  FABRIC_INITIAL_STREAM_CREDIT,
  FABRIC_MAX_STREAM_CREDIT,
  FabricReset,
  MAX_OPERATION_METADATA_BYTES,
} from "../src/forward/fabric-frame.js";

const NEVER = "2099-01-01T00:00:00.000Z";
const CREDIT = BigInt(FABRIC_INITIAL_STREAM_CREDIT);

function id(value: number): string {
  return value.toString(16).padStart(32, "0");
}

function cloneFrame(frame: FabricFrame): FabricFrame {
  return { ...frame, payload: Buffer.from(frame.payload) };
}

class TestConnection implements FabricEndpointConnection {
  readonly context: Readonly<FabricEndpointContext>;
  readonly socketIdentity = {};
  readonly streams = new Map<string, FabricStreamLeg>();
  readonly pending = new Map<string, symbol>();
  readonly tombstones = new Map<string, number>();
  readonly lateFrameBudgets = new Map<string, number>();
  readonly sent: FabricFrame[] = [];
  readonly closeCodes: number[] = [];
  closed = false;
  strikes = 0;

  constructor(
    handle: string,
    options: {
      epoch?: string;
      expiresAt?: string | null;
      connectionGeneration?: number;
      transportFlow?: boolean;
    } = {},
  ) {
    this.context = Object.freeze({
      endpointHandle: handle,
      revocationHandle: `revoke:${handle}`,
      expiresAt: options.expiresAt ?? null,
      connectionGeneration: options.connectionGeneration ?? 1,
      presenceLeaseSeconds: 90,
      connectionEpoch: options.epoch ?? `epoch:${handle}`,
      transportFlow: options.transportFlow ?? false,
    });
  }

  send(frame: FabricFrame): void {
    this.sent.push(cloneFrame(frame));
  }

  async sendFlow(frame: FabricFrame): Promise<void> {
    this.sent.push(cloneFrame(frame));
  }

  close(code: number): void {
    this.closeCodes.push(code);
  }
}

class TestAuthority implements FabricAuthority {
  readonly calls: Array<{ sourceEndpointHandle: string; routeTicket: string }> = [];
  readonly routes = new Map<string, FabricRouteGrant>();
  private revoked: ((revocation: FabricRevocation) => void) | null = null;

  grant(ticket: string, targetEndpointHandle: string, routeHandle = `route:${ticket}`, expiresAt = NEVER): void {
    this.routes.set(ticket, { targetEndpointHandle, routeHandle, expiresAt });
  }

  async authorizeEndpoint(_credential: string): Promise<FabricEndpointGrant | null> {
    return null;
  }

  async authorizeRoute(
    sourceEndpointHandle: string,
    routeTicket: string,
  ): Promise<FabricRouteGrant | null> {
    this.calls.push({ sourceEndpointHandle, routeTicket });
    const grant = this.routes.get(routeTicket) ?? null;
    this.routes.delete(routeTicket);
    return grant;
  }

  async reportEndpointPresence(
    _endpointHandle: string,
    _connectionGeneration: number,
    _state: FabricPresenceState,
  ): Promise<void> {}

  onFabricRevoked(handler: (revocation: FabricRevocation) => void): void {
    this.revoked = handler;
  }

  revoke(revocation: FabricRevocation): void {
    this.revoked?.(revocation);
  }
}

function frame(
  kind: FabricFrame["kind"],
  streamId: string,
  value = 0n,
  payload: Buffer = Buffer.alloc(0),
): FabricFrame {
  return { kind, streamId, value, payload };
}

function open(
  streamId: string,
  ticket: string,
  hello = ticket,
  credit = CREDIT,
): FabricFrame {
  return frame(
    FabricKind.Open,
    streamId,
    credit,
    encodeFabricOpenPayload(ticket, Buffer.from(hello)),
  );
}

function last(connection: TestConnection): FabricFrame {
  const value = connection.sent.at(-1);
  assert.ok(value, `expected ${connection.context.endpointHandle} to receive a frame`);
  return value;
}

async function establish(
  core: FabricCore,
  authority: TestAuthority,
  source: TestConnection,
  target: TestConnection,
  sourceStreamId: string,
  ticket: string,
  routeHandle = `route:${ticket}`,
  expiresAt = NEVER,
  credit = CREDIT,
): Promise<string> {
  authority.grant(ticket, target.context.endpointHandle, routeHandle, expiresAt);
  await core.handle(source, open(sourceStreamId, ticket, `hello:${ticket}`, credit));
  const incoming = last(target);
  assert.equal(incoming.kind, FabricKind.Incoming);
  assert.deepEqual(incoming.payload, Buffer.from(`hello:${ticket}`));
  await core.handle(target, frame(FabricKind.Accept, incoming.streamId, credit, Buffer.from("accepted")));
  const accepted = last(source);
  assert.equal(accepted.kind, FabricKind.Accept);
  assert.equal(accepted.streamId, sourceStreamId);
  return incoming.streamId;
}

describe("Fabric endpoint-neutral routing", () => {
  it("negotiates transport flow only when both physical endpoints opt in", async () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority, { streamId: () => id(900) });
    const source = new TestConnection("endpoint:flow-source", {
      transportFlow: true,
    });
    const target = new TestConnection("endpoint:flow-target", {
      transportFlow: true,
    });
    core.register(source);
    core.register(target);
    authority.grant("flow", target.context.endpointHandle);

    await core.handle(source, open(id(91), "flow", "hello"));
    const incoming = last(target);
    assert.equal(incoming.kind, FabricKind.Incoming);
    assert.equal(incoming.value, 0n);
    await core.handle(
      target,
      frame(FabricKind.Accept, incoming.streamId, 0n, Buffer.from("accepted")),
    );
    assert.equal(last(source).kind, FabricKind.Accept);
    assert.equal(last(source).value, 0n);

    const sourceFrames = source.sent.length;
    await core.handle(
      source,
      frame(FabricKind.Data, id(91), 1n, Buffer.from("opaque-record")),
    );
    assert.deepEqual(
      last(target),
      frame(FabricKind.Data, incoming.streamId, 1n, Buffer.from("opaque-record")),
    );
    assert.equal(
      source.sent.length,
      sourceFrames,
      "Relay must not return or forward application credit in transport flow",
    );
  });

  it("falls back to legacy credit when either endpoint lacks the capability", async () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority, { streamId: () => id(899) });
    const source = new TestConnection("endpoint:new", { transportFlow: true });
    const target = new TestConnection("endpoint:old");
    core.register(source);
    core.register(target);
    const peer = await establish(core, authority, source, target, id(92), "legacy");
    assert.equal(target.sent[0]?.value, CREDIT);
    assert.equal(last(source).value, CREDIT);
    assert.equal(core.usesTransportFlow(source, id(92)), false);
    assert.equal(core.usesTransportFlow(target, peer), false);
  });

  it("prunes idle endpoint tombstones during sweep and clears them on unregister", () => {
    let now = 1_000;
    const authority = new TestAuthority();
    const core = new FabricCore(authority, { now: () => now });
    const endpoint = new TestConnection("endpoint:tombstones");
    core.register(endpoint);
    endpoint.tombstones.set(id(1), 999);
    endpoint.tombstones.set(id(2), 2_000);

    core.sweepExpired();
    assert.deepEqual([...endpoint.tombstones.keys()], [id(2)]);
    now = 3_000;
    core.unregister(endpoint);
    assert.equal(endpoint.tombstones.size, 0);
  });
  it("lets one endpoint use one connection for two concurrent targets", async () => {
    const authority = new TestAuthority();
    const generated = [id(101), id(102)];
    const core = new FabricCore(authority, { streamId: () => generated.shift()! });
    const source = new TestConnection("endpoint:browser");
    const targetA = new TestConnection("endpoint:node-a");
    const targetB = new TestConnection("endpoint:node-b");
    core.register(source);
    core.register(targetA);
    core.register(targetB);

    const peerA = await establish(core, authority, source, targetA, id(1), "ticket-a");
    const peerB = await establish(core, authority, source, targetB, id(2), "ticket-b");

    await core.handle(source, frame(FabricKind.Data, id(1), 1n, Buffer.from("only-a")));
    await core.handle(source, frame(FabricKind.Data, id(2), 1n, Buffer.from("only-b")));

    assert.deepEqual(last(targetA), frame(FabricKind.Data, peerA, 1n, Buffer.from("only-a")));
    assert.deepEqual(last(targetB), frame(FabricKind.Data, peerB, 1n, Buffer.from("only-b")));
    assert.deepEqual(authority.calls, [
      { sourceEndpointHandle: "endpoint:browser", routeTicket: "ticket-a" },
      { sourceEndpointHandle: "endpoint:browser", routeTicket: "ticket-b" },
    ]);
    assert.deepEqual(core.stats(), { endpoints: 3, streams: 2, pendingOpens: 0 });
  });

  it("allows every endpoint to initiate OPEN over its existing connection", async () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority, { streamId: () => id(201) });
    const first = new TestConnection("endpoint:first");
    const second = new TestConnection("endpoint:second");
    core.register(first);
    core.register(second);

    const peer = await establish(core, authority, second, first, id(3), "reverse");
    await core.handle(second, frame(FabricKind.Data, id(3), 1n, Buffer.from("node-to-node")));

    assert.deepEqual(last(first), frame(FabricKind.Data, peer, 1n, Buffer.from("node-to-node")));
    assert.deepEqual(authority.calls, [
      { sourceEndpointHandle: "endpoint:second", routeTicket: "reverse" },
    ]);
  });

  it("scopes equal local stream ids to their actual sockets", async () => {
    const authority = new TestAuthority();
    const generated = [id(301), id(302)];
    const core = new FabricCore(authority, { streamId: () => generated.shift()! });
    const sourceA = new TestConnection("endpoint:source-a");
    const sourceB = new TestConnection("endpoint:source-b");
    const target = new TestConnection("endpoint:target");
    core.register(sourceA);
    core.register(sourceB);
    core.register(target);
    const sameLocalId = id(4);

    const peerA = await establish(core, authority, sourceA, target, sameLocalId, "from-a");
    const peerB = await establish(core, authority, sourceB, target, sameLocalId, "from-b");
    await core.handle(sourceA, frame(FabricKind.Data, sameLocalId, 1n, Buffer.from("a")));
    await core.handle(sourceB, frame(FabricKind.Data, sameLocalId, 1n, Buffer.from("b")));

    assert.deepEqual(target.sent.slice(-2), [
      frame(FabricKind.Data, peerA, 1n, Buffer.from("a")),
      frame(FabricKind.Data, peerB, 1n, Buffer.from("b")),
    ]);
  });

  it("does not let a third endpoint inject by guessing either peer stream id", async () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority, { streamId: () => id(401) });
    const victim = new TestConnection("endpoint:victim");
    const target = new TestConnection("endpoint:target");
    const attacker = new TestConnection("endpoint:attacker");
    core.register(victim);
    core.register(target);
    core.register(attacker);

    const targetStream = await establish(core, authority, victim, target, id(5), "victim-route");
    const before = target.sent.length;
    await core.handle(attacker, frame(FabricKind.Data, id(5), 1n, Buffer.from("guess-source")));
    await core.handle(attacker, frame(FabricKind.Data, targetStream, 1n, Buffer.from("guess-target")));

    assert.equal(target.sent.length, before);
    assert.deepEqual(
      attacker.sent.map(({ kind, streamId, value }) => ({ kind, streamId, value })),
      [
        { kind: FabricKind.Reset, streamId: id(5), value: BigInt(FabricReset.UnknownStream) },
        { kind: FabricKind.Reset, streamId: targetStream, value: BigInt(FabricReset.UnknownStream) },
      ],
    );
  });

  it("tears down old streams on reconnect and never accepts the old socket again", async () => {
    const authority = new TestAuthority();
    const generated = [id(501), id(502)];
    const core = new FabricCore(authority, { streamId: () => generated.shift()! });
    const oldSource = new TestConnection("endpoint:source", { epoch: "epoch:old" });
    const target = new TestConnection("endpoint:target");
    core.register(oldSource);
    core.register(target);
    await establish(core, authority, oldSource, target, id(6), "old-route");

    const replacement = new TestConnection("endpoint:source", {
      epoch: "epoch:new",
      connectionGeneration: 2,
    });
    assert.equal(core.register(replacement), oldSource);
    assert.equal(oldSource.closed, true);
    assert.equal(last(target).value, BigInt(FabricReset.EndpointClosed));
    const targetCount = target.sent.length;

    await core.handle(oldSource, frame(FabricKind.Data, id(6), 1n, Buffer.from("stale")));
    assert.equal(target.sent.length, targetCount);

    const peer = await establish(core, authority, replacement, target, id(6), "new-route");
    await core.handle(replacement, frame(FabricKind.Data, id(6), 1n, Buffer.from("fresh")));
    assert.deepEqual(last(target), frame(FabricKind.Data, peer, 1n, Buffer.from("fresh")));
  });

  it("keeps the highest connection generation as a replay fence after disconnect", () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority);
    const current = new TestConnection("endpoint:source", {
      epoch: "epoch:current",
      connectionGeneration: 8,
    });
    core.register(current);

    const equal = new TestConnection("endpoint:source", {
      epoch: "epoch:equal",
      connectionGeneration: 8,
    });
    assert.equal(core.register(equal), null);
    assert.equal(equal.closed, true);
    assert.deepEqual(equal.closeCodes, [4409]);
    assert.equal(core.current("endpoint:source"), current);

    core.unregister(current);
    const stale = new TestConnection("endpoint:source", {
      epoch: "epoch:stale",
      connectionGeneration: 7,
    });
    assert.equal(core.register(stale), null);
    assert.equal(stale.closed, true);
    assert.deepEqual(stale.closeCodes, [4409]);
    assert.equal(core.current("endpoint:source"), null);

    const newer = new TestConnection("endpoint:source", {
      epoch: "epoch:newer",
      connectionGeneration: 9,
    });
    assert.equal(core.register(newer), null);
    assert.equal(newer.closed, false);
    assert.equal(core.current("endpoint:source"), newer);
  });

  it("bounds generation fences by failing closed and prunes expired client identities", () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const authority = new TestAuthority();
    const core = new FabricCore(authority, {
      now: () => now,
      maxConnectionGenerations: 1,
    });
    const expiring = new TestConnection("endpoint:expiring", {
      expiresAt: "2030-01-01T00:00:10.000Z",
    });
    core.register(expiring);
    core.unregister(expiring);

    const refused = new TestConnection("endpoint:other");
    core.register(refused);
    assert.equal(refused.closed, true);
    assert.deepEqual(refused.closeCodes, [4429]);

    now = Date.parse("2030-01-01T00:00:11.000Z");
    const admitted = new TestConnection("endpoint:other");
    core.register(admitted);
    assert.equal(admitted.closed, false);
    assert.equal(core.current("endpoint:other"), admitted);
  });

  it("cleans route and endpoint bindings on revocation", async () => {
    const authority = new TestAuthority();
    const generated = [id(601), id(602)];
    const core = new FabricCore(authority, { streamId: () => generated.shift()! });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    await establish(core, authority, source, target, id(7), "route-revoke", "route:r1");
    core.revoke({ target: "route", handle: "route:r1" });
    assert.equal(last(source).value, BigInt(FabricReset.Revoked));
    assert.equal(last(target).value, BigInt(FabricReset.Revoked));
    assert.equal(core.stats().streams, 0);

    await establish(core, authority, source, target, id(8), "endpoint-revoke", "route:r2");
    core.revoke({ target: "endpoint", handle: target.context.revocationHandle });
    assert.deepEqual(target.closeCodes, [4403]);
    assert.equal(last(source).value, BigInt(FabricReset.Revoked));
    assert.equal(core.current(target.context.endpointHandle), null);
    assert.equal(core.stats().streams, 0);
  });

  it("rejects already-expired grants and sweeps active routes and endpoints", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const authority = new TestAuthority();
    const generated = [id(701), id(702)];
    const core = new FabricCore(authority, {
      now: () => now,
      streamId: () => generated.shift()!,
    });
    const source = new TestConnection("endpoint:source", {
      expiresAt: "2030-01-01T00:00:20.000Z",
    });
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    authority.grant(
      "already-expired",
      target.context.endpointHandle,
      "route:expired",
      "2029-12-31T23:59:59.000Z",
    );
    await core.handle(source, open(id(9), "already-expired"));
    assert.equal(last(source).value, BigInt(FabricReset.Expired));
    assert.equal(target.sent.length, 0);

    await establish(
      core,
      authority,
      source,
      target,
      id(10),
      "short-route",
      "route:short",
      "2030-01-01T00:00:10.000Z",
    );
    now = Date.parse("2030-01-01T00:00:11.000Z");
    await core.handle(source, frame(FabricKind.Data, id(10), 1n, Buffer.from("late")));
    assert.equal(last(source).value, BigInt(FabricReset.Expired));
    assert.equal(last(target).value, BigInt(FabricReset.Expired));
    assert.equal(core.stats().streams, 0);

    now = Date.parse("2030-01-01T00:00:21.000Z");
    await core.handle(source, frame(FabricKind.Ping, id(0), 1n));
    assert.deepEqual(source.closeCodes, [4408]);
    assert.equal(core.current(source.context.endpointHandle), null);
  });
});

describe("Fabric protocol violations stay scoped", () => {
  it("enforces each leg's credit without stalling or closing a healthy binding", async () => {
    const authority = new TestAuthority();
    const generated = [id(901), id(902)];
    const core = new FabricCore(authority, { streamId: () => generated.shift()! });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    const floodedPeer = await establish(
      core,
      authority,
      source,
      target,
      id(21),
      "flooded",
      "route:flooded",
      NEVER,
      4n,
    );
    const healthyPeer = await establish(
      core,
      authority,
      source,
      target,
      id(22),
      "healthy",
      "route:healthy",
      NEVER,
      4n,
    );

    await core.handle(source, frame(FabricKind.Data, id(21), 1n, Buffer.from("flood")));
    assert.equal(source.closeCodes.length, 0);
    assert.equal(target.closed, false);
    assert.equal(core.stats().streams, 1);
    assert.deepEqual(last(source), frame(
      FabricKind.Reset,
      id(21),
      BigInt(FabricReset.ProtocolViolation),
    ));

    await core.handle(source, frame(FabricKind.Data, id(22), 1n, Buffer.from("full")));
    assert.deepEqual(last(target), frame(FabricKind.Data, healthyPeer, 1n, Buffer.from("full")));
    await core.handle(target, frame(FabricKind.WindowUpdate, healthyPeer, 4n));
    assert.deepEqual(last(source), frame(FabricKind.WindowUpdate, id(22), 4n));
    await core.handle(source, frame(FabricKind.Data, id(22), 2n, Buffer.from("x")));
    assert.deepEqual(last(target), frame(FabricKind.Data, healthyPeer, 2n, Buffer.from("x")));

    // The peer now has only three bytes available. Granting two would overflow
    // its negotiated window, so only this binding is reset.
    await core.handle(target, frame(FabricKind.WindowUpdate, healthyPeer, 2n));
    assert.equal(core.stats().streams, 0);
    assert.equal(source.closed, false);
    assert.equal(target.closed, false);
    assert.equal(last(source).value, BigInt(FabricReset.ProtocolViolation));
    assert.equal(last(target).value, BigInt(FabricReset.ProtocolViolation));
    assert.notEqual(floodedPeer, healthyPeer);
  });

  it("rejects zero or excessive negotiated windows without closing endpoints", async () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority, { streamId: () => id(903) });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    await core.handle(source, open(id(23), "zero", "hello", 0n));
    await core.handle(
      source,
      open(
        id(24),
        "overflow",
        "hello",
        BigInt(FABRIC_MAX_STREAM_CREDIT) + 1n,
      ),
    );
    assert.equal(authority.calls.length, 0);
    assert.deepEqual(
      source.sent.map(({ streamId, value }) => ({ streamId, value })),
      [
        { streamId: id(23), value: BigInt(FabricReset.MalformedOpen) },
        { streamId: id(24), value: BigInt(FabricReset.MalformedOpen) },
      ],
    );
    assert.equal(source.closed, false);
    assert.equal(target.closed, false);
  });

  it("rejects oversized ACCEPT metadata at stream scope", async () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority, { streamId: () => id(906) });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);
    authority.grant("large-accept", target.context.endpointHandle);

    await core.handle(source, open(id(27), "large-accept"));
    const incoming = last(target);
    await core.handle(
      target,
      frame(
        FabricKind.Accept,
        incoming.streamId,
        CREDIT,
        Buffer.alloc(MAX_OPERATION_METADATA_BYTES + 1),
      ),
    );

    assert.equal(core.stats().streams, 0);
    assert.equal(source.closed, false);
    assert.equal(target.closed, false);
    assert.equal(last(source).value, BigInt(FabricReset.ProtocolViolation));
    assert.equal(last(target).value, BigInt(FabricReset.ProtocolViolation));
  });

  it("rejects malformed RESET frames without forwarding attacker-controlled fields", async () => {
    const authority = new TestAuthority();
    const generated = [id(904), id(905)];
    const core = new FabricCore(authority, { streamId: () => generated.shift()! });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    const firstPeer = await establish(core, authority, source, target, id(25), "zero-reset");
    await core.handle(source, frame(FabricKind.Reset, id(25), 0n));
    assert.deepEqual(
      last(source),
      frame(FabricKind.Reset, id(25), BigInt(FabricReset.ProtocolViolation)),
    );
    assert.deepEqual(
      last(target),
      frame(FabricKind.Reset, firstPeer, BigInt(FabricReset.ProtocolViolation)),
    );

    const secondPeer = await establish(
      core,
      authority,
      source,
      target,
      id(26),
      "payload-reset",
    );
    await core.handle(
      source,
      frame(FabricKind.Reset, id(26), 1n, Buffer.from("must-not-cross")),
    );
    assert.deepEqual(
      last(source),
      frame(FabricKind.Reset, id(26), BigInt(FabricReset.ProtocolViolation)),
    );
    assert.deepEqual(
      last(target),
      frame(FabricKind.Reset, secondPeer, BigInt(FabricReset.ProtocolViolation)),
    );
    assert.equal(core.stats().streams, 0);
  });

  it("absorbs only a bounded tail already in flight when its peer resets", async () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority, {
      streamId: () => id(906),
      maxStrikes: 2,
      maxLateFramesPerClosedStream: 2,
    });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    const targetStream = await establish(
      core,
      authority,
      source,
      target,
      id(27),
      "reset-race",
    );
    await core.handle(source, frame(FabricKind.Reset, id(27), 1n));
    const sourceFrames = source.sent.length;

    await core.handle(
      target,
      frame(FabricKind.Data, targetStream, 1n, Buffer.from("already sent")),
    );
    await core.handle(
      target,
      frame(FabricKind.WindowUpdate, targetStream, 12n),
    );
    assert.equal(target.strikes, 0);
    assert.equal(source.sent.length, sourceFrames);

    await core.handle(target, frame(FabricKind.Fin, targetStream));
    assert.equal(target.strikes, 1, "the grace is finite");
    await core.handle(target, frame(FabricKind.Fin, targetStream));
    assert.equal(target.closed, true);
    assert.deepEqual(target.closeCodes, [4400]);
  });

  it("does not let control frames bypass DATA payload limits", async () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority, { maxStrikes: 3 });
    const source = new TestConnection("endpoint:source");
    core.register(source);

    await core.handle(
      source,
      frame(FabricKind.Ping, id(0), 1n, Buffer.from("control payload")),
    );
    assert.equal(source.strikes, 1);
    assert.equal(source.sent.length, 0);

    await core.handle(source, frame(FabricKind.Ping, id(0), 2n));
    assert.deepEqual(last(source), frame(FabricKind.Pong, id(0), 2n));

    await core.handle(
      source,
      frame(FabricKind.Pong, id(0), 2n, Buffer.from("control payload")),
    );
    assert.equal(source.strikes, 2);
    assert.equal(source.closed, false);
  });

  it("does not turn a duplicate local OPEN into a second binding", async () => {
    const authority = new TestAuthority();
    let release: (grant: FabricRouteGrant | null) => void = () => {
      throw new Error("route authorization was not started");
    };
    authority.authorizeRoute = async (sourceEndpointHandle, routeTicket) => {
      authority.calls.push({ sourceEndpointHandle, routeTicket });
      return new Promise<FabricRouteGrant | null>((resolve) => {
        release = resolve;
      });
    };
    const core = new FabricCore(authority, { streamId: () => id(801) });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    const first = core.handle(source, open(id(11), "first"));
    await core.handle(source, open(id(11), "duplicate"));
    assert.equal(last(source).value, BigInt(FabricReset.DuplicateStream));

    release({
      targetEndpointHandle: target.context.endpointHandle,
      routeHandle: "route:first",
      expiresAt: NEVER,
    });
    await first;

    assert.equal(target.sent.length, 0, "a duplicate OPEN must cancel the pending authorization");
    assert.equal(core.stats().streams, 0);
  });

  it("does not resurrect a route revoked while authorization is in flight", async () => {
    const authority = new TestAuthority();
    let release: (grant: FabricRouteGrant | null) => void = () => {
      throw new Error("route authorization was not started");
    };
    authority.authorizeRoute = async (sourceEndpointHandle, routeTicket) => {
      authority.calls.push({ sourceEndpointHandle, routeTicket });
      return new Promise<FabricRouteGrant | null>((resolve) => {
        release = resolve;
      });
    };
    const core = new FabricCore(authority, { streamId: () => id(901) });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    const opening = core.handle(source, open(id(12), "soon-revoked"));
    core.revoke({ target: "route", handle: "route:soon-revoked" });
    release({
      targetEndpointHandle: target.context.endpointHandle,
      routeHandle: "route:soon-revoked",
      expiresAt: NEVER,
    });
    await opening;

    assert.equal(target.sent.length, 0);
    assert.equal(last(source).value, BigInt(FabricReset.Revoked));
    assert.equal(core.stats().streams, 0);
  });

  it("does not resurrect an OPEN cancelled by RESET or an early DATA frame", async () => {
    const authority = new TestAuthority();
    const releases: Array<(grant: FabricRouteGrant | null) => void> = [];
    authority.authorizeRoute = async (sourceEndpointHandle, routeTicket) => {
      authority.calls.push({ sourceEndpointHandle, routeTicket });
      return new Promise<FabricRouteGrant | null>((resolve) => releases.push(resolve));
    };
    const core = new FabricCore(authority, { streamId: () => id(950) });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    const resetOpening = core.handle(source, open(id(13), "reset-race"));
    await core.handle(source, frame(FabricKind.Reset, id(13), 1n));
    const dataOpening = core.handle(source, open(id(14), "data-race"));
    await core.handle(source, frame(FabricKind.Data, id(14), 1n, Buffer.from("too early")));

    releases[0]!({
      targetEndpointHandle: target.context.endpointHandle,
      routeHandle: "route:reset-race",
      expiresAt: NEVER,
    });
    releases[1]!({
      targetEndpointHandle: target.context.endpointHandle,
      routeHandle: "route:data-race",
      expiresAt: NEVER,
    });
    await Promise.all([resetOpening, dataOpening]);

    assert.equal(target.sent.length, 0);
    assert.equal(core.stats().streams, 0);
    assert.equal(core.stats().pendingOpens, 0);
    assert.equal(last(source).value, BigInt(FabricReset.ProtocolViolation));
  });

  it("bounds pending route authorization per endpoint and globally", async () => {
    const authority = new TestAuthority();
    const releases: Array<(grant: FabricRouteGrant | null) => void> = [];
    authority.authorizeRoute = async (sourceEndpointHandle, routeTicket) => {
      authority.calls.push({ sourceEndpointHandle, routeTicket });
      return new Promise<FabricRouteGrant | null>((resolve) => releases.push(resolve));
    };
    const core = new FabricCore(authority, {
      maxPendingPerEndpoint: 2,
      maxPendingGlobal: 2,
    });
    const source = new TestConnection("endpoint:source");
    core.register(source);

    const first = core.handle(source, open(id(15), "one"));
    const second = core.handle(source, open(id(16), "two"));
    await core.handle(source, open(id(17), "over-limit"));
    assert.equal(authority.calls.length, 2);
    assert.equal(core.stats().pendingOpens, 2);
    assert.equal(last(source).value, BigInt(FabricReset.TooSlow));

    releases[0]!(null);
    releases[1]!(null);
    await Promise.all([first, second]);
    assert.equal(core.stats().pendingOpens, 0);
  });

  it("reports transient route-authority failure as retryable and stream-local", async () => {
    const authority = new TestAuthority();
    authority.authorizeRoute = async () => {
      throw new Error("Control temporarily unavailable");
    };
    const core = new FabricCore(authority);
    const source = new TestConnection("endpoint:source");
    core.register(source);

    await core.handle(source, open(id(18), "temporary"));
    assert.equal(last(source).kind, FabricKind.Reset);
    assert.equal(last(source).value, BigInt(FabricReset.TooSlow));
    assert.equal(source.closed, false);
    assert.equal(core.stats().pendingOpens, 0);
  });

  it("rejects an oversized OPEN hello before starting route authorization", async () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority);
    const source = new TestConnection("endpoint:source");
    core.register(source);

    const ticket = Buffer.from("ticket");
    const payload = Buffer.alloc(
      2 + ticket.length + MAX_OPERATION_METADATA_BYTES + 1,
    );
    payload.writeUInt16BE(ticket.length, 0);
    ticket.copy(payload, 2);
    await core.handle(source, frame(FabricKind.Open, id(18), CREDIT, payload));

    assert.equal(authority.calls.length, 0);
    assert.equal(core.stats().pendingOpens, 0);
    assert.deepEqual(
      last(source),
      frame(FabricKind.Reset, id(18), BigInt(FabricReset.MalformedOpen)),
    );
  });

  it("does not admit an endpoint after its revocation arrived first", () => {
    const authority = new TestAuthority();
    const core = new FabricCore(authority);
    core.revoke({ target: "endpoint", handle: "revoke:endpoint:late" });

    const late = new TestConnection("endpoint:late");
    core.register(late);

    assert.equal(late.closed, true);
    assert.deepEqual(late.closeCodes, [4403]);
    assert.equal(core.current(late.context.endpointHandle), null);
    assert.deepEqual(core.stats(), { endpoints: 0, streams: 0, pendingOpens: 0 });
  });

  it("fails delayed grants closed after revocation churn evicts an exact fence", async () => {
    const authority = new TestAuthority();
    let release!: (grant: FabricRouteGrant | null) => void;
    authority.authorizeRoute = async () =>
      new Promise<FabricRouteGrant | null>((resolve) => {
        release = resolve;
      });
    const core = new FabricCore(authority, { maxRevocationTombstones: 1 });
    const source = new TestConnection("endpoint:source");
    const target = new TestConnection("endpoint:target");
    core.register(source);
    core.register(target);

    const opening = core.handle(source, open(id(90), "delayed"));
    await Promise.resolve();
    core.revoke({ target: "route", handle: "route:churn-one" });
    core.revoke({ target: "route", handle: "route:churn-two" });
    release({
      targetEndpointHandle: target.context.endpointHandle,
      routeHandle: "route:delayed",
      expiresAt: NEVER,
    });
    await opening;

    assert.equal(last(source).value, BigInt(FabricReset.Revoked));
    assert.equal(target.sent.length, 0, "a delayed grant crossed the revocation floor");

    const staleCheckpoint = 0;
    const late = new TestConnection("endpoint:late");
    core.register(late, staleCheckpoint);
    assert.equal(late.closed, true);
    assert.deepEqual(late.closeCodes, [4403]);
  });
});
