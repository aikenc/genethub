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
  effortId,
  disabled,
  agentLocked,
  onPickAgent,
  onPickModel,
  onPickMode,
  onPickEffort,
}: {
  agents: AgentInfo[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
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
  onPickEffort(id: string): void;
}) {
  const installed = agents.filter((agent) => agent.probe.state === "ready");
  const current = installed.find((agent) => agent.id === agentId) ?? installed[0];
  const model =
    current?.catalog.models.find((candidate) => candidate.id === modelId) ??
    current?.catalog.models.find((candidate) => candidate.id === current?.catalog.defaultModel) ??
    current?.catalog.models[0];
  // The levels belong to the model, not to the agent: on Claude Code each model
  // names its own, and a model with none should not be offered the control.
  const efforts = model?.efforts ?? [];

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
      {current?.capabilities.setEffort && efforts.length > 0 ? (
        <Chip
          ariaLabel="思考强度"
          label="思考"
          value={effortId ?? current.catalog.defaultEffort ?? ""}
          disabled={disabled}
          options={[
            // Only when nothing is chosen and the agent did not say what its own
            // default is: showing the weakest level as if it were in force would
            // be a wrong answer rather than an unknown one (Claude Code does not
            // report which level it is on).
            ...(effortId ?? current.catalog.defaultEffort
              ? []
              : [{ value: "", label: "默认" }]),
            ...efforts.map((effort) => ({ value: effort, label: effort })),
          ]}
          onChange={(value) => {
            // The placeholder is not a level anyone can be switched to.
            if (value) onPickEffort(value);
          }}
        />
      ) : null}
      {current?.capabilities.setMode && current.catalog.modes.length > 0 ? (
        <Chip
          // Modes are now only ever tool-approval policy: the thinking axis moved
          // to `efforts`, so this chip no longer means two different things
          // depending on which agent you were talking to.
          ariaLabel="模式"
          label={current.capabilities.permissions ? "权限" : "模式"}
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
