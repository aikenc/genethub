import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { AUTHORIZE_CLIENT, AUTHORIZE_DAEMON, PRESENCE } from "../src/contract/wire.js";
import { RemoteAuthority } from "../src/forward/remote-authority.js";
import { startRelay } from "../src/main.js";
import {
  AuthorityHttpError,
  isDefinitiveAuthorityError,
} from "../src/shared/authority-error.js";

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

/**
 * What the relay puts on the wire, checked without a control plane present.
 *
 * The control plane is closed and lives in another repository, so this is the
 * open half of the agreement: anyone can read these cases and see the complete
 * set of questions the relay is capable of asking.
 */
describe("the contract as the relay speaks it", () => {
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

  const authority = () => new RemoteAuthority("http://control.test", "tok", fakeFetch);

  before(() => seen.splice(0));
  after(() => seen.splice(0));

  it("asks about a daemon ticket and nothing else", async () => {
    reply = Response.json({
      machineId: "m_1",
      daemonId: "dmn_1",
      connectionGeneration: 7,
      presenceLeaseSeconds: 90,
    });
    const grant = await authority().authorizeDaemon("uplink-ticket");

    assert.deepEqual(grant, {
      machineId: "m_1",
      daemonId: "dmn_1",
      connectionGeneration: 7,
      presenceLeaseSeconds: 90,
    });
    const call = seen.at(-1)!;
    assert.equal(call.url, `http://control.test${AUTHORIZE_DAEMON}`);
    assert.deepEqual(call.body, { ticket: "uplink-ticket" });
    assert.equal(call.headers.get("authorization"), "Bearer tok");
  });

  it("asks about a client ticket the same way", async () => {
    reply = Response.json({
      machineId: "m_1",
      clientId: "dev_1",
      channelCapability: "cap_dev_1",
    });
    const grant = await authority().authorizeClient("channel-ticket");

    assert.deepEqual(grant, {
      machineId: "m_1",
      clientId: "dev_1",
      channelCapability: "cap_dev_1",
    });
    assert.equal(seen.at(-1)!.url, `http://control.test${AUTHORIZE_CLIENT}`);
  });

  it("reads 204 as a refusal rather than an error", async () => {
    reply = new Response(null, { status: 204 });
    assert.equal(await authority().authorizeDaemon("stale"), null);
  });

  it("keeps an unreachable control plane distinct from a definitive refusal", async () => {
    const broken = new RemoteAuthority("http://control.test", null, async () => {
      throw new Error("ECONNREFUSED");
    });
    await assert.rejects(broken.authorizeClient("anything"), /ECONNREFUSED/);
  });

  it("aborts an authority request which exceeds its deadline as a transient failure", async () => {
    let requestSignal: AbortSignal | null = null;
    const remote = new RemoteAuthority(
      "http://control.test",
      "tok",
      async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return await new Promise<Response>(() => {});
      },
      { requestTimeoutMs: 25 },
    );

    await assert.rejects(within(remote.authorizeClient("stalled")), /timed out/);
    assert.equal(wasAborted(requestSignal), true);
  });

  it("does not collapse Control 5xx or malformed success bodies into an invalid ticket", async () => {
    reply = new Response(null, { status: 503 });
    await assert.rejects(authority().authorizeDaemon("fresh-admission"), /returned 503/);

    reply = new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(authority().authorizeClient("fresh-client-ticket"));
  });

  it("validates grant shape and bounds declared or streamed JSON bodies", async () => {
    reply = Response.json({
      machineId: "m_1",
      clientId: "dev_1",
      channelCapability: "contains spaces",
    });
    await assert.rejects(authority().authorizeClient("bad-shape"), /invalid client grant/);

    reply = new Response("{}", {
      status: 200,
      headers: { "content-length": "9999999" },
    });
    await assert.rejects(authority().authorizeDaemon("declared-large"), /byte limit/);

    const remote = new RemoteAuthority(
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
    await assert.rejects(remote.authorizeDaemon("chunked-large"), /byte limit/);
  });

  it("aborts before decoding an oversized legacy SSE chunk", async () => {
    let requestSignal: AbortSignal | null = null;
    const remote = new RemoteAuthority(
      "http://control.test",
      "tok",
      async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(65));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { maxRevocationBufferBytes: 64 },
    );
    let disconnected!: () => void;
    const failed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onDisconnect: disconnected,
    });
    try {
      await within(failed);
      assert.equal(wasAborted(requestSignal), true);
    } finally {
      stop();
    }
  });

  it("reports presence and expects nothing back", async () => {
    reply = new Response(null, { status: 204 });
    await authority().reportPresence("m_1", 7, "offline");
    const call = seen.at(-1)!;
    assert.equal(call.url, `http://control.test${PRESENCE}`);
    assert.deepEqual(call.body, {
      machineId: "m_1",
      connectionGeneration: 7,
      state: "offline",
    });
  });

  it("surfaces a stale presence generation as a definitive conflict", async () => {
    reply = new Response(null, { status: 409 });
    const failure = await authority()
      .reportPresence("m_stale", 3, "online")
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(failure instanceof AuthorityHttpError);
    assert.equal(failure.status, 409);
    assert.equal(isDefinitiveAuthorityError(failure), true);
  });

  it("sends no credential when it has none, rather than an empty one", async () => {
    reply = new Response(null, { status: 204 });
    await new RemoteAuthority("http://control.test", null, fakeFetch).reportPresence(
      "m_1",
      7,
      "online",
    );
    assert.equal(seen.at(-1)!.headers.has("authorization"), false);
  });

  it("passes a revocation straight through to whoever is listening", () => {
    const remote = authority();
    const seenRevocations: string[] = [];
    remote.onRevoked((event) =>
      seenRevocations.push(event.target === "machine" ? event.machineId : event.clientId),
    );
    remote.deliverRevocation({
      target: "machine",
      machineId: "m_9",
      reason: "revoked by the owner",
    });
    remote.deliverRevocation({
      target: "client",
      clientId: "dev_9",
      reason: "session revoked by the owner",
    });
    assert.deepEqual(seenRevocations, ["m_9", "dev_9"]);
  });

  it("reads machine and client catch-up events and accepts old machine events", async () => {
    const encoder = new TextEncoder();
    const remote = new RemoteAuthority("http://control.test", "tok", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              [
                'event: sync\ndata: {"machineIds":["m_sync"],"clientIds":["dev_sync"]}\n\n',
                'event: revoked\ndata: {"target":"client","clientId":"dev_live","reason":"signed out"}\n\n',
                'event: revoked\ndata: {"machineId":"m_old","reason":"old Hub"}\n\n',
              ].join(""),
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const seen: string[] = [];
    remote.onRevoked((event) => seen.push(event.target === "machine" ? event.machineId : event.clientId));

    const stop = remote.watchRevocations({ retryMs: 1_000 });
    try {
      const deadline = Date.now() + 500;
      while (seen.length < 4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(seen, ["m_sync", "dev_sync", "dev_live", "m_old"]);
    } finally {
      stop();
    }
  });

  it("installs bounded sync pages but announces readiness only after completion", async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const remote = new RemoteAuthority("http://control.test", "tok", async () =>
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
    remote.onRevoked((event) => {
      if (event.target === "machine") revoked.push(event.machineId);
    });
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onReconnect: () => {
        reconnects += 1;
      },
    });
    try {
      stream.enqueue(
        encoder.encode('event: sync-page\ndata: {"machineIds":["m_page_1"]}\n\n'),
      );
      stream.enqueue(
        encoder.encode('event: sync-page\ndata: {"machineIds":["m_page_2"]}\n\n'),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(revoked, ["m_page_1", "m_page_2"]);
      assert.equal(reconnects, 0);

      stream.enqueue(encoder.encode("event: sync-complete\ndata: {}\n\n"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(reconnects, 1);
    } finally {
      stop();
    }
  });

  it("fires onReconnect every time the revocation stream is re-established", async () => {
    // Each stream completes a valid sync and then ends, so the watcher loops.
    // Headers alone must never announce readiness: the durable snapshot is
    // what makes presence re-reporting safe after a control-plane restart.
    const encoder = new TextEncoder();
    const authority = new RemoteAuthority("http://control.test", "tok", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: sync\ndata: {"machineIds":[]}\n\n'));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    let resyncs = 0;
    let disconnects = 0;
    const stop = authority.watchRevocations({
      retryMs: 5,
      onReconnect: () => {
        resyncs += 1;
      },
      onDisconnect: () => {
        disconnects += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();
    assert.ok(resyncs >= 2, `expected a resync per (re)connect, saw ${resyncs}`);
    assert.ok(disconnects >= 2, `expected fail-close per dropped stream, saw ${disconnects}`);
  });

  it("does not announce readiness when SSE headers arrive without an initial sync", async () => {
    let reconnects = 0;
    let failClosed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      failClosed = resolve;
    });
    const remote = new RemoteAuthority(
      "http://control.test",
      "tok",
      async () =>
        new Response(new ReadableStream<Uint8Array>(), {
          headers: { "content-type": "text/event-stream" },
        }),
      { firstEventTimeoutMs: 25 },
    );
    const stop = remote.watchRevocations({
      retryMs: 60_000,
      onReconnect: () => {
        reconnects += 1;
      },
      onDisconnect: failClosed,
    });
    try {
      await within(disconnected);
      assert.equal(reconnects, 0);
    } finally {
      stop();
    }
  });

  it("exposes legacy authority readiness in health", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const remote = new RemoteAuthority(
      "http://control.test",
      "tok",
      async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const relay = await startRelay({
      port: 0,
      host: "127.0.0.1",
      authority: remote,
      fabricAuthority: null,
    });
    try {
      const health = async () =>
        (await (
          await fetch(`http://127.0.0.1:${relay.port}/api/health`)
        ).json()) as {
          status: "ok" | "degraded";
          ready: boolean;
          forward: { authorityReady: boolean };
        };
      assert.equal((await health()).forward.authorityReady, false);
      assert.deepEqual(
        { status: (await health()).status, ready: (await health()).ready },
        { status: "degraded", ready: false },
      );
      assert.equal(
        (await fetch(`http://127.0.0.1:${relay.port}/api/ready`)).status,
        503,
      );
      streamController.enqueue(encoder.encode("event: sync-complete\ndata: {}\n\n"));
      await within(relay.legacyReady);
      assert.equal((await health()).forward.authorityReady, true);
      assert.equal((await health()).status, "ok");
      assert.equal(
        (await fetch(`http://127.0.0.1:${relay.port}/api/ready`)).status,
        200,
      );

      relay.forwarder.authorityDisconnected();
      assert.equal((await health()).status, "degraded");
      assert.equal(
        (await fetch(`http://127.0.0.1:${relay.port}/api/ready`)).status,
        503,
      );
      relay.forwarder.authoritySynchronized();
      assert.equal((await health()).status, "ok");
    } finally {
      await relay.close();
    }
  });
});
