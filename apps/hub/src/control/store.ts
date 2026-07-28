import { config } from "../shared/config.js";
import type { HubDatabase } from "./db.js";
import { hashToken, isoIn, nowIso, randomId, randomToken, userCode } from "../shared/tokens.js";

// ---------------------------------------------------------------------------
// Rows

export interface UserRow {
  id: string;
  kind: "temp" | "full";
  email: string | null;
  display_name: string;
  created_at: string;
  disabled_at: string | null;
}

export interface DeviceSessionRow {
  id: string;
  user_id: string;
  name: string;
  platform: string | null;
  secret_hash: string;
  trusted_until: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  ip_first_seen: string | null;
  ua_first_seen: string | null;
}

export interface MachineRow {
  id: string;
  owner_user_id: string;
  name: string;
  platform: string | null;
  daemon_id: string;
  public_key: string;
  credential_verifier: string;
  state: "active" | "revoked";
  visibility: "private" | "public";
  connected_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface DeviceAuthorizationRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  display_name: string;
  status: "pending" | "approved" | "denied" | "expired" | "enrolled";
  claimed_by_user_id: string | null;
  approved_by_device_id: string | null;
  enrollment_token_hash: string | null;
  enrollment_token: string | null;
  machine_id: string | null;
  expires_at: string;
  interval_seconds: number;
  created_at: string;
}

export interface TransferLinkRow {
  id: string;
  user_id: string;
  purpose: "device_transfer" | "upgrade";
  token_hash: string;
  created_by_device_id: string | null;
  expires_at: string;
  max_uses: number;
  used_count: number;
  consumed_by_device_id: string | null;
  consumed_ip: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Users

export function createTempUser(db: HubDatabase, displayName: string): UserRow {
  const user: UserRow = {
    id: randomId("usr"),
    kind: "temp",
    email: null,
    display_name: displayName,
    created_at: nowIso(),
    disabled_at: null,
  };
  db.prepare(
    `INSERT INTO users (id, kind, email, display_name, created_at) VALUES (?, 'temp', NULL, ?, ?)`,
  ).run(user.id, user.display_name, user.created_at);
  return user;
}

export function getUser(db: HubDatabase, id: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

// ---------------------------------------------------------------------------
// Device sessions
//
// A session token is `<sessionId>.<secret>`; only the secret hash is stored, so
// a database leak does not hand out logins.

export interface IssuedSession {
  row: DeviceSessionRow;
  token: string;
}

export function createDeviceSession(
  db: HubDatabase,
  input: { userId: string; name: string; platform?: string | null; ip?: string | null; userAgent?: string | null },
): IssuedSession {
  const id = randomId("dev");
  const secret = randomToken();
  const row: DeviceSessionRow = {
    id,
    user_id: input.userId,
    name: input.name,
    platform: input.platform ?? null,
    secret_hash: hashToken(secret),
    trusted_until: null,
    created_at: nowIso(),
    last_seen_at: nowIso(),
    revoked_at: null,
    ip_first_seen: input.ip ?? null,
    ua_first_seen: input.userAgent ?? null,
  };
  db.prepare(
    `INSERT INTO device_sessions (id, user_id, name, platform, secret_hash, ip_first_seen, ua_first_seen, created_at, last_seen_at)
     VALUES (@id, @user_id, @name, @platform, @secret_hash, @ip_first_seen, @ua_first_seen, @created_at, @last_seen_at)`,
  ).run(row);
  return { row, token: `${id}.${secret}` };
}

export function resolveSession(db: HubDatabase, token: string | undefined): DeviceSessionRow | null {
  if (!token) return null;
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const id = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  const row = db.prepare(`SELECT * FROM device_sessions WHERE id = ?`).get(id) as
    | DeviceSessionRow
    | undefined;
  if (!row || row.revoked_at) return null;
  if (row.secret_hash !== hashToken(secret)) return null;
  db.prepare(`UPDATE device_sessions SET last_seen_at = ? WHERE id = ?`).run(nowIso(), id);
  return row;
}

export function listSessions(db: HubDatabase, userId: string): DeviceSessionRow[] {
  return db
    .prepare(`SELECT * FROM device_sessions WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as DeviceSessionRow[];
}

export function revokeSession(db: HubDatabase, userId: string, sessionId: string): boolean {
  const result = db
    .prepare(`UPDATE device_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .run(nowIso(), sessionId, userId);
  return result.changes > 0;
}

export function trustSession(db: HubDatabase, userId: string, sessionId: string): boolean {
  const until = isoIn(config.control.session.ttlDays * 24 * 3600);
  const result = db
    .prepare(`UPDATE device_sessions SET trusted_until = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .run(until, sessionId, userId);
  return result.changes > 0;
}

export function isTrusted(session: DeviceSessionRow): boolean {
  return session.trusted_until !== null && Date.parse(session.trusted_until) > Date.now();
}

// ---------------------------------------------------------------------------
// Recovery keys

export function createRecoveryKey(db: HubDatabase, userId: string): string {
  const key = randomToken();
  db.prepare(
    `INSERT INTO recovery_keys (id, user_id, key_hash, created_at) VALUES (?, ?, ?, ?)`,
  ).run(randomId("rcv"), userId, hashToken(key), nowIso());
  return key;
}

export function consumeRecoveryKey(db: HubDatabase, key: string): UserRow | null {
  const row = db
    .prepare(`SELECT * FROM recovery_keys WHERE key_hash = ? AND revoked_at IS NULL`)
    .get(hashToken(key)) as { id: string; user_id: string } | undefined;
  if (!row) return null;
  db.prepare(`UPDATE recovery_keys SET last_used_at = ? WHERE id = ?`).run(nowIso(), row.id);
  return getUser(db, row.user_id) ?? null;
}

// ---------------------------------------------------------------------------
// Transfer links

export interface IssuedTransferLink {
  row: TransferLinkRow;
  token: string;
}

export function createTransferLink(
  db: HubDatabase,
  input: { userId: string; createdByDeviceId: string | null; purpose?: "device_transfer" | "upgrade" },
): IssuedTransferLink {
  const token = randomToken();
  const row: TransferLinkRow = {
    id: randomId("lnk"),
    user_id: input.userId,
    purpose: input.purpose ?? "device_transfer",
    token_hash: hashToken(token),
    created_by_device_id: input.createdByDeviceId,
    expires_at: isoIn(config.control.transferLink.ttlSeconds),
    max_uses: 1,
    used_count: 0,
    consumed_by_device_id: null,
    consumed_ip: null,
    consumed_at: null,
    revoked_at: null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO transfer_links (id, user_id, purpose, token_hash, created_by_device_id, expires_at, max_uses, used_count, created_at)
     VALUES (@id, @user_id, @purpose, @token_hash, @created_by_device_id, @expires_at, @max_uses, 0, @created_at)`,
  ).run(row);
  return { row, token };
}

export function findTransferLink(db: HubDatabase, token: string): TransferLinkRow | undefined {
  return db.prepare(`SELECT * FROM transfer_links WHERE token_hash = ?`).get(hashToken(token)) as
    | TransferLinkRow
    | undefined;
}

export function markTransferLinkConsumed(
  db: HubDatabase,
  linkId: string,
  deviceId: string,
  ip: string | null,
  userAgent: string | null,
): void {
  db.prepare(
    `UPDATE transfer_links
     SET used_count = used_count + 1, consumed_by_device_id = ?, consumed_ip = ?, consumed_user_agent = ?, consumed_at = ?
     WHERE id = ?`,
  ).run(deviceId, ip, userAgent, nowIso(), linkId);
}

export function revokeTransferLink(db: HubDatabase, userId: string, linkId: string): boolean {
  const result = db
    .prepare(`UPDATE transfer_links SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .run(nowIso(), linkId, userId);
  return result.changes > 0;
}

export function listTransferLinks(db: HubDatabase, userId: string): TransferLinkRow[] {
  return db
    .prepare(`SELECT * FROM transfer_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`)
    .all(userId) as TransferLinkRow[];
}

// ---------------------------------------------------------------------------
// Channel tickets
//
// One device, one machine, one use, a couple of minutes. Short-lived because a
// browser cannot set headers on a WebSocket handshake, so the ticket travels in
// a query string and may end up in a proxy log.

export interface ChannelTicketRow {
  id: string;
  token_hash: string;
  machine_id: string;
  device_session_id: string;
  expires_at: string;
  redeemed_at: string | null;
  created_at: string;
}

export function createChannelTicket(
  db: HubDatabase,
  input: { machineId: string; deviceSessionId: string },
): { row: ChannelTicketRow; token: string } {
  const token = randomToken();
  const row: ChannelTicketRow = {
    id: randomId("tkt"),
    token_hash: hashToken(token),
    machine_id: input.machineId,
    device_session_id: input.deviceSessionId,
    expires_at: isoIn(config.control.channelTicketTtlSeconds),
    redeemed_at: null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO channel_tickets (id, token_hash, machine_id, device_session_id, expires_at, created_at)
     VALUES (@id, @token_hash, @machine_id, @device_session_id, @expires_at, @created_at)`,
  ).run(row);
  return { row, token };
}

/**
 * Redeems a ticket, or returns null. Marking it used is part of the same
 * statement so two racing attaches cannot both win.
 */
export function redeemChannelTicket(db: HubDatabase, token: string): ChannelTicketRow | null {
  const hash = hashToken(token);
  const result = db
    .prepare(
      `UPDATE channel_tickets SET redeemed_at = ?
       WHERE token_hash = ? AND redeemed_at IS NULL AND expires_at > ?`,
    )
    .run(nowIso(), hash, nowIso());
  if (result.changes === 0) return null;
  return db.prepare(`SELECT * FROM channel_tickets WHERE token_hash = ?`).get(hash) as ChannelTicketRow;
}

export function purgeExpiredChannelTickets(db: HubDatabase): void {
  db.prepare(`DELETE FROM channel_tickets WHERE expires_at <= ?`).run(nowIso());
}

// ---------------------------------------------------------------------------
// Device authorizations

export interface IssuedDeviceAuthorization {
  row: DeviceAuthorizationRow;
  deviceCode: string;
}

export function createDeviceAuthorization(
  db: HubDatabase,
  displayName: string,
): IssuedDeviceAuthorization {
  const deviceCode = randomToken(36);
  const row: DeviceAuthorizationRow = {
    id: randomId("dac"),
    device_code_hash: hashToken(deviceCode),
    user_code: userCode(),
    display_name: displayName,
    status: "pending",
    claimed_by_user_id: null,
    approved_by_device_id: null,
    enrollment_token_hash: null,
    enrollment_token: null,
    machine_id: null,
    expires_at: isoIn(config.control.deviceAuthorization.ttlSeconds),
    interval_seconds: config.control.deviceAuthorization.pollIntervalSeconds,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO device_authorizations (id, device_code_hash, user_code, display_name, status, expires_at, interval_seconds, created_at)
     VALUES (@id, @device_code_hash, @user_code, @display_name, 'pending', @expires_at, @interval_seconds, @created_at)`,
  ).run(row);
  return { row, deviceCode };
}

export function findDeviceAuthorizationByCode(
  db: HubDatabase,
  deviceCode: string,
): DeviceAuthorizationRow | undefined {
  return db
    .prepare(`SELECT * FROM device_authorizations WHERE device_code_hash = ?`)
    .get(hashToken(deviceCode)) as DeviceAuthorizationRow | undefined;
}

export function findDeviceAuthorizationByUserCode(
  db: HubDatabase,
  code: string,
): DeviceAuthorizationRow | undefined {
  return db
    .prepare(`SELECT * FROM device_authorizations WHERE user_code = ?`)
    .get(code.trim().toUpperCase()) as DeviceAuthorizationRow | undefined;
}

export function approveDeviceAuthorization(
  db: HubDatabase,
  id: string,
  userId: string,
  approvedByDeviceId: string,
): string {
  const enrollmentToken = randomToken();
  db.prepare(
    `UPDATE device_authorizations
     SET status = 'approved', claimed_by_user_id = ?, approved_by_device_id = ?,
         enrollment_token_hash = ?, enrollment_token = ?
     WHERE id = ?`,
  ).run(userId, approvedByDeviceId, hashToken(enrollmentToken), enrollmentToken, id);
  return enrollmentToken;
}

export function denyDeviceAuthorization(db: HubDatabase, id: string): void {
  db.prepare(`UPDATE device_authorizations SET status = 'denied' WHERE id = ?`).run(id);
}

export function findDeviceAuthorizationByEnrollmentToken(
  db: HubDatabase,
  token: string,
): DeviceAuthorizationRow | undefined {
  return db
    .prepare(`SELECT * FROM device_authorizations WHERE enrollment_token_hash = ?`)
    .get(hashToken(token)) as DeviceAuthorizationRow | undefined;
}

export function markDeviceAuthorizationEnrolled(
  db: HubDatabase,
  id: string,
  machineId: string,
): void {
  db.prepare(
    `UPDATE device_authorizations
     SET status = 'enrolled', machine_id = ?, enrollment_token = NULL
     WHERE id = ?`,
  ).run(machineId, id);
}

export function touchDeviceAuthorizationPoll(db: HubDatabase, id: string): void {
  db.prepare(`UPDATE device_authorizations SET last_polled_at = ? WHERE id = ?`).run(nowIso(), id);
}

export function expireStaleDeviceAuthorizations(db: HubDatabase): void {
  db.prepare(
    `UPDATE device_authorizations SET status = 'expired'
     WHERE status IN ('pending', 'approved') AND expires_at <= ?`,
  ).run(nowIso());
}

// ---------------------------------------------------------------------------
// Machines

export function upsertMachine(
  db: HubDatabase,
  input: {
    ownerUserId: string;
    name: string;
    platform: string | null;
    daemonId: string;
    publicKey: string;
    credentialVerifier: string;
  },
): MachineRow {
  const existing = db.prepare(`SELECT * FROM machines WHERE daemon_id = ?`).get(input.daemonId) as
    | MachineRow
    | undefined;

  if (existing) {
    // Re-enrolling (a retry, or a reinstall on the same machine) keeps the row
    // and its history rather than leaving a duplicate in the owner's list.
    db.prepare(
      `UPDATE machines
       SET owner_user_id = ?, name = ?, platform = ?, public_key = ?, credential_verifier = ?,
           state = 'active', revoked_at = NULL
       WHERE daemon_id = ?`,
    ).run(
      input.ownerUserId,
      input.name,
      input.platform,
      input.publicKey,
      input.credentialVerifier,
      input.daemonId,
    );
    return db.prepare(`SELECT * FROM machines WHERE daemon_id = ?`).get(input.daemonId) as MachineRow;
  }

  const id = randomId("mch");
  db.prepare(
    `INSERT INTO machines (id, owner_user_id, name, platform, daemon_id, public_key, credential_verifier, state, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'private', ?)`,
  ).run(
    id,
    input.ownerUserId,
    input.name,
    input.platform,
    input.daemonId,
    input.publicKey,
    input.credentialVerifier,
    nowIso(),
  );
  return db.prepare(`SELECT * FROM machines WHERE id = ?`).get(id) as MachineRow;
}

export function findMachineByDaemonId(db: HubDatabase, daemonId: string): MachineRow | undefined {
  return db.prepare(`SELECT * FROM machines WHERE daemon_id = ?`).get(daemonId) as
    | MachineRow
    | undefined;
}

export function findMachine(db: HubDatabase, id: string): MachineRow | undefined {
  return db.prepare(`SELECT * FROM machines WHERE id = ?`).get(id) as MachineRow | undefined;
}

export function listMachines(db: HubDatabase, ownerUserId: string): MachineRow[] {
  return db
    .prepare(`SELECT * FROM machines WHERE owner_user_id = ? AND state = 'active' ORDER BY created_at DESC`)
    .all(ownerUserId) as MachineRow[];
}

export function revokeMachine(db: HubDatabase, daemonId: string): void {
  db.prepare(
    `UPDATE machines SET state = 'revoked', revoked_at = ?, connected_at = NULL WHERE daemon_id = ?`,
  ).run(nowIso(), daemonId);
}

export function renameMachine(db: HubDatabase, userId: string, machineId: string, name: string): boolean {
  const result = db
    .prepare(`UPDATE machines SET name = ? WHERE id = ? AND owner_user_id = ?`)
    .run(name, machineId, userId);
  return result.changes > 0;
}

export function isMachineOnline(machine: MachineRow): boolean {
  return machine.connected_at !== null;
}

export function setMachineConnectedById(db: HubDatabase, machineId: string, connected: boolean): void {
  db.prepare(`UPDATE machines SET connected_at = ?, last_seen_at = ? WHERE id = ?`).run(
    connected ? nowIso() : null,
    nowIso(),
    machineId,
  );
}

export function setMachineConnected(db: HubDatabase, daemonId: string, connected: boolean): void {
  if (connected) {
    db.prepare(`UPDATE machines SET connected_at = ?, last_seen_at = ? WHERE daemon_id = ?`).run(
      nowIso(),
      nowIso(),
      daemonId,
    );
    return;
  }
  db.prepare(`UPDATE machines SET connected_at = NULL, last_seen_at = ? WHERE daemon_id = ?`).run(
    nowIso(),
    daemonId,
  );
}
