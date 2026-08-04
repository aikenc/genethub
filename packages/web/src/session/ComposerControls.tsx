import type { AgentInfo, ModeInfo, ModelInfo } from "@genehub/proto";
import { useCallback, useRef, useState } from "react";

import { AgentMark } from "../presentation/AgentMark";
import {
  resolveAgentAvailability,
  resolveEffortBadge,
  resolveModeBadge,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import { defaultAgent } from "./store";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";

export interface RuntimeSelection {
  current: AgentInfo | undefined;
  installed: AgentInfo[];
  model: ModelInfo | undefined;
  modelAvailable: boolean;
  mode: ModeInfo | undefined;
  modeAvailable: boolean;
  effortId: string | null;
}

/** Resolve exactly what the footer and the settings panel describe.
 *
 * A historical model or mode can disappear from a dynamic catalog. Keep its
 * real id visible instead of silently presenting the new default as if the
 * session had switched itself.
 */
export function resolveRuntimeSelection({
  agents,
  agentId,
  modelId,
  modeId,
  effortId,
}: {
  agents: AgentInfo[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
}): RuntimeSelection {
  const installed = agents.filter((agent) => agent.probe.state === "ready");
  const selected = agents.find((agent) => agent.id === agentId);
  const current = selected ?? defaultAgent(agents) ?? installed[0];
  const catalogModel = current?.catalog.models.find((candidate) => candidate.id === modelId);
  const fallbackModel =
    current?.catalog.models.find((candidate) => candidate.id === current.catalog.defaultModel) ??
    current?.catalog.models[0];
  const missingModel =
    modelId && !catalogModel
      ? { id: modelId, label: modelId, contextWindow: undefined, reasoning: false, efforts: [] }
      : undefined;
  const model = catalogModel ?? missingModel ?? fallbackModel;
  const catalogMode = current?.catalog.modes.find((candidate) => candidate.id === modeId);
  const fallbackMode =
    current?.catalog.modes.find((candidate) => candidate.id === current.catalog.defaultMode) ??
    current?.catalog.modes[0];
  const missingMode =
    modeId && !catalogMode ? { id: modeId, label: modeId, description: undefined } : undefined;

  return {
    current,
    installed,
    model,
    modelAvailable: Boolean(catalogModel ?? (!modelId && fallbackModel)),
    mode: catalogMode ?? missingMode ?? fallbackMode,
    modeAvailable: Boolean(catalogMode ?? (!modeId && fallbackMode)),
    effortId: effortId ?? current?.catalog.defaultEffort ?? null,
  };
}

/** One quiet, non-wrapping summary in the composer footer.
 *
 * The full catalog remains available in `RuntimeSettingsPanel`; focusing the
 * textarea no longer unfolds four native selects into the conversation.
 */
export function ComposerControls({
  agents,
  agentId,
  modelId,
  modeId,
  effortId,
  disabled,
  agentLocked,
  onOpenChange,
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
  agentLocked?: boolean;
  onOpenChange?(open: boolean): void;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
  onPickEffort(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = resolveRuntimeSelection({ agents, agentId, modelId, modeId, effortId });
  const model = selection.model
    ? resolveModelPresentation({
        agentId: selection.current?.id ?? null,
        modelId: selection.model.id,
        modelLabel: selection.model.label,
      })
    : null;
  const agentAvailability = selection.current
    ? resolveAgentAvailability(selection.current)
    : null;
  const effort =
    selection.current?.capabilities.setEffort && (selection.model?.efforts.length ?? 0) > 0
    ? resolveEffortBadge(selection.effortId)
    : null;
  const mode = selection.current?.capabilities.setMode && selection.mode
    ? resolveModeBadge({
        agentId: selection.current.id,
        permissions: selection.current.capabilities.permissions,
        modeId: selection.mode?.id,
        modeLabel: selection.mode?.label,
      })
    : null;
  const summary = [
    selection.current
      ? `Agent：${selection.current.label}${agentAvailability ? `（${agentAvailability.fullLabel}）` : ""}`
      : "Agent：未选择",
    model ? `模型：${model.fullLabel}` : null,
    effort ? `思考强度：${effort.fullLabel}` : null,
    mode
      ? `${selection.current?.capabilities.permissions ? "权限" : "模式"}：${mode.fullLabel}`
      : null,
  ]
    .filter(Boolean)
    .join("；");
  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);
  const closePanel = useCallback(() => setPanelOpen(false), [setPanelOpen]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="runtime-settings"
        onClick={() => setPanelOpen(true)}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-xl px-2 text-left text-muted hover:bg-raised hover:text-fg md:min-h-8"
      >
        {selection.current ? <AgentMark agent={selection.current} /> : null}
        {agentAvailability ? (
          <span
            className="shrink-0 whitespace-nowrap text-xs text-danger"
            title={agentAvailability.fullLabel}
          >
            {agentAvailability.shortLabel}
          </span>
        ) : null}
        {model ? (
          <span className="min-w-0 truncate text-xs text-muted" title={model.fullLabel}>
            {model.shortLabel}
          </span>
        ) : null}
        {effort ? (
          <span
            className="shrink-0 whitespace-nowrap text-xs text-muted"
            title={`思考强度：${effort.fullLabel}`}
          >
            <span aria-hidden>{effort.emoji}</span>
            <span>{effort.shortLabel}</span>
          </span>
        ) : null}
        {mode ? (
          <span
            className="shrink-0 whitespace-nowrap text-xs text-muted"
            title={`${selection.current?.capabilities.permissions ? "权限" : "模式"}：${mode.fullLabel}`}
          >
            <span aria-hidden>{mode.emoji}</span>
            <span className="max-[360px]:sr-only">{mode.shortLabel}</span>
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[10px] text-faint" aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <RuntimeSettingsPanel
          id="runtime-settings"
          selection={selection}
          disabled={disabled}
          agentLocked={agentLocked}
          returnFocusRef={trigger}
          onClose={closePanel}
          onPickAgent={onPickAgent}
          onPickModel={onPickModel}
          onPickMode={onPickMode}
          onPickEffort={onPickEffort}
        />
      ) : null}
    </>
  );
}
