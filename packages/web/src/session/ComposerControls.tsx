import type { AgentInfo } from "@genehub/proto";

/**
 * Compact agent / model / mode chips that live *inside* the composer.
 *
 * The chat surface stays quiet: these are chrome for the next send, not a
 * second toolbar competing with the timeline.
 */
export function ComposerControls({
  agents,
  agentId,
  modelId,
  modeId,
  disabled,
  agentLocked,
  onPickAgent,
  onPickModel,
  onPickMode,
}: {
  agents: AgentInfo[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  disabled?: boolean;
  /**
   * True once the session has said anything. Picking a different agent here
   * does not hand the conversation over to it — each adapter keeps its own,
   * incompatible idea of "session" (a CLI's own `--resume` id, its own HTTP
   * session, a scratch file), so today it silently opens a *second*, empty
   * session instead. That surprise is worse than not offering the switch, so
   * once there is something to lose, the picker locks instead of lying about
   * what it does (`docs/architecture.md` on cross-agent history).
   */
  agentLocked?: boolean;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
}) {
  const installed = agents.filter((agent) => agent.probe.state === "ready");
  const current = installed.find((agent) => agent.id === agentId) ?? installed[0];

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      <Chip
        ariaLabel="agent"
        value={current?.id ?? ""}
        disabled={disabled || agentLocked}
        title={agentLocked ? "对话已经开始，无法在同一会话里换 agent；新建一个会话即可换" : undefined}
        options={installed.map((agent) => ({ value: agent.id, label: agent.label }))}
        onChange={onPickAgent}
      />
      {current?.capabilities.setModel && current.catalog.models.length > 0 ? (
        <Chip
          ariaLabel="模型"
          value={modelId ?? current.catalog.defaultModel ?? ""}
          disabled={disabled}
          options={current.catalog.models.map((model) => ({
            value: model.id,
            label: model.label,
          }))
          }
          onChange={onPickModel}
        />
      ) : null}
      {current?.capabilities.setMode && current.catalog.modes.length > 0 ? (
        <Chip
          // The protocol has one `mode` axis, but adapters load two different
          // things onto it: genet's modes are thinking-effort levels, while
          // claude/acp reuse it for tool-approval policy (default /
          // acceptEdits). Both used to render as an unlabelled "模式" chip,
          // reading as the same control on every agent when it isn't —
          // `capabilities.permissions` (true only for the approval-policy
          // kind) tells them apart as a stopgap until the protocol splits
          // this into two real fields (tracked in `docs/roadmap.md`).
          ariaLabel="模式"
          label={current.capabilities.permissions ? "权限" : "思考"}
          value={modeId ?? current.catalog.defaultMode ?? ""}
          disabled={disabled}
          options={current.catalog.modes.map((mode) => ({ value: mode.id, label: mode.label }))}
          onChange={onPickMode}
        />
      ) : null}
    </div>
  );
}

function Chip({
  ariaLabel,
  label,
  value,
  options,
  disabled,
  title,
  onChange,
}: {
  ariaLabel: string;
  /** A short visible caption before the value, for chips whose options alone
   * (e.g. "Default" / "Off") don't say what axis they belong to. */
  label?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  title?: string;
  onChange(value: string): void;
}) {
  return (
    <label className="relative inline-flex max-w-[11rem] items-center gap-1" title={title}>
      <span className="sr-only">{ariaLabel}</span>
      {label ? <span className="shrink-0 text-[10px] text-faint">{label}</span> : null}
      <select
        aria-label={ariaLabel}
        className="appearance-none truncate rounded-full bg-transparent py-0.5 pl-2 pr-5 text-xs text-muted outline-none hover:bg-raised hover:text-fg disabled:opacity-40"
        value={value}
        disabled={disabled || options.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-1.5 text-[9px] text-faint" aria-hidden>
        ▾
      </span>
    </label>
  );
}
