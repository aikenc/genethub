import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Client } from "@genehub/workbench/client";

import {
  BlockedError,
  defineSpecialty,
  locateGenet,
  tryLocateDaemonComponent,
  tryLocateHost,
  type CaseContext,
} from "../../framework/public.ts";
import { connectProductClient } from "../../framework/drivers/client.ts";
import { daemonEndpoint, startDaemon, type DaemonHandle } from "../../framework/drivers/daemon.ts";

// The release flow is a chain of separately-built artifacts — the App's own
// version, the signed component's envelope version, the App manifest the
// daemon reads, and the component manifest the host reads. These cases run
// the real daemon against a loopback release service so a drift between any
// two links fails here instead of in a person's settings page.

const APP_VERSION = "0.7.0-beta.3";
const COMPONENT_VERSION = "0.7.0-beta.4";
const NEXT_COMPONENT_VERSION = "0.7.0-beta.5";

function build(openRoot: string, args: string[]): void {
  const result = spawnSync("cargo", args, { cwd: openRoot, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new BlockedError(`cargo ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function requireArtifacts(openRoot: string): { genet: string; host: string; guest: string } {
  let host = tryLocateHost(openRoot);
  let guest = tryLocateDaemonComponent(openRoot);
  if (!guest) {
    build(openRoot, ["build", "--profile", "iterate", "-p", "genehub-guest", "--target", "wasm32-wasip2"]);
    guest = tryLocateDaemonComponent(openRoot);
  }
  if (!host) {
    build(openRoot, ["build", "--profile", "iterate", "-p", "genehub-host", "--bin", "genehub-host-local"]);
    host = tryLocateHost(openRoot);
  }
  const genet = locateGenet(openRoot);
  if (!host || !guest) throw new BlockedError("genehub-host-local or genehub_guest.wasm missing after build");
  return { genet, host, guest };
}

function packComponent(host: string, rawWasm: string, version: string, outDir: string): string {
  const out = path.join(outDir, `genehub_guest-${version}.wasm`);
  const result = spawnSync(host, ["pack", rawWasm, out, "local", version], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`host pack ${version} failed: ${result.stderr || result.stdout}`);
  return out;
}

interface ComponentIdentity {
  appAbiHash: string;
  webProtocol: number;
}

interface ComponentSpec {
  version: string;
  bytes: Buffer;
  identity: ComponentIdentity;
  channel?: string;
  /** Defaults to enabled; a paused channel refuses downloads with the reason. */
  activation?: { enabled: boolean; pausedReason?: string };
  /** Overrides the manifest's releaseVersion, letting it disagree with the
   * envelope inside `bytes`. */
  manifestVersion?: string;
  /** Overrides the manifest's artifact digest, letting it disagree with the
   * bytes actually served. */
  sha256?: string;
}

interface ReleaseService {
  origin: string;
  close(): Promise<void>;
  setAppManifest(version: string): void;
  /** Serves a verbatim body (or 404s on null) so malformed answers are
   * testable too. */
  setAppManifestRaw(body: string | null): void;
  setComponent(component: ComponentSpec | null): void;
  setComponentRaw(body: string | null): void;
}

async function startReleaseService(): Promise<ReleaseService> {
  let appManifest: string | null = null;
  let component: ComponentSpec | null = null;
  let componentRaw: string | null = null;
  const server: Server = createServer((req, res) => {
    if (req.url === "/app/latest.json" && appManifest) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(appManifest);
      return;
    }
    if (req.url === "/component/latest.json" && componentRaw) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(componentRaw);
      return;
    }
    if (req.url === "/component/latest.json" && component) {
      const sha256 = component.sha256 ?? createHash("sha256").update(component.bytes).digest("hex");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          schema: "genehub.release-manifest.v2",
          channel: component.channel ?? "local",
          releaseVersion: component.manifestVersion ?? component.version,
          appAbiHash: component.identity.appAbiHash,
          webProtocol: component.identity.webProtocol,
          artifact: {
            sources: [{ url: `${origin}/component/genehub_guest.wasm` }],
            sha256,
            size: component.bytes.length,
          },
          source: { kind: "test" },
          activation: component.activation?.enabled === false
            ? { enabled: false, pausedReason: component.activation.pausedReason ?? "paused" }
            : { enabled: true },
        }),
      );
      return;
    }
    if (req.url === "/component/genehub_guest.wasm" && component) {
      res.writeHead(200, { "content-type": "application/wasm" });
      res.end(component.bytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("release service has no port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setAppManifest(version: string) {
      appManifest = JSON.stringify({
        version,
        page: `https://example.test/releases/tag/v${version}`,
        platforms: {},
      });
    },
    setAppManifestRaw(body: string | null) {
      appManifest = body;
    },
    setComponent(next) {
      component = next;
      componentRaw = null;
    },
    setComponentRaw(body: string | null) {
      componentRaw = body;
      component = null;
    },
  };
}

async function startReleaseDaemon(
  t: CaseContext,
  opts: {
    wasm?: string;
    env?: Record<string, string>;
    config?: Record<string, unknown>;
  },
): Promise<{ client: Client; daemon: DaemonHandle }> {
  if (opts.config) {
    writeFileSync(path.join(t.env.data, "config.json"), JSON.stringify(opts.config));
  }
  Object.assign(t.env.env, opts.env ?? {});
  const daemon = startDaemon({ genet: locateGenet(t.openRoot), wasm: opts.wasm, lease: t.env });
  try {
    const client = await connectProductClient({
      ...daemonEndpoint(daemon),
      redial: async () => daemonEndpoint(daemon),
    });
    return { client, daemon };
  } finally {
    if (!daemon) throw new Error("unreachable");
  }
}

async function stopReleaseDaemon(handle: { client: Client; daemon: DaemonHandle }): Promise<void> {
  handle.client.close();
  handle.daemon.stop();
}

function meta(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  expectedDurationMs = 60_000,
  timeoutMs = 180_000,
) {
  return {
    id,
    title,
    oracle,
    catches,
    tags: ["core", "release", "version-flow"],
    llm: { default: "none" as const },
    expectedDurationMs,
    timeoutMs,
    resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "heavy" as const },
    surfaces: ["daemon", "genehub-host", "release-service"],
    productInterfaces: ["daemon-protocol", "genehub-host"],
  };
}

defineSpecialty(
  meta(
    "specialty.release.app-check-clean-status",
    "A successful App update check reports no problem",
    "update.appCheck against a reachable manifest answers newer/latest and a null problem",
    [
      "a successful check still carries the auto-update-disabled nag as a problem",
      "the workbench shows every healthy check as a failure",
    ],
  ),
  async (t) => {
    const service = await startReleaseService();
    service.setAppManifest("0.9.0");
    try {
      const { guest } = requireArtifacts(t.openRoot);
      const handle = await startReleaseDaemon(t, {
        wasm: guest,
        config: { updateManifestUrl: `${service.origin}/app/latest.json` },
      });
      try {
        const reply = await handle.client.call({ type: "update.appCheck" });
        t.assertions.assert(reply?.type === "update", `appCheck answered ${reply?.type}`);
        if (reply?.type !== "update") return;
        t.assertions.assert(
          reply.data.problem === null || reply.data.problem === undefined,
          `a healthy check reported a problem: ${reply.data.problem}`,
        );
        t.assertions.assert(reply.data.latest === "0.9.0", `latest was ${reply.data.latest}`);
        // A source build (0.0.0) never compares itself against releases.
        t.assertions.assert(reply.data.newer === false, "a 0.0.0 build claimed an upgrade");
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.component-version-reaches-daemon",
    "A signed component's release version is what the daemon reports",
    "packing the guest as 0.7.0-beta.4 makes the hello handshake's daemonVersion 0.7.0-beta.4",
    [
      "the daemon reports its own crate version instead of the component envelope version",
      "a Live release ships and the settings page still shows the old version",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    try {
      const signed = packComponent(host, guest, COMPONENT_VERSION, dir);
      const handle = await startReleaseDaemon(t, { wasm: signed });
      try {
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `daemon reported ${handle.client.identity?.daemonVersion}, expected ${COMPONENT_VERSION}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.app-check-uses-app-version",
    "The App update check compares the App's version, not the component's",
    "with App 0.7.0-beta.3 and component 0.7.0-beta.4 installed, a 0.8.0 manifest answers current 0.7.0-beta.3 and newer true",
    [
      "the guest compares its own component version against the App manifest",
      "a Live-updated machine never learns that its App is behind",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    service.setAppManifest("0.8.0");
    try {
      const signed = packComponent(host, guest, COMPONENT_VERSION, dir);
      const handle = await startReleaseDaemon(t, {
        wasm: signed,
        env: { GENEHUB_APP_VERSION: APP_VERSION },
        config: { updateManifestUrl: `${service.origin}/app/latest.json` },
      });
      try {
        // The component version is what a person sees as the daemon's version…
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `daemon reported ${handle.client.identity?.daemonVersion}, expected ${COMPONENT_VERSION}`,
        );
        const reply = await handle.client.call({ type: "update.appCheck" });
        t.assertions.assert(reply?.type === "update", `appCheck answered ${reply?.type}`);
        if (reply?.type !== "update") return;
        // …but the App check answers about the App.
        t.assertions.assert(
          reply.data.current === APP_VERSION,
          `appCheck current was ${reply.data.current}, expected the App version ${APP_VERSION}`,
        );
        t.assertions.assert(reply.data.latest === "0.8.0", `latest was ${reply.data.latest}`);
        t.assertions.assert(
          reply.data.newer === true,
          `App ${APP_VERSION} did not see 0.8.0 as newer`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-full-chain",
    "A published component is discovered, verified, staged, and live-reloaded",
    "check finds 0.7.0-beta.5, download applies it, and the reloaded daemon reports 0.7.0-beta.5",
    [
      "manifest discovery, signature, ABI, or version gates silently disagree",
      "the store stages but the running daemon never picks the candidate up",
      "a Live release requires an App reinstall to take effect",
    ],
    120_000,
    300_000,
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedNext = packComponent(host, guest, NEXT_COMPONENT_VERSION, dir);
      const identity = readComponentIdentity(host, signedCurrent);
      service.setComponent({
        version: COMPONENT_VERSION,
        bytes: readFileSync(signedCurrent),
        identity,
      });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `daemon started on ${handle.client.identity?.daemonVersion}`,
        );
        // Publish the next Live release while the daemon runs.
        service.setComponent({
          version: NEXT_COMPONENT_VERSION,
          bytes: readFileSync(signedNext),
          identity,
        });
        const check = await handle.client.call({ type: "update.check" });
        t.assertions.assert(check?.type === "update", `update.check answered ${check?.type}`);
        if (check?.type !== "update") return;
        t.assertions.assert(check.data.newer === true, `check did not see ${NEXT_COMPONENT_VERSION}`);
        t.assertions.assert(
          check.data.latest === NEXT_COMPONENT_VERSION,
          `latest was ${check.data.latest}`,
        );
        const download = await handle.client.call({ type: "update.download" });
        t.assertions.assert(
          download?.type === "updateDownload",
          `update.download answered ${download?.type}: ${JSON.stringify(download)?.slice(0, 300)}`,
        );
        await waitForDaemonVersion(handle.client, NEXT_COMPONENT_VERSION);
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-rejects-rollback",
    "A manifest pointing backwards never replaces the running component",
    "with 0.7.0-beta.4 running, a 0.7.0-beta.3 manifest answers newer false and download fails",
    [
      "the high-water mark regresses",
      "a stale mirror serves an old manifest and machines downgrade",
    ],
    120_000,
    300_000,
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedOlder = packComponent(host, guest, "0.7.0-beta.3", dir);
      const identity = readComponentIdentity(host, signedCurrent);
      service.setComponent({
        version: "0.7.0-beta.3",
        bytes: readFileSync(signedOlder),
        identity,
      });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        const check = await handle.client.call({ type: "update.check" });
        t.assertions.assert(check?.type === "update", `update.check answered ${check?.type}`);
        if (check?.type !== "update") return;
        t.assertions.assert(check.data.newer === false, "a rollback looked newer");
        let refused = false;
        try {
          await handle.client.call({ type: "update.download" });
        } catch {
          refused = true;
        }
        t.assertions.assert(refused, "a rollback download was accepted");
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `daemon moved to ${handle.client.identity?.daemonVersion}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-rejects-foreign-abi",
    "A component built for another App ABI is refused with a clear answer",
    "a manifest naming a different appAbiHash fails download and the daemon stays on its version",
    [
      "the ABI gate is bypassed and the host loads an incompatible component",
      "the refusal loses the 'needs a new App' explanation",
    ],
    120_000,
    300_000,
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedNext = packComponent(host, guest, NEXT_COMPONENT_VERSION, dir);
      service.setComponent({
        version: NEXT_COMPONENT_VERSION,
        bytes: readFileSync(signedNext),
        identity: { appAbiHash: "0".repeat(64), webProtocol: 3 },
      });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        let refused = false;
        try {
          await handle.client.call({ type: "update.download" });
        } catch {
          refused = true;
        }
        t.assertions.assert(refused, "a foreign-ABI download was accepted");
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `daemon moved to ${handle.client.identity?.daemonVersion}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.channel-mismatch-rejected",
    "Another channel's manifest is never applied to this build",
    "a beta component manifest answers a local build with newer false and a channel problem",
    [
      "a beta machine applies a stable manifest, or the other way around",
      "the channel gate is checked only at download, after the UI already offered the update",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signed = packComponent(host, guest, COMPONENT_VERSION, dir);
      const identity = readComponentIdentity(host, signed);
      service.setComponent({
        version: NEXT_COMPONENT_VERSION,
        bytes: readFileSync(signed),
        identity,
        channel: "beta",
      });
      const handle = await startReleaseDaemon(t, {
        wasm: signed,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        const check = await handle.client.call({ type: "update.check" });
        t.assertions.assert(check?.type === "update", `update.check answered ${check?.type}`);
        if (check?.type !== "update") return;
        t.assertions.assert(check.data.newer === false, "a foreign channel looked newer");
        t.assertions.assert(
          typeof check.data.problem === "string" && check.data.problem.includes("不属于这个通道"),
          `a foreign channel manifest reported: ${check.data.problem}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.consecutive-live-updates",
    "Two Live releases in a row both take effect on one running machine",
    "0.7.0-beta.4 applies beta.5, then applies beta.6, and the daemon reports beta.6",
    [
      "the high-water mark advances once and then sticks",
      "the store accumulates candidates until apply fails",
      "the second reload reuses a stale component",
    ],
    180_000,
    420_000,
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signed4 = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signed5 = packComponent(host, guest, NEXT_COMPONENT_VERSION, dir);
      const signed6 = packComponent(host, guest, "0.7.0-beta.6", dir);
      const identity = readComponentIdentity(host, signed4);
      service.setComponent({ version: COMPONENT_VERSION, bytes: readFileSync(signed4), identity });
      const handle = await startReleaseDaemon(t, {
        wasm: signed4,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        for (const [version, file] of [
          [NEXT_COMPONENT_VERSION, signed5],
          ["0.7.0-beta.6", signed6],
        ] as const) {
          service.setComponent({ version, bytes: readFileSync(file), identity });
          const check = await handle.client.call({ type: "update.check" });
          t.assertions.assert(check?.type === "update" && check.data.newer === true, `no path to ${version}`);
          await handle.client.call({ type: "update.download" });
          await waitForDaemonVersion(handle.client, version);
        }
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.app-check-survives-live-update",
    "A Live update never moves the App version the App check compares",
    "after live-updating the component to 0.7.0-beta.5, appCheck still answers current 0.7.0-beta.3 and newer true against a 0.8.0 manifest",
    [
      "the component version leaks into the App comparison after a reload",
      "a Live-updated machine stops hearing about App releases",
    ],
    180_000,
    420_000,
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    service.setAppManifest("0.8.0");
    try {
      const signed4 = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signed5 = packComponent(host, guest, NEXT_COMPONENT_VERSION, dir);
      const identity = readComponentIdentity(host, signed4);
      service.setComponent({ version: NEXT_COMPONENT_VERSION, bytes: readFileSync(signed5), identity });
      const handle = await startReleaseDaemon(t, {
        wasm: signed4,
        env: {
          GENEHUB_APP_VERSION: APP_VERSION,
          GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json`,
        },
        config: { updateManifestUrl: `${service.origin}/app/latest.json` },
      });
      try {
        await handle.client.call({ type: "update.download" });
        await waitForDaemonVersion(handle.client, NEXT_COMPONENT_VERSION);
        const reply = await handle.client.call({ type: "update.appCheck" });
        t.assertions.assert(reply?.type === "update", `appCheck answered ${reply?.type}`);
        if (reply?.type !== "update") return;
        t.assertions.assert(
          reply.data.current === APP_VERSION,
          `after a Live update appCheck current was ${reply.data.current}, expected ${APP_VERSION}`,
        );
        t.assertions.assert(reply.data.newer === true, "the App check lost the 0.8.0 release");
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.high-water-survives-restart",
    "A restarted daemon keeps the Live update and still refuses a rollback",
    "after applying beta.5 and restarting, the daemon runs beta.5 and a beta.4 manifest is refused",
    [
      "the activation store is only consulted on the first boot",
      "a restart silently reverts to the bundled component",
      "the persisted high-water mark is lost with the process",
    ],
    180_000,
    420_000,
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signed4 = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signed5 = packComponent(host, guest, NEXT_COMPONENT_VERSION, dir);
      const identity = readComponentIdentity(host, signed4);
      service.setComponent({ version: NEXT_COMPONENT_VERSION, bytes: readFileSync(signed5), identity });
      const env = { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` };
      const first = await startReleaseDaemon(t, { wasm: signed4, env });
      try {
        await first.client.call({ type: "update.download" });
        await waitForDaemonVersion(first.client, NEXT_COMPONENT_VERSION);
      } finally {
        await stopReleaseDaemon(first);
      }
      // The release service points backwards, and the machine must not follow.
      service.setComponent({ version: COMPONENT_VERSION, bytes: readFileSync(signed4), identity });
      const second = await startReleaseDaemon(t, { wasm: signed4, env });
      try {
        t.assertions.assert(
          second.client.identity?.daemonVersion === NEXT_COMPONENT_VERSION,
          `after restart the daemon ran ${second.client.identity?.daemonVersion}, expected ${NEXT_COMPONENT_VERSION}`,
        );
        const check = await second.client.call({ type: "update.check" });
        t.assertions.assert(check?.type === "update" && check.data.newer === false, "a rollback looked newer");
        let refused = false;
        try {
          await second.client.call({ type: "update.download" });
        } catch {
          refused = true;
        }
        t.assertions.assert(refused, "a rollback download was accepted after restart");
      } finally {
        await stopReleaseDaemon(second);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.app-check-prerelease-ordering",
    "A beta App hears about its stable successor",
    "with App 0.8.0-beta.1 installed, a 0.8.0 manifest answers newer true",
    [
      "the App checker's version comparison truncates the prerelease and calls 0.8.0-beta.1 equal to 0.8.0",
      "beta machines never learn the stable line shipped",
    ],
  ),
  async (t) => {
    const service = await startReleaseService();
    service.setAppManifest("0.8.0");
    try {
      const { guest } = requireArtifacts(t.openRoot);
      const handle = await startReleaseDaemon(t, {
        wasm: guest,
        env: { GENEHUB_APP_VERSION: "0.8.0-beta.1" },
        config: { updateManifestUrl: `${service.origin}/app/latest.json` },
      });
      try {
        const reply = await handle.client.call({ type: "update.appCheck" });
        t.assertions.assert(reply?.type === "update", `appCheck answered ${reply?.type}`);
        if (reply?.type !== "update") return;
        t.assertions.assert(reply.data.current === "0.8.0-beta.1", `current was ${reply.data.current}`);
        t.assertions.assert(
          reply.data.newer === true,
          "0.8.0-beta.1 did not see 0.8.0 as newer — the prerelease was truncated away",
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
    }
  },
);

function readComponentIdentity(host: string, signed: string): ComponentIdentity {
  const result = spawnSync(host, ["inspect", signed], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`host inspect failed: ${result.stderr || result.stdout}`);
  const identity = JSON.parse(result.stdout) as { appAbiHash?: string; webProtocol?: number };
  if (!identity.appAbiHash || !identity.webProtocol) {
    throw new Error(`host inspect did not report identity: ${result.stdout.slice(0, 200)}`);
  }
  return { appAbiHash: identity.appAbiHash, webProtocol: identity.webProtocol };
}

/** The durable update store, laid out by hand so a case can start the daemon
 * on top of a crash-shaped state. */
function plantStore(
  t: CaseContext,
  layout: { active?: string; candidate?: string; highest?: string },
): void {
  const root = path.join(t.env.data, "component");
  mkdirSync(root, { recursive: true });
  if (layout.active) cpSync(layout.active, path.join(root, "active.wasm"));
  if (layout.candidate) cpSync(layout.candidate, path.join(root, "candidate.wasm"));
  if (layout.highest) writeFileSync(path.join(root, "highest-version"), `${layout.highest}\n`);
}

/** A signed file whose component bytes were flipped after signing: the
 * envelope still parses, but the signature no longer covers the payload. */
function tamperComponent(signed: string, outDir: string): Buffer {
  const bytes = Buffer.from(readFileSync(signed));
  bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 0xff;
  writeFileSync(path.join(outDir, "tampered.wasm"), bytes);
  return bytes;
}

defineSpecialty(
  meta(
    "specialty.release.live-update-rejects-paused-channel",
    "A paused channel refuses the download and says why",
    "activation.enabled false fails update.download with the pause reason and the daemon stays put",
    [
      "a paused channel still pushes the staged component to machines",
      "the pause reason never reaches the operator",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedNext = packComponent(host, guest, "0.7.0-beta.5", dir);
      const identity = readComponentIdentity(host, signedCurrent);
      service.setComponent({
        version: "0.7.0-beta.5",
        bytes: readFileSync(signedNext),
        identity,
        activation: { enabled: false, pausedReason: "beta.5 回滚中,通道暂停" },
      });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        let refused: unknown = null;
        try {
          await handle.client.call({ type: "update.download" });
        } catch (error) {
          refused = error;
        }
        t.assertions.assert(refused !== null, "a paused channel's download was accepted");
        t.assertions.assert(
          String(refused).includes("回滚中"),
          `the pause reason did not reach the caller: ${String(refused).slice(0, 120)}`,
        );
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `daemon moved to ${handle.client.identity?.daemonVersion}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-rejects-corrupted-download",
    "Bytes that do not match the manifest digest never reach the store",
    "a manifest whose sha256 disagrees with the served bytes fails update.download",
    [
      "transport corruption is staged as a valid component",
      "the digest check compares the wrong scale and honest downloads die here",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedNext = packComponent(host, guest, "0.7.0-beta.5", dir);
      const identity = readComponentIdentity(host, signedCurrent);
      service.setComponent({
        version: "0.7.0-beta.5",
        bytes: readFileSync(signedNext),
        identity,
        sha256: createHash("sha256").update("not the served bytes").digest("hex"),
      });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        let refused: unknown = null;
        try {
          await handle.client.call({ type: "update.download" });
        } catch (error) {
          refused = error;
        }
        t.assertions.assert(refused !== null, "a corrupted download was accepted");
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `daemon moved to ${handle.client.identity?.daemonVersion}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-rejects-tampered-component",
    "A component modified after signing fails verification",
    "bytes whose envelope parses but whose payload no longer matches the signature fail update.download",
    [
      "signature verification is skipped when the envelope parses",
      "a tampered component replaces the running one",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedNext = packComponent(host, guest, "0.7.0-beta.5", dir);
      const identity = readComponentIdentity(host, signedCurrent);
      // The manifest digest matches the tampered bytes, so the transport
      // check passes and only the signature can catch this.
      const tampered = tamperComponent(signedNext, dir);
      service.setComponent({ version: "0.7.0-beta.5", bytes: tampered, identity });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        let refused: unknown = null;
        try {
          await handle.client.call({ type: "update.download" });
        } catch (error) {
          refused = error;
        }
        t.assertions.assert(refused !== null, "a tampered component was accepted");
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `daemon moved to ${handle.client.identity?.daemonVersion}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-rejects-envelope-mismatch",
    "A manifest naming one version while serving another is refused",
    "releaseVersion 0.7.0-beta.6 in the manifest with a 0.7.0-beta.5 envelope fails update.download",
    [
      "the manifest's identity fields are trusted over the signed envelope's",
      "a mislabelled release installs the wrong component",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedNext = packComponent(host, guest, "0.7.0-beta.5", dir);
      const identity = readComponentIdentity(host, signedCurrent);
      service.setComponent({
        version: "0.7.0-beta.5",
        manifestVersion: "0.7.0-beta.6",
        bytes: readFileSync(signedNext),
        identity,
      });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        let refused: unknown = null;
        try {
          await handle.client.call({ type: "update.download" });
        } catch (error) {
          refused = error;
        }
        t.assertions.assert(refused !== null, "a mislabelled manifest was accepted");
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `daemon moved to ${handle.client.identity?.daemonVersion}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-rejects-noncanonical-version",
    "A manifest with a non-canonical version is not an update",
    "releaseVersion 1.2 answers check with newer false and fails update.download",
    [
      "a malformed version is parsed leniently and ordered wrongly",
      "the download path accepts what the check path rejected",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedNext = packComponent(host, guest, "0.7.0-beta.5", dir);
      const identity = readComponentIdentity(host, signedCurrent);
      service.setComponent({
        version: "0.7.0-beta.5",
        manifestVersion: "1.2",
        bytes: readFileSync(signedNext),
        identity,
      });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        const check = await handle.client.call({ type: "update.check" });
        t.assertions.assert(check?.type === "update", `update.check answered ${check?.type}`);
        if (check?.type === "update") {
          t.assertions.assert(check.data.newer === false, "a non-canonical version looked newer");
        }
        let refused: unknown = null;
        try {
          await handle.client.call({ type: "update.download" });
        } catch (error) {
          refused = error;
        }
        t.assertions.assert(refused !== null, "a non-canonical version was downloaded");
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-unreachable-manifest",
    "A missing manifest is a problem answer, not a crash",
    "a 404 component manifest answers update.check with a problem and the daemon keeps serving",
    [
      "a fetch failure kills the daemon or wedges the update state",
      "the problem is reported as success with no update",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      // Nothing is served: every manifest request is a 404.
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        const check = await handle.client.call({ type: "update.check" });
        t.assertions.assert(check?.type === "update", `update.check answered ${check?.type}`);
        if (check?.type !== "update") return;
        t.assertions.assert(
          typeof check.data.problem === "string" && check.data.problem.length > 0,
          `a 404 manifest reported no problem: ${JSON.stringify(check.data)}`,
        );
        t.assertions.assert(check.data.newer === false, "a missing manifest looked newer");
        const state = await handle.client.call({ type: "update.downloadState" });
        t.assertions.assert(
          state?.type === "updateDownload",
          "the daemon stopped serving after the 404",
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-rejects-malformed-manifest",
    "A malformed manifest body is a problem answer, not a crash",
    "a non-JSON component manifest answers update.check with a problem and the daemon keeps serving",
    ["a parse failure kills the daemon", "the parse failure is reported as an empty update"],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      service.setComponentRaw("this is not json");
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        const check = await handle.client.call({ type: "update.check" });
        t.assertions.assert(check?.type === "update", `update.check answered ${check?.type}`);
        if (check?.type !== "update") return;
        t.assertions.assert(
          typeof check.data.problem === "string" && check.data.problem.length > 0,
          `a malformed manifest reported no problem: ${JSON.stringify(check.data)}`,
        );
        t.assertions.assert(check.data.newer === false, "a malformed manifest looked newer");
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.live-update-recovers-interrupted-commit",
    "A crash between the high-water mark and the commit still lands the update",
    "a store holding highest 0.7.0-beta.5 with the candidate staged boots the daemon on 0.7.0-beta.5",
    [
      "the interrupted commit is forgotten and the machine stays on the old component",
      "the half-committed store wedges every later update",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedNext = packComponent(host, guest, "0.7.0-beta.5", dir);
      // The crash shape: the fence advanced and the candidate is staged, but
      // candidate -> active never happened.
      plantStore(t, {
        active: signedCurrent,
        candidate: signedNext,
        highest: "0.7.0-beta.5",
      });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        t.assertions.assert(
          handle.client.identity?.daemonVersion === "0.7.0-beta.5",
          `the interrupted commit recovered as ${handle.client.identity?.daemonVersion}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.bundled-baseline-fences-stale-active",
    "An App upgrade outranking the downloaded component runs the bundled one",
    "with the store active on 0.7.0-beta.4 and the App bundling 0.7.0-beta.5, the daemon runs 0.7.0-beta.5",
    [
      "a stale download keeps running after the App shipped a newer component",
      "the bundled baseline is ignored once any download exists",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      const signedNext = packComponent(host, guest, "0.7.0-beta.5", dir);
      plantStore(t, { active: signedCurrent, highest: COMPONENT_VERSION });
      const handle = await startReleaseDaemon(t, {
        wasm: signedNext,
        env: {
          GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json`,
          GENEHUB_BUNDLED_RELEASE_VERSION: "0.7.0-beta.5",
        },
      });
      try {
        t.assertions.assert(
          handle.client.identity?.daemonVersion === "0.7.0-beta.5",
          `the stale store active won over the bundled baseline: ${handle.client.identity?.daemonVersion}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.app-upgrade-fences-foreign-abi-component",
    "An App upgrade fences the downloaded component from the old ABI generation",
    "with the store active signed for another App ABI, the daemon boots on the bundled component instead of failing",
    [
      "a stored component from the old App generation makes the upgraded App unable to start",
      "the ABI fence is bypassed and an incompatible component is instantiated",
    ],
  ),
  async (t) => {
    const { host, guest } = requireArtifacts(t.openRoot);
    const dir = mkdtempSync(path.join(tmpdir(), "genehub-release-pack-"));
    const service = await startReleaseService();
    try {
      const signedCurrent = packComponent(host, guest, COMPONENT_VERSION, dir);
      // A component from another App generation: honestly signed, but its
      // envelope names an ABI digest this host was not built for.
      const foreignAbi = "f".repeat(64);
      const signedForeign = path.join(dir, "genehub_guest-foreign.wasm");
      const packed = spawnSync(
        host,
        ["pack", guest, signedForeign, "local", "0.7.0-beta.5"],
        { encoding: "utf8", env: { ...process.env, GENEHUB_ABI_DIGEST: foreignAbi } },
      );
      if (packed.status !== 0) throw new Error(`pack foreign-abi failed: ${packed.stderr}`);
      plantStore(t, { active: signedForeign, highest: "0.7.0-beta.5" });
      const handle = await startReleaseDaemon(t, {
        wasm: signedCurrent,
        env: { GENEHUB_COMPONENT_MANIFEST_URL: `${service.origin}/component/latest.json` },
      });
      try {
        t.assertions.assert(
          handle.client.identity?.daemonVersion === COMPONENT_VERSION,
          `the foreign-ABI active was not fenced: ${handle.client.identity?.daemonVersion}`,
        );
        const storeFiles = readdirSync(path.join(t.env.data, "component"));
        t.assertions.assert(
          !storeFiles.includes("active.wasm"),
          `the fenced active was not discarded: ${storeFiles}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.local-default-has-no-update-source",
    "A source build without any injection is off every release scale",
    "with no manifest URLs configured, update.check and update.appCheck answer not-on-the-scale and update.download refuses",
    [
      "a local build silently dials a release feed and lets a published component replace the checkout",
      "the no-source answer reads as a network failure instead of a deliberate stance",
    ],
  ),
  async (t) => {
    const { guest } = requireArtifacts(t.openRoot);
    // No GENEHUB_COMPONENT_MANIFEST_URL, no updateManifestUrl: the defaults a
    // plain `cargo build` runs with.
    const handle = await startReleaseDaemon(t, { wasm: guest });
    try {
      const check = await handle.client.call({ type: "update.check" });
      t.assertions.assert(check?.type === "update", `update.check answered ${check?.type}`);
      if (check?.type === "update") {
        t.assertions.assert(check.data.newer === false, "a source build looked outdated");
        t.assertions.assert(
          check.data.problem?.includes("没有签名组件更新源") ?? false,
          `the no-source stance read as: ${check.data.problem}`,
        );
      }
      const appCheck = await handle.client.call({ type: "update.appCheck" });
      t.assertions.assert(appCheck?.type === "update", `appCheck answered ${appCheck?.type}`);
      if (appCheck?.type === "update") {
        t.assertions.assert(appCheck.data.newer === false, "a source build's App looked outdated");
      }
      let refused: unknown = null;
      try {
        await handle.client.call({ type: "update.download" });
      } catch (error) {
        refused = error;
      }
      t.assertions.assert(refused !== null, "a source build accepted a component download");
    } finally {
      await stopReleaseDaemon(handle);
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.app-check-reports-newer-with-url",
    "An available App update carries its version and release page",
    "with App 0.8.0 installed, a 0.9.0 manifest answers newer true with latest 0.9.0 and the page URL",
    [
      "the newer flag arrives without the version or the link, and the UI cannot render the answer",
      "the release page URL is built from the wrong field",
    ],
  ),
  async (t) => {
    const service = await startReleaseService();
    service.setAppManifest("0.9.0");
    try {
      const { guest } = requireArtifacts(t.openRoot);
      const handle = await startReleaseDaemon(t, {
        wasm: guest,
        env: { GENEHUB_APP_VERSION: "0.8.0" },
        config: { updateManifestUrl: `${service.origin}/app/latest.json` },
      });
      try {
        const reply = await handle.client.call({ type: "update.appCheck" });
        t.assertions.assert(reply?.type === "update", `appCheck answered ${reply?.type}`);
        if (reply?.type !== "update") return;
        t.assertions.assert(reply.data.newer === true, "0.9.0 did not look newer than 0.8.0");
        t.assertions.assert(reply.data.latest === "0.9.0", `latest was ${reply.data.latest}`);
        t.assertions.assert(
          reply.data.url === "https://example.test/releases/tag/v0.9.0",
          `the release page was ${reply.data.url}`,
        );
        t.assertions.assert(
          reply.data.problem === null || reply.data.problem === undefined,
          `a healthy newer answer carried a problem: ${reply.data.problem}`,
        );
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.app-check-unreachable-manifest",
    "An unreachable App manifest is a problem answer, not a crash",
    "an App manifest URL nothing listens on answers update.appCheck with a problem",
    [
      "a connection refusal kills the appCheck route",
      "the failure is reported as 'no update available'",
    ],
  ),
  async (t) => {
    const { guest } = requireArtifacts(t.openRoot);
    const handle = await startReleaseDaemon(t, {
      wasm: guest,
      // Nothing listens on port 1.
      config: { updateManifestUrl: "http://127.0.0.1:1/app/latest.json" },
    });
    try {
      const reply = await handle.client.call({ type: "update.appCheck" });
      t.assertions.assert(reply?.type === "update", `appCheck answered ${reply?.type}`);
      if (reply?.type !== "update") return;
      t.assertions.assert(
        typeof reply.data.problem === "string" && reply.data.problem.length > 0,
        `an unreachable manifest reported no problem: ${JSON.stringify(reply.data)}`,
      );
      t.assertions.assert(reply.data.newer === false, "an unreachable manifest looked newer");
    } finally {
      await stopReleaseDaemon(handle);
    }
  },
);

defineSpecialty(
  meta(
    "specialty.release.app-check-malformed-manifest",
    "A malformed App manifest is a problem answer, not a crash",
    "a non-JSON App manifest answers update.appCheck with a problem",
    ["a parse failure kills the appCheck route", "the failure is reported as 'already current'"],
  ),
  async (t) => {
    const service = await startReleaseService();
    service.setAppManifestRaw("this is not json");
    try {
      const { guest } = requireArtifacts(t.openRoot);
      const handle = await startReleaseDaemon(t, {
        wasm: guest,
        config: { updateManifestUrl: `${service.origin}/app/latest.json` },
      });
      try {
        const reply = await handle.client.call({ type: "update.appCheck" });
        t.assertions.assert(reply?.type === "update", `appCheck answered ${reply?.type}`);
        if (reply?.type !== "update") return;
        t.assertions.assert(
          typeof reply.data.problem === "string" && reply.data.problem.length > 0,
          `a malformed manifest reported no problem: ${JSON.stringify(reply.data)}`,
        );
        t.assertions.assert(reply.data.newer === false, "a malformed manifest looked newer");
      } finally {
        await stopReleaseDaemon(handle);
      }
    } finally {
      await service.close();
    }
  },
);


defineSpecialty(
  meta(
    "specialty.release.cli-start-without-data-dir-env",
    "A bare CLI start hands the guest the data directory it cannot discover",
    "with no GENEHUB_*_DATA_DIR in the environment the daemon still boots and lands its state under the platform data home",
    [
      "the CLI never sets the data-dir override and a WASI guest has no platform dirs to discover",
      "every test lease pre-sets the override, so the real CLI path can ship broken",
    ],
  ),
  async (t) => {
    requireArtifacts(t.openRoot);
    const daemon = startDaemon({
      genet: locateGenet(t.openRoot),
      lease: t.env,
      dropEnv: ["GENEHUB_LOCAL_DATA_DIR", "GENEHUB_DATA_DIR"],
    });
    try {
      const client = await connectProductClient({
        ...daemonEndpoint(daemon),
        redial: async () => daemonEndpoint(daemon),
      });
      try {
        t.assertions.assert(
          typeof client.identity?.daemonVersion === "string",
          `daemon never identified itself: ${JSON.stringify(client.identity)}`,
        );
      } finally {
        client.close();
      }
      const discovered = path.join(t.env.home, ".local", "share", "GeneHub-local");
      const found = spawnSync("find", [t.env.home, "-name", "endpoint.json"], { encoding: "utf8" })
        .stdout.trim();
      t.assertions.assert(
        existsSync(path.join(discovered, "endpoint.json")),
        `state did not land under the platform data home ${discovered}; endpoint.json found at: ${found || "nowhere"}`,
      );
    } finally {
      daemon.stop();
    }
  },
);


async function waitForDaemonVersion(client: Client, version: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (client.connectionState === "ready" && client.identity?.daemonVersion === version) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `daemon never came back on ${version}; identity is ${JSON.stringify(client.identity?.daemonVersion)}`,
  );
}
