import type { PeerAuth, PeerHello, PeerWelcome } from "@genehub/proto";

import {
  channelClientProof,
  channelServerProof,
  deriveChannelSessionKey,
  deviceChannelContext,
  hostedChannelContext,
  randomNonce,
  type ChannelSessionKey,
} from "../devices/proof";
import {
  DATA_PLANE_VERSION,
  INITIAL_STREAM_WINDOW_BYTES,
  MAX_BULK_STREAM_WINDOW_BYTES,
} from "./frame";

export type PeerCredential =
  | { kind: "loopback"; secret: string }
  | { kind: "device"; deviceId: string; secret: string }
  | { kind: "hosted"; capabilityId: string; secret: string }
  | { kind: "invite"; inviteId: string; secret: string };

export interface PreparedPeerHandshake {
  hello: PeerHello;
  complete(welcome: PeerWelcome): Promise<PeerHandshakeResult>;
}

export interface PeerHandshakeResult {
  key: ChannelSessionKey;
  /** Receive lease advertised by this authenticated daemon for finite bulk flows. */
  maxBulkStreamWindowBytes: number;
}

/** Builds the only plaintext application message on a peer carrier. */
export async function preparePeerHandshake(
  credential: PeerCredential,
  options: { clientName?: string; rtcSupported?: boolean } = {},
): Promise<PreparedPeerHandshake> {
  const nonce = randomNonce();
  const context = contextOf(credential);
  const proof = await channelClientProof(credential.secret, context, nonce);
  const auth: PeerAuth = authOf(credential, nonce, proof);
  const hello: PeerHello = {
    version: DATA_PLANE_VERSION,
    clientName: boundedClientName(options.clientName),
    auth,
    rtcSupported: options.rtcSupported ?? supportsRtc(),
  };
  return {
    hello,
    async complete(welcome) {
      if (
        welcome.version !== DATA_PLANE_VERSION ||
        typeof welcome.serverNonce !== "string" ||
        !/^[0-9a-f]{32,128}$/.test(welcome.serverNonce) ||
        typeof welcome.proof !== "string"
      ) {
        throw new Error("the daemon returned an invalid data-plane welcome");
      }
      const expected = await channelServerProof(
        credential.secret,
        context,
        nonce,
        welcome.serverNonce,
      );
      if (!sameHex(welcome.proof, expected)) {
        throw new Error("the peer did not prove the expected E2EE secret");
      }
      const advertised = welcome.maxBulkStreamWindowBytes;
      const maxBulkStreamWindowBytes =
        advertised === undefined
          ? INITIAL_STREAM_WINDOW_BYTES
          : validBulkWindow(advertised);
      return {
        key: await deriveChannelSessionKey(
          credential.secret,
          context,
          nonce,
          welcome.serverNonce,
        ),
        maxBulkStreamWindowBytes,
      };
    },
  };
}

function validBulkWindow(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < INITIAL_STREAM_WINDOW_BYTES ||
    value > MAX_BULK_STREAM_WINDOW_BYTES
  ) {
    throw new Error("the daemon advertised an invalid finite-bulk receive lease");
  }
  return value;
}

function contextOf(credential: PeerCredential): string {
  switch (credential.kind) {
    case "loopback":
      return "loopback";
    case "device":
      return deviceChannelContext(credential.deviceId);
    case "hosted":
      return hostedChannelContext(credential.capabilityId);
    case "invite":
      return `invite:${credential.inviteId}`;
  }
}

function authOf(
  credential: PeerCredential,
  nonce: string,
  proof: string,
): PeerAuth {
  switch (credential.kind) {
    case "loopback":
      return { type: "loopback", context: "loopback", nonce, proof };
    case "device":
      return { type: "device", deviceId: credential.deviceId, nonce, proof };
    case "hosted":
      return {
        type: "hosted",
        capabilityId: credential.capabilityId,
        nonce,
        proof,
      };
    case "invite":
      return { type: "invite", inviteId: credential.inviteId, nonce, proof };
  }
}

function boundedClientName(value = "genehub-web"): string {
  const name = value.trim();
  if (!name || new TextEncoder().encode(name).byteLength > 80) {
    throw new Error("invalid data-plane client name");
  }
  return name;
}

function supportsRtc(): boolean {
  return typeof globalThis.RTCPeerConnection === "function";
}

function sameHex(left: string, right: string): boolean {
  if (
    left.length !== right.length ||
    !/^[0-9a-f]+$/i.test(left) ||
    !/^[0-9a-f]+$/i.test(right)
  ) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
