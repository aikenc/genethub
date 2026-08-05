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
  /** Control-issued fence; stale offline reports cannot clear a replacement. */
  connectionGeneration: number;
  /** Control's presence lease; Relay refreshes well before this expires. */
  presenceLeaseSeconds: number;
}

/** A client may attach to a machine's channel. */
export interface ClientGrant {
  machineId: string;
  /** Identifies the attaching device, for presence and revocation. */
  clientId: string;
  /** Opaque capability passed to the daemon; never itself a credential. */
  channelCapability: string;
}

export type PresenceState = "online" | "offline";
export type LegacyPresenceResult =
  | "connected"
  | "renewed"
  | "disconnected"
  | "ignored";

/** A live legacy socket which must lose its authority immediately. */
export type Revocation =
  | {
      target: "machine";
      machineId: string;
      reason: string;
    }
  | {
      target: "client";
      /** The device-session id returned in `ClientGrant`. */
      clientId: string;
      reason: string;
    };

export interface ChannelAuthority {
  /**
   * Machine registering with a short-lived, one-use admission. Null means a
   * definitive refusal; transient authority failures reject the Promise.
   */
  authorizeDaemon(ticket: string): Promise<DaemonGrant | null>;

  /**
   * Look up a client ticket without spending it.
   *
   * The forwarder asks this first so it can refuse an offline machine with
   * 409 *before* burning a one-shot ticket. Spending happens in
   * `authorizeClient`, only once the uplink is known to be there.
   */
  inspectClient(ticket: string): Promise<ClientGrant | null>;

  /** Device asking to attach to a machine. Null means "not allowed". Spends the ticket. */
  authorizeClient(ticket: string): Promise<ClientGrant | null>;

  /** Tells the control plane whether a machine currently has an uplink. */
  reportPresence(
    machineId: string,
    connectionGeneration: number,
    state: PresenceState,
  ): Promise<void | LegacyPresenceResult>;

  /** Control plane pushes machine- and client-scoped socket revocations. */
  onRevoked(handler: (revocation: Revocation) => void): void;
}
