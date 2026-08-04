//! The relay: it moves bytes without interpreting their product meaning.
//!
//! Everything with an opinion — accounts, machines, tickets, audit — lives
//! behind the contract in `src/contract/`, reached over HTTP. That is what
//! keeps this process free of product authorization and persistence. Until
//! endpoints add E2EE, TLS terminates here: an operator can still observe or
//! alter forwarded bytes as well as metadata, delay them, or drop them. The
//! narrower current claim is stated in `docs/security-model.md`.

import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import type { ChannelAuthority } from "./contract/index.js";
import type { FabricAuthority } from "./contract/fabric.js";
import { FabricForwarder } from "./forward/fabric-forwarder.js";
import { Forwarder } from "./forward/index.js";
import { RemoteAuthority } from "./forward/remote-authority.js";
import { RemoteFabricAuthority } from "./forward/remote-fabric-authority.js";
import { RendezvousAuthority, resolveJoinToken } from "./forward/rendezvous.js";
import { config } from "./shared/config.js";
import { log } from "./shared/log.js";

export interface Relay {
  app: Hono;
  server: Server;
  port: number;
  forwarder: Forwarder;
  fabricForwarder: FabricForwarder | null;
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
          options.controlOrigin ?? config.controlOrigin(),
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
              options.controlOrigin ?? config.controlOrigin(),
              options.controlToken ?? config.controlToken(),
            )
          : null;

  const app = new Hono();
  const forwarder = new Forwarder(authority);
  const fabricAuthorityIsRemote = fabricAuthority instanceof RemoteFabricAuthority;
  const fabricForwarder = fabricAuthority
    ? new FabricForwarder(fabricAuthority, {
        // A remote authority is unsafe until its revocation stream has
        // delivered the mandatory initial sync. In-process test authorities do
        // not have an external stream and start ready by construction.
        authorityReady: !fabricAuthorityIsRemote,
      })
    : null;
  let resolveInitialFabricSync: (() => void) | null = null;
  const initialFabricSync = fabricAuthorityIsRemote
    ? new Promise<void>((resolve) => {
        resolveInitialFabricSync = resolve;
      })
    : Promise.resolve();
  // A revocation the relay never hears about is a machine that stays reachable
  // after its owner cut it off, so the subscription is not optional. Its
  // reconnect is also the resync signal: the control plane boots every machine
  // to offline, and without the re-report a restart of it leaves live machines
  // looking gone.
  const stopWatching =
    authority instanceof RemoteAuthority
      ? authority.watchRevocations({ onReconnect: () => forwarder.resyncPresence() })
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

  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      forward: forwarder.stats(),
      ...(fabricForwarder
        ? {
            fabric: {
              ...fabricForwarder.stats(),
              authorityReady: fabricForwarder.authorityAvailable(),
            },
          }
        : {}),
    }),
  );

  const port = options.port ?? config.port;
  const server = await new Promise<Server>((resolve) => {
    const created = serve({ fetch: app.fetch, hostname: host, port }, () =>
      resolve(created as unknown as Server),
    );
  });
  forwarder.attach(server);
  fabricForwarder?.attach(server);

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  log.info("relay listening", { address: `http://${host}:${boundPort}` });

  return {
    app,
    server,
    port: boundPort,
    forwarder,
    fabricForwarder,
    fabricReady: initialFabricSync,
    async close() {
      stopWatching();
      stopWatchingFabric();
      fabricForwarder?.close();
      forwarder.close();
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
