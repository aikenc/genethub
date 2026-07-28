import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { createControl, type Control } from "./control/index.js";
import { Forwarder } from "./forward/index.js";
import { RemoteAuthority } from "./forward/remote-authority.js";
import { config, rolesFromEnv, type Role } from "./shared/config.js";
import { log } from "./shared/log.js";

export interface Hub {
  app: Hono;
  server: Server;
  port: number;
  control: Control | null;
  forwarder: Forwarder | null;
  close(): Promise<void>;
}

/**
 * Assembles the process from the roles it was asked to run.
 *
 * Both roles in one process is the shipping topology. Running `ROLES=forward`
 * alone is not a curiosity: it is the check that the two halves have not grown
 * back together (`docs/architecture.md` §6.5).
 */
export async function startHub(
  options: {
    roles?: Set<Role>;
    port?: number;
    host?: string;
    databasePath?: string;
    workbenchUrl?: string;
    internalToken?: string;
    /** Where a lone forwarding role finds the control plane. */
    controlOrigin?: string;
  } = {},
): Promise<Hub> {
  const roles = options.roles ?? rolesFromEnv();
  const app = new Hono();

  const control = roles.has("control")
    ? createControl({
        ...(options.databasePath ? { databasePath: options.databasePath } : {}),
        ...(options.workbenchUrl ? { workbenchUrl: options.workbenchUrl } : {}),
        ...(options.internalToken ? { internalToken: options.internalToken } : {}),
      })
    : null;

  let forwarder: Forwarder | null = null;
  if (roles.has("forward")) {
    // Same process: call the control plane directly. Split: talk to it over
    // HTTP. The forwarder cannot tell the difference, which is the whole point
    // of the contract being the only thing it depends on.
    const authority =
      control?.authority ??
      new RemoteAuthority(
        options.controlOrigin ??
          config.forward.controlOrigin ??
          (() => {
            throw new Error(
              "ROLES=forward without control needs HUB_CONTROL_ORIGIN to reach the control plane",
            );
          })(),
        process.env.HUB_INTERNAL_TOKEN ?? null,
      );
    forwarder = new Forwarder(authority);
  }

  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      roles: [...roles],
      forward: forwarder?.stats() ?? null,
    }),
  );
  if (control) app.route("/", control.routes);

  const host = options.host ?? config.host;
  const port = options.port ?? config.port;

  const server = await new Promise<Server>((resolve) => {
    const created = serve({ fetch: app.fetch, hostname: host, port }, () =>
      resolve(created as unknown as Server),
    );
  });
  forwarder?.attach(server);

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  log.info("hub listening", { address: `http://${host}:${boundPort}`, roles: [...roles] });

  return {
    app,
    server,
    port: boundPort,
    control,
    forwarder,
    async close() {
      forwarder?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      control?.close();
    },
  };
}

const invokedDirectly = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (invokedDirectly) {
  const hub = await startHub();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void hub.close().then(() => process.exit(0));
    });
  }
}
