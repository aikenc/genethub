import { Hono, type Context } from "hono";
import { z } from "zod";

import { writeAudit } from "../audit.js";
import type { HubDatabase } from "../db.js";
import {
  createDeviceAuthorization,
  expireStaleDeviceAuthorizations,
  findDeviceAuthorizationByCode,
  findDeviceAuthorizationByEnrollmentToken,
  findMachineByDaemonId,
  markDeviceAuthorizationEnrolled,
  revokeMachine,
  touchDeviceAuthorizationPoll,
  upsertMachine,
} from "../store.js";
import { isExpired, tokenMatchesHash } from "../../shared/tokens.js";
import { clientIp, hubOrigin, userAgent, webSocketUrl } from "./session.js";
import { DAEMON_PATH } from "../../contract/index.js";

const StartSchema = z.object({
  displayName: z.string().min(1).max(100),
  platform: z.string().max(60).optional(),
});
const PollSchema = z.object({ deviceCode: z.string().min(1) });
const EnrollSchema = z.object({
  daemonId: z.string().min(1).max(128),
  /** The daemon's identity key, shown to the owner as a fingerprint. */
  publicKey: z.string().min(1),
  /** Hash of the uplink secret. The secret itself never leaves the machine. */
  credentialVerifier: z.string().min(1),
  platform: z.string().max(60).optional(),
});

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer") return null;
  const value = rest.join(" ").trim();
  return value.length > 0 ? value : null;
}

/**
 * The routes a machine's daemon talks to: the device-code flow that ties it to
 * an account, and enrollment, which is what earns it an uplink.
 *
 * The daemon has no browser, so it cannot complete a redirect-based login. It
 * prints a short code instead and waits for a human to approve it somewhere
 * that does have one (`docs/product-ux.md`).
 */
export function enrollmentRoutes(db: HubDatabase): Hono {
  const app = new Hono();

  app.post("/api/device-authorizations", async (c) => {
    const parsed = StartSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "displayName is required" }, 400);

    const { row, deviceCode } = createDeviceAuthorization(db, parsed.data.displayName);
    const verificationUri = `${hubOrigin(c)}/activate`;

    writeAudit(db, {
      action: "device_authorization.started",
      targetType: "device_authorization",
      targetId: row.id,
      ip: clientIp(c),
      userAgent: userAgent(c),
      detail: { displayName: row.display_name },
    });

    return c.json({
      deviceCode,
      userCode: row.user_code,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(row.user_code)}`,
      expiresAt: row.expires_at,
      interval: row.interval_seconds,
    });
  });

  app.post("/api/device-authorizations/poll", async (c) => {
    const parsed = PollSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "deviceCode is required" }, 400);

    expireStaleDeviceAuthorizations(db);
    const row = findDeviceAuthorizationByCode(db, parsed.data.deviceCode);
    if (!row) return c.json({ error: "unknown device code" }, 404);

    touchDeviceAuthorizationPoll(db, row.id);
    const interval = row.interval_seconds;

    if (row.status === "approved") {
      if (!row.enrollment_token) {
        // Collected once already but enrollment never finished. Sending the
        // daemon back to the start beats handing out a token we no longer hold.
        return c.json({ status: "expired", interval });
      }
      return c.json({ status: "approved", interval, enrollmentToken: row.enrollment_token });
    }

    return c.json({ status: row.status, interval });
  });

  app.post("/api/machines/enroll", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "missing enrollment token" }, 401);

    const parsed = EnrollSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid enrollment payload" }, 400);
    const body = parsed.data;

    expireStaleDeviceAuthorizations(db);
    const authorization = findDeviceAuthorizationByEnrollmentToken(db, token);
    if (!authorization || !authorization.claimed_by_user_id) {
      return c.json({ error: "unknown enrollment token" }, 401);
    }
    if (authorization.status === "denied" || authorization.status === "expired") {
      return c.json({ error: "enrollment token is no longer valid" }, 403);
    }
    if (authorization.status !== "enrolled" && isExpired(authorization.expires_at)) {
      return c.json({ error: "enrollment token expired" }, 403);
    }

    const machine = upsertMachine(db, {
      ownerUserId: authorization.claimed_by_user_id,
      name: authorization.display_name,
      platform: body.platform ?? null,
      daemonId: body.daemonId,
      publicKey: body.publicKey,
      credentialVerifier: body.credentialVerifier,
    });
    markDeviceAuthorizationEnrolled(db, authorization.id, machine.id);

    writeAudit(db, {
      action: "machine.enrolled",
      actorUserId: authorization.claimed_by_user_id,
      targetType: "machine",
      targetId: machine.id,
      ip: clientIp(c),
      userAgent: userAgent(c),
      detail: { daemonId: body.daemonId },
    });

    return c.json({
      machineId: machine.id,
      daemonId: body.daemonId,
      uplinkUrl: webSocketUrl(c, DAEMON_PATH),
    });
  });

  /** A machine unenrolling itself, using the uplink credential as proof. */
  app.delete("/api/machines/:daemonId", (c) => {
    const credential = bearer(c.req.header("authorization"));
    if (!credential) return c.json({ error: "missing credential" }, 401);

    const daemonId = c.req.param("daemonId");
    const machine = findMachineByDaemonId(db, daemonId);
    if (!machine) return c.json({ error: "unknown machine" }, 404);
    if (!tokenMatchesHash(credential, machine.credential_verifier)) {
      return c.json({ error: "invalid credential" }, 403);
    }

    revokeMachine(db, daemonId);
    writeAudit(db, {
      action: "machine.revoked",
      actorUserId: machine.owner_user_id,
      targetType: "machine",
      targetId: machine.id,
      ip: clientIp(c),
      detail: { by: "machine" },
    });
    return c.body(null, 204);
  });

  return app;
}

export type EnrollmentContext = Context;
