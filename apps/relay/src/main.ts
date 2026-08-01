//! The relay: it moves bytes and knows nothing about them.
//!
//! Everything with an opinion — accounts, machines, tickets, audit — lives
//! behind the contract in `src/contract/`, reached over HTTP. That is what
//! makes this process safe to hand to someone else to run: the worst a hostile
//! relay operator can do is drop traffic or observe who talks to whom, which is
//! stated plainly in `docs/security-model.md` rather than glossed over.

import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import type { ChannelAuthority } from "./contract/index.js";
import { Forwarder } from "./forward/index.js";
import { RemoteAuthority } from "./forward/remote-authority.js";
import { RendezvousAuthority, resolveJoinToken } from "./forward/rendezvous.js";
import { config } from "./shared/config.js";
import { log } from "./shared/log.js";

export interface Relay {
  app: Hono;
  server: Server;
  port: number;
  forwarder: Forwarder;
  close(): Promise<void>;
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

  const app = new Hono();
  const forwarder = new Forwarder(authority);
  // A revocation the relay never hears about is a machine that stays reachable
  // after its owner cut it off, so the subscription is not optional. Its
  // reconnect is also the resync signal: the control plane boots every machine
  // to offline, and without the re-report a restart of it leaves live machines
  // looking gone.
  const stopWatching =
    authority instanceof RemoteAuthority
      ? authority.watchRevocations({ onReconnect: () => forwarder.resyncPresence() })
      : () => {};

  app.get("/api/health", (c) => c.json({ status: "ok", forward: forwarder.stats() }));

  const port = options.port ?? config.port;
  const server = await new Promise<Server>((resolve) => {
    const created = serve({ fetch: app.fetch, hostname: host, port }, () =>
      resolve(created as unknown as Server),
    );
  });
  forwarder.attach(server);

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  log.info("relay listening", { address: `http://${host}:${boundPort}` });

  return {
    app,
    server,
    port: boundPort,
    forwarder,
    async close() {
      stopWatching();
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
