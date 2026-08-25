import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface ReleaseService {
  origin: string;
  close(): Promise<void>;
  setAppManifest(version: string): void;
  setComponent(
    component: { version: string; bytes: Buffer; identity: ComponentIdentity; channel?: string } | null,
  ): void;
}

async function startReleaseService(): Promise<ReleaseService> {
  let appManifest: Record<string, unknown> | null = null;
  let component: { version: string; bytes: Buffer; identity: ComponentIdentity; channel?: string } | null =
    null;
  const server: Server = createServer((req, res) => {
    if (req.url === "/app/latest.json" && appManifest) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(appManifest));
      return;
    }
    if (req.url === "/component/latest.json" && component) {
      const sha256 = createHash("sha256").update(component.bytes).digest("hex");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          schema: "genehub.release-manifest.v2",
          channel: component.channel ?? "local",
          releaseVersion: component.version,
          appAbiHash: component.identity.appAbiHash,
          webProtocol: component.identity.webProtocol,
          artifact: {
            sources: [{ url: `${origin}/component/genehub_guest.wasm` }],
            sha256,
            size: component.bytes.length,
          },
          source: { kind: "test" },
          activation: { enabled: true },
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
      appManifest = { version, page: `https://example.test/releases/tag/v${version}`, platforms: {} };
    },
    setComponent(next) {
      component = next;
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
