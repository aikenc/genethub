import { createHash, timingSafeEqual } from "node:crypto";

import type { ChannelAuthority, ClientGrant, DaemonGrant } from "../contract/index.js";
import { isLiteralLoopbackHost } from "../shared/config.js";
import { log } from "../shared/log.js";

/**
 * The self-hosted mode: a meeting point and nothing else.
 *
 * There is no control plane to ask, so this asks nobody. A ticket is the
 * rendezvous id itself, and matching two sockets that name the same id is the
 * entire job.
 *
 * That does not make the relay a trust anchor. Admission is decided on the
 * machine, by its authorized-devices list, after the channel exists: the client
 * and the daemon prove themselves to each other over the shared secret they
 * agreed on when they paired (`docs/security-model.md` §4.2). Squatting on
 * someone's slot therefore gets you a connection nobody will talk on.
 *
 * The join token is a different question — not "who are you" but "may you use
 * this relay at all". It applies to machines only: a client can only reach a
 * slot some machine is already holding.
 */
export class RendezvousAuthority implements ChannelAuthority {
  /**
   * One process-wide monotonic source is enough: Forwarder fences per machine,
   * while using a global counter avoids a second unbounded per-slot map in the
   * deliberately stateless self-hosted authority.
   */
  private connectionGeneration = 0;

  constructor(private readonly joinToken: string | null) {}

  async authorizeDaemon(ticket: string): Promise<DaemonGrant | null> {
    const [presented, id] = split(ticket);
    if (!id) return null;
    if (this.joinToken && !sameSecret(presented, this.joinToken)) return null;
    if (this.connectionGeneration >= Number.MAX_SAFE_INTEGER) return null;
    this.connectionGeneration += 1;
    return {
      machineId: id,
      daemonId: id,
      connectionGeneration: this.connectionGeneration,
      presenceLeaseSeconds: 60,
    };
  }

  async inspectClient(ticket: string): Promise<ClientGrant | null> {
    if (!ticket) return null;
    // There is no account session in rendezvous mode. The slot is the only
    // stable opaque identity available, and must agree with authorizeClient so
    // the forwarder cannot switch subjects between peek and spend.
    return { machineId: ticket, clientId: ticket, channelCapability: "rendezvous" };
  }

  async authorizeClient(ticket: string): Promise<ClientGrant | null> {
    if (!ticket) return null;
    // A client that names a slot nobody holds is turned away by the forwarder
    // itself, which is the only "does this machine exist" check there is.
    return { machineId: ticket, clientId: ticket, channelCapability: "rendezvous" };
  }

  async reportPresence(): Promise<void> {}

  onRevoked(): void {}
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
