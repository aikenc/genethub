import { Hono, type Context } from "hono";
import { z } from "zod";

import { recentAuditForUser, writeAudit } from "../audit.js";
import type { HubDatabase } from "../db.js";
import type { ControlAuthority } from "../authority.js";
import {
  approveDeviceAuthorization,
  consumeRecoveryKey,
  createChannelTicket,
  createDeviceSession,
  createRecoveryKey,
  createTempUser,
  createTransferLink,
  denyDeviceAuthorization,
  expireStaleDeviceAuthorizations,
  findDeviceAuthorizationByUserCode,
  findMachine,
  findTransferLink,
  isMachineOnline,
  isTrusted,
  listMachines,
  listSessions,
  listTransferLinks,
  markTransferLinkConsumed,
  renameMachine,
  revokeMachine,
  revokeSession,
  revokeTransferLink,
  trustSession,
  type DeviceSessionRow,
  type MachineRow,
} from "../store.js";
import { isExpired, publicKeyFingerprint } from "../../shared/tokens.js";
import { CLIENT_PATH } from "../../contract/index.js";
import { attachSessionCookie, clientIp, currentSession, hubOrigin, userAgent } from "./session.js";

function machineView(machine: MachineRow) {
  return {
    id: machine.id,
    name: machine.name,
    online: isMachineOnline(machine),
    visibility: machine.visibility,
    fingerprint: publicKeyFingerprint(machine.public_key),
    lastSeenAt: machine.last_seen_at,
    createdAt: machine.created_at,
  };
}

function sessionView(session: DeviceSessionRow, currentId: string) {
  return {
    id: session.id,
    name: session.name,
    platform: session.platform,
    current: session.id === currentId,
    trusted: isTrusted(session),
    createdAt: session.created_at,
    lastSeenAt: session.last_seen_at,
    firstSeenIp: session.ip_first_seen,
  };
}

export function appApiRoutes(db: HubDatabase, authority: ControlAuthority): Hono {
  const app = new Hono();

  const requireSession = (c: Context): DeviceSessionRow | null => currentSession(c, db);

  app.post("/app/auth/temp", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { deviceName?: string };
    const user = createTempUser(db, "临时用户");
    const session = createDeviceSession(db, {
      userId: user.id,
      name: body.deviceName ?? "这台设备",
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    const recoveryKey = createRecoveryKey(db, user.id);

    writeAudit(db, {
      action: "user.temp.created",
      actorUserId: user.id,
      actorDeviceId: session.row.id,
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    writeAudit(db, {
      action: "recovery_key.created",
      actorUserId: user.id,
      actorDeviceId: session.row.id,
    });

    attachSessionCookie(c, session.token);
    // The recovery key is shown exactly once: losing it strands every machine
    // already enrolled under this temporary identity.
    return c.json({
      user: { id: user.id, kind: user.kind, displayName: user.display_name },
      sessionToken: session.token,
      recoveryKey,
    });
  });

  app.post("/app/auth/recover", async (c) => {
    const parsed = z
      .object({ recoveryKey: z.string().min(1), deviceName: z.string().optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "recoveryKey is required" }, 400);

    const user = consumeRecoveryKey(db, parsed.data.recoveryKey);
    if (!user) return c.json({ error: "invalid recovery key" }, 403);

    const session = createDeviceSession(db, {
      userId: user.id,
      name: parsed.data.deviceName ?? "恢复的设备",
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    writeAudit(db, {
      action: "recovery_key.used",
      actorUserId: user.id,
      actorDeviceId: session.row.id,
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    attachSessionCookie(c, session.token);
    return c.json({ user: { id: user.id, kind: user.kind }, sessionToken: session.token });
  });

  app.get("/app/me", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);
    const machines = listMachines(db, session.user_id).map(machineView);
    return c.json({
      user: { id: session.user_id },
      session: sessionView(session, session.id),
      sessions: listSessions(db, session.user_id).map((s) => sessionView(s, session.id)),
      machines,
    });
  });

  app.get("/app/machines", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);
    return c.json({ machines: listMachines(db, session.user_id).map(machineView) });
  });

  app.post("/app/machines/:id/rename", async (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);
    const parsed = z
      .object({ name: z.string().min(1).max(100) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "name is required" }, 400);

    if (!renameMachine(db, session.user_id, c.req.param("id"), parsed.data.name)) {
      return c.json({ error: "machine not found" }, 404);
    }
    writeAudit(db, {
      action: "machine.renamed",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "machine",
      targetId: c.req.param("id"),
      detail: { name: parsed.data.name },
    });
    return c.json({ ok: true });
  });

  /**
   * Approving a machine's pairing code from the SPA. The server-rendered
   * `/activate` page does the same thing for browsers that arrive by link.
   */
  app.post("/app/activations/:code", async (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);

    const parsed = z
      .object({ action: z.enum(["approve", "deny"]) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "action must be approve or deny" }, 400);

    expireStaleDeviceAuthorizations(db);
    const authorization = findDeviceAuthorizationByUserCode(db, c.req.param("code"));
    if (!authorization) return c.json({ error: "unknown code" }, 404);
    if (authorization.status !== "pending" || isExpired(authorization.expires_at)) {
      return c.json({ error: "code is no longer valid" }, 410);
    }

    if (parsed.data.action === "deny") {
      denyDeviceAuthorization(db, authorization.id);
      writeAudit(db, {
        action: "device_authorization.denied",
        actorUserId: session.user_id,
        actorDeviceId: session.id,
        targetType: "device_authorization",
        targetId: authorization.id,
        ip: clientIp(c),
      });
      return c.json({ status: "denied" });
    }

    approveDeviceAuthorization(db, authorization.id, session.user_id, session.id);
    writeAudit(db, {
      action: "device_authorization.approved",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "device_authorization",
      targetId: authorization.id,
      ip: clientIp(c),
      userAgent: userAgent(c),
      detail: { displayName: authorization.display_name },
    });
    return c.json({ status: "approved", displayName: authorization.display_name });
  });

  /**
   * Mints the ticket a browser needs to reach this machine through the
   * forwarding layer. Single use and short lived, because a WebSocket
   * handshake from a browser cannot carry a header, so it travels in the URL.
   */
  app.post("/app/machines/:id/connect", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);

    const machine = findMachine(db, c.req.param("id"));
    if (!machine || machine.owner_user_id !== session.user_id || machine.state !== "active") {
      return c.json({ error: "machine not found" }, 404);
    }
    if (!isMachineOnline(machine)) {
      return c.json({ error: "machine is offline" }, 409);
    }

    const ticket = createChannelTicket(db, { machineId: machine.id, deviceSessionId: session.id });
    writeAudit(db, {
      action: "channel.ticket_issued",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "machine",
      targetId: machine.id,
      ip: clientIp(c),
      userAgent: userAgent(c),
    });

    const url = new URL(hubOrigin(c));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = CLIENT_PATH;
    url.searchParams.set("ticket", ticket.token);

    return c.json({
      url: url.toString(),
      expiresAt: ticket.row.expires_at,
      fingerprint: publicKeyFingerprint(machine.public_key),
    });
  });

  app.post("/app/machines/:id/revoke", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);

    const machine = findMachine(db, c.req.param("id"));
    if (!machine || machine.owner_user_id !== session.user_id) {
      return c.json({ error: "machine not found" }, 404);
    }

    revokeMachine(db, machine.daemon_id);
    authority.revoke(machine.id, "revoked by owner");
    writeAudit(db, {
      action: "machine.revoked",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "machine",
      targetId: machine.id,
      detail: { by: "owner" },
    });
    return c.json({ ok: true });
  });

  app.post("/app/links", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);

    const link = createTransferLink(db, { userId: session.user_id, createdByDeviceId: session.id });
    writeAudit(db, {
      action: "transfer_link.created",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "transfer_link",
      targetId: link.row.id,
    });
    return c.json({
      id: link.row.id,
      url: `${hubOrigin(c)}/link/${link.token}`,
      expiresAt: link.row.expires_at,
    });
  });

  app.get("/app/links", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);
    return c.json({
      links: listTransferLinks(db, session.user_id).map((l) => ({
        id: l.id,
        createdAt: l.created_at,
        expiresAt: l.expires_at,
        consumedAt: l.consumed_at,
        consumedIp: l.consumed_ip,
        revokedAt: l.revoked_at,
      })),
    });
  });

  app.post("/app/links/:id/revoke", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);
    if (!revokeTransferLink(db, session.user_id, c.req.param("id"))) {
      return c.json({ error: "link not found" }, 404);
    }
    writeAudit(db, {
      action: "transfer_link.revoked",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "transfer_link",
      targetId: c.req.param("id"),
    });
    return c.json({ ok: true });
  });

  app.post("/app/sessions/:id/revoke", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);
    if (!revokeSession(db, session.user_id, c.req.param("id"))) {
      return c.json({ error: "session not found" }, 404);
    }
    writeAudit(db, {
      action: "session.revoked",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "device_session",
      targetId: c.req.param("id"),
    });
    return c.json({ ok: true });
  });

  app.post("/app/sessions/:id/trust", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);
    if (!trustSession(db, session.user_id, c.req.param("id"))) {
      return c.json({ error: "session not found" }, 404);
    }
    writeAudit(db, {
      action: "session.trusted",
      actorUserId: session.user_id,
      actorDeviceId: session.id,
      targetType: "device_session",
      targetId: c.req.param("id"),
    });
    return c.json({ ok: true });
  });

  app.get("/app/audit", (c) => {
    const session = requireSession(c);
    if (!session) return c.json({ error: "not signed in" }, 401);
    return c.json({ entries: recentAuditForUser(db, session.user_id) });
  });

  return app;
}

/** Consumes a one-time transfer link and starts a session for the opening device. */
export function consumeTransferLink(
  db: HubDatabase,
  c: Context,
  token: string,
): { ok: true; token: string } | { ok: false; reason: string } {
  const link = findTransferLink(db, token);
  if (!link) return { ok: false, reason: "链接无效" };

  const reject = (reason: string) => {
    writeAudit(db, {
      action: "transfer_link.rejected",
      actorUserId: link.user_id,
      targetType: "transfer_link",
      targetId: link.id,
      ip: clientIp(c),
      userAgent: userAgent(c),
      detail: { reason },
    });
    return { ok: false as const, reason };
  };

  if (link.revoked_at) return reject("链接已被撤销");
  if (isExpired(link.expires_at)) return reject("链接已过期");
  if (link.used_count >= link.max_uses) return reject("链接已被使用");

  const session = createDeviceSession(db, {
    userId: link.user_id,
    name: "通过链接打开的设备",
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  markTransferLinkConsumed(db, link.id, session.row.id, clientIp(c), userAgent(c));

  writeAudit(db, {
    action: "transfer_link.consumed",
    actorUserId: link.user_id,
    actorDeviceId: session.row.id,
    targetType: "transfer_link",
    targetId: link.id,
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  writeAudit(db, {
    action: "session.created",
    actorUserId: link.user_id,
    actorDeviceId: session.row.id,
    ip: clientIp(c),
    userAgent: userAgent(c),
    detail: { via: "transfer_link" },
  });

  return { ok: true, token: session.token };
}
