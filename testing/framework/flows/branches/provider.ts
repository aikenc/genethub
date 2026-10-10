import type { CaseContext } from "../../context.ts";
import { hideHostAgentClis, installScriptAgent, readScriptAgentJournal, writeScriptAgentControl } from "../../builders/script-agent.ts";
import { createAgentSession, openWorkspace } from "../main/index.ts";
import { agentReady, waitForAgent } from "./script-agent.ts";

/** A normal third-party script uses the real CLI and controller admission. */
export async function openProviderSession(t: CaseContext, dialect: "openai" | "anthropic" = "anthropic") {
  hideHostAgentClis(t.env);
  const agent = installScriptAgent(t.env, { id: "fixture-provider", control: { profile: "normal" } });
  const opened = await openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    writeScriptAgentControl(agent, { profile: "provider-cli", once: true, providerBaseUrl: opened.mock.origin,
      providerDialect: dialect, expectedResume: "GeneHub provider operation", processTree: true });
    await opened.client.call({ type: "agent.reload", payload: { agentId: agent.agentId } });
    await waitForAgent(opened.client, agent.agentId, agentReady);
    const sessionId = await createAgentSession(opened.client, { workspaceId: opened.workspaceId, agentId: agent.agentId, modelId: null });
    return { ...opened, agent, sessionId, actionId: "fixture-provider-action", journal: () => readScriptAgentJournal(agent),
      async dispose() { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); },
    };
  } catch (error) { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); throw error; }
}
