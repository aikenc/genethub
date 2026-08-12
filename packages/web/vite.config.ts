import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";

// @ts-expect-error -- plain JS, shared with the cloud console's config in
// another checkout, so it stays outside `src` and outside this tsconfig.
import { buildDefines } from "./build-stamp.js";

/**
 * Where the page can find a daemon without a second port forward.
 *
 * Opening the workbench from another machine usually means only 5173 is
 * forwarded. A hash that points at `ws://127.0.0.1:<daemon-port>` then talks
 * to the *viewer's* machine, finds nothing, and the UI sits on "open a
 * project" with an empty catalog — looking exactly like a first-run that
 * never got a default workspace. Proxying `/daemon` through Vite keeps the
 * WebSocket on the same host the page came from.
 */
function daemonProxy(): Record<string, string | ProxyOptions> {
  const target = process.env.GENEHUB_PROXY_TARGET ?? readPublishedTarget();
  if (!target) return {};
  return {
    "/daemon": {
      target,
      changeOrigin: true,
      ws: true,
      rewrite: (path) => path.replace(/^\/daemon/, ""),
    },
  };
}

function readPublishedTarget(): string | null {
  const dataDir = process.env.GENEHUB_DATA_DIR;
  if (!dataDir) return null;
  const file = `${dataDir}/endpoint.json`;
  if (!existsSync(file)) return null;
  try {
    const published = JSON.parse(readFileSync(file, "utf8")) as { port?: number };
    return typeof published.port === "number" ? `http://127.0.0.1:${published.port}` : null;
  } catch {
    return null;
  }
}

/**
 * Same idea as `daemonProxy`, for the relay's client-facing socket.
 *
 * Only relevant when trying the full Hub journey (register → pair → connect
 * through the forwarding layer) from a machine where only this dev server's
 * port is forwarded: the ticket URL the control plane hands out points at the
 * relay's own (unforwarded) port, which `hub-connect.html` rewrites to go
 * through `/relay` on this origin instead — see that file and
 * `.cursor/skills/try-genehub`.
 */
function relayProxy(): Record<string, string | ProxyOptions> {
  const target = process.env.GENEHUB_RELAY_PROXY_TARGET;
  if (!target) return {};
  return {
    "/relay": {
      target,
      changeOrigin: true,
      ws: true,
      rewrite: (path) => path.replace(/^\/relay/, ""),
    },
  };
}

export default defineConfig({
  plugins: [react(), devIdentity()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@genehub/proto": fileURLToPath(new URL("../proto/bindings/index.ts", import.meta.url)),
    },
  },
  // Relative so the same build works served from a Hub path, from a Tauri
  // `asset://` URL and from a Capacitor bundle without three configurations.
  base: "./",
  // So the page can say which build it is; see `build-stamp.js`.
  define: buildDefines(),
  build: { outDir: "dist", sourcemap: true },
  server: {
    proxy: { ...daemonProxy(), ...relayProxy() },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Several mandatory journeys launch real daemon, agent and relay
    // processes. Running those files beside timer-sensitive protocol tests
    // makes the result depend on runner load instead of product behavior.
    fileParallelism: false,
  },
});

function devIdentity() {
  return {
    name: "genehub-dev-identity",
    transformIndexHtml(html: string) {
      const name = process.env.VITE_GENEHUB_DEV_NAME;
      if (!name) return html;
      return html
        .replace("<title>GeneHub</title>", `<title>GeneHub ${name}</title>`)
        .replace("</head>", `  <meta name="genehub-dev-build" content="开发版 ${name}" />\n  </head>`);
    },
  };
}
