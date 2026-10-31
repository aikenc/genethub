import { describe, expect, it } from "vitest";

import { channelServerProof } from "../devices/proof";
import { DATA_PLANE_VERSION } from "./frame";
import { preparePeerHandshake } from "./handshake";

const SECRET = "finite-bulk-handshake-secret";
const SERVER_NONCE = "ffeeddccbbaa99887766554433221100";

async function welcome() {
  const prepared = await preparePeerHandshake({ kind: "loopback", secret: SECRET });
  const auth = prepared.hello.auth;
  if (auth.type !== "loopback") throw new Error("unexpected auth kind");
  const proof = await channelServerProof(
    SECRET,
    "loopback",
    auth.nonce,
    SERVER_NONCE,
  );
  return {
    prepared,
    value: {
      version: DATA_PLANE_VERSION,
      serverNonce: SERVER_NONCE,
      proof,
    },
  };
}

describe("the strict peer authentication handshake", () => {
  it("rejects the old data-plane generation", async () => {
    const fixture = await welcome();
    await expect(fixture.prepared.complete({ ...fixture.value, version: 3 })).rejects.toThrow("invalid data-plane welcome");
  });
  it("sends only identity and RTC capability, without a receive allowance", async () => {
    const fixture = await welcome();
    expect(Object.keys(fixture.prepared.hello).sort()).toEqual(["auth", "clientName", "rtcSupported", "version"]);
  });
  it("authenticates the expected peer and derives its record key", async () => {
    const fixture = await welcome();
    const result = await fixture.prepared.complete(fixture.value);
    expect(result.key.context).toBe("loopback");
  });
  it("rejects obsolete negotiated-window fields", async () => {
    const fixture = await welcome();
    const obsolete = { ...fixture.value, maxBulkStreamWindowBytes: 3 * 1024 * 1024 };
    await expect(fixture.prepared.complete(obsolete)).rejects.toThrow("invalid data-plane welcome");
  });
  it("rejects a peer which cannot prove the shared secret", async () => {
    const fixture = await welcome();
    await expect(fixture.prepared.complete({ ...fixture.value, proof: "0".repeat(64) })).rejects.toThrow("expected E2EE secret");
  });
});
