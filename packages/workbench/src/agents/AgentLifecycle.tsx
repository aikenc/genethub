import type { AgentActionInfo, AgentInfo, AgentJobInfo } from "@genehub/proto";

import { AgentMark } from "../presentation/AgentMark";

/**
 * Pieces of a script Agent's lifecycle row (proposal §8), shared by the
 * settings list and the model picker. The platform knows no action names: it
 * shows what the script declared and runs the one clicked.
 */

/** Where an Agent came from. "内置" is only the native Agent the installer
 * ships; a script directory shipped with it is "随附", so "让内置 Agent 修复"
 * names one Agent, not two. */
export function agentSourceLabel(agent: Pick<AgentInfo, "builtin" | "source">): string | null {
  if (agent.builtin) return "内置";
  switch (agent.source) {
    case "builtin":
      return "随附";
    case "user":
      return "本地";
    case "override":
      return "本地修改版本";
    default:
      return null;
  }
}

/** Primary actions first: the one marked `primary` is what the row offers. */
export function orderedAgentActions(actions: AgentActionInfo[] | undefined): AgentActionInfo[] {
  return [...(actions ?? [])].sort((left, right) => Number(right.primary) - Number(left.primary));
}

export function primaryAgentAction(
  agent: Pick<AgentInfo, "actions">,
): AgentActionInfo | undefined {
  return agent.actions?.find((action) => action.primary);
}

/** The message a script Agent shows while its process has not reported yet. */
const STARTING_MESSAGE = "正在启动";

/**
 * A script Agent the script itself cannot move forward: not ready, nothing
 * running, and no primary action to offer (an uninstalled or logged-out
 * Agent offers one). That is when "让内置 Agent 修复" is worth a button.
 */
export function agentNeedsRepair(
  agent: Pick<AgentInfo, "source" | "probe" | "actions" | "job" | "message">,
): boolean {
  if (agent.source == null || agent.probe.state === "ready") return false;
  if (agent.job && !agent.job.done) return false;
  if (agent.message === STARTING_MESSAGE) return false;
  return !primaryAgentAction(agent);
}

/** A job is shown while it runs, and after it finished only when it failed. */
export function visibleAgentJob(agent: Pick<AgentInfo, "job">): AgentJobInfo | null {
  const job = agent.job;
  if (!job) return null;
  return !job.done || job.error ? job : null;
}

export function AgentActionButton({
  action,
  agentLabel,
  disabled,
  onRun,
}: {
  action: AgentActionInfo;
  agentLabel: string;
  disabled?: boolean;
  onRun(actionId: string): void;
}) {
  return (
    <button
      type="button"
      aria-label={`${agentLabel} ${action.label}`}
      disabled={disabled}
      onClick={(event) => {
        // Inside a picker row the click must not also select the row.
        event.stopPropagation();
        onRun(action.id);
      }}
      className={
        action.primary
          ? "min-h-11 shrink-0 rounded bg-accent px-3 text-xs text-white disabled:opacity-40"
          : "min-h-11 shrink-0 rounded border border-line px-3 text-xs text-fg hover:border-accent disabled:opacity-40"
      }
    >
      {action.label}
    </button>
  );
}

export function AgentJobProgress({ job }: { job: AgentJobInfo }) {
  const percent =
    typeof job.percent === "number" ? Math.max(0, Math.min(100, Math.round(job.percent))) : null;
  const tail = job.logTail.slice(-3);
  const headline = [job.phase, job.message].filter(Boolean).join(" · ");
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs" aria-label="Agent 任务进度">
      {headline || percent !== null ? (
        <div className="flex items-center gap-2 text-muted">
          <span className="min-w-0 flex-1 truncate">{headline || (job.done ? "已结束" : "进行中")}</span>
          {percent !== null ? <span className="shrink-0 tabular-nums">{percent}%</span> : null}
        </div>
      ) : null}
      {!job.done && job.phase !== "waiting" ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          className="h-1 overflow-hidden rounded bg-raised"
        >
          <div
            className={`h-full bg-accent ${percent === null ? "w-1/3 animate-pulse" : ""}`}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      ) : null}
      {tail.length > 0 ? (
        <pre className="max-h-16 overflow-hidden whitespace-pre-wrap break-all rounded bg-raised px-2 py-1 font-mono text-[11px] text-faint">
          {tail.join("\n")}
        </pre>
      ) : null}
      {job.error ? <p className="whitespace-pre-wrap text-danger">{job.error}</p> : null}
    </div>
  );
}

/**
 * A script Agent that cannot be picked yet, shown where Agents are picked
 * (proposal §8.4): why, and the one button the script marked primary. What the
 * button leads to — an install confirmation, a login — arrives by itself as
 * an Agent request.
 */
export function AgentUnavailableRow({
  agent,
  reason,
  onRun,
}: {
  agent: AgentInfo;
  reason: string;
  onRun(agentId: string, actionId: string): void;
}) {
  const action = primaryAgentAction(agent);
  const job = visibleAgentJob(agent);
  const running = Boolean(agent.job && !agent.job.done);
  return (
    <div role="listitem" className="rounded-lg px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <AgentMark agent={agent} className="h-6 w-6" fallbackToText={false} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-fg">{agent.label}</span>
          <span className="mt-0.5 block truncate text-[10px] text-faint">{agent.message || reason}</span>
        </span>
        {action ? (
          <AgentActionButton
            action={action}
            agentLabel={agent.label}
            disabled={running}
            onRun={(actionId) => onRun(agent.id, actionId)}
          />
        ) : null}
      </div>
      {job ? <AgentJobProgress job={job} /> : null}
    </div>
  );
}
