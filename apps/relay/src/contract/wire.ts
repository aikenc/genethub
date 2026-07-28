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
export const AUTHORIZE_CLIENT = "/internal/authorize-client";
export const PRESENCE = "/internal/presence";
export const REVOCATIONS = "/internal/revocations";

/** `POST /internal/authorize-daemon` */
export interface AuthorizeDaemonRequest {
  ticket: string;
}

/** 200 with a body, or 204 for "no". Never an error for a bad ticket. */
export interface AuthorizeDaemonResponse {
  machineId: string;
  daemonId: string;
}

/** `POST /internal/authorize-client` */
export interface AuthorizeClientRequest {
  ticket: string;
}

export interface AuthorizeClientResponse {
  machineId: string;
  clientId: string;
}

/** `POST /internal/presence` — 204, no body. */
export interface PresenceRequest {
  machineId: string;
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
export interface RevocationEvent {
  machineId: string;
  reason: string;
}

/**
 * Sent first on every subscribe, listing machines revoked recently enough that
 * a relay which was disconnected might still be holding their sockets open.
 * Without it, a revocation that lands during a blip is a revocation that does
 * not take effect until the machine happens to reconnect.
 */
export interface RevocationSync {
  machineIds: string[];
}
