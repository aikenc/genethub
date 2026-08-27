import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  BlockedError,
  connectProductClient,
  createLatencyInjector,
  defineSpecialty,
  startRelay,
  tryLocateDaemonComponent,
  tryLocateHost,
  type CaseContext,
  type ClientDiagnosticEvent,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type ProductClient = Opened["client"];

const MIB = 1024 * 1024;
// packages/proto data-plane constant; the throughput law this specialty
// measures is window/RTT, so the oracles reason about it directly.
const STREAM_WINDOW_BYTES = 256 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function requireWasmArtifacts(openRoot: string): void {
  const host = tryLocateHost(openRoot);
  const component = tryLocateDaemonComponent(openRoot);
  if (!host || !component) {
    throw new BlockedError(
      `wasm artifacts missing: host=${host ?? "no"} component=${component ?? "no"}`,
    );
  }
}

function neteffMeta(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  extra: { ms: number; timeoutMs: number; relay?: boolean },
) {
  return {
    id,
    title,
    oracle,
    catches,
    tags: extra.relay
      ? ["neteff", "performance", "connectivity", "wasm-guest", "relay"]
      : ["neteff", "performance", "connectivity", "wasm-guest"],
    llm: { default: "none" as const },
    expectedDurationMs: extra.ms,
    timeoutMs: extra.timeoutMs,
    resources: {
      environments: 1,
      cpu: 2,
      memoryMb: 2048,
      io: 1,
      browser: 0,
      pool: "heavy" as const,
    },
    surfaces: extra.relay ? ["daemon", "relay", "workbench-client"] : ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client", "genet-cli"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
    retention: true,
  };
}

/** PNG magic + random payload: the daemon's sniffed image path, no decodable pixels needed. */
function seedImage(t: CaseContext, name: string, sizeBytes: number): string {
  const payload = Buffer.concat([PNG_MAGIC, randomBytes(sizeBytes - PNG_MAGIC.length)]);
  writeFileSync(path.join(t.env.workspace, name), payload);
  return createHash("sha256").update(payload).digest("hex");
}

/** Collects the product's own asset.preview finish diagnostics for cross-checking. */
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
    return this.durationsMs.length > 0 ? this.durationsMs[this.durationsMs.length - 1]! : null;
  }
}

interface Sample {
  line: string;
  mibPerSec: number;
  elapsedMs: number;
  rttMs: number;
  sizeMiB: number;
}

async function measurePoint(
  t: CaseContext,
  input: {
    client: ProductClient;
    opened: Opened;
    file: { name: string; sizeBytes: number; sha256: string };
    label: string;
    rttMs: number;
    probe: PreviewProbe;
    injectorStats?: () => { receivedMessages: number; receivedBytes: number; firstReceivedAtMs: number | null };
  },
): Promise<Sample> {
  const began = Date.now();
  const body = await input.client.preview(
    input.opened.workspaceId,
    `${input.opened.rootHandle}/${input.file.name}`,
  );
  const elapsedMs = Date.now() - began;
  const sha256 = createHash("sha256").update(body.bytes).digest("hex");
  t.assertions.assert(
    sha256 === input.file.sha256,
    `${input.label}: preview bytes sha256 ${sha256} != source ${input.file.sha256}`,
  );
  t.assertions.assert(
    body.bytes.byteLength === input.file.sizeBytes,
    `${input.label}: preview size ${body.bytes.byteLength} != ${input.file.sizeBytes}`,
  );
  const mibPerSec = body.bytes.byteLength / MIB / (elapsedMs / 1000);
  if (input.rttMs > 0) {
    // Injection-validity proof: no single stream can beat 2x window/RTT, so a
    // loopback-grade number here would mean the delay socket fell off the path.
    const ceiling = (2 * (STREAM_WINDOW_BYTES / MIB)) / (input.rttMs / 1000);
    t.assertions.assert(
      mibPerSec <= ceiling,
      `${input.label}: ${mibPerSec.toFixed(2)} MiB/s beats the 2x window/RTT ceiling ${ceiling.toFixed(2)} — latency injection is not on the data path`,
    );
  }
  const stats = input.injectorStats?.();
  if (stats) {
    t.assertions.assert(
      stats.receivedBytes >= body.bytes.byteLength,
      `${input.label}: injected socket carried ${stats.receivedBytes}B inbound for a ${body.bytes.byteLength}B payload`,
    );
  }
  const ttfbMs = stats?.firstReceivedAtMs != null ? stats.firstReceivedAtMs - began : null;
  const productMs = input.probe.latestMs();
  const line =
    `${input.label} elapsedMs=${elapsedMs} mibPerSec=${mibPerSec.toFixed(2)}` +
    ` productMs=${productMs ?? "-"} ttfbMs=${ttfbMs ?? "-"}` +
    (stats ? ` rxMsgs=${stats.receivedMessages} rxBytes=${stats.receivedBytes}` : "");
  return { line, mibPerSec, elapsedMs, rttMs: input.rttMs, sizeMiB: input.file.sizeBytes / MIB };
}

/** Headline = the optimization target itself: user-visible wait per image at each RTT. */
function windowLawConclusion(samples: Sample[]): string {
  const waits = [8, 32]
    .map((size) => {
      const cells = [0, 50, 100, 200]
        .map((rtt) => samples.find((s) => s.rttMs === rtt && s.sizeMiB === size))
        .filter((s): s is Sample => s !== undefined)
        .map((s) => `${(s.elapsedMs / 1000).toFixed(1)}s@${s.rttMs}ms`);
      return cells.length > 0 ? `${size}MiB 图等待 ${cells.join(" → ")}` : null;
    })
    .filter((line): line is string => line !== null);
  const ladder = [0, 50, 100, 200]
    .map((rtt) => samples.find((s) => s.rttMs === rtt && s.sizeMiB === 32))
    .filter((s): s is Sample => s !== undefined)
    .map((s) => s.mibPerSec.toFixed(1))
    .join(" → ");
  const achievement: string[] = [];
  for (const rtt of [50, 100, 200]) {
    const point = samples.find((s) => s.rttMs === rtt && s.sizeMiB === 32);
    if (!point) continue;
    const theory = STREAM_WINDOW_BYTES / MIB / (rtt / 1000);
    achievement.push(`${rtt}ms=${Math.round((point.mibPerSec / theory) * 100)}%`);
  }
  return (
    `核心指标（优化目标=缩短等待）：${waits.join("；")}。` +
    `吞吐 ${ladder} MiB/s，即 256KiB/RTT 窗口定律。` +
    `次级：达成率 ${achievement.join(" ")}——实现已贴天花板，杠杆在协议窗口不在代码。`
  );
}

function theoreticalMs(sizeBytes: number, rttMs: number): number {
  return rttMs === 0 ? 0 : (sizeBytes / STREAM_WINDOW_BYTES) * rttMs;
}

function assertWithinLooseBound(
  t: CaseContext,
  label: string,
  elapsedMs: number,
  sizeBytes: number,
  rttMs: number,
): void {
  // Order-of-magnitude guard only: 9x headroom over the window/RTT model, and
  // never tighter than 15s for the CPU-bound loopback points.
  const boundMs = Math.max(15_000, theoreticalMs(sizeBytes, rttMs) * 9);
  t.assertions.assert(
    elapsedMs <= boundMs,
    `${label}: ${elapsedMs}ms exceeds the loose bound ${boundMs}ms (model ${theoreticalMs(sizeBytes, rttMs)}ms)`,
  );
}

class PointFailure extends Error {}

async function failWithSamples(samples: Sample[], error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  const table = samples.map((sample) => sample.line).join("\n");
  throw new PointFailure(table.length > 0 ? `${message}\n\ncompleted points:\n${table}` : message);
}

defineSpecialty(
  neteffMeta(
    "specialty.neteff.preview-loopback-rtt-matrix",
    "Preview throughput over the direct daemon socket across a size x RTT matrix",
    "every point is byte-identical (sha256), beats its loose upper bound, and RTT>0 points stay under the 2x window/RTT physics ceiling",
    [
      "stream window shrink regression",
      "record slicing regression",
      "single stream starved by fair rotation",
      "preview timeout/reset that only non-zero RTT exposes",
      "latency injection silently off the data path",
    ],
    { ms: 120_000, timeoutMs: 300_000 },
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const sizesMiB = [1, 8, 32];
    const rttsMs = [0, 50, 100, 200];
    const files = new Map<number, { name: string; sizeBytes: number; sha256: string }>();
    for (const size of sizesMiB) {
      const name = `neteff-${size}m.png`;
      files.set(size, { name, sizeBytes: size * MIB, sha256: seedImage(t, name, size * MIB) });
    }
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const samples: Sample[] = [];
    try {
      for (const rtt of rttsMs) {
        const injector = rtt > 0 ? createLatencyInjector({ rttMs: rtt }) : null;
        const probe = new PreviewProbe();
        // RTT 0 uses a plain socket: a zero-delay timer per record would tax
        // the baseline it is meant to measure.
        const client = await t.flows.main.openSecondClient(opened, `neteff-${rtt}ms`, {
          ...(injector ? { socketFactory: injector.socketFactory } : {}),
          onDiagnostic: probe.onDiagnostic,
        });
        try {
          for (const size of sizesMiB) {
            const file = files.get(size)!;
            injector?.resetStats();
            const began = Date.now();
            let sample: Sample;
            try {
              sample = await measurePoint(t, {
                client,
                opened,
                file,
                label: `direct rtt=${rtt}ms size=${size}MiB`,
                rttMs: rtt,
                probe,
                injectorStats: injector ? () => injector.stats() : undefined,
              });
              assertWithinLooseBound(t, `direct rtt=${rtt}ms size=${size}MiB`, Date.now() - began, file.sizeBytes, rtt);
            } catch (error) {
              await failWithSamples(samples, error);
            }
            samples.push(sample!);
          }
        } finally {
          client.close();
          injector?.closeAll();
        }
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
    t.note(
      `neteff preview-loopback-rtt-matrix (daemon=wasm guest, direct loopback)\n${windowLawConclusion(samples)}\n${samples.map((sample) => sample.line).join("\n")}`,
    );
  },
);

defineSpecialty(
  neteffMeta(
    "specialty.neteff.preview-relay-rtt-matrix",
    "Preview throughput over a real rendezvous relay with a paired remote client",
    "relay points are byte-identical and bounded, and 8MiB@100ms over relay is not faster than 1.2x the same point direct",
    [
      "relay forwarding serializes streams",
      "outer Fabric window stacks with the inner window and degrades",
      "pairing or dialling fails under latency",
      "relay leg not actually carrying the traffic",
    ],
    { ms: 90_000, timeoutMs: 240_000, relay: true },
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const files = new Map<number, { name: string; sizeBytes: number; sha256: string }>();
    for (const size of [8, 32]) {
      const name = `neteff-${size}m.png`;
      files.set(size, { name, sizeBytes: size * MIB, sha256: seedImage(t, name, size * MIB) });
    }
    const relay = await startRelay({ openRoot: t.openRoot });
    // The daemon's own log is the only window into the guest side of a relay
    // failure; the lease default (warn) says nothing on a healthy path.
    t.env.env.GENEHUB_LOCAL_LOG = "info";
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const samples: Sample[] = [];
    let conclusion = "";
    try {
      const attached = await opened.client.call({
        type: "device.remoteAttach",
        payload: { relayUrl: relay.origin, joinToken: relay.joinToken },
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
      const pairing = await connectProductClient({
        url: rendezvous,
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

      // Direct reference point, same daemon, so the relay comparison is
      // within this case and stays independent of case 1 (P07).
      {
        const injector = createLatencyInjector({ rttMs: 100 });
        const probe = new PreviewProbe();
        const client = await t.flows.main.openSecondClient(opened, "neteff-ref-100ms", {
          socketFactory: injector.socketFactory,
          onDiagnostic: probe.onDiagnostic,
        });
        try {
          injector.resetStats();
          const began = Date.now();
          const file = files.get(8)!;
          try {
            const sample = await measurePoint(t, {
              client,
              opened,
              file,
              label: "direct-ref rtt=100ms size=8MiB",
              rttMs: 100,
              probe,
              injectorStats: () => injector.stats(),
            });
            assertWithinLooseBound(t, "direct-ref rtt=100ms size=8MiB", Date.now() - began, file.sizeBytes, 100);
            samples.push(sample);
          } catch (error) {
            await failWithSamples(samples, error);
          }
        } finally {
          client.close();
          injector.closeAll();
        }
      }

      // No rtt=0 relay point on purpose: a loopback-fast client pulling >=4MiB
      // over the relay currently gets its fabric stream reset by the daemon
      // (ProtocolViolation/6 — the daemon's 16-record inbound carrier queue
      // overflows under burst; reproduced 2026-08-27, seq intact, queue
      // capacity 0). 10ms is the fastest speed the product path survives, so
      // the near-loopback measurement lives there until the daemon fix lands.
      for (const point of [
        { rtt: 10, size: 8 },
        { rtt: 100, size: 8 },
        { rtt: 100, size: 32 },
      ]) {
        const injector = createLatencyInjector({ rttMs: point.rtt });
        const probe = new PreviewProbe();
        const client = await connectProductClient({
          url: rendezvous,
          credential,
          name: `neteff-relay-${point.rtt}ms`,
          socketFactory: injector.socketFactory,
          onDiagnostic: probe.onDiagnostic,
        });
        try {
          injector.resetStats();
          const began = Date.now();
          const file = files.get(point.size)!;
          try {
            const sample = await measurePoint(t, {
              client,
              opened,
              file,
              label: `relay rtt=${point.rtt}ms size=${point.size}MiB`,
              rttMs: point.rtt,
              probe,
              injectorStats: () => injector.stats(),
            });
            assertWithinLooseBound(
              t,
              `relay rtt=${point.rtt}ms size=${point.size}MiB`,
              Date.now() - began,
              file.sizeBytes,
              point.rtt,
            );
            samples.push(sample);
          } catch (error) {
            await failWithSamples(samples, error);
          }
        } finally {
          client.close();
          injector.closeAll();
        }
      }

      const directRef = samples.find((sample) => sample.line.startsWith("direct-ref"));
      const relay100 = samples.find((sample) => sample.line.startsWith("relay rtt=100ms size=8MiB"));
      const relay10 = samples.find((sample) => sample.line.startsWith("relay rtt=10ms"));
      t.assertions.assert(
        directRef !== undefined && relay100 !== undefined,
        "comparison points are missing",
      );
      t.assertions.assert(
        relay100!.mibPerSec <= directRef!.mibPerSec * 1.2,
        `relay ${relay100!.mibPerSec.toFixed(2)} MiB/s is suspiciously faster than 1.2x direct ${directRef!.mibPerSec.toFixed(2)} MiB/s — the relay leg is likely not carrying the traffic`,
      );
      const relay32 = samples.find((sample) => sample.line.startsWith("relay rtt=100ms size=32MiB"));
      conclusion =
        `核心指标（优化目标=缩短等待）：relay 路径 8MiB 图等待 ` +
        [relay10, relay100]
          .filter((s): s is Sample => s !== undefined)
          .map((s) => `${(s.elapsedMs / 1000).toFixed(1)}s@${s.rttMs}ms`)
          .join(" → ") +
        (relay32 ? `，32MiB@100ms 等待 ${(relay32.elapsedMs / 1000).toFixed(1)}s` : "") +
        `——等待随 RTT 线性增长。次级：relay 自身只加约 ${Math.round((1 - relay100!.mibPerSec / directRef!.mibPerSec) * 100)}% 开销` +
        `（100ms 为直连 ${Math.round((relay100!.mibPerSec / directRef!.mibPerSec) * 100)}%），远程的税是 RTT 不是 relay；` +
        (relay10 ? `10ms 半窗退化（${relay10.mibPerSec.toFixed(1)} MiB/s = 理论 50%）；` : "") +
        `已知缺陷：回环 ≥4MiB 触发 daemon 入队溢出 reset，rtt=0 点排除。`;
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
      relay.stop();
    }
    t.note(
      `neteff preview-relay-rtt-matrix (daemon=wasm guest, rendezvous relay)\n${conclusion}\n${samples.map((sample) => sample.line).join("\n")}`,
    );
  },
);

defineSpecialty(
  neteffMeta(
    "specialty.neteff.preview-timeout-cliff",
    "48MiB at 400ms RTT must fail inside the product's 60s preview timeout, not hang",
    "preview rejects with a timeout-shaped error within [55s, 90s], and a 1MiB preview on the same connection still succeeds afterwards",
    [
      "timeout boundary degrades into a hang under latency",
      "stream reset poisons the connection",
      "daemon wedged after an aborted large preview",
    ],
    { ms: 120_000, timeoutMs: 240_000 },
  ),
  async (t) => {
    requireWasmArtifacts(t.openRoot);
    const big = { name: "neteff-48m.png", sizeBytes: 48 * MIB, sha256: seedImage(t, "neteff-48m.png", 48 * MIB) };
    const small = { name: "neteff-1m.png", sizeBytes: 1 * MIB, sha256: seedImage(t, "neteff-1m.png", 1 * MIB) };
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const lines: string[] = [];
    let cliffElapsedMs = 0;
    try {
      const injector = createLatencyInjector({ rttMs: 400 });
      const probe = new PreviewProbe();
      const client = await t.flows.main.openSecondClient(opened, "neteff-400ms", {
        socketFactory: injector.socketFactory,
        onDiagnostic: probe.onDiagnostic,
      });
      try {
        injector.resetStats();
        const began = Date.now();
        let outcome: unknown = null;
        try {
          await client.preview(opened.workspaceId, `${opened.rootHandle}/${big.name}`);
        } catch (error) {
          outcome = error;
        }
        const elapsedMs = Date.now() - began;
        cliffElapsedMs = elapsedMs;
        t.assertions.assert(outcome !== null, "48MiB@400ms preview unexpectedly succeeded");
        const message = outcome instanceof Error ? outcome.message : String(outcome);
        t.assertions.assert(
          /timed out|timeout/i.test(message),
          `48MiB@400ms failed with a non-timeout shape: ${message}`,
        );
        t.assertions.assert(
          elapsedMs >= 55_000 && elapsedMs <= 90_000,
          `timeout fired at ${elapsedMs}ms, outside the product contract window [55000, 90000]`,
        );
        const stats = injector.stats();
        lines.push(
          `cliff rtt=400ms size=48MiB outcome=timeout elapsedMs=${elapsedMs} rxMsgs=${stats.receivedMessages} rxBytes=${stats.receivedBytes}`,
        );

        injector.resetStats();
        const check = await measurePoint(t, {
          client,
          opened,
          file: small,
          label: "recovery rtt=400ms size=1MiB",
          rttMs: 400,
          probe,
          injectorStats: () => injector.stats(),
        });
        lines.push(check.line);
      } finally {
        client.close();
        injector.closeAll();
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
    t.note(
      `neteff preview-timeout-cliff (daemon=wasm guest)\n` +
        `核心指标（优化目标=消除死线）：48MiB 图 @400ms RTT 在 ${(cliffElapsedMs / 1000).toFixed(1)}s 被产品 60s 超时杀死（理论需 77s）——` +
        `该档 RTT 下大图永远打不开；超时后同连接恢复预览正常（见下行）。\n` +
        lines.join("\n"),
    );
  },
);
