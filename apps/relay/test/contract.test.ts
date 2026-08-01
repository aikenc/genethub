import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { AUTHORIZE_CLIENT, AUTHORIZE_DAEMON, PRESENCE } from "../src/contract/wire.js";
import { RemoteAuthority } from "../src/forward/remote-authority.js";

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
    reply = Response.json({ machineId: "m_1", daemonId: "dmn_1" });
    const grant = await authority().authorizeDaemon("uplink-ticket");

    assert.deepEqual(grant, { machineId: "m_1", daemonId: "dmn_1" });
    const call = seen.at(-1)!;
    assert.equal(call.url, `http://control.test${AUTHORIZE_DAEMON}`);
    assert.deepEqual(call.body, { ticket: "uplink-ticket" });
    assert.equal(call.headers.get("authorization"), "Bearer tok");
  });

  it("asks about a client ticket the same way", async () => {
    reply = Response.json({ machineId: "m_1", clientId: "dev_1" });
    const grant = await authority().authorizeClient("channel-ticket");

    assert.deepEqual(grant, { machineId: "m_1", clientId: "dev_1" });
    assert.equal(seen.at(-1)!.url, `http://control.test${AUTHORIZE_CLIENT}`);
  });

  it("reads 204 as a refusal rather than an error", async () => {
    reply = new Response(null, { status: 204 });
    assert.equal(await authority().authorizeDaemon("stale"), null);
  });

  it("treats an unreachable control plane as a refusal, not a crash", async () => {
    const broken = new RemoteAuthority("http://control.test", null, async () => {
      throw new Error("ECONNREFUSED");
    });
    // Refusing to connect is the safe failure: the alternative is admitting
    // everyone whenever the control plane has a bad minute.
    assert.equal(await broken.authorizeClient("anything"), null);
  });

  it("reports presence and expects nothing back", async () => {
    reply = new Response(null, { status: 204 });
    await authority().reportPresence("m_1", "offline");
    const call = seen.at(-1)!;
    assert.equal(call.url, `http://control.test${PRESENCE}`);
    assert.deepEqual(call.body, { machineId: "m_1", state: "offline" });
  });

  it("sends no credential when it has none, rather than an empty one", async () => {
    reply = new Response(null, { status: 204 });
    await new RemoteAuthority("http://control.test", null, fakeFetch).reportPresence(
      "m_1",
      "online",
    );
    assert.equal(seen.at(-1)!.headers.has("authorization"), false);
  });

  it("passes a revocation straight through to whoever is listening", () => {
    const remote = authority();
    const seenRevocations: string[] = [];
    remote.onRevoked(({ machineId }) => seenRevocations.push(machineId));
    remote.deliverRevocation({ machineId: "m_9", reason: "revoked by the owner" });
    assert.deepEqual(seenRevocations, ["m_9"]);
  });

  it("fires onReconnect every time the revocation stream is re-established", async () => {
    // A stream that ends at once, so the watcher loops: each pass is one
    // (re)connect and must be one resync signal — that signal is what brings
    // presence back after the control plane restarts and boots every machine
    // to offline.
    const authority = new RemoteAuthority("http://control.test", "tok", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    let resyncs = 0;
    const stop = authority.watchRevocations({
      retryMs: 5,
      onReconnect: () => {
        resyncs += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();
    assert.ok(resyncs >= 2, `expected a resync per (re)connect, saw ${resyncs}`);
  });
});
