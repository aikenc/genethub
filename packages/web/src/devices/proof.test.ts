import { describe, expect, it } from "vitest";

import {
  channelClientProof,
  channelServerProof,
  deriveChannelSessionKey,
} from "./proof";
import { openDataRecord, sealDataRecord } from "../dataplane/secure";

const SECRET = "0123456789abcdef".repeat(4);
const CONTEXT = "hosted:cap_golden";
const CLIENT_NONCE = "00112233445566778899aabbccddeeff";
const SERVER_NONCE = "ffeeddccbbaa99887766554433221100";
describe("the protocol-v3 cross-language E2EE wire", () => {
  /** Mirrored byte-for-byte in apps/daemon/src/channel_auth.rs. */
  it("matches the Rust handshake and binary record golden vectors", async () => {
    expect(await channelClientProof(SECRET, CONTEXT, CLIENT_NONCE)).toBe(
      "2a0958501e684eb33817ddca6c2346e3a5f0d683b2c821666c0b045a5afe801b",
    );
    expect(
      await channelServerProof(SECRET, CONTEXT, CLIENT_NONCE, SERVER_NONCE),
    ).toBe("6e7af7a542b0ed092aa7017984d91e81d80c904663fa669945ef36fe042c3094");

    const key = await deriveChannelSessionKey(
      SECRET,
      CONTEXT,
      CLIENT_NONCE,
      SERVER_NONCE,
    );
    const plaintext = new TextEncoder().encode("binary\0body");
    const wire = await sealDataRecord(key, "client-to-daemon", 7, plaintext);
    expect(hex(wire)).toBe(
      "47480300000000000000000778bfb3552d1c1a17eac4131325b976445893ce649d9c4361da402a",
    );
    expect(hex(await openDataRecord(key, "client-to-daemon", 7, wire))).toBe(
      hex(plaintext),
    );
  });
});

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
