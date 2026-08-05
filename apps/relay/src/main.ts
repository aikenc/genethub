//! The relay: it moves bytes without interpreting their product meaning.
//!
//! Everything with an opinion — accounts, machines, tickets, audit — lives
//! behind the contract in `src/contract/`, reached over HTTP. That is what
//! keeps this process free of product authorization and persistence. Until
//! v2 application frames are encrypted end to end with a channel PSK, so this
//! process sees routing metadata and ciphertext and can delay/drop it, but
//! cannot read or forge it without that secret. Hosted Control creates the
//! secret, so this Relay-specific boundary is not a platform zero-knowledge
//! claim; the exact boundary is stated in `docs/security-model.md`.

import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { CLIENT_PATH, DAEMON_PATH, type ChannelAuthority } from "./contract/index.js";
import type { FabricAuthority } from "./contract/fabric.js";
import { FABRIC_PATH } from "./contract/fabric-wire.js";
import { FabricForwarder } from "./forward/fabric-forwarder.js";
import { Forwarder } from "./forward/index.js";
import { RemoteAuthority } from "./forward/remote-authority.js";
import { RemoteFabricAuthority } from "./forward/remote-fabric-authority.js";
import { RendezvousAuthority, resolveJoinToken } from "./forward/rendezvous.js";
import { config, validateControlOrigin } from "./shared/config.js";
import { log } from "./shared/log.js";
import { OutboundByteBudget } from "./shared/outbound-budget.js";
import { requestTarget } from "./shared/request-target.js";

export interface Relay {
  app: Hono;
  server: Server;
  port: number;
  forwarder: Forwarder;
  fabricForwarder: FabricForwarder | null;
  /** Resolves after the remote legacy authority installs its first sync. */
  legacyReady: Promise<void>;
  /** Resolves after the remote Fabric authority installs its first sync. */
  fabricReady: Promise<void>;
  close(): Promise<void>;
}

function isFabricAuthority(value: ChannelAuthority): value is ChannelAuthority & FabricAuthority {
  const candidate = value as Partial<FabricAuthority>;
  return (
    typeof candidate.authorizeEndpoint === "function" &&
    typeof candidate.authorizeRoute === "function" &&
    typeof candidate.reportEndpointPresence === "function" &&
    typeof candidate.onFabricRevoked === "function"
  );
}

export async function startRelay(
  options: {
    port?: number;
    host?: string;
    /**
     * Injected by tests. In production this is always a `RemoteAuthority`:
     * there is no in-process control plane to fall back to, by design.
    */
    authority?: ChannelAuthority;
    /** Tests may inject the v2 authority separately; null keeps Fabric off. */
    fabricAuthority?: FabricAuthority | null;
    controlOrigin?: string;
    controlToken?: string | null;
  } = {},
): Promise<Relay> {
  const host = options.host ?? config.host;
  const authority =
    options.authority ??
    (config.mode() === "rendezvous"
      ? new RendezvousAuthority(resolveJoinToken(config.joinToken(), host))
      : new RemoteAuthority(
          options.controlOrigin
            ? validateControlOrigin(options.controlOrigin)
            : config.controlOrigin(),
          options.controlToken ?? config.controlToken(),
        ));
  const fabricAuthority =
    options.fabricAuthority !== undefined
      ? options.fabricAuthority
      : options.authority !== undefined
        ? isFabricAuthority(options.authority)
          ? options.authority
          : null
        : config.mode() === "control"
          ? new RemoteFabricAuthority(
              options.controlOrigin
                ? validateControlOrigin(options.controlOrigin)
                : config.controlOrigin(),
              options.controlToken ?? config.controlToken(),
            )
          : null;

  const app = new Hono();
  // Legacy and Fabric share one process-wide memory allowance. A large number
  // of individually well-behaved sockets must not be able to exhaust the host
  // in aggregate.
  const outboundBudget = new OutboundByteBudget(
    config.limits.maxOutboundQueuedBytes,
    config.limits.maxBufferedBytes,
  );
  const authorityIsRemote = authority instanceof RemoteAuthority;
  const forwarder = new Forwarder(authority, {
    authorityReady: !authorityIsRemote,
    outboundBudget,
  });
  const fabricAuthorityIsRemote = fabricAuthority instanceof RemoteFabricAuthority;
  const fabricForwarder = fabricAuthority
      ? new FabricForwarder(fabricAuthority, {
        // A remote authority is unsafe until its revocation stream has
        // delivered the mandatory initial sync. In-process test authorities do
        // not have an external stream and start ready by construction.
        authorityReady: !fabricAuthorityIsRemote,
        outboundBudget,
      })
    : null;
  let resolveInitialFabricSync: (() => void) | null = null;
  const initialFabricSync = fabricAuthorityIsRemote
    ? new Promise<void>((resolve) => {
        resolveInitialFabricSync = resolve;
      })
    : Promise.resolve();
  let resolveInitialLegacySync: (() => void) | null = null;
  const initialLegacySync = authorityIsRemote
    ? new Promise<void>((resolve) => {
        resolveInitialLegacySync = resolve;
      })
    : Promise.resolve();
  // A revocation the relay never hears about is a machine that stays reachable
  // after its owner cut it off, so the subscription is not optional. Its
  // reconnect is also the resync signal: the control plane boots every machine
  // to offline, and without the re-report a restart of it leaves live machines
  // looking gone.
  const stopWatching =
    authorityIsRemote && authority instanceof RemoteAuthority
      ? authority.watchRevocations({
          onReconnect: () => {
            forwarder.authoritySynchronized();
            resolveInitialLegacySync?.();
            resolveInitialLegacySync = null;
          },
          onDisconnect: () => forwarder.authorityDisconnected(),
        })
      : () => {};
  const stopWatchingFabric =
    fabricAuthorityIsRemote &&
    fabricAuthority instanceof RemoteFabricAuthority &&
    fabricForwarder
      ? fabricAuthority.watchRevocations({
          onReconnect: () => {
            fabricForwarder.authoritySynchronized();
            resolveInitialFabricSync?.();
            resolveInitialFabricSync = null;
          },
          onDisconnect: () => fabricForwarder.authorityDisconnected(),
        })
      : () => {};

  const readiness = () =>
    forwarder.authorityAvailable() &&
    (!fabricForwarder || fabricForwarder.authorityAvailable());
  const healthBody = () => {
    const ready = readiness();
    return {
      status: ready ? "ok" : "degraded",
      ready,
      forward: {
        ...forwarder.stats(),
        authorityReady: forwarder.authorityAvailable(),
      },
      ...(fabricForwarder
        ? {
            fabric: {
              ...fabricForwarder.stats(),
              authorityReady: fabricForwarder.authorityAvailable(),
            },
          }
        : {}),
    };
  };
  /** Liveness stays 200; callers must inspect `ready` or use `/api/ready`. */
  app.get("/api/health", (c) => c.json(healthBody()));
  /** Deployment/readiness probe: no admissions before every remote sync fence. */
  app.get("/api/ready", (c) =>
    readiness()
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
  forwarder.attach(server);
  fabricForwarder?.attach(server);
  // The two forwarders deliberately own disjoint paths. A final dispatcher
  // closes everything neither claimed; otherwise Node leaves an upgraded raw
  // socket open forever, giving unauthenticated slowloris traffic an FD leak.
  const upgradePaths = new Set([DAEMON_PATH, CLIENT_PATH, ...(fabricForwarder ? [FABRIC_PATH] : [])]);
  server.on("upgrade", (request, socket) => {
    const target = requestTarget(request.url);
    if (!target) {
      socket.destroy();
      return;
    }
    const path = target.pathname;
    if (upgradePaths.has(path)) return;
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
    forwarder,
    fabricForwarder,
    legacyReady: initialLegacySync,
    fabricReady: initialFabricSync,
    async close() {
      stopWatching();
      stopWatchingFabric();
      if (fabricForwarder) await fabricForwarder.close();
      await forwarder.close();
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
