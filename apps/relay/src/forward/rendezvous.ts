import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  FabricAuthority,
  FabricEndpointGrant,
  FabricPresenceState,
  FabricRevocation,
  FabricRouteGrant,
} from "../contract/fabric.js";
import { isLiteralLoopbackHost } from "../shared/config.js";

/**
 * Account-free authority for the endpoint-neutral Fabric.
 *
 * The endpoint and route credentials are only opaque anti-abuse/routing
 * material. They never authorize a daemon operation: the browser still has to
 * prove a daemon-issued device or invite secret inside the E2EE peer stream.
 */
export class RendezvousFabricAuthority implements FabricAuthority {
  private connectionGeneration = 0;
  private readonly onlineNodes = new Set<string>();

  constructor(private readonly joinToken: string | null) {}

  async authorizeEndpoint(credential: string): Promise<FabricEndpointGrant | null> {
    if (this.connectionGeneration >= Number.MAX_SAFE_INTEGER) return null;
    const clientSlot = credential.startsWith("client:") ? credential.slice(7) : null;
    if (clientSlot !== null) {
      if (!validSlot(clientSlot) || !this.onlineNodes.has(nodeHandle(clientSlot))) return null;
      this.connectionGeneration += 1;
      const identity = randomBytes(16).toString("hex");
      return {
        endpointHandle: `client:${identity}`,
        revocationHandle: `client:${identity}`,
        expiresAt: null,
        connectionGeneration: this.connectionGeneration,
        presenceLeaseSeconds: 60,
      };
    }

    const [presented, slot] = split(credential);
    if (!slot || !validSlot(slot)) return null;
    if (this.joinToken && !sameSecret(presented, this.joinToken)) return null;
    this.connectionGeneration += 1;
    return {
      endpointHandle: nodeHandle(slot),
      revocationHandle: nodeHandle(slot),
      expiresAt: null,
      connectionGeneration: this.connectionGeneration,
      presenceLeaseSeconds: 60,
    };
  }

  async authorizeRoute(
    sourceEndpointHandle: string,
    routeTicket: string,
  ): Promise<FabricRouteGrant | null> {
    const target = nodeHandle(routeTicket);
    if (
      !sourceEndpointHandle.startsWith("client:") ||
      !validSlot(routeTicket) ||
      !this.onlineNodes.has(target)
    ) {
      return null;
    }
    return {
      targetEndpointHandle: target,
      routeHandle: `route:${randomBytes(16).toString("hex")}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }

  async reportEndpointPresence(
    endpointHandle: string,
    _connectionGeneration: number,
    state: FabricPresenceState,
  ): Promise<void> {
    if (!endpointHandle.startsWith("node:")) return;
    if (state === "online") this.onlineNodes.add(endpointHandle);
    else this.onlineNodes.delete(endpointHandle);
  }

  onFabricRevoked(_handler: (revocation: FabricRevocation) => void): void {}
}

function validSlot(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

function nodeHandle(slot: string): string {
  return `node:${slot}`;
}

/**
 * Compares in a time that does not depend on how much of it matched.
 *
 * Hashed first so the lengths always agree: `timingSafeEqual` throws on a
 * mismatch, and refusing early on length is itself an answer.
 */
function sameSecret(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** `<joinToken>.<rendezvousId>`, or just the id when no token is configured. */
function split(ticket: string): [string | null, string | null] {
  const at = ticket.lastIndexOf(".");
  if (at < 0) return [null, ticket || null];
  return [ticket.slice(0, at), ticket.slice(at + 1) || null];
}

/**
 * The token this relay will require of machines, or none on a laptop.
 *
 * A relay bound to a public address without one is an open relay, so it refuses
 * to start rather than defaulting to "anyone". It used to generate one and print
 * it, which put a live secret in the log — the one file that gets copied into a
 * central store, shared in a paste, and kept long after the relay is gone. It
 * also meant the operator learned their token by reading logs instead of setting
 * it, so `docs/self-hosting.md` already said this had to be configured.
 *
 * On loopback there is nothing to protect: only this machine can reach it.
 */
export function resolveJoinToken(configured: string | null, host: string): string | null {
  const loopback = isLiteralLoopbackHost(host);
  if (configured) {
    if (
      !loopback &&
      (!/^[A-Za-z0-9_-]{32,256}$/.test(configured) ||
        Buffer.byteLength(configured, "utf8") < 32)
    ) {
      throw new Error(
        "relay: RELAY_JOIN_TOKEN on a non-loopback listener must be 32-256 " +
          "base64url/hex characters generated from a cryptographic random source",
      );
    }
    return configured;
  }
  if (loopback) return null;
  throw new Error(
    `relay: refusing to listen on ${host} with no RELAY_JOIN_TOKEN — any machine ` +
      `could then hold a slot on it. Set one (e.g. RELAY_JOIN_TOKEN=$(openssl rand -hex 32)) ` +
      `and give the same value to your machines, or bind 127.0.0.1 for local use.`,
  );
}
