import type { AgentInfo } from "@genehub/proto";

/**
 * Agent, model and mode pickers.
 *
 * Every control here is rendered from the agent's declared `Capabilities`. An
 * agent that cannot switch models simply has no model picker — the user never
 * gets offered a button that answers "unsupported" (`architecture.md` §3.2).
 */
export function AgentControls({
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
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2 text-xs">
      <Select
        label="agent"
        value={current?.id ?? ""}
        disabled={disabled}
        options={installed.map((agent) => ({ value: agent.id, label: agent.label }))}
        onChange={onPickAgent}
      />

      {current?.capabilities.setModel && current.catalog.models.length > 0 ? (
        <Select
          label="模型"
          value={modelId ?? current.catalog.defaultModel ?? ""}
          disabled={disabled}
          options={current.catalog.models.map((model) => ({
            value: model.id,
            label: model.label,
          }))}
          onChange={onPickModel}
        />
      ) : null}

      {current?.capabilities.setMode && current.catalog.modes.length > 0 ? (
        <Select
          label="模式"
          value={modeId ?? current.catalog.defaultMode ?? ""}
          disabled={disabled}
          options={current.catalog.modes.map((mode) => ({ value: mode.id, label: mode.label }))}
          onChange={onPickMode}
        />
      ) : null}
    </div>
  );
}

function Select({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  return (
    <label className="flex items-center gap-1 text-muted">
      {label}
      <select
        className="rounded border border-line bg-bg px-2 py-1 text-fg"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
