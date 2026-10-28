import type { LocalServerProof, ProtocolDial } from "./client";

/**
 * A machine this client can control.
 *
 * Deliberately says nothing about accounts. "Which machines am I allowed to
 * drive" is a question a self-hosted copy asks too — it answers it from the
 * machines this browser paired with — and a deployment that has accounts
 * answers the same question from a better source. Putting a user on this type
 * would make the switcher an account feature, which is exactly the coupling
 * this indirection exists to avoid.
 */
export interface Target {
  id: string;
  /** Stable daemon-owned handle used in portable asset-preview URLs. */
  deviceHandle?: string;
  label: string;
  /**
   * The machine this shell is running on. Not a mode: it is one entry in the
   * list, distinguished only by being the one that stays reachable with the
   * network off.
   */
  kind: "local" | "remote";
  /** Only where the source knows. Absent means "no idea", not "offline". */
  online?: boolean;
  fingerprint?: string;
}

export interface Endpoint {
  bulk?: ProtocolDial;
  /** WebSocket URL for the daemon, direct or relayed. */
  url: string;
  /** How we got here, for the connection badge. */
  via: "loopback" | "lan" | "relay";
  label: string;
  /**
   * The daemon's key fingerprint as the shell learned it, without asking the
   * connection. Present only where the shell has an independent source; it is
   * what makes comparing against the handshake worth anything.
   */
  fingerprint?: string;
  /**
   * What this browser got when it paired with the machine. A machine reached
   * through a rendezvous relay will not talk without it.
   */
  credential?: { deviceId: string; secret: string };
  /** Fresh hosted-channel secret paired with this one-use Relay URL. */
  channelCredential?: { capabilityId: string; secret: string };
  /** One-use opaque route consumed as the first OPEN on a Fabric endpoint. */
  fabricRouteTicket?: string;
  fabricAuthorizationExpiresAt?: string;
  /** Out-of-band proof that a loopback listener owns the daemon endpoint. */
  localServerProof?: LocalServerProof;
}
