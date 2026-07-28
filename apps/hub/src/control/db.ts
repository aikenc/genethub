import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { config } from "../shared/config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('temp', 'full')),
  email TEXT,
  github_id TEXT,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  upgraded_from_temp_id TEXT,
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  platform TEXT,
  secret_hash TEXT NOT NULL,
  ip_first_seen TEXT,
  ua_first_seen TEXT,
  trusted_until TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_user ON device_sessions(user_id);

CREATE TABLE IF NOT EXISTS transfer_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('device_transfer', 'upgrade')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by_device_id TEXT,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  consumed_by_device_id TEXT,
  consumed_ip TEXT,
  consumed_user_agent TEXT,
  consumed_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfer_links_user ON transfer_links(user_id);

CREATE TABLE IF NOT EXISTS recovery_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'enrolled')),
  claimed_by_user_id TEXT REFERENCES users(id),
  approved_by_device_id TEXT,
  enrollment_token_hash TEXT,
  -- Held in the clear only between approval and enrollment (minutes) because the
  -- daemon fetches it by polling, then cleared. Lookup still goes through the hash.
  enrollment_token TEXT,
  machine_id TEXT,
  expires_at TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_polled_at TEXT
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  platform TEXT,
  daemon_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  -- Hash of the secret the daemon minted for itself. The Hub never holds the
  -- secret, so a database leak does not hand out a machine's uplink.
  credential_verifier TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  connected_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_machines_owner ON machines(owner_user_id);

-- Short-lived, single-use permission for one device to attach to one machine
-- through the forwarding layer. Kept here rather than in the forwarder on
-- purpose: the two roles must not share a table (architecture.md §6.4).
CREATE TABLE IF NOT EXISTS channel_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  device_session_id TEXT NOT NULL REFERENCES device_sessions(id),
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_tickets_machine ON channel_tickets(machine_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_user_id TEXT,
  actor_device_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip TEXT,
  user_agent TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id, at);
`;

export type HubDatabase = Database.Database;

export function openDatabase(databasePath = config.control.databasePath): HubDatabase {
  if (databasePath !== ":memory:") {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Presence is reported by the forwarding role and lives only as long as its
  // sockets do. Anything left over from a previous run is a lie.
  db.prepare(`UPDATE machines SET connected_at = NULL WHERE connected_at IS NOT NULL`).run();
  return db;
}
