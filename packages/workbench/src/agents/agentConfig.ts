import type { AgentActionInfo, AgentInfo } from "@genehub/proto";

import { canStartAgent } from "../presentation/catalog/resolve";
import { orderedAgentActions, primaryAgentAction } from "./AgentLifecycle";

/**
 * Pure presentation helpers of the Agent 配置 surface. The platform knows no
 * action names beyond the grouping hints below: an unknown id still renders
 * as a button, it just lands in the default group.
 */

export type AgentStatusKind = "ready" | "needsLogin" | "notInstalled" | "busy" | "unavailable";

export interface AgentStatus {
  kind: AgentStatusKind;
  /** Always shown as text: colour alone never carries the state. */
  label: string;
}

const LOGIN_ACTIONS = ["login", "login-api-key", "logout"];
const INSTALL_ACTIONS = ["install", "update"];

export function isAgentBusy(agent: Pick<AgentInfo, "job">): boolean {
  return Boolean(agent.job && !agent.job.done);
}

/** probe.state + message + job → the one line a person reads first. */
export function agentStatus(
  agent: Pick<AgentInfo, "id" | "probe" | "catalog" | "source" | "message" | "job" | "actions">,
): AgentStatus {
  if (isAgentBusy(agent)) return { kind: "busy", label: "正在处理…" };
  if (agent.probe.state === "ready") {
    return canStartAgent(agent)
      ? { kind: "ready", label: "可用" }
      : { kind: "unavailable", label: "不可用" };
  }
  if (agent.probe.state === "notInstalled") return { kind: "notInstalled", label: "未安装" };
  const primary = primaryAgentAction(agent);
  if (primary && LOGIN_ACTIONS.includes(primary.id)) return { kind: "needsLogin", label: "需要登录" };
  if (primary && primary.id === "install") return { kind: "notInstalled", label: "未安装" };
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

export type ActionGroupId = "account" | "install" | "other";

export interface ActionGroup {
  id: ActionGroupId;
  /** Null for the default group of a card that has no other group. */
  title: string | null;
  actions: AgentActionInfo[];
}

function groupOf(action: AgentActionInfo): ActionGroupId {
  if (LOGIN_ACTIONS.includes(action.id)) return "account";
  if (INSTALL_ACTIONS.includes(action.id)) return "install";
  return "other";
}

const GROUP_TITLES: Record<ActionGroupId, string> = {
  account: "账号",
  install: "安装与更新",
  other: "其他",
};

/** Declared actions in display groups; the primary one leads its group. */
export function groupAgentActions(actions: AgentActionInfo[] | undefined): ActionGroup[] {
  const ordered = orderedAgentActions(actions);
  const order: ActionGroupId[] = ["account", "install", "other"];
  const groups = order
    .map((id) => ({ id, actions: ordered.filter((action) => groupOf(action) === id) }))
    .filter((group) => group.actions.length > 0);
  const labelled = groups.some((group) => group.id !== "other");
  return groups.map((group) => ({
    ...group,
    title: group.id === "other" && !labelled ? null : GROUP_TITLES[group.id],
  }));
}

/** Actions that end something a person set up must be confirmed first. */
export function isDestructiveAction(action: Pick<AgentActionInfo, "id" | "label">): boolean {
  return action.id === "logout" || /退出登录|卸载/.test(action.label);
}

export function confirmQuestion(action: Pick<AgentActionInfo, "id" | "label">): string {
  if (action.id === "logout" || action.label.includes("退出登录")) return "确认退出？";
  return `确认${action.label}？`;
}
