import { BlockedError, createLease, releaseLease, type CaseMeta, type EnvironmentLease } from "../infrastructure/public.ts";

import { assertions } from "./assertions/index.ts";
import { data } from "./builders/index.ts";
import { completeVerifiableTask, handshakeAndList, startLocalEnvironment, openWorkspace, createBuiltinSession, createAgentSession, requireAgentReady, configureMockProvider, sendPrompt, attachEventLog, openSecondClient, pairDevice, connectDevice, claimDeviceInvite, daemonWsUrl, connectWithoutAdmission, seedHostCursorLogin, seedHostBetaProviders, seedHostCodexLogin, pointClaudeAtBuiltinLlm, writeOpencodeBuiltinConfig, sessionEventOf, startShell, runShell, shellText, shellExit, shellTimedOut } from "./flows/main/index.ts";
import { leftoverProcesses, openControlledAgentSession, processAlive, reconnectAfterStop, timeControlCall } from "./flows/branches/index.ts";
import { waitUntil } from "./tools/wait.ts";

export interface CaseContext {
  browser?: import('playwright').BrowserContext;
  meta: CaseMeta;
  env: EnvironmentLease;
  openRoot: string;
  /**
   * Appends to the case's bounded public summary (4 KiB cap, truncated
   * beyond it). A passing case's note lands in results.ndjson as its
   * message; cases declaring `retention` also get a redacted report file.
   */
  note(text: string): void;
  /** @internal */
  takeNote(): string | undefined;
  flows: {
    main: {
      startLocalEnvironment: typeof startLocalEnvironment;
      completeVerifiableTask: typeof completeVerifiableTask;
      handshakeAndList: typeof handshakeAndList;
      openWorkspace: typeof openWorkspace;
      createBuiltinSession: typeof createBuiltinSession;
      createAgentSession: typeof createAgentSession;
      requireAgentReady: typeof requireAgentReady;
      configureMockProvider: typeof configureMockProvider;
      sendPrompt: typeof sendPrompt;
      attachEventLog: typeof attachEventLog;
      openSecondClient: typeof openSecondClient;
      pairDevice: typeof pairDevice;
      connectDevice: typeof connectDevice;
      claimDeviceInvite: typeof claimDeviceInvite;
      daemonWsUrl: typeof daemonWsUrl;
      connectWithoutAdmission: typeof connectWithoutAdmission;
      seedHostCursorLogin: typeof seedHostCursorLogin;
      seedHostBetaProviders: typeof seedHostBetaProviders;
      seedHostCodexLogin: typeof seedHostCodexLogin;
      pointClaudeAtBuiltinLlm: typeof pointClaudeAtBuiltinLlm;
      writeOpencodeBuiltinConfig: typeof writeOpencodeBuiltinConfig;
      sessionEventOf: typeof sessionEventOf;
      startShell: typeof startShell;
      runShell: typeof runShell;
      shellText: typeof shellText;
      shellExit: typeof shellExit;
      shellTimedOut: typeof shellTimedOut;
    };
    branches: {
      reconnectAfterStop: typeof reconnectAfterStop;
      leftoverProcesses: typeof leftoverProcesses;
      openControlledAgentSession: typeof openControlledAgentSession;
      timeControlCall: typeof timeControlCall;
      processAlive: typeof processAlive;
    };
  };
  data: typeof data;
  assertions: typeof assertions;
  tools: { waitUntil: typeof waitUntil };
  dispose(): Promise<void>;
}

export async function createCaseContext(meta: CaseMeta): Promise<CaseContext> {
  const env = {
    id: process.env.TESTCTL_LEASE_ROOT ? "leased" : "inline",
    root: process.env.TESTCTL_LEASE_ROOT ?? "",
    home: process.env.HOME ?? "",
    data: process.env.GENEHUB_LOCAL_DATA_DIR ?? "",
    workspace: process.env.GENEHUB_LOCAL_WORKSPACE_DIR ?? "",
    config: process.env.XDG_CONFIG_HOME ?? "",
    logs: process.env.GENEHUB_LOG ?? "",
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  } satisfies EnvironmentLease;
  const lease = env.root ? env : createLease();
  const openRoot = process.env.TESTCTL_OPEN_ROOT ?? process.cwd();
  let browser: import('playwright').Browser | undefined;
  let browserContext: import('playwright').BrowserContext | undefined;
  if (process.env.TESTCTL_BROWSER_REQUIRED === '1') {
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch();
      browserContext = await browser.newContext();
    } catch (error) {
      await browser?.close();
      throw new BlockedError(`Browser prerequisite unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const NOTE_BUDGET = 4096;
  const notes: string[] = [];
  let noteBytes = 0;
  return {
    meta,
    browser: browserContext,
    env: lease,
    openRoot,
    note(text: string) {
      const remaining = NOTE_BUDGET - noteBytes;
      if (remaining <= 0) return;
      const slice = text.length > remaining ? `${text.slice(0, remaining - 1)}…` : text;
      notes.push(slice);
      noteBytes += slice.length;
    },
    takeNote() {
      return notes.length > 0 ? notes.join("\n") : undefined;
    },
    flows: {
      main: {
        startLocalEnvironment,
        completeVerifiableTask,
        handshakeAndList,
        openWorkspace,
        createBuiltinSession,
        createAgentSession,
        requireAgentReady,
        configureMockProvider,
        sendPrompt,
        attachEventLog,
        openSecondClient,
        pairDevice,
        connectDevice,
        claimDeviceInvite,
        daemonWsUrl,
        connectWithoutAdmission,
        seedHostCursorLogin,
        seedHostBetaProviders,
        seedHostCodexLogin,
        pointClaudeAtBuiltinLlm,
        writeOpencodeBuiltinConfig,
        sessionEventOf,
        startShell,
        runShell,
        shellText,
        shellExit,
        shellTimedOut,
      },
      branches: {
        reconnectAfterStop,
        leftoverProcesses,
        openControlledAgentSession,
        timeControlCall,
        processAlive,
      },
    },
    data,
    assertions,
    tools: { waitUntil },
    async dispose() {
      await browserContext?.close();
      await browser?.close();
      if (!env.root) releaseLease(lease);
    },
  };
}
