import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

import { config } from "../../shared/config.js";
import type { HubDatabase } from "../db.js";
import { resolveSession, type DeviceSessionRow } from "../store.js";

export function clientIp(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  const real = c.req.header("x-real-ip");
  if (real) return real;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function userAgent(c: Context): string | null {
  return c.req.header("user-agent") ?? null;
}

export function currentSession(c: Context, db: HubDatabase): DeviceSessionRow | null {
  const cookie = getCookie(c, config.control.session.cookieName);
  const header = c.req.header("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : undefined;
  return resolveSession(db, cookie ?? bearer);
}

export function attachSessionCookie(c: Context, token: string): void {
  setCookie(c, config.control.session.cookieName, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: config.control.session.ttlDays * 24 * 3600,
  });
}

/**
 * Origin the daemon used in `paseo hub connect <url>`. The daemon rejects an
 * enrollment whose webSocketUrl host does not match it, so behind a proxy the
 * forwarded protocol matters.
 */
export function hubOrigin(c: Context): string {
  if (config.publicOrigin) return config.publicOrigin.replace(/\/$/, "");
  const host = c.req.header("host") ?? `${config.host}:${config.port}`;
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function webSocketUrl(c: Context, pathname: string): string {
  const origin = new URL(hubOrigin(c));
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = pathname;
  return origin.toString();
}
