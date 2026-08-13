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
import {
  AuthorityHttpError,
  isDefinitiveAuthorityError,
} from "../src/shared/authority-error.js";
import { connect } from "./harness.js";

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`test timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function wasAborted(signal: AbortSignal | null): boolean {
  return signal?.aborted ?? false;
}

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
      presenceLeaseSeconds: 90,
    });

    const grant = await authority().authorizeEndpoint("one-shot-credential");
    assert.deepEqual(grant, {
      endpointHandle: "opaque:endpoint:1",
      revocationHandle: "opaque:revoke:1",
      expiresAt: null,
      connectionGeneration: 7,
      presenceLeaseSeconds: 90,
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

  it("treats a fenced Fabric generation as a definitive presence refusal", async () => {
    reply = new Response(null, { status: 409 });
    await assert.rejects(
      authority().reportEndpointPresence("opaque:endpoint:stale", 6, "online"),
      (error: unknown) =>
        error instanceof AuthorityHttpError &&
        error.status === 409 &&
        isDefinitiveAuthorityError(error),
    );
  });

  it("fails closed on refusal and control-plane failure", async () => {
    reply = new Response(null, { status: 204 });
    assert.equal(await authority().authorizeEndpoint("expired"), null);

    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    const broken = new RemoteFabricAuthority("http://control.test", null, async () => {
      throw new Error("ECONNREFUSED credential-that-must-not-be-logged");
    });
    try {
      await assert.rejects(broken.authorizeRoute("source", "route"), /ECONNREFUSED/);
    } finally {
      console.error = original;
    }
    assert.match(lines.join("\n"), /"error":"Error"/);
    assert.doesNotMatch(lines.join("\n"), /credential-that-must-not-be-logged/);
  });

  it("aborts and fails closed when an authority POST exceeds its deadline", async () => {
    let requestSignal: AbortSignal | null = null;
    const remote = new RemoteFabricAuthority(
      "http://control.test",
      "tok",
      async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return await new Promise<Response>(() => {});
      },
      { requestTimeoutMs: 25 },
    );

    await assert.rejects(within(remote.authorizeRoute("source", "route")), /timed out/);
    assert.equal(wasAborted(requestSignal), true);
  });

  it("keeps malformed, 5xx and oversized responses distinct from a 204 refusal", async () => {
    reply = Response.json({ endpointHandle: 7 });
    await assert.rejects(authority().authorizeEndpoint("malformed"), /invalid endpoint grant/);

    reply = new Response(null, { status: 503 });
    await assert.rejects(authority().authorizeEndpoint("unavailable"), /returned 503/);

    reply = new Response("{}", {
      status: 200,
      headers: { "content-length": "9999999" },
    });
    await assert.rejects(authority().authorizeEndpoint("declared-oversized"), /byte limit/);

    const oversized = new RemoteFabricAuthority(
      "http://control.test",
      null,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(65));
              controller.close();
            },
          }),
        ),
      { maxAuthorityResponseBytes: 64 },
    );
    await assert.rejects(
      oversized.authorizeEndpoint("oversized"),
      /byte limit/,
    );
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

  it("fails closed when the revocation fetch never returns headers", async () => {
    let requestSignal: AbortSignal | null = null;
    const remote = new RemoteFabricAuthority(
      "http://control.test",
      "tok",
      async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return await new Promise<Response>(() => {});
      },
      { requestTimeoutMs: 25 },
    );
    let reconnects = 0;
    let disconnected!: () => void;
    const failedClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onReconnect: () => {
        reconnects += 1;
      },
      onDisconnect: disconnected,
    });

    try {
      await within(failedClosed);
      assert.equal(reconnects, 0);
      assert.equal(wasAborted(requestSignal), true);
    } finally {
      stop();
    }
  });

  it("fails closed when SSE headers arrive without an initial sync", async () => {
    let requestSignal: AbortSignal | null = null;
    const stream = new ReadableStream<Uint8Array>();
    const remote = new RemoteFabricAuthority(
      "http://control.test",
      "tok",
      async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      { firstEventTimeoutMs: 25 },
    );
    let reconnects = 0;
    let disconnected!: () => void;
    const failedClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onReconnect: () => {
        reconnects += 1;
      },
      onDisconnect: disconnected,
    });

    try {
      await within(failedClosed);
      assert.equal(reconnects, 0, "response headers alone must never make Fabric ready");
      assert.equal(wasAborted(requestSignal), true);
    } finally {
      stop();
    }
  });

  it("fails closed after a synchronized revocation stream becomes idle", async () => {
    const encoder = new TextEncoder();
    let requestSignal: AbortSignal | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: sync\ndata: {"revocations":[]}\n\n'));
      },
    });
    const remote = new RemoteFabricAuthority(
      "http://control.test",
      "tok",
      async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      { idleTimeoutMs: 25 },
    );
    let reconnects = 0;
    let disconnected!: () => void;
    const failedClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onReconnect: () => {
        reconnects += 1;
      },
      onDisconnect: disconnected,
    });

    try {
      await within(failedClosed);
      assert.equal(reconnects, 1);
      assert.equal(wasAborted(requestSignal), true);
    } finally {
      stop();
    }
  });

  it("aborts and fails closed on malformed post-sync event data", async () => {
    const encoder = new TextEncoder();
    let requestSignal: AbortSignal | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: sync\ndata: {"revocations":[]}\n\nevent: revoked\ndata: {broken-json}\n\n',
          ),
        );
      },
    });
    const remote = new RemoteFabricAuthority(
      "http://control.test",
      "tok",
      async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    );
    let reconnects = 0;
    let disconnected!: () => void;
    const failedClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onReconnect: () => {
        reconnects += 1;
      },
      onDisconnect: disconnected,
    });

    try {
      await within(failedClosed);
      assert.equal(reconnects, 1);
      assert.equal(wasAborted(requestSignal), true);
    } finally {
      stop();
    }
  });

  it("aborts and fails closed when an unterminated SSE event exceeds the buffer limit", async () => {
    const encoder = new TextEncoder();
    let requestSignal: AbortSignal | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${"x".repeat(64)}`));
      },
    });
    const remote = new RemoteFabricAuthority(
      "http://control.test",
      "tok",
      async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      { maxRevocationBufferBytes: 32 },
    );
    let reconnects = 0;
    let disconnected!: () => void;
    const failedClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onReconnect: () => {
        reconnects += 1;
      },
      onDisconnect: disconnected,
    });

    try {
      await within(failedClosed);
      assert.equal(reconnects, 0);
      assert.equal(wasAborted(requestSignal), true);
    } finally {
      stop();
    }
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

  it("waits for Fabric sync-complete after installing every bounded page", async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const remote = new RemoteFabricAuthority("http://control.test", "tok", async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const revoked: string[] = [];
    let reconnects = 0;
    remote.onFabricRevoked((event) => revoked.push(event.handle));
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onReconnect: () => {
        reconnects += 1;
      },
    });
    try {
      stream.enqueue(
        encoder.encode(
          'event: sync-page\ndata: {"revocations":[{"target":"route","handle":"r1"}]}\n\n',
        ),
      );
      stream.enqueue(
        encoder.encode(
          'event: sync-page\ndata: {"revocations":[{"target":"endpoint","handle":"e1"}]}\n\n',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(revoked, ["r1", "e1"]);
      assert.equal(reconnects, 0);
      stream.enqueue(encoder.encode("event: sync-complete\ndata: {}\n\n"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(reconnects, 1);
    } finally {
      stop();
    }
  });

  it("does not report a reconnect until the replacement stream completes a valid sync", async () => {
    const encoder = new TextEncoder();
    let fetches = 0;
    let replacementController!: ReadableStreamDefaultController<Uint8Array>;
    let replacementStarted!: () => void;
    const replacementConnected = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    const remote = new RemoteFabricAuthority(
      "http://control.test",
      "tok",
      async () => {
        fetches += 1;
        if (fetches === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode('event: sync\ndata: {"revocations":[]}\n\n'),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              replacementController = controller;
              replacementStarted();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { firstEventTimeoutMs: 1_000, idleTimeoutMs: 1_000 },
    );
    let reconnects = 0;
    let replacementReady!: () => void;
    const readyAgain = new Promise<void>((resolve) => {
      replacementReady = resolve;
    });
    const stop = remote.watchRevocations({
      retryMs: 1,
      onReconnect: () => {
        reconnects += 1;
        if (reconnects === 2) replacementReady();
      },
    });

    try {
      await within(replacementConnected);
      assert.equal(reconnects, 1, "response headers must not complete a reconnect");
      replacementController.enqueue(encoder.encode("event: sync\n"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reconnects, 1, "a partial sync must not complete a reconnect");
      replacementController.enqueue(encoder.encode('data: {"revocations":[]}\n\n'));
      await within(readyAgain);
      assert.equal(reconnects, 2);
    } finally {
      stop();
    }
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
      streamController.close();
      await relay.close();
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
