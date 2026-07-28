import { Hono } from "hono";

import { ControlAuthority } from "./authority.js";
import { openDatabase, type HubDatabase } from "./db.js";
import { appApiRoutes } from "./http/app-api.js";
import { enrollmentRoutes } from "./http/enrollment.js";
import { internalRoutes } from "./http/internal.js";
import { pageRoutes } from "./http/pages.js";
import { purgeExpiredChannelTickets } from "./store.js";

export interface Control {
  routes: Hono;
  authority: ControlAuthority;
  db: HubDatabase;
  close(): void;
}

/**
 * Accounts, machine directory, rentals and audit — everything that needs a
 * database and knows what a user is.
 */
export function createControl(
  options: { databasePath?: string; workbenchUrl?: string; internalToken?: string } = {},
): Control {
  const db = openDatabase(options.databasePath);
  const authority = new ControlAuthority(db);

  const routes = new Hono();
  routes.route("/", enrollmentRoutes(db));
  routes.route("/", appApiRoutes(db, authority));
  routes.route("/", pageRoutes(db, options.workbenchUrl ?? "/workbench/"));
  const internalToken = options.internalToken ?? process.env.HUB_INTERNAL_TOKEN ?? null;
  if (internalToken) routes.route("/", internalRoutes(authority, internalToken));

  // Tickets are minutes-long; sweeping them hourly keeps the table from
  // growing without adding a job runner we would otherwise not need.
  const sweep = setInterval(() => purgeExpiredChannelTickets(db), 3_600_000);
  sweep.unref?.();

  return {
    routes,
    authority,
    db,
    close() {
      clearInterval(sweep);
      db.close();
    },
  };
}
