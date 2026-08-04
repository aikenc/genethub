import { describe, expect, it } from "vitest";

import {
  channelClientProof,
  channelServerProof,
  deriveChannelSessionKey,
  openChannelFrame,
  sealChannelFrame,
  type ChannelDirection,
} from "./proof";

const SECRET = "0123456789abcdef".repeat(4);
const CONTEXT = "hosted:cap_golden";
const CLIENT_NONCE = "00112233445566778899aabbccddeeff";
const SERVER_NONCE = "ffeeddccbbaa99887766554433221100";
const PLAINTEXT = '{"id":"vector","type":"connection.identity"}';

const DIRECTIONS: Array<{
  direction: ChannelDirection;
  body: string;
  mac: string;
}> = [
  {
    direction: "client-to-daemon",
    body: "mQ-ImSzrzMxYwp4U9arFZahyEjdPYdDAZ0fdvD0JbtoauaBNRGISBpoJWVMNNACBOMagpAVdy9Tft2yk",
    mac: "d3011fb60bb148fc93edef330ce2b92cf6829ce31d5e72a7712157d5ad520633",
  },
  {
    direction: "daemon-to-client",
    body: "ZockPFxM1fAFyOyk90K1zciLolBzZaASZncJirI8Wc6bsVHvyeUTszofYf7tFkiFKbSeyyVjb0EtbKz1",
    mac: "4a2ab0f8cbe9651d20bd4a248b5a4eaa6626e6e509983ecefe900bfa5dfccb5a",
  },
];

describe("the channel v2 cross-language wire", () => {
  /** Mirrored byte-for-byte in apps/daemon/src/channel_auth.rs. */
  it("matches the Rust handshake, ciphertext and MAC golden vectors", async () => {
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
    for (const vector of DIRECTIONS) {
      expect(await sealChannelFrame(key, vector.direction, 7, PLAINTEXT)).toEqual({
        body: vector.body,
        mac: vector.mac,
      });
      expect(
        await openChannelFrame(
          key,
          vector.direction,
          7,
          vector.body,
          vector.mac,
        ),
      ).toBe(PLAINTEXT);
    }
  });
});
