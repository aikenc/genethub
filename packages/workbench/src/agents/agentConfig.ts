import type { AgentActionInfo, AgentInfo } from "@genehub/proto";

import { canStartAgent } from "../presentation/catalog/resolve";
import { orderedAgentActions, primaryAgentAction } from "./AgentLifecycle";

/**
 * Pure presentation helpers of the 模型与 Agent surface. Nothing here knows an
 * Agent's action names or reads its wording: an action says which group it
 * belongs to (`account`, `install`, `advanced`), an Agent says what its ready
 * state is called (`statusLabel`), and an unknown group still renders as a
 * button in the default one.
 */

export type AgentStatusKind = "ready" | "needsLogin" | "notInstalled" | "busy" | "unavailable";

export interface AgentStatus {
  kind: AgentStatusKind;
  /** Always shown as text: colour alone never carries the state. */
  label: string;
}

/** Groups an Agent's actions may name. Anything else lands in "其他". */
const GROUPS = ["account", "install", "advanced"] as const;

export function isAgentBusy(agent: Pick<AgentInfo, "job">): boolean {
  return Boolean(agent.job && !agent.job.done);
}

/** probe.state + message + job → the one line a person reads first. */
export function agentStatus(
  agent: Pick<AgentInfo, "id" | "probe" | "catalog" | "source" | "message" | "job" | "actions"> &
    Partial<Pick<AgentInfo, "statusLabel">>,
): AgentStatus {
  if (isAgentBusy(agent)) return { kind: "busy", label: "正在处理…" };
  if (agent.probe.state === "ready") {
    if (!canStartAgent(agent)) return { kind: "unavailable", label: "不可用" };
    // Green must not claim more than was checked: an Agent that could not ask
    // the service about a saved key says so in its own label.
    return { kind: "ready", label: agent.statusLabel || "可用" };
  }
  if (agent.probe.state === "notInstalled") return { kind: "notInstalled", label: "未安装" };
  const primary = primaryAgentAction(agent);
  if (primary?.group === "account") return { kind: "needsLogin", label: "需要登录" };
  if (primary?.group === "install") return { kind: "notInstalled", label: "未安装" };
  if (agent.message && /登录|授权|未登录/.test(agent.message)) {
    return { kind: "needsLogin", label: "需要登录" };
  }
  return { kind: "unavailable", label: "不可用" };
}

/** Usable Agents first, then the ones that need something. The sort is stable. */
export function sortAgentsForConfig<T extends Pick<AgentInfo, "probe">>(agents: readonly T[]): T[] {
  return [...agents].sort(
    (left, right) => Number(right.probe.state === "ready") - Number(left.probe.state === "ready"),
  );
}

/** One line for the system settings row. */
export function agentConfigSummary(agents: readonly AgentInfo[]): string {
  if (agents.length === 0) return "还没有可配置的 Agent";
  const kinds = agents.map((agent) => agentStatus(agent).kind);
  const ready = kinds.filter((kind) => kind === "ready").length;
  const login = kinds.filter((kind) => kind === "needsLogin").length;
  const other = kinds.length - ready - login;
  const parts = [`${ready} 个可用`];
  if (login > 0) parts.push(`${login} 个需要登录`);
  if (other > 0) parts.push(`${other} 个需要处理`);
  return parts.join(" · ");
}

export type ActionGroupId = "account" | "install" | "other" | "advanced";

export interface ActionGroup {
  id: ActionGroupId;
  /** Null for the default group of a card that has no other group. */
  title: string | null;
  actions: AgentActionInfo[];
}

function groupOf(action: AgentActionInfo): ActionGroupId {
  const group = GROUPS.find((known) => known === action.group);
  return group ?? "other";
}

const GROUP_TITLES: Record<ActionGroupId, string> = {
  account: "账号",
  install: "安装与更新",
  other: "其他",
  advanced: "高级",
};

/** Declared actions in display groups; the primary one leads its group. */
export function groupAgentActions(actions: AgentActionInfo[] | undefined): ActionGroup[] {
  const ordered = orderedAgentActions(actions);
  const order: ActionGroupId[] = ["account", "install", "other", "advanced"];
  const groups = order
    .map((id) => ({ id, actions: ordered.filter((action) => groupOf(action) === id) }))
    .filter((group) => group.actions.length > 0);
  const labelled = groups.some((group) => group.id !== "other" && group.id !== "advanced");
  return groups.map((group) => ({
    ...group,
    title: group.id === "other" && !labelled ? null : GROUP_TITLES[group.id],
  }));
}

/**
 * An action that ends something a person set up is confirmed first, and only
 * when its script says so (`confirm` is the question to ask). Nothing here
 * guesses from an action's id or wording.
 */
export function isDestructiveAction(action: Pick<AgentActionInfo, "confirm">): boolean {
  return Boolean(action.confirm);
}

export function confirmQuestion(action: Pick<AgentActionInfo, "confirm">): string {
  return action.confirm ?? "确认？";
}
