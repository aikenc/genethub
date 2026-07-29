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
  onPickAgent,
  onPickModel,
  onPickMode,
}: {
  agents: AgentInfo[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  disabled?: boolean;
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
        disabled={disabled}
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
          ariaLabel="模式"
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
  value,
  options,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  return (
    <label className="relative inline-flex max-w-[10rem] items-center">
      <span className="sr-only">{ariaLabel}</span>
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
