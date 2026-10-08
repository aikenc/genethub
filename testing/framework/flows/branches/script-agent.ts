import type { AgentRequestOutcome, AgentUserRequest, Reply } from "@genehub/proto";

import type { ProductSession } from "../main/index.ts";

type Client = ProductSession["client"];
export type AgentInfo = Extract<Reply, { type: "agents" }>["data"][number];

/** `agent.list`: what the daemon knows right now, without asking anyone. */
export async function listAgents(client: Client): Promise<AgentInfo[]> {
  const reply = await client.call({ type: "agent.list" });
  if (reply?.type !== "agents") throw new Error(`agent.list returned ${reply?.type}`);
  return reply.data;
}

/**
 * Resolves with the Agent once `accept` holds, from whichever arrives first:
 * an `agents` push the product client hands its listeners, or an `agent.list`
 * poll. Script Agents report state asynchronously, so a single list right
 * after start is a race, not a fact. Rejects with the last thing seen.
 */
export async function waitForAgent(
  client: Client,
  agentId: string,
  accept: (agent: AgentInfo) => boolean,
  options: { timeoutMs?: number; what?: string } = {},
): Promise<AgentInfo> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let last: AgentInfo | undefined;
  let found: AgentInfo | undefined;
  const consider = (agents: AgentInfo[]) => {
    const agent = agents.find((item) => item.id === agentId);
    if (agent) last = agent;
    if (!found && agent && accept(agent)) found = agent;
  };
  const off = client.onAgents(consider);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      consider(await listAgents(client));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (found) return found;
    }
  } finally {
    off();
  }
  throw new Error(
    `${agentId} never became ${options.what ?? "what the case waited for"} within ${timeoutMs}ms; last seen ${JSON.stringify(
      last === undefined ? null : summarizeAgent(last),
    )}`,
  );
}

export const agentReady = (agent: AgentInfo): boolean => agent.probe.state === "ready";

/** The fields a failure message needs, without a catalog or an icon. */
export function summarizeAgent(agent: AgentInfo): Record<string, unknown> {
  return {
    id: agent.id,
    probe: agent.probe,
    source: agent.source,
    message: agent.message,
    actions: agent.actions,
    job: agent.job,
    pendingRequests: agent.pendingRequests,
  };
}

/** Everything the daemon pushed about Agents to this client, in order. */
export interface AgentPushes {
  lists: AgentInfo[][];
  requests: AgentUserRequest[];
  closed: Array<{ agentId: string; requestId: string }>;
  stop(): void;
}

export function recordAgentPushes(client: Client): AgentPushes {
  const pushes: Omit<AgentPushes, "stop"> = { lists: [], requests: [], closed: [] };
  const offs = [
    client.onAgents((agents) => pushes.lists.push(agents)),
    client.onAgentRequest((request) => pushes.requests.push(request)),
    client.onAgentRequestClosed((agentId, requestId) => pushes.closed.push({ agentId, requestId })),
  ];
  return { ...pushes, stop: () => offs.forEach((off) => off()) };
}

/** `agent.logs`: what the script wrote to stderr, plus the daemon's own notes. */
export async function agentLogs(client: Client, agentId: string, lines = 500): Promise<string[]> {
  const reply = await client.call({ type: "agent.logs", payload: { agentId, lines } });
  if (reply?.type !== "agentLogs") throw new Error(`agent.logs returned ${reply?.type}`);
  return reply.data.lines;
}

/** Answers an Agent-level request the way a person in the workbench does. */
export async function answerAgentRequest(
  client: Client,
  input: { agentId: string; requestId: string; outcome: AgentRequestOutcome },
): Promise<void> {
  const reply = await client.call({ type: "agent.requestAnswer", payload: input });
  if (reply?.type !== "ack") throw new Error(`agent.requestAnswer returned ${reply?.type}`);
}

/** `agent.reload` / `agent.reset` / `agent.action`, returning the error text
 * instead of throwing, because a refusal is often the fact under test. */
export async function agentControl(
  client: Client,
  request:
    | { type: "agent.reload"; payload: { agentId: string } }
    | { type: "agent.reset"; payload: { agentId: string } }
    | { type: "agent.action"; payload: { agentId: string; actionId: string } },
): Promise<{ ok: true; agents: AgentInfo[] } | { ok: false; error: string }> {
  try {
    const reply = await client.call(request);
    if (reply?.type !== "agents") return { ok: false, error: `unexpected reply ${reply?.type}` };
    return { ok: true, agents: reply.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
