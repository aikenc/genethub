import {
  defineE2e as defineE2eBase,
  defineJourney as defineJourneyBase,
  defineSpecialty as defineSpecialtyBase,
  type DefineInput,
} from "../infrastructure/public.ts";
import type { CaseContext } from "./context.ts";

export {
  genetEnv,
  locateGenet,
  locateWasm,
  parseJson,
  runGenet,
  runGenetAsync,
  tryLocateAgent,
  tryLocateAgentComponent,
  tryLocateDaemonComponent,
  tryLocateGuestProbe,
  tryLocateHost,
  tryLocateWasm,
  procCmdline,
  procEnviron,
  processesMatching,
  agentHostProcesses,
} from "./drivers/cli.ts";

export type { CaseContext } from "./context.ts";
export { assertions } from "./assertions/index.ts";
export { connectProductClient } from "./drivers/client.ts";
export type { ClientDiagnosticEvent } from "@genehub/workbench/client";
export { createLatencyInjector, type LatencyInjector, type LatencyStats } from "./drivers/latency.ts";
export {
  measureTcpTransfer,
  startShapedTcpProxy,
  startTcpPayloadServer,
  type NetworkLinkProfile,
  type ShapedTcpProxy,
  type ShapedTcpProxyStats,
  type TcpPayloadServer,
  type TcpTransferSample,
} from "./drivers/network-link.ts";
export { daemonEndpoint, type DaemonEndpoint, type DaemonHandle } from "./drivers/daemon.ts";
export { startRelay, type RelayHandle } from "./drivers/relay.ts";
export { startHub, type HubBrowser, type HubHandle } from "./drivers/hub.ts";
export { data } from "./builders/index.ts";
export { compareQueueTails } from "./queue.ts";
export { qualificationReasons } from "../policies/gates.ts";
export { BlockedError, UnstableError, parseSummaryLanguage, renderRunSummary } from "../infrastructure/public.ts";
export type { RunManifest, UnitResult } from "../infrastructure/public.ts";

function callerFile(): string {
  const stack = new Error().stack ?? "";
  const lines = stack.split("\n").slice(2);
  for (const line of lines) {
    const match = line.match(/at (?:file:\/\/)?(\/[^:]+)/) ?? line.match(/\((\/[^:]+)/);
    const file = match?.[1];
    if (file && !file.includes("/framework/public.ts")) return file;
  }
  return "unknown";
}

export function defineJourney(input: DefineInput, run: (ctx: CaseContext) => Promise<void>): void {
  defineJourneyBase(input, (ctx) => run(ctx as CaseContext), callerFile());
}

export function defineSpecialty(input: DefineInput, run: (ctx: CaseContext) => Promise<void>): void {
  defineSpecialtyBase(input, (ctx) => run(ctx as CaseContext), callerFile());
}

export function defineE2e(input: DefineInput, run: (ctx: CaseContext) => Promise<void>): void {
  defineE2eBase(input, (ctx) => run(ctx as CaseContext), callerFile());
}

export { registerScriptedCodex } from "./builders/codex.ts";
