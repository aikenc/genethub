import { createLease, releaseLease, type CaseMeta, type EnvironmentLease } from "../infrastructure/public.ts";

import { assertions } from "./assertions/index.ts";
import { data } from "./builders/index.ts";
import { completeVerifiableTask, handshakeAndList, startLocalEnvironment, openWorkspace, createBuiltinSession, createAgentSession, requireAgentReady, configureMockProvider, sendPrompt, attachEventLog, openSecondClient, pairDevice, connectDevice, claimDeviceInvite, daemonWsUrl, connectWithoutAdmission, seedHostCursorLogin, seedHostBetaProviders, seedHostCodexLogin, installFixtureAcpAgent, pointClaudeAtBuiltinLlm, writeOpencodeBuiltinConfig, configureOpencodeBuiltinAgent, sessionEventOf, startShell, runShell, shellText, shellExit, shellTimedOut } from "./flows/main/index.ts";
import { leftoverProcesses, reconnectAfterStop } from "./flows/branches/index.ts";
import { waitUntil } from "./tools/wait.ts";

export interface CaseContext {
  meta: CaseMeta;
  env: EnvironmentLease;
  openRoot: string;
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
      installFixtureAcpAgent: typeof installFixtureAcpAgent;
      pointClaudeAtBuiltinLlm: typeof pointClaudeAtBuiltinLlm;
      writeOpencodeBuiltinConfig: typeof writeOpencodeBuiltinConfig;
      configureOpencodeBuiltinAgent: typeof configureOpencodeBuiltinAgent;
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
  return {
    meta,
    env: lease,
    openRoot,
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
        installFixtureAcpAgent,
        pointClaudeAtBuiltinLlm,
        writeOpencodeBuiltinConfig,
        configureOpencodeBuiltinAgent,
        sessionEventOf,
        startShell,
        runShell,
        shellText,
        shellExit,
        shellTimedOut,
      },
      branches: { reconnectAfterStop, leftoverProcesses },
    },
    data,
    assertions,
    tools: { waitUntil },
    async dispose() {
      if (!env.root) releaseLease(lease);
    },
  };
}
