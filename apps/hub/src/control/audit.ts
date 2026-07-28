import type { HubDatabase } from "./db.js";
import { nowIso, randomId } from "../shared/tokens.js";

/**
 * Audit actions are written from the MVP onward even though the query UI comes
 * later, so that history exists when it is needed. Never put agent prompts or
 * agent output in `detail`.
 */
export type AuditAction =
  | "user.temp.created"
  | "session.created"
  | "session.revoked"
  | "session.trusted"
  | "transfer_link.created"
  | "transfer_link.consumed"
  | "transfer_link.revoked"
  | "transfer_link.rejected"
  | "recovery_key.created"
  | "recovery_key.used"
  | "device_authorization.started"
  | "device_authorization.approved"
  | "device_authorization.denied"
  | "machine.enrolled"
  | "machine.connected"
  | "machine.disconnected"
  | "machine.revoked"
  | "machine.renamed"
  | "channel.ticket_issued";

export interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
}

export function writeAudit(db: HubDatabase, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_logs (id, at, actor_user_id, actor_device_id, action, target_type, target_id, ip, user_agent, detail_json)
     VALUES (@id, @at, @actorUserId, @actorDeviceId, @action, @targetType, @targetId, @ip, @userAgent, @detailJson)`,
  ).run({
    id: randomId("aud"),
    at: nowIso(),
    actorUserId: entry.actorUserId ?? null,
    actorDeviceId: entry.actorDeviceId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    detailJson: entry.detail ? JSON.stringify(entry.detail) : null,
  });
}

export interface AuditRow {
  id: string;
  at: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  detail_json: string | null;
}

export function recentAuditForUser(db: HubDatabase, userId: string, limit = 50): AuditRow[] {
  return db
    .prepare(
      `SELECT id, at, action, target_type, target_id, ip, detail_json
       FROM audit_logs WHERE actor_user_id = ? ORDER BY at DESC LIMIT ?`,
    )
    .all(userId, limit) as AuditRow[];
}
