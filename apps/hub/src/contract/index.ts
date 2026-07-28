/**
 * The only thing the forwarding role is allowed to know about the control
 * plane (`docs/architecture.md` §6.4).
 *
 * Every method is async, takes and returns plain serialisable data, and shares
 * no memory or transaction with the caller. That is not decoration: it is what
 * makes "same process today, separate service tomorrow" a change of
 * implementation rather than a rewrite of the callers.
 *
 * Keep this file small. Every method added here is a method that has to survive
 * becoming a network call.
 */

/**
 * Where the forwarding role listens. Shared because the control plane has to
 * hand these URLs out, and a constant in one place beats two string literals
 * that drift.
 */
export const DAEMON_PATH = "/forward/daemon";
export const CLIENT_PATH = "/forward/client";

/** A daemon's outbound registration was accepted. */
export interface DaemonGrant {
  machineId: string;
  /** Opaque to the forwarder; handed back on presence reports. */
  daemonId: string;
}

/** A client may attach to a machine's channel. */
export interface ClientGrant {
  machineId: string;
  /** Identifies the attaching device, for presence and revocation. */
  clientId: string;
}

export type PresenceState = "online" | "offline";

export interface Revocation {
  machineId: string;
  reason: string;
}

export interface ChannelAuthority {
  /** Machine registering its outbound connection. Null means "not allowed". */
  authorizeDaemon(ticket: string): Promise<DaemonGrant | null>;

  /** Device asking to attach to a machine. Null means "not allowed". */
  authorizeClient(ticket: string): Promise<ClientGrant | null>;

  /** Tells the control plane whether a machine currently has an uplink. */
  reportPresence(machineId: string, state: PresenceState): Promise<void>;

  /** Control plane pushes "cut this machine loose" to the forwarder. */
  onRevoked(handler: (revocation: Revocation) => void): void;
}
