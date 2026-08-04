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
  FabricReset,
} from "../src/forward/fabric-frame.js";

const NEVER = "2099-01-01T00:00:00.000Z";

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
  readonly sent: FabricFrame[] = [];
  readonly closeCodes: number[] = [];
  closed = false;
  strikes = 0;

  constructor(handle: string, options: { epoch?: string; expiresAt?: string | null } = {}) {
    this.context = Object.freeze({
      endpointHandle: handle,
      revocationHandle: `revoke:${handle}`,
      expiresAt: options.expiresAt ?? null,
      connectionEpoch: options.epoch ?? `epoch:${handle}`,
    });
  }

  send(frame: FabricFrame): void {
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

function open(streamId: string, ticket: string, hello = ticket): FabricFrame {
  return frame(
    FabricKind.Open,
    streamId,
    0n,
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
): Promise<string> {
  authority.grant(ticket, target.context.endpointHandle, routeHandle, expiresAt);
  await core.handle(source, open(sourceStreamId, ticket, `hello:${ticket}`));
  const incoming = last(target);
  assert.equal(incoming.kind, FabricKind.Incoming);
  assert.deepEqual(incoming.payload, Buffer.from(`hello:${ticket}`));
  await core.handle(target, frame(FabricKind.Accept, incoming.streamId, 0n, Buffer.from("accepted")));
  const accepted = last(source);
  assert.equal(accepted.kind, FabricKind.Accept);
  assert.equal(accepted.streamId, sourceStreamId);
  return incoming.streamId;
}

describe("Fabric endpoint-neutral routing", () => {
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

    const replacement = new TestConnection("endpoint:source", { epoch: "epoch:new" });
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
    core.sweepExpired();
    assert.equal(last(source).value, BigInt(FabricReset.Expired));
    assert.equal(last(target).value, BigInt(FabricReset.Expired));
    assert.equal(core.stats().streams, 0);

    now = Date.parse("2030-01-01T00:00:21.000Z");
    core.sweepExpired();
    assert.deepEqual(source.closeCodes, [4408]);
    assert.equal(core.current(source.context.endpointHandle), null);
  });
});

describe("Fabric protocol violations stay scoped", () => {
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
});
