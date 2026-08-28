import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  BlockedError,
  connectProductClient,
  daemonEndpoint,
  defineSpecialty,
  measureTcpTransfer,
  startRelay,
  startShapedTcpProxy,
  startTcpPayloadServer,
  tryLocateDaemonComponent,
  tryLocateHost,
  type CaseContext,
  type ClientDiagnosticEvent,
  type NetworkLinkProfile,
  type ShapedTcpProxyStats,
  type TcpPayloadServer,
  type TcpTransferSample,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type ProductClient = Opened["client"];

const MIB = 1024 * 1024;
const LINK_BANDWIDTH_MBPS = 100;
const DIRECT_TARGET_UTILIZATION = 0.85;
const RELAY_TARGET_UTILIZATION = 0.8;
// The product does not meet the target yet. This independent floor makes the
// baseline a regression guard without pretending the optimization is done.
const BASELINE_UTILIZATION_FLOOR = 0.1;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface FileFixture {
  name: string;
  sizeBytes: number;
  sha256: string;
}

interface ProductSample {
  elapsedMs: number;
  mibPerSec: number;
  productMs: number | null;
}

interface UtilizationSample {
  label: string;
  sizeMiB: number;
  clientRttMs: number;
  daemonRttMs: number;
  tcp: TcpTransferSample;
  product: ProductSample;
  utilization: number;
  line: string;
}

function requireWasmArtifacts(openRoot: string): void {
  const host = tryLocateHost(openRoot);
  const component = tryLocateDaemonComponent(openRoot);
  if (!host || !component) {
    throw new BlockedError(
      `wasm artifacts missing: host=${host ?? "no"} component=${component ?? "no"}`,
    );
  }
}

function neteffMeta(input: {
  id: string;
  title: string;
  oracle: string;
  catches: string[];
  relay?: boolean;
}) {
  return {
    id: input.id,
    title: input.title,
    oracle: input.oracle,
    catches: input.catches,
    tags: input.relay
      ? ["neteff", "performance", "connectivity", "wasm-guest", "relay"]
      : ["neteff", "performance", "connectivity", "wasm-guest"],
    llm: { default: "none" as const },
    expectedDurationMs: 20_000,
    timeoutMs: 90_000,
    resources: {
      environments: 1,
      cpu: 2,
      memoryMb: 1024,
      io: 1,
      browser: 0,
      pool: "heavy" as const,
    },
    surfaces: input.relay
      ? ["daemon", "relay", "workbench-client", "tcp-control"]
      : ["daemon", "workbench-client", "tcp-control"],
    productInterfaces: ["@genehub/workbench/client", "genet-cli"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
    retention: true,
  };
}

/** PNG magic + random body: exact image-sized payload through the real preview path. */
function seedImage(t: CaseContext, name: string, sizeBytes: number): FileFixture {
  const payload = Buffer.concat([PNG_MAGIC, randomBytes(sizeBytes - PNG_MAGIC.length)]);
  writeFileSync(path.join(t.env.workspace, name), payload);
  return {
    name,
    sizeBytes,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

class PreviewProbe {
  private readonly durationsMs: number[] = [];
  readonly onDiagnostic = (event: ClientDiagnosticEvent): void => {
    if (
      event.kind === "operation" &&
      event.detail.operation === "asset.preview" &&
      event.detail.phase === "finish"
    ) {
      this.durationsMs.push(Number(event.detail.durationMs));
    }
  };
  latestMs(): number | null {
    return this.durationsMs.at(-1) ?? null;
  }
}

async function measurePreview(
  t: CaseContext,
  input: {
    client: ProductClient;
    opened: Opened;
    file: FileFixture;
    probe: PreviewProbe;
  },
): Promise<ProductSample> {
  const began = performance.now();
  const body = await input.client.preview(
    input.opened.workspaceId,
    `${input.opened.rootHandle}/${input.file.name}`,
  );
  const elapsedMs = performance.now() - began;
  const sha256 = createHash("sha256").update(body.bytes).digest("hex");
  t.assertions.assert(
    body.bytes.byteLength === input.file.sizeBytes,
    `preview size ${body.bytes.byteLength} != ${input.file.sizeBytes}`,
  );
  t.assertions.assert(
    sha256 === input.file.sha256,
    `preview sha256 ${sha256} != source ${input.file.sha256}`,
  );
  const productMs = input.probe.latestMs();
  if (productMs !== null) {
    t.assertions.assert(
      Math.abs(productMs - elapsedMs) <= 250,
      `product diagnostic ${productMs}ms differs from observer ${elapsedMs.toFixed(0)}ms`,
    );
  }
  return {
    elapsedMs,
    mibPerSec: body.bytes.byteLength / MIB / (elapsedMs / 1000),
    productMs,
  };
}

function expectedTcpElapsedMs(sizeBytes: number, profile: NetworkLinkProfile): number {
  const serializationMs = (sizeBytes * 8) / (profile.bandwidthMbps * 1_000);
  return profile.rttMs + serializationMs;
}

function assertTcpControl(
  t: CaseContext,
  input: {
    label: string;
    sizeBytes: number;
    profile: NetworkLinkProfile;
    sample: TcpTransferSample;
    stats: ShapedTcpProxyStats[];
  },
): void {
  const expectedMs = expectedTcpElapsedMs(input.sizeBytes, input.profile);
  const lowerMs = expectedMs * 0.7;
  const upperMs = expectedMs * 1.8 + 100;
  t.assertions.assert(
    input.sample.elapsedMs >= lowerMs && input.sample.elapsedMs <= upperMs,
    `${input.label}: raw TCP ${input.sample.elapsedMs.toFixed(0)}ms is outside calibrated link range ${lowerMs.toFixed(0)}-${upperMs.toFixed(0)}ms (model ${expectedMs.toFixed(0)}ms)`,
  );
  for (const [index, stats] of input.stats.entries()) {
    t.assertions.assert(
      stats.targetToClientBytes >= input.sizeBytes,
      `${input.label}: TCP link ${index} carried only ${stats.targetToClientBytes} response bytes`,
    );
    t.assertions.assert(
      stats.peakQueuedBytes <= 64 * MIB,
      `${input.label}: TCP link ${index} exceeded its bounded queue`,
    );
  }
}

function recordUtilization(
  t: CaseContext,
  input: {
    label: string;
    file: FileFixture;
    clientRttMs: number;
    daemonRttMs: number;
    tcp: TcpTransferSample;
    product: ProductSample;
    productLinkStats: ShapedTcpProxyStats[];
    target: number;
  },
): UtilizationSample {
  const utilization = input.product.mibPerSec / input.tcp.mibPerSec;
  t.assertions.assert(
    utilization >= BASELINE_UTILIZATION_FLOOR,
    `${input.label}: GeneHub uses only ${(utilization * 100).toFixed(1)}% of same-link TCP, below the ${(BASELINE_UTILIZATION_FLOOR * 100).toFixed(0)}% regression floor`,
  );
  t.assertions.assert(
    utilization <= 1.25,
    `${input.label}: GeneHub/TCP utilization ${(utilization * 100).toFixed(1)}% is implausibly above 125%`,
  );
  for (const [index, stats] of input.productLinkStats.entries()) {
    t.assertions.assert(
      stats.targetToClientBytes + stats.clientToTargetBytes >= input.file.sizeBytes,
      `${input.label}: product link ${index} did not carry the preview payload`,
    );
  }
  const gapPp = (utilization - input.target) * 100;
  const line =
    `${input.label} size=${(input.file.sizeBytes / MIB).toFixed(0)}MiB` +
    ` tcpMs=${input.tcp.elapsedMs.toFixed(0)} tcpMiBps=${input.tcp.mibPerSec.toFixed(2)}` +
    ` genehubMs=${input.product.elapsedMs.toFixed(0)} genehubMiBps=${input.product.mibPerSec.toFixed(2)}` +
    ` bandwidthUtilization=${(utilization * 100).toFixed(1)}%` +
    ` target=${(input.target * 100).toFixed(0)}% gap=${gapPp.toFixed(1)}pp` +
    ` productMs=${input.product.productMs ?? "-"}`;
  return {
    label: input.label,
    sizeMiB: input.file.sizeBytes / MIB,
    clientRttMs: input.clientRttMs,
    daemonRttMs: input.daemonRttMs,
    tcp: input.tcp,
    product: input.product,
    utilization,
    line,
  };
}

function headline(label: string, samples: UtilizationSample[], target: number): string {
  const ladder = samples
    .map(
      (sample) =>
        `${sample.clientRttMs}+${sample.daemonRttMs}ms=${(sample.utilization * 100).toFixed(1)}%` +
        `（${(sample.product.elapsedMs / 1000).toFixed(1)}s vs TCP ${(sample.tcp.elapsedMs / 1000).toFixed(1)}s）`,
    )
    .join("；");
  const met = samples.every((sample) => sample.utilization >= target);
  return (
    `核心指标（同链路原始 TCP 带宽利用率；优化目标≥${(target * 100).toFixed(0)}%且不随 RTT 下滑）：` +
    `${ladder}。目标状态=${met ? "达到" : "未达到"}；` +
    `${label} 的通过只表示测量有效并守住现状下限，不代表网络优化完成。`
  );
}

async function connectLinkedDaemon(
  opened: Opened,
  proxy: { urlFor(url: string): string },
  name: string,
  probe: PreviewProbe,
): Promise<ProductClient> {
  const current = daemonEndpoint(opened.daemon);
  return connectProductClient({
    ...current,
    url: proxy.urlFor(current.url),
    name,
    onDiagnostic: probe.onDiagnostic,
    redial: async () => {
      const next = daemonEndpoint(opened.daemon);
      return { ...next, url: proxy.urlFor(next.url) };
    },
  });
}

async function measureRawOneLeg(
  t: CaseContext,
  server: TcpPayloadServer,
  profile: NetworkLinkProfile,
  label: string,
): Promise<TcpTransferSample> {
  const link = await startShapedTcpProxy({ targetUrl: server.url, profile });
  try {
    const sample = await measureTcpTransfer({
      url: link.urlFor(server.url),
      expectedBytes: server.sizeBytes,
      expectedSha256: server.sha256,
    });
    assertTcpControl(t, {
      label,
      sizeBytes: server.sizeBytes,
      profile,
      sample,
      stats: [link.stats()],
    });
    return sample;
  } finally {
    await link.stop();
  }
}

async function measureRawTwoLegs(
  t: CaseContext,
  server: TcpPayloadServer,
  input: { client: NetworkLinkProfile; daemon: NetworkLinkProfile; label: string },
): Promise<TcpTransferSample> {
  const daemonLink = await startShapedTcpProxy({ targetUrl: server.url, profile: input.daemon });
  const daemonUrl = daemonLink.urlFor(server.url);
  const clientLink = await startShapedTcpProxy({ targetUrl: daemonUrl, profile: input.client });
  try {
    const sample = await measureTcpTransfer({
      url: clientLink.urlFor(daemonUrl),
      expectedBytes: server.sizeBytes,
      expectedSha256: server.sha256,
    });
    assertTcpControl(t, {
      label: input.label,
      sizeBytes: server.sizeBytes,
      profile: {
        rttMs: input.client.rttMs + input.daemon.rttMs,
        bandwidthMbps: Math.min(input.client.bandwidthMbps, input.daemon.bandwidthMbps),
      },
      sample,
      stats: [clientLink.stats(), daemonLink.stats()],
    });
    return sample;
  } finally {
    await clientLink.stop();
    await daemonLink.stop();
  }
}

defineSpecialty(
  neteffMeta({
    id: "specialty.neteff.preview-direct-bandwidth-utilization",
    title: "Preview bandwidth utilization against a same-link raw TCP control",
    oracle:
      "each real-WASM preview is byte-identical, its shaped byte path is proven, and its useful goodput is divided by a calibrated raw-TCP transfer under the same RTT and bandwidth",
    catches: [
      "application credit feedback makes utilization collapse as RTT grows",
      "network injector falls off the real product or TCP control path",
      "preview bytes are truncated or corrupted under shaping",
      "transport throughput regresses below the recorded independent baseline floor",
    ],
  }),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const file = seedImage(t, "neteff-direct-8m.png", 8 * MIB);
    const rawServer = await startTcpPayloadServer(file.sizeBytes);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const samples: UtilizationSample[] = [];
    try {
      const endpoint = daemonEndpoint(opened.daemon);
      for (const rttMs of [0, 100, 200]) {
        const profile = { rttMs, bandwidthMbps: LINK_BANDWIDTH_MBPS };
        const tcp = await measureRawOneLeg(t, rawServer, profile, `direct tcp rtt=${rttMs}ms`);
        const productLink = await startShapedTcpProxy({ targetUrl: endpoint.url, profile });
        const probe = new PreviewProbe();
        let client: ProductClient | null = null;
        try {
          client = await connectLinkedDaemon(opened, productLink, `neteff-direct-${rttMs}ms`, probe);
          productLink.resetStats();
          const product = await measurePreview(t, { client, opened, file, probe });
          samples.push(
            recordUtilization(t, {
              label: `direct rtt=${rttMs}ms`,
              file,
              clientRttMs: rttMs,
              daemonRttMs: 0,
              tcp,
              product,
              productLinkStats: [productLink.stats()],
              target: DIRECT_TARGET_UTILIZATION,
            }),
          );
        } finally {
          client?.close();
          await productLink.stop();
        }
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
      await rawServer.stop();
    }
    t.note(
      `neteff preview-direct-bandwidth-utilization (daemon=wasm guest, link=${LINK_BANDWIDTH_MBPS}Mbps)\n` +
        `${headline("直连", samples, DIRECT_TARGET_UTILIZATION)}\n` +
        samples.map((sample) => sample.line).join("\n"),
    );
  },
);

defineSpecialty(
  neteffMeta({
    id: "specialty.neteff.preview-relay-leg-utilization",
    title: "Preview bandwidth utilization across independently shaped relay legs",
    oracle:
      "a real rendezvous relay carries exact preview bytes through independently shaped client and daemon legs, compared with a raw two-leg TCP splice using the same profiles",
    catches: [
      "client and daemon relay legs remain one end-to-end credit feedback loop",
      "latency on one relay leg is silently omitted",
      "relay path is bypassed by a direct daemon connection",
      "relay utilization changes materially when the same RTT moves between legs",
    ],
    relay: true,
  }),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const file = seedImage(t, "neteff-relay-4m.png", 4 * MIB);
    const rawServer = await startTcpPayloadServer(file.sizeBytes);
    const relay = await startRelay({ openRoot: t.openRoot });
    const zeroProfile = { rttMs: 0, bandwidthMbps: LINK_BANDWIDTH_MBPS };
    const daemonLink = await startShapedTcpProxy({ targetUrl: relay.origin, profile: zeroProfile });
    const clientLink = await startShapedTcpProxy({ targetUrl: relay.origin, profile: zeroProfile });
    t.env.env.GENEHUB_LOCAL_LOG = "info";
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const samples: UtilizationSample[] = [];
    try {
      const attached = await opened.client.call({
        type: "device.remoteAttach",
        payload: { relayUrl: daemonLink.urlFor(relay.origin), joinToken: relay.joinToken },
      });
      t.assertions.assert(
        attached?.type === "remoteAccess" && typeof attached.data.rendezvousUrl === "string",
        `device.remoteAttach returned ${attached?.type}`,
      );
      const rendezvous = attached.data.rendezvousUrl;
      await t.tools.waitUntil(async () => {
        const devices = await opened.client.call({ type: "device.list" });
        return devices?.type === "devices" && devices.data.remote.online === true;
      }, 20_000);

      const invite = await opened.client.call({ type: "device.invite", payload: null });
      t.assertions.assert(invite?.type === "invite", `device.invite returned ${invite?.type}`);
      const code = invite.data.code;
      const split = code.indexOf(".");
      t.assertions.assert(split > 0, "device invite is not inviteId.secret");
      const routedRendezvous = clientLink.urlFor(rendezvous);
      const pairing = await connectProductClient({
        url: routedRendezvous,
        inviteCredential: { inviteId: code.slice(0, split), secret: code.slice(split + 1) },
        name: "neteff-pairing",
      });
      let credential: { deviceId: string; secret: string };
      try {
        const claimed = await pairing.call({
          type: "device.claim",
          payload: { code: code.slice(0, split), deviceName: "neteff-remote" },
        });
        t.assertions.assert(claimed?.type === "claimed", `device.claim returned ${claimed?.type}`);
        credential = claimed.data;
      } finally {
        pairing.close();
      }

      const points = [
        { clientRttMs: 100, daemonRttMs: 0 },
        { clientRttMs: 50, daemonRttMs: 50 },
        { clientRttMs: 0, daemonRttMs: 100 },
        { clientRttMs: 100, daemonRttMs: 100 },
      ];
      for (const point of points) {
        const clientProfile = {
          rttMs: point.clientRttMs,
          bandwidthMbps: LINK_BANDWIDTH_MBPS,
        };
        const daemonProfile = {
          rttMs: point.daemonRttMs,
          bandwidthMbps: LINK_BANDWIDTH_MBPS,
        };
        const label = `relay rtt=${point.clientRttMs}+${point.daemonRttMs}ms`;
        const tcp = await measureRawTwoLegs(t, rawServer, {
          client: clientProfile,
          daemon: daemonProfile,
          label: `${label} tcp`,
        });
        daemonLink.setProfile(daemonProfile);
        clientLink.setProfile(clientProfile);
        daemonLink.resetStats();
        clientLink.resetStats();
        const probe = new PreviewProbe();
        const client = await connectProductClient({
          url: routedRendezvous,
          credential,
          name: `neteff-relay-${point.clientRttMs}-${point.daemonRttMs}`,
          onDiagnostic: probe.onDiagnostic,
          redial: async () => ({ url: routedRendezvous, credential }),
        });
        try {
          const product = await measurePreview(t, { client, opened, file, probe });
          samples.push(
            recordUtilization(t, {
              label,
              file,
              clientRttMs: point.clientRttMs,
              daemonRttMs: point.daemonRttMs,
              tcp,
              product,
              productLinkStats: [clientLink.stats(), daemonLink.stats()],
              target: RELAY_TARGET_UTILIZATION,
            }),
          );
        } finally {
          client.close();
        }
      }

      const clientOnly = samples.find(
        (sample) => sample.clientRttMs === 100 && sample.daemonRttMs === 0,
      );
      const daemonOnly = samples.find(
        (sample) => sample.clientRttMs === 0 && sample.daemonRttMs === 100,
      );
      t.assertions.assert(clientOnly !== undefined && daemonOnly !== undefined, "relay symmetry points missing");
      const symmetryDelta = Math.abs(clientOnly!.utilization - daemonOnly!.utilization);
      t.assertions.assert(
        symmetryDelta <= 0.2,
        `moving the same 100ms RTT between relay legs changes utilization by ${(symmetryDelta * 100).toFixed(1)}pp`,
      );
    } catch (error) {
      const tail = relay.logTail().trim();
      if (error instanceof Error && tail.length > 0) {
        error.message = `${error.message}\n\nrelay log tail:\n${tail.slice(-3072)}`;
      }
      throw error;
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
      await clientLink.stop();
      await daemonLink.stop();
      relay.stop();
      await rawServer.stop();
    }
    t.note(
      `neteff preview-relay-leg-utilization (daemon=wasm guest, real relay, each leg=${LINK_BANDWIDTH_MBPS}Mbps)\n` +
        `${headline("Relay", samples, RELAY_TARGET_UTILIZATION)}\n` +
        samples.map((sample) => sample.line).join("\n"),
    );
  },
);
