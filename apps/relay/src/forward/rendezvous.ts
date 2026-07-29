import { randomBytes } from "node:crypto";

import type { ChannelAuthority, ClientGrant, DaemonGrant } from "../contract/index.js";
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
  constructor(private readonly joinToken: string | null) {}

  async authorizeDaemon(ticket: string): Promise<DaemonGrant | null> {
    const [presented, id] = split(ticket);
    if (!id) return null;
    if (this.joinToken && presented !== this.joinToken) return null;
    return { machineId: id, daemonId: id };
  }

  async authorizeClient(ticket: string): Promise<ClientGrant | null> {
    if (!ticket) return null;
    // A client that names a slot nobody holds is turned away by the forwarder
    // itself, which is the only "does this machine exist" check there is.
    return { machineId: ticket, clientId: randomBytes(8).toString("hex") };
  }

  async reportPresence(): Promise<void> {}

  onRevoked(): void {}
}

/** `<joinToken>.<rendezvousId>`, or just the id when no token is configured. */
function split(ticket: string): [string | null, string | null] {
  const at = ticket.lastIndexOf(".");
  if (at < 0) return [null, ticket || null];
  return [ticket.slice(0, at), ticket.slice(at + 1) || null];
}

/**
 * Generates a join token when the operator did not set one.
 *
 * Refusing to start would break `npm start` on a laptop for no security gain,
 * and defaulting to "no token" would quietly turn a public relay into an open
 * one. Printing a generated token does neither.
 */
export function resolveJoinToken(configured: string | null, host: string): string | null {
  if (configured) return configured;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (loopback) return null;
  const generated = randomBytes(24).toString("hex");
  log.warn("relay: no RELAY_JOIN_TOKEN was set, so one was generated for this run", {
    joinToken: generated,
  });
  return generated;
}
