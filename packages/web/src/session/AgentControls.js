import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Agent, model and mode pickers.
 *
 * Every control here is rendered from the agent's declared `Capabilities`. An
 * agent that cannot switch models simply has no model picker — the user never
 * gets offered a button that answers "unsupported" (`architecture.md` §3.2).
 */
export function AgentControls({ agents, agentId, modelId, modeId, disabled, onPickAgent, onPickModel, onPickMode, }) {
    const installed = agents.filter((agent) => agent.probe.state === "ready");
    const current = installed.find((agent) => agent.id === agentId) ?? installed[0];
    return (_jsxs("div", { className: "flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2 text-xs", children: [_jsx(Select, { label: "agent", value: current?.id ?? "", disabled: disabled, options: installed.map((agent) => ({ value: agent.id, label: agent.label })), onChange: onPickAgent }), current?.capabilities.setModel && current.catalog.models.length > 0 ? (_jsx(Select, { label: "\u6A21\u578B", value: modelId ?? current.catalog.defaultModel ?? "", disabled: disabled, options: current.catalog.models.map((model) => ({
                    value: model.id,
                    label: model.label,
                })), onChange: onPickModel })) : null, current?.capabilities.setMode && current.catalog.modes.length > 0 ? (_jsx(Select, { label: "\u6A21\u5F0F", value: modeId ?? current.catalog.defaultMode ?? "", disabled: disabled, options: current.catalog.modes.map((mode) => ({ value: mode.id, label: mode.label })), onChange: onPickMode })) : null] }));
}
function Select({ label, value, options, disabled, onChange, }) {
    return (_jsxs("label", { className: "flex items-center gap-1 text-muted", children: [label, _jsx("select", { className: "rounded border border-line bg-bg px-2 py-1 text-fg", "aria-label": label, value: value, disabled: disabled, onChange: (event) => onChange(event.target.value), children: options.map((option) => (_jsx("option", { value: option.value, children: option.label }, option.value))) })] }));
}
