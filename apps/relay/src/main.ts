// Endpoint-neutral byte forwarding. Product identity and E2EE secrets never
// enter this process; it sees only opaque endpoint, route and stream handles.

import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import type { FabricAuthority } from "./contract/fabric.js";
import { FABRIC_PATH } from "./contract/fabric-wire.js";
import { FabricForwarder } from "./forward/fabric-forwarder.js";
import { RemoteFabricAuthority } from "./forward/remote-fabric-authority.js";
import {
  RendezvousFabricAuthority,
  resolveJoinToken,
} from "./forward/rendezvous.js";
import { config, validateControlOrigin } from "./shared/config.js";
import { log } from "./shared/log.js";
import { OutboundByteBudget } from "./shared/outbound-budget.js";
import { requestTarget } from "./shared/request-target.js";

export interface Relay {
  app: Hono;
  server: Server;
  port: number;
  fabricForwarder: FabricForwarder;
  /** Resolves after a hosted authority installs its first revocation sync. */
  fabricReady: Promise<void>;
  close(): Promise<void>;
}

export async function startRelay(
  options: {
    port?: number;
    host?: string;
    /** In-process authority injection is test-only. */
    fabricAuthority?: FabricAuthority;
    controlOrigin?: string;
    controlToken?: string | null;
  } = {},
): Promise<Relay> {
  const host = options.host ?? config.host;
  const fabricAuthority =
    options.fabricAuthority ??
    (config.mode() === "control"
      ? new RemoteFabricAuthority(
          options.controlOrigin
            ? validateControlOrigin(options.controlOrigin)
            : config.controlOrigin(),
          options.controlToken ?? config.controlToken(),
        )
      : new RendezvousFabricAuthority(resolveJoinToken(config.joinToken(), host)));
  const authorityIsRemote = fabricAuthority instanceof RemoteFabricAuthority;
  const outboundBudget = new OutboundByteBudget(
    config.limits.maxOutboundQueuedBytes,
    config.limits.maxBufferedBytes,
  );
  const fabricForwarder = new FabricForwarder(fabricAuthority, {
    authorityReady: !authorityIsRemote,
    outboundBudget,
  });

  let resolveInitialSync: (() => void) | null = null;
  const fabricReady = authorityIsRemote
    ? new Promise<void>((resolve) => {
        resolveInitialSync = resolve;
      })
    : Promise.resolve();
  const stopWatching =
    authorityIsRemote && fabricAuthority instanceof RemoteFabricAuthority
      ? fabricAuthority.watchRevocations({
          onReconnect: () => {
            fabricForwarder.authoritySynchronized();
            resolveInitialSync?.();
            resolveInitialSync = null;
          },
          onDisconnect: () => fabricForwarder.authorityDisconnected(),
        })
      : () => {};

  const app = new Hono();
  const healthBody = () => {
    const ready = fabricForwarder.authorityAvailable();
    return {
      status: ready ? "ok" : "degraded",
      ready,
      fabric: {
        ...fabricForwarder.stats(),
        authorityReady: ready,
      },
    };
  };
  app.get("/api/health", (c) => c.json(healthBody()));
  app.get("/api/ready", (c) =>
    fabricForwarder.authorityAvailable()
      ? c.json(healthBody(), 200)
      : c.json(healthBody(), 503),
  );

  const port = options.port ?? config.port;
  const server = await new Promise<Server>((resolve) => {
    const created = serve({ fetch: app.fetch, hostname: host, port }, () =>
      resolve(created as unknown as Server),
    );
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  fabricForwarder.attach(server);
  server.on("upgrade", (request, socket) => {
    const target = requestTarget(request.url);
    if (target?.pathname === FABRIC_PATH) return;
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  log.info("relay listening", { address: `http://${host}:${boundPort}` });
  return {
    app,
    server,
    port: boundPort,
    fabricForwarder,
    fabricReady,
    async close() {
      stopWatching();
      await fabricForwarder.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const invokedDirectly = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (invokedDirectly) {
  const relay = await startRelay();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void relay.close().then(() => process.exit(0));
    });
  }
}
