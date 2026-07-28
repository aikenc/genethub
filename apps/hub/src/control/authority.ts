import { writeAudit } from "./audit.js";
import type { HubDatabase } from "./db.js";
import {
  findMachine,
  findMachineByDaemonId,
  redeemChannelTicket,
  resolveSession,
  setMachineConnectedById,
} from "./store.js";
import { tokenMatchesHash } from "../shared/tokens.js";
import type {
  ChannelAuthority,
  ClientGrant,
  DaemonGrant,
  PresenceState,
  Revocation,
} from "../contract/index.js";

/**
 * The control plane's implementation of the forwarding layer's only interface.
 *
 * Everything here is async even though it is synchronous SQLite underneath.
 * That is the point: when the two roles split, this class is replaced by an
 * HTTP client and nothing on the forwarding side changes.
 */
export class ControlAuthority implements ChannelAuthority {
  private readonly revocationHandlers: Array<(revocation: Revocation) => void> = [];

  constructor(private readonly db: HubDatabase) {}

  /** Ticket is `<daemonId>.<secret>`, minted by the daemon at enrollment. */
  async authorizeDaemon(ticket: string): Promise<DaemonGrant | null> {
    const separator = ticket.indexOf(".");
    if (separator <= 0) return null;
    const daemonId = ticket.slice(0, separator);
    const secret = ticket.slice(separator + 1);

    const machine = findMachineByDaemonId(this.db, daemonId);
    if (!machine || machine.state !== "active") return null;
    if (!tokenMatchesHash(secret, machine.credential_verifier)) return null;

    return { machineId: machine.id, daemonId };
  }

  async authorizeClient(ticket: string): Promise<ClientGrant | null> {
    const row = redeemChannelTicket(this.db, ticket);
    if (!row) return null;

    // A ticket is not a standing permission: the device may have been revoked
    // in the seconds since it was issued, and the machine may have been too.
    const machine = findMachine(this.db, row.machine_id);
    if (!machine || machine.state !== "active") return null;

    const session = this.db
      .prepare(`SELECT revoked_at FROM device_sessions WHERE id = ?`)
      .get(row.device_session_id) as { revoked_at: string | null } | undefined;
    if (!session || session.revoked_at) return null;

    return { machineId: machine.id, clientId: row.device_session_id };
  }

  async reportPresence(machineId: string, state: PresenceState): Promise<void> {
    setMachineConnectedById(this.db, machineId, state === "online");
    const machine = findMachine(this.db, machineId);
    if (!machine) return;
    writeAudit(this.db, {
      action: state === "online" ? "machine.connected" : "machine.disconnected",
      actorUserId: machine.owner_user_id,
      targetType: "machine",
      targetId: machineId,
    });
  }

  onRevoked(handler: (revocation: Revocation) => void): void {
    this.revocationHandlers.push(handler);
  }

  /**
   * Called by the control plane's own routes when an owner revokes a machine.
   * In a split deployment this becomes a push to the forwarding tier; the
   * signature stays the same.
   */
  revoke(machineId: string, reason: string): void {
    for (const handler of this.revocationHandlers) handler({ machineId, reason });
  }
}

/** Re-exported so control routes do not have to reach into `store` for it. */
export { resolveSession };
