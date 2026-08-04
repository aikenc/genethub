import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  FABRIC_AUTHORIZE_ENDPOINT,
  FABRIC_AUTHORIZE_ROUTE,
  FABRIC_PATH,
  FABRIC_PRESENCE,
  FABRIC_REVOCATIONS,
} from "../src/contract/fabric-wire.js";
import { RemoteFabricAuthority } from "../src/forward/remote-fabric-authority.js";
import { startRelay } from "../src/main.js";
import { connect, FakeAuthority } from "./harness.js";

describe("the opaque Fabric authority contract", () => {
  const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
  let reply: Response = new Response(null, { status: 204 });

  const fakeFetch: typeof fetch = async (input, init) => {
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "null")),
    });
    return reply.clone();
  };

  const authority = () => new RemoteFabricAuthority("http://control.test", "tok", fakeFetch);

  before(() => seen.splice(0));
  after(() => seen.splice(0));

  it("authorizes a connection without exposing a user, node, or resource", async () => {
    reply = Response.json({
      endpointHandle: "opaque:endpoint:1",
      revocationHandle: "opaque:revoke:1",
      expiresAt: null,
      connectionGeneration: 7,
    });

    const grant = await authority().authorizeEndpoint("one-shot-credential");
    assert.deepEqual(grant, {
      endpointHandle: "opaque:endpoint:1",
      revocationHandle: "opaque:revoke:1",
      expiresAt: null,
      connectionGeneration: 7,
    });
    const call = seen.at(-1)!;
    assert.equal(call.url, `http://control.test${FABRIC_AUTHORIZE_ENDPOINT}`);
    assert.deepEqual(call.body, { credential: "one-shot-credential" });
    assert.equal(call.headers.get("authorization"), "Bearer tok");
  });

  it("binds route admission to the source handle taken from the actual socket", async () => {
    reply = Response.json({
      targetEndpointHandle: "opaque:endpoint:target",
      routeHandle: "opaque:route:1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const grant = await authority().authorizeRoute(
      "opaque:endpoint:source",
      "one-shot-route-ticket",
    );
    assert.deepEqual(grant, {
      targetEndpointHandle: "opaque:endpoint:target",
      routeHandle: "opaque:route:1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const call = seen.at(-1)!;
    assert.equal(call.url, `http://control.test${FABRIC_AUTHORIZE_ROUTE}`);
    assert.deepEqual(call.body, {
      sourceEndpointHandle: "opaque:endpoint:source",
      ticket: "one-shot-route-ticket",
    });
  });

  it("reports only opaque presence", async () => {
    reply = new Response(null, { status: 204 });
    await authority().reportEndpointPresence("opaque:endpoint:1", 7, "offline");
    const call = seen.at(-1)!;
    assert.equal(call.url, `http://control.test${FABRIC_PRESENCE}`);
    assert.deepEqual(call.body, {
      endpointHandle: "opaque:endpoint:1",
      connectionGeneration: 7,
      state: "offline",
    });
  });

  it("fails closed on refusal and control-plane failure", async () => {
    reply = new Response(null, { status: 204 });
    assert.equal(await authority().authorizeEndpoint("expired"), null);

    const broken = new RemoteFabricAuthority("http://control.test", null, async () => {
      throw new Error("ECONNREFUSED");
    });
    assert.equal(await broken.authorizeRoute("source", "route"), null);
  });

  it("delivers endpoint and route revocations without interpreting their handles", () => {
    const remote = authority();
    const revoked: Array<{ target: "endpoint" | "route"; handle: string }> = [];
    remote.onFabricRevoked((event) => revoked.push(event));
    remote.deliverRevocation({ target: "endpoint", handle: "opaque:e" });
    remote.deliverRevocation({ target: "route", handle: "opaque:r" });
    assert.deepEqual(revoked, [
      { target: "endpoint", handle: "opaque:e" },
      { target: "route", handle: "opaque:r" },
    ]);
  });

  it("installs the initial revocation sync before re-reporting presence", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately split CRLF boundaries across reads: proxies are free to
        // choose chunk boundaries, including between CR and LF.
        for (const chunk of [
          "event: sync\r",
          '\ndata: {"revocations":[{"target":"endpoint","handle":"opaque:revoked"}]}\r',
          "\n\r",
          "\n",
        ]) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const remote = new RemoteFabricAuthority(
      "http://control.test",
      "tok",
      async (input) => {
        assert.equal(String(input), `http://control.test${FABRIC_REVOCATIONS}`);
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    );
    const order: string[] = [];
    remote.onFabricRevoked((event) => order.push(`revoked:${event.handle}`));
    let connected!: () => void;
    const ready = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onReconnect: () => {
        order.push("reconnected");
        connected();
      },
    });

    let timeout!: NodeJS.Timeout;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("timed out waiting for Fabric sync")),
            1_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      stop();
    }
    assert.deepEqual(order, ["revoked:opaque:revoked", "reconnected"]);
  });

  it("reports remote Relay readiness only after the initial sync is complete", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const remote = new RemoteFabricAuthority(
      "http://control.test",
      "tok",
      async (input) => {
        assert.equal(String(input), `http://control.test${FABRIC_REVOCATIONS}`);
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    );
    const relay = await startRelay({
      port: 0,
      host: "127.0.0.1",
      authority: new FakeAuthority(),
      fabricAuthority: remote,
    });
    let resolved = false;
    void relay.fabricReady.then(() => {
      resolved = true;
    });

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(resolved, false);
      const healthBefore = (await (
        await fetch(`http://127.0.0.1:${relay.port}/api/health`)
      ).json()) as { fabric: { authorityReady: boolean } };
      assert.equal(healthBefore.fabric.authorityReady, false);
      assert.deepEqual(
        await connect(
          `ws://127.0.0.1:${relay.port}${FABRIC_PATH}?ticket=must-not-be-spent`,
        ),
        { error: "503" },
      );

      streamController.enqueue(encoder.encode("event: sync\n"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(resolved, false, "a partial first event must not open admission");

      streamController.enqueue(encoder.encode('data: {"revocations":[]}\n\n'));
      await relay.fabricReady;
      assert.equal(resolved, true);
      const healthAfter = (await (
        await fetch(`http://127.0.0.1:${relay.port}/api/health`)
      ).json()) as { fabric: { authorityReady: boolean } };
      assert.equal(healthAfter.fabric.authorityReady, true);
    } finally {
      await relay.close();
      streamController.close();
    }
  });

  it("fails active bindings closed when the revocation stream ends", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: sync\ndata: {"revocations":[]}\n\n'));
        controller.close();
      },
    });
    const remote = new RemoteFabricAuthority("http://control.test", "tok", async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    let disconnected!: () => void;
    const failedClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onDisconnect: disconnected,
    });
    try {
      await failedClosed;
    } finally {
      stop();
    }
  });
});
