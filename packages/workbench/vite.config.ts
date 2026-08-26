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
 * relay's own (unforwarded) port. `hub-connect.html` used to rewrite that onto
 * `/relay` on this origin; that hop is deprecated leftover of the pre-subpath
 * architecture and must not grow new callers. See that file.
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
  plugins: [react(), localIdentity()],
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
  build: {
    outDir: "dist",
    sourcemap: true,
    // The PCM capture worklet must stay a real file. Under the default 4 kB
    // inline limit Vite turns it into a data: URL, and every CSP-bearing
    // consumer — the cloud console (script-src 'self') and the Tauri desktop
    // shell (default-src 'self') — then blocks audioWorklet.addModule, so
    // voice input fails before recording starts (beta.2 report, 2026-08-14).
    assetsInlineLimit: (filePath) =>
      filePath.endsWith("pcm-worklet.js") ? false : undefined,
  },
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

function localIdentity() {
  return {
    name: "genehub-local-identity",
    transformIndexHtml(html: string) {
      const name = process.env.VITE_GENEHUB_LOCAL_NAME;
      if (!name) return html;
      return html
        .replace("<title>GeneHub</title>", `<title>GeneHub ${name}</title>`)
        .replace("</head>", `  <meta name="genehub-local-build" content="本地版 ${name}" />\n  </head>`);
    },
  };
}
