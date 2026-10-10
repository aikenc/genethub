import type { AgentActionInfo, AgentInfo } from "@genehub/proto";
import { useState } from "react";

import { AgentMark } from "../presentation/AgentMark";
import { agentRequestKey, useWorkbench } from "../session/store";
import {
  AgentActionButton,
  AgentJobProgress,
  agentNeedsRepair,
  agentSourceLabel,
  visibleAgentJob,
} from "./AgentLifecycle";
import {
  agentStatus,
  confirmQuestion,
  groupAgentActions,
  isDestructiveAction,
  isAgentBusy,
  type AgentStatusKind,
} from "./agentConfig";

const QUIET_BUTTON =
  "min-h-11 shrink-0 rounded border border-line px-3 text-xs text-fg hover:border-accent disabled:opacity-40";

const DOT: Record<AgentStatusKind, string> = {
  ready: "bg-ok",
  needsLogin: "bg-accent",
  notInstalled: "bg-accent",
  busy: "bg-accent animate-pulse",
  unavailable: "bg-danger",
};

/**
 * One Agent in the Agent 配置 dialog: what it is, where it stands, and the
 * buttons its script declared. The platform renders and runs them; what a
 * button leads to (a login link, an install confirmation) arrives as an Agent
 * request card and never passes through a model.
 */
export function AgentCard({
  agent,
  onOpenKeys,
}: {
  agent: AgentInfo;
  /** Jumps to the model key tab; offered for the built-in Agent that cannot start yet. */
  onOpenKeys?(): void;
}) {
  const runAgentAction = useWorkbench((state) => state.runAgentAction);
  const resetAgent = useWorkbench((state) => state.resetAgent);
  const reloadAgent = useWorkbench((state) => state.reloadAgent);
  const repairAgent = useWorkbench((state) => state.repairAgent);
  const showAgentRequest = useWorkbench((state) => state.showAgentRequest);
  const repairing = useWorkbench((state) => state.repairingAgentIds.includes(agent.id));
  const hiddenRequest = useWorkbench((state) =>
    state.agentRequests.find(
      (request) =>
        request.agentId === agent.id &&
        state.hiddenAgentRequests.includes(agentRequestKey(request.agentId, request.id)),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const status = agentStatus(agent);
  const source = agentSourceLabel(agent);
  const job = visibleAgentJob(agent);
  const running = isAgentBusy(agent);
  const ready = agent.probe.state === "ready";
  const groups = groupAgentActions(agent.actions);
  // Edits under user/ take effect on reload, including the copy a repair
  // session makes of a built-in that the daemon has not seen yet.
  const reloadable = agent.source === "user" || agent.source === "override" || repairing;
  const resettable = agent.source === "override";
  const repairable = agentNeedsRepair(agent);
  const hasMore = reloadable || resettable || repairable;
  const keysHint = Boolean(onOpenKeys) && agent.builtin && status.kind === "unavailable";

  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  const runAction = (action: AgentActionInfo) => {
    if (isDestructiveAction(action)) {
      setConfirming(action.id);
      return;
    }
    run(() => runAgentAction(agent.id, action.id));
  };
  const disabled = busy || running;

  return (
    <li
      data-agent-id={agent.id}
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <AgentMark agent={agent} className="h-8 w-8 shrink-0" fallbackToText={false} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="min-w-0 truncate text-sm font-medium text-fg">{agent.label}</h4>
            {agent.version ? <span className="shrink-0 text-xs text-faint">{agent.version}</span> : null}
            {source ? (
              <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">{source}</span>
            ) : null}
            {agent.source === "override" && agent.overrideStale ? (
              <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">
                基于旧内置版本
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted" data-status={status.kind}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[status.kind]}`} aria-hidden />
            <span>{status.label}</span>
          </p>
        </div>
      </div>

      {/* What a not-yet-usable script Agent is, from its manifest (proposal §8.2). */}
      {agent.source != null && !ready && agent.description ? (
        <p className="text-xs text-faint">{agent.description}</p>
      ) : null}
      {agent.message ? (
        <p className="whitespace-pre-wrap text-xs text-muted">{agent.message}</p>
      ) : null}
      {job ? <AgentJobProgress job={job} /> : null}

      {hiddenRequest || keysHint || groups.length > 0 ? (
        <div className="flex flex-col gap-2">
          {hiddenRequest ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={QUIET_BUTTON}
                onClick={() => showAgentRequest(hiddenRequest.agentId, hiddenRequest.id)}
              >
                查看请求：{hiddenRequest.title}
              </button>
            </div>
          ) : null}
          {keysHint ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={QUIET_BUTTON} onClick={onOpenKeys}>
                配置模型密钥
              </button>
            </div>
          ) : null}
          {groups.map((group) => (
            <div
              key={group.id}
              role="group"
              aria-label={group.title ? `${agent.label} ${group.title}` : `${agent.label} 操作`}
              className="flex flex-col gap-1"
            >
              {group.title ? <span className="text-[11px] text-faint">{group.title}</span> : null}
              <div className="flex flex-wrap items-center gap-2">
                {group.actions.map((action) =>
                  confirming === action.id ? (
                    <ConfirmAction
                      key={action.id}
                      agentLabel={agent.label}
                      action={action}
                      disabled={disabled}
                      onConfirm={() => {
                        setConfirming(null);
                        run(() => runAgentAction(agent.id, action.id));
                      }}
                      onCancel={() => setConfirming(null)}
                    />
                  ) : (
                    <AgentActionButton
                      key={action.id}
                      action={action}
                      agentLabel={agent.label}
                      disabled={disabled}
                      onRun={() => runAction(action)}
                    />
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {hasMore ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-label={`${agent.label} 更多`}
            className="min-h-11 self-start rounded px-1 text-xs text-muted hover:text-fg"
            onClick={() => setMoreOpen((open) => !open)}
          >
            更多 {moreOpen ? "▴" : "▾"}
          </button>
          {moreOpen ? (
            <div className="flex flex-wrap gap-2">
              {reloadable ? (
                <button
                  type="button"
                  disabled={disabled}
                  className={QUIET_BUTTON}
                  onClick={() => run(() => reloadAgent(agent.id))}
                >
                  重新加载
                </button>
              ) : null}
              {resettable ? (
                <button
                  type="button"
                  disabled={disabled}
                  className={QUIET_BUTTON}
                  onClick={() => run(() => resetAgent(agent.id))}
                >
                  恢复内置
                </button>
              ) : null}
              {repairable ? (
                <button
                  type="button"
                  disabled={busy}
                  className={QUIET_BUTTON}
                  onClick={() => run(() => repairAgent(agent.id))}
                >
                  让内置 Agent 修复
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Inline "are you sure" for an action that ends something. */
function ConfirmAction({
  agentLabel,
  action,
  disabled,
  onConfirm,
  onCancel,
}: {
  agentLabel: string;
  action: AgentActionInfo;
  disabled: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <span
      role="group"
      aria-label={`${agentLabel} ${action.label} 确认`}
      className="flex flex-wrap items-center gap-2 rounded border border-danger/50 px-2"
    >
      <span className="text-xs text-fg">{confirmQuestion(action)}</span>
      <button
        type="button"
        disabled={disabled}
        aria-label={`${agentLabel} 确认${action.label}`}
        className="min-h-11 rounded px-2 text-xs text-danger hover:underline disabled:opacity-40"
        onClick={onConfirm}
      >
        确认
      </button>
      <button
        type="button"
        aria-label={`${agentLabel} 取消${action.label}`}
        className="min-h-11 rounded px-2 text-xs text-muted hover:text-fg"
        onClick={onCancel}
      >
        取消
      </button>
    </span>
  );
}
