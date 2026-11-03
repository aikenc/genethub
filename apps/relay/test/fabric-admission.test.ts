import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { WebSocket } from "ws";

// This file runs in its own Node test process; use production configuration,
// with a small bound so the real incident can be reproduced without 100k sockets.
process.env.RELAY_MAX_FABRIC_GENERATION_FENCES = "2";
const { FABRIC_PATH } = await import("../src/contract/fabric-wire.js");
const { closed, connect, opened, FakeFabricAuthority, startTestRelay } = await import("./harness.js");

describe("fb_Xo1cR5T2re-R: historical admissions cannot exhaust the relay", () => {
  let authority: InstanceType<typeof FakeFabricAuthority>;
  let stack: Awaited<ReturnType<typeof startTestRelay>>;
  const sockets = new Set<WebSocket>();
  const releases: Array<() => void> = [];

  beforeEach(async () => {
    authority = new FakeFabricAuthority();
    stack = await startTestRelay(authority);
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    await stack.stop();
  });

  async function endpoint(handle: string, generation = 1): Promise<WebSocket> {
    const credential = `credential:${handle}:${generation}`;
    authority.grantEndpoint(credential, handle, { connectionGeneration: generation });
    const socket = opened(await connect(`${stack.wsOrigin}${FABRIC_PATH}?ticket=${credential}`));
    sockets.add(socket);
    return socket;
  }
  async function disconnect(socket: WebSocket, endpoints: number): Promise<void> {
    const ended = closed(socket);
    socket.close();
    await ended;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (stack.relay.fabricForwarder!.stats().endpoints === endpoints) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("relay did not observe socket closure");
  }

  it("admits 100 sequential identities beyond capacity while a node stays online", async () => {
    await endpoint("endpoint:node");
    for (let i = 0; i < 100; i++) {
      const client = await endpoint(`endpoint:client-${i}`);
      await disconnect(client, 1);
      sockets.delete(client);
      const health = await stack.json<{ ready: boolean; fabric: { admission: { generationFences: number } } }>("/api/health");
      assert.equal(health.ready, true, `admission ${i} poisoned relay readiness`);
      assert.equal(health.fabric.admission.generationFences, 1);
    }
  });

  it("reports actual exhaustion as unready and recovers when a live endpoint leaves", async () => {
    const first = await endpoint("endpoint:first");
    await endpoint("endpoint:second");
    assert.equal((await fetch(`${stack.origin}/api/ready`)).status, 503);
    const health = await stack.json<{ ready: boolean; fabric: { authorityReady: boolean } }>("/api/health");
    assert.equal(health.ready, false);
    assert.equal(health.fabric.authorityReady, true);
    await disconnect(first, 1);
    assert.equal((await fetch(`${stack.origin}/api/ready`)).status, 200);
    await endpoint("endpoint:third");
    assert.equal(stack.relay.fabricForwarder!.stats().endpoints, 2);
  });

  it("retains the winner fence after disconnect until a delayed older grant returns", async () => {
    const credential = "credential:delayed";
    authority.grantEndpoint(credential, "endpoint:race", { connectionGeneration: 1 });
    const held = authority.holdEndpointAuthorization(credential);
    releases.push(held.release);
    const pending = connect(`${stack.wsOrigin}${FABRIC_PATH}?ticket=${credential}`);
    await held.started;
    const winner = await endpoint("endpoint:race", 2);
    await disconnect(winner, 0);
    held.release();
    const stale = opened(await pending);
    sockets.add(stale);
    assert.equal(await closed(stale), 4409);
    assert.equal(stack.relay.fabricForwarder!.stats().endpoints, 0);
    await endpoint("endpoint:race", 3);
    await endpoint("endpoint:other");
    assert.equal(stack.relay.fabricForwarder!.stats().endpoints, 2);
  });
});
