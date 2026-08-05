/**
 * The contract as it actually travels: HTTP paths and JSON bodies.
 *
 * Two implementations in two repositories have to agree on this, and only one
 * of them is open. So it is written down here, in the open one, where anyone
 * can read exactly what the relay is able to ask about them — three questions,
 * none of which involve the traffic itself.
 *
 * Changing anything in this file is a cross-repository change. The control
 * plane keeps a copy and a test that fails when the two drift apart.
 */

export const WIRE_VERSION = 1;

export const AUTHORIZE_DAEMON = "/internal/authorize-daemon";
/** Look up a client ticket without spending it (`ChannelAuthority.inspectClient`). */
export const INSPECT_CLIENT = "/internal/inspect-client";
export const AUTHORIZE_CLIENT = "/internal/authorize-client";
export const PRESENCE = "/internal/presence";
export const REVOCATIONS = "/internal/revocations";

/** `POST /internal/authorize-daemon` */
export interface AuthorizeDaemonRequest {
  ticket: string;
}

/** 200 grant; 204 definitive refusal. Non-2xx is an operational/contract error. */
export interface AuthorizeDaemonResponse {
  machineId: string;
  daemonId: string;
  connectionGeneration: number;
  presenceLeaseSeconds: number;
}

/** `POST /internal/inspect-client` and `POST /internal/authorize-client` */
export interface AuthorizeClientRequest {
  ticket: string;
}

/** 200 with a body, or 204 for "no". Same shape for inspect and authorize. */
export interface AuthorizeClientResponse {
  machineId: string;
  clientId: string;
  channelCapability: string;
}

/**
 * `POST /internal/presence` — 204 when this generation was applied; 409 when
 * Control has already fenced it out. Both responses have no body.
 */
export interface PresenceRequest {
  machineId: string;
  connectionGeneration: number;
  state: "online" | "offline";
}

/**
 * `GET /internal/revocations` — an SSE stream, one JSON object per event.
 *
 * The relay subscribes; the control plane never calls the relay. That keeps
 * every authenticated endpoint on the control side and lets a relay run behind
 * NAT, which is what makes "host your own" something a person can actually do
 * at home rather than only in a datacentre.
 */
export type RevocationEvent =
  | {
      /** Optional only so a new relay can consume events from an older Hub. */
      target?: "machine";
      machineId: string;
      reason: string;
    }
  | {
      target: "client";
      clientId: string;
      reason: string;
    };

/**
 * Sent first on every subscribe, listing machines revoked recently enough that
 * a relay which was disconnected might still be holding their sockets open.
 * Without it, a revocation that lands during a blip is a revocation that does
 * not take effect until the machine happens to reconnect.
 */
export interface RevocationSync {
  machineIds: string[];
  /** Missing when a new relay briefly overlaps an older Hub during rollout. */
  clientIds?: string[];
}

/** Initial catch-up may be split into bounded pages; ready only follows complete. */
export type RevocationSyncPage = RevocationSync;
export type RevocationSyncComplete = Record<string, never>;
