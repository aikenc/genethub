import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FABRIC_PATH } from "../src/contract/fabric-wire.js";
import {
  decodeFabricFrame,
  encodeFabricFrame,
  encodeFabricOpenPayload,
  FABRIC_INITIAL_STREAM_CREDIT,
  FabricKind,
} from "../src/forward/fabric-frame.js";
import {
  RendezvousFabricAuthority,
  resolveJoinToken,
} from "../src/forward/rendezvous.js";
import {
  connect,
  nextMessage,
  opened,
  startTestRelay,
} from "./harness.js";

const SLOT = "0123456789abcdef0123456789abcdef";
const OTHER_SLOT = "fedcba9876543210fedcba9876543210";

describe("the endpoint-neutral rendezvous Fabric", () => {
  it("routes a client to the online node holding the same opaque slot", async () => {
    const authority = new RendezvousFabricAuthority(null);
    const relay = await startTestRelay(authority);
    const node = opened(
      await connect(`${relay.wsOrigin}${FABRIC_PATH}?ticket=${SLOT}`),
    );
    const client = opened(
      await connect(
        `${relay.wsOrigin}${FABRIC_PATH}?ticket=${encodeURIComponent(`client:${SLOT}`)}`,
      ),
    );
    const incoming = nextMessage(node);
    client.send(
      encodeFabricFrame({
        kind: FabricKind.Open,
        streamId: "00000000000000000000000000000001",
        value: BigInt(FABRIC_INITIAL_STREAM_CREDIT),
        payload: encodeFabricOpenPayload(SLOT, Buffer.from("opaque hello")),
      }),
    );

    const frame = decodeFabricFrame(await incoming);
    assert.ok(frame);
    assert.equal(frame.kind, FabricKind.Incoming);
    assert.deepEqual(frame.payload, Buffer.from("opaque hello"));

    client.close();
    node.close();
    await relay.stop();
  });

  it("turns away a client naming a slot no node holds", async () => {
    const authority = new RendezvousFabricAuthority(null);
    assert.equal(await authority.authorizeEndpoint(`client:${SLOT}`), null);
  });

  it("requires the join token only from nodes", async () => {
    const authority = new RendezvousFabricAuthority("let-me-in");
    assert.equal(await authority.authorizeEndpoint(`wrong.${SLOT}`), null);
    const node = await authority.authorizeEndpoint(`let-me-in.${SLOT}`);
    assert.equal(node?.endpointHandle, `node:${SLOT}`);
    await authority.reportEndpointPresence(
      node!.endpointHandle,
      node!.connectionGeneration,
      "online",
    );
    assert.match(
      (await authority.authorizeEndpoint(`client:${SLOT}`))?.endpointHandle ?? "",
      /^client:[0-9a-f]{32}$/,
    );
  });

  it("authorizes routes only from admitted clients to an online slot", async () => {
    const authority = new RendezvousFabricAuthority(null);
    const node = await authority.authorizeEndpoint(SLOT);
    await authority.reportEndpointPresence(
      node!.endpointHandle,
      node!.connectionGeneration,
      "online",
    );
    const client = await authority.authorizeEndpoint(`client:${SLOT}`);
    assert.equal(
      await authority.authorizeRoute(node!.endpointHandle, SLOT),
      null,
      "nodes cannot turn the self-hosted relay into an arbitrary router",
    );
    assert.equal(
      await authority.authorizeRoute(client!.endpointHandle, OTHER_SLOT),
      null,
    );
    const route = await authority.authorizeRoute(client!.endpointHandle, SLOT);
    assert.equal(route?.targetEndpointHandle, `node:${SLOT}`);
    assert.match(route?.routeHandle ?? "", /^route:[0-9a-f]{32}$/);
  });

  it("rejects empty, malformed and non-lowercase slots", async () => {
    const authority = new RendezvousFabricAuthority(null);
    for (const invalid of ["", "slot-1", "A".repeat(32), "a".repeat(31)]) {
      assert.equal(await authority.authorizeEndpoint(invalid), null);
      assert.equal(await authority.authorizeEndpoint(`client:${invalid}`), null);
    }
  });

  it("will not listen where others can reach it without a strong token", () => {
    assert.equal(resolveJoinToken(null, "127.0.0.1"), null);
    assert.equal(resolveJoinToken(null, "127.42.0.9"), null);
    assert.equal(resolveJoinToken(null, "::1"), null);
    const strong = "0123456789abcdef".repeat(4);
    assert.equal(resolveJoinToken(strong, "0.0.0.0"), strong);
    assert.throws(() => resolveJoinToken(null, "0.0.0.0"), /RELAY_JOIN_TOKEN/);
    assert.throws(() => resolveJoinToken(null, "localhost"), /RELAY_JOIN_TOKEN/);
    assert.throws(() => resolveJoinToken(null, "192.168.1.2"), /RELAY_JOIN_TOKEN/);
    for (const weak of ["a", "configured", "a".repeat(31), `${"x".repeat(32)}.`]) {
      assert.throws(() => resolveJoinToken(weak, "0.0.0.0"), /32-256/);
    }
    assert.equal(resolveJoinToken("dev", "127.0.0.1"), "dev");
  });

  it("compares the node token safely even when presented lengths differ", async () => {
    const authority = new RendezvousFabricAuthority("let-me-in");
    assert.equal(await authority.authorizeEndpoint(`l.${SLOT}`), null);
    assert.equal(
      await authority.authorizeEndpoint(`let-me-in-and-more.${SLOT}`),
      null,
    );
    assert.equal(
      (await authority.authorizeEndpoint(`let-me-in.${SLOT}`))?.endpointHandle,
      `node:${SLOT}`,
    );
  });
});
