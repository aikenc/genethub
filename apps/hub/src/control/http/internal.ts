import { Hono } from "hono";
import { z } from "zod";

import type { ControlAuthority } from "../authority.js";

const TicketSchema = z.object({ ticket: z.string().min(1) });
const PresenceSchema = z.object({
  machineId: z.string().min(1),
  state: z.enum(["online", "offline"]),
});

/**
 * The contract, exposed over HTTP for a forwarding tier running elsewhere.
 *
 * Mounted only when `HUB_INTERNAL_TOKEN` is set, because in the single-process
 * topology nobody needs it and an unauthenticated `/internal` on a public
 * origin is a hole. Even with the token, this belongs behind network isolation.
 */
export function internalRoutes(authority: ControlAuthority, token: string): Hono {
  const app = new Hono();

  app.use("/internal/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (!header.toLowerCase().startsWith("bearer ") || header.slice(7).trim() !== token) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  app.post("/internal/authorize-daemon", async (c) => {
    const parsed = TicketSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "ticket is required" }, 400);
    const grant = await authority.authorizeDaemon(parsed.data.ticket);
    return grant ? c.json(grant) : c.body(null, 204);
  });

  app.post("/internal/authorize-client", async (c) => {
    const parsed = TicketSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "ticket is required" }, 400);
    const grant = await authority.authorizeClient(parsed.data.ticket);
    return grant ? c.json(grant) : c.body(null, 204);
  });

  app.post("/internal/presence", async (c) => {
    const parsed = PresenceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "machineId and state are required" }, 400);
    await authority.reportPresence(parsed.data.machineId, parsed.data.state);
    return c.body(null, 204);
  });

  return app;
}
