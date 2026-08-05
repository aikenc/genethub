import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeFabricFrame,
  decodeFabricOpenPayload,
  encodeFabricFrame,
  encodeFabricOpenPayload,
  FABRIC_HEADER_BYTES,
  MAX_OPERATION_METADATA_BYTES,
  FABRIC_VERSION,
  FabricKind,
  ZERO_STREAM_ID,
} from "../src/forward/fabric-frame.js";

const STREAM = "0123456789abcdef0123456789abcdef";

describe("Fabric v2 framing", () => {
  it("round-trips opaque binary DATA without interpreting it", () => {
    const payload = Buffer.from([
      0xff,
      0x00,
      0x7b,
      0x22,
      0x73,
      0x65,
      0x63,
      0x72,
      0x65,
      0x74,
      0x22,
      0x3a,
      0x31,
      0x7d,
    ]);
    const encoded = encodeFabricFrame({
      kind: FabricKind.Data,
      streamId: STREAM,
      value: 7n,
      payload,
    });
    const decoded = decodeFabricFrame(encoded);

    assert.ok(decoded);
    assert.equal(decoded.kind, FabricKind.Data);
    assert.equal(decoded.streamId, STREAM);
    assert.equal(decoded.value, 7n);
    assert.deepEqual(decoded.payload, payload);
  });

  it("parses only the route-ticket boundary of OPEN and preserves the hello", () => {
    const hello = Buffer.from([0x00, 0xff, 0x80, 0x01, 0x7b, 0x7d]);
    const payload = encodeFabricOpenPayload("opaque-route-ticket", hello);

    assert.deepEqual(decodeFabricOpenPayload(payload), {
      routeTicket: "opaque-route-ticket",
      opaqueHello: hello,
    });
  });

  it("rejects malformed headers, reserved flags, and invalid stream classes", () => {
    assert.equal(decodeFabricFrame(Buffer.alloc(FABRIC_HEADER_BYTES - 1)), null);

    const wrongVersion = encodeFabricFrame({
      kind: FabricKind.Data,
      streamId: STREAM,
      value: 1n,
      payload: Buffer.alloc(0),
    });
    wrongVersion[0] = FABRIC_VERSION + 1;
    assert.equal(decodeFabricFrame(wrongVersion), null);

    const reservedFlags = Buffer.from(
      encodeFabricFrame({
        kind: FabricKind.Data,
        streamId: STREAM,
        value: 1n,
        payload: Buffer.alloc(0),
      }),
    );
    reservedFlags.writeUInt16BE(1, 2);
    assert.equal(decodeFabricFrame(reservedFlags), null);

    assert.throws(
      () =>
        encodeFabricFrame({
          kind: FabricKind.Data,
          streamId: ZERO_STREAM_ID,
          value: 1n,
          payload: Buffer.alloc(0),
        }),
      /cannot be mixed/,
    );
    assert.throws(
      () =>
        encodeFabricFrame({
          kind: FabricKind.Ping,
          streamId: STREAM,
          value: 1n,
          payload: Buffer.alloc(0),
        }),
      /cannot be mixed/,
    );
  });

  it("rejects empty, truncated, oversized, and non-UTF-8 route tickets", () => {
    assert.equal(decodeFabricOpenPayload(Buffer.from([0, 0])), null);
    assert.equal(decodeFabricOpenPayload(Buffer.from([0, 4, 0x61])), null);
    assert.equal(decodeFabricOpenPayload(Buffer.from([0, 1, 0xff])), null);

    const oversizedLength = Buffer.alloc(2);
    oversizedLength.writeUInt16BE(4097, 0);
    assert.equal(decodeFabricOpenPayload(oversizedLength), null);
  });

  it("bounds opaque OPEN metadata independently from DATA frames", () => {
    const boundary = encodeFabricOpenPayload(
      "ticket",
      Buffer.alloc(MAX_OPERATION_METADATA_BYTES),
    );
    assert.equal(
      decodeFabricOpenPayload(boundary)?.opaqueHello.length,
      MAX_OPERATION_METADATA_BYTES,
    );
    assert.throws(
      () =>
        encodeFabricOpenPayload(
          "ticket",
          Buffer.alloc(MAX_OPERATION_METADATA_BYTES + 1),
        ),
      /operation metadata/,
    );
    assert.equal(
      decodeFabricOpenPayload(Buffer.concat([boundary, Buffer.from([1])])),
      null,
    );
  });
});
