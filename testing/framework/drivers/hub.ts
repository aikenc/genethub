import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BlockedError } from "../../infrastructure/public.ts";

/**
 * The real Cloud control plane (`@genehub-cloud/server`), booted in-process
 * from the cloud worktree testctl was pointed at (`--cloud`), exactly the way
 * the server's own harness does it (`server/test/harness.ts` there).
 *
 * Production interface on the three planes (P11):
 * - owner: `@genehub-cloud/server`; entry: `startControlServer` in
 *   `server/src/main.ts`, the same composition root its own entrypoint and
 *   tests consume; build/typecheck: `npm --prefix server run typecheck`.
 * - action surface: the HTTP contract browsers and daemons speak
 *   (`/api/device-authorizations`, `/app/activations/:code`, `/link/:token`,
 *   `/app/me`). No test-only routes, no source patching.
 * - evidence: real HTTP status codes and the session cookie jar, nothing else.
 *
 * Cookies and one-time tokens live in memory only and are never written to
 * run artifacts (L09).
 */

export interface HubBrowser {
  /** What this browser would send back, or null while it has no session. */
  cookie(): string | null;
  fetch(target: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(target: string, init?: RequestInit): Promise<T>;
}

export interface HubHandle {
  /** Loopback origin the control plane listens on. */
  origin: string;
  /** A caller with a cookie jar of its own — one per simulated browser. */
  browser(): HubBrowser;
  /**
   * Signs a browser in as a temporary user the way a first-time visitor
   * actually does: a device code, a trial claim link, preview, redeem.
   * Deliberately the product's own path, not a test-only shortcut.
   */
  signInOwner(browser: HubBrowser): Promise<{ userId: string }>;
  /** Approves a machine's pairing code as the signed-in browser. */
  approvePairing(browser: HubBrowser, userCode: string): Promise<void>;
  stop(): Promise<void>;
}

interface ControlServerLike {
  port: number;
  close(): Promise<void>;
}

export async function startHub(input: { databasePath: string }): Promise<HubHandle> {
  const cloudRoot = process.env.TESTCTL_CLOUD_ROOT?.trim();
  if (!cloudRoot) {
    throw new BlockedError(
      "this case boots the real Cloud control plane; rerun with --cloud <path to the cloud worktree>",
    );
  }
  const entry = path.join(cloudRoot, "server", "src", "main.ts");
  if (!existsSync(entry)) {
    throw new BlockedError(`cloud server entry missing at ${entry}`);
  }
  if (!existsSync(path.join(cloudRoot, "server", "node_modules", "better-sqlite3"))) {
    throw new BlockedError(
      `cloud server dependencies missing; install them with: npm --prefix ${path.join(cloudRoot, "server")} ci`,
    );
  }
  // The daemon under test will try its uplink in the background. Point the
  // relay origin at a dead loopback port so that failure is fast and
  // deterministic; this driver exists for cases whose oracle never crosses
  // the relay.
  process.env.HUB_RELAY_ORIGIN ??= "http://127.0.0.1:1";

  mkdirSync(path.dirname(input.databasePath), { recursive: true });
  const module = (await import(pathToFileURL(entry).href)) as {
    startControlServer(options: {
      port: number;
      host: string;
      databasePath: string;
      consoleDir: string;
      relayToken: string;
    }): Promise<ControlServerLike>;
  };
  const control = await module.startControlServer({
    port: 0,
    host: "127.0.0.1",
    databasePath: input.databasePath,
    // API only: whether someone happens to have built the console locally
    // must not change what these cases exercise.
    consoleDir: path.join(path.dirname(input.databasePath), "no-console"),
    // The relay authenticates to the control plane with this token. No relay
    // ever dials in these cases, but the server refuses to start without one.
    relayToken: `testctl-${randomBytes(24).toString("hex")}`,
  });
  const origin = `http://127.0.0.1:${control.port}`;

  function browser(): HubBrowser {
    const cookies = new Map<string, string>();
    const cookieHeader = () =>
      cookies.size > 0 ? [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") : null;
    const self: HubBrowser = {
      cookie: cookieHeader,
      async fetch(target, init = {}) {
        const headers = new Headers(init.headers);
        const cookie = cookieHeader();
        if (cookie) headers.set("cookie", cookie);
        if (
          init.method &&
          !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase()) &&
          !headers.has("origin")
        ) {
          headers.set("origin", origin);
          if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
        }
        if (init.body && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        const response = await fetch(new URL(target, origin), {
          ...init,
          headers,
          redirect: "manual",
        });
        const setCookies =
          (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
          (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
        for (const setCookie of setCookies) {
          const pair = setCookie.split(";", 1)[0] ?? "";
          const separator = pair.indexOf("=");
          if (separator < 1) continue;
          const name = pair.slice(0, separator);
          const value = pair.slice(separator + 1);
          if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(setCookie)) cookies.delete(name);
          else cookies.set(name, value);
        }
        return response;
      },
      async json(target, init) {
        const response = await self.fetch(target, init);
        return (await response.json()) as never;
      },
    };
    return self;
  }

  return {
    origin,
    browser,
    async signInOwner(owner) {
      const started = await owner.json<{ deviceCode: string }>("/api/device-authorizations", {
        method: "POST",
        body: JSON.stringify({ displayName: "第一台电脑" }),
      });
      const trial = await owner.json<{ claimUrl: string }>("/api/trial", {
        method: "POST",
        body: JSON.stringify({ deviceCode: started.deviceCode }),
      });
      // Confirm, then redeem: GET only previews so link scanners cannot spend it.
      const claimPath = new URL(trial.claimUrl).pathname;
      const preview = await owner.fetch(claimPath);
      if (preview.status !== 200) throw new Error(`the trial claim link did not preview: ${preview.status}`);
      const redeemed = await owner.fetch(claimPath, { method: "POST" });
      if (redeemed.status !== 303) throw new Error(`the trial claim link did not sign in: ${redeemed.status}`);
      const me = await owner.json<{ user: { id: string } }>("/app/me");
      return { userId: me.user.id };
    },
    async approvePairing(owner, userCode) {
      const approved = await owner.fetch(`/app/activations/${encodeURIComponent(userCode)}`, {
        method: "POST",
        body: JSON.stringify({ action: "approve" }),
      });
      if (!approved.ok) throw new Error(`pairing approval failed: ${approved.status}`);
    },
    async stop() {
      await control.close();
    },
  };
}
