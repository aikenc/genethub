import type { AgentInfo, ModeInfo, ModelInfo } from "@genehub/proto";
import { useCallback, useId, useRef, useState } from "react";

import { AgentMark } from "../presentation/AgentMark";
import {
  resolveAgentAvailability,
  resolveAgentPresentation,
  resolveAgentProfile,
  resolveEffortBadge,
  resolveModeBadge,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import { defaultAgent } from "./store";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";

export interface RuntimeSelection {
  current: AgentInfo | undefined;
  agents: AgentInfo[];
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
  const ready = agents.filter((agent) => agent.probe.state === "ready");
  const selected = agents.find((agent) => agent.id === agentId);
  const removed = agentId && !selected ? removedAgent(agentId) : undefined;
  const current = selected ?? removed ?? defaultAgent(agents) ?? ready[0];
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
    agents: removed ? [removed, ...agents] : agents,
    model,
    modelAvailable: Boolean(catalogModel ?? (!modelId && fallbackModel)),
    mode: catalogMode ?? missingMode ?? fallbackMode,
    modeAvailable: Boolean(catalogMode ?? (!modeId && fallbackMode)),
    effortId: effortId ?? current?.catalog.defaultEffort ?? null,
  };
}

/** Keep a historical/custom Agent honest after it has been removed from the
 * daemon configuration. Falling through to the default used to relabel old
 * sessions as Codex or Genet. */
function removedAgent(id: string): AgentInfo {
  return {
    id,
    label: id,
    builtin: false,
    probe: { state: "unavailable", reason: "已从当前 Agent 配置中移除" },
    capabilities: {
      interrupt: false,
      setModel: false,
      setEffort: false,
      setMode: false,
      permissions: false,
      resume: false,
      fork: false,
      attachments: false,
    },
    catalog: {
      models: [],
      modes: [],
      commands: [],
      defaultModel: undefined,
      defaultMode: undefined,
      defaultEffort: undefined,
    },
    // Gone from the daemon, so there is nothing to probe, sign in, or guide:
    // the fields below exist so the row renders, not because anyone can act.
    platform: "linux",
    version: undefined,
    auth: "unknown",
    setup: { install: [] },
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
  compact = false,
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
  /** Idle composer treatment: one very small metadata strip under the input. */
  compact?: boolean;
  disabled?: boolean;
  agentLocked?: boolean;
  onOpenChange?(open: boolean): void;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
  onPickEffort(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const generatedId = useId();
  const panelId = `runtime-settings-${generatedId}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = resolveRuntimeSelection({ agents, agentId, modelId, modeId, effortId });
  const agentPresentation = selection.current
    ? resolveAgentPresentation(selection.current)
    : null;
  const agentProfile = selection.current
    ? resolveAgentProfile(selection.current.id)
    : null;
  const permissionAxis = Boolean(
    selection.current?.capabilities.permissions && agentProfile?.modeKind === "permission",
  );
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
        permissions: permissionAxis,
        modeId: selection.mode?.id,
        modeLabel: selection.mode?.label,
      })
    : null;
  const summary = [
    selection.current
      ? `Agent：${agentPresentation?.label ?? selection.current.id}${agentAvailability ? `（${agentAvailability.fullLabel}）` : ""}`
      : "Agent：未选择",
    model ? `模型：${model.fullLabel}` : null,
    effort ? `思考强度：${effort.fullLabel}` : null,
    mode
      ? `${permissionAxis ? "权限" : "模式"}：${mode.fullLabel}`
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
        aria-controls={panelId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setPanelOpen(true)}
        className={`flex !min-h-0 !min-w-0 flex-1 items-center text-left text-muted hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 ${
          compact
            ? "relative h-[18px] min-h-0 rounded px-1 text-[14px] leading-[18px] after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] md:h-3 md:text-[11px] md:leading-3"
            : "h-9 min-h-0 rounded-md px-1.5 text-[14px] leading-9 md:h-6 md:text-[12px] md:leading-6"
        }`}
      >
        <span
          className={`flex min-w-0 flex-1 items-center overflow-hidden opacity-75 ${
            compact ? "gap-1.5 md:gap-1" : "gap-2 md:gap-1.5"
          }`}
        >
          {selection.current ? (
            <AgentMark
              agent={selection.current}
              className={compact ? "h-4 w-4 md:h-3 md:w-3" : "h-5 w-5 md:h-4 md:w-4"}
              textClassName={compact ? "max-w-16 text-[14px] md:text-[11px]" : "max-w-24 text-[14px] md:text-[12px]"}
              glyphClassName={compact ? "text-[14px] md:text-[11px]" : "text-[18px] md:text-[14px]"}
            />
          ) : null}
          {agentAvailability ? (
            <span
              className="shrink-0 whitespace-nowrap text-danger"
              title={agentAvailability.fullLabel}
            >
              {agentAvailability.shortLabel}
            </span>
          ) : null}
          {model ? (
            <span className="min-w-0 truncate text-muted" title={model.fullLabel}>
              {model.shortLabel}
            </span>
          ) : selection.current && agentPresentation && agentPresentation.kind !== "text" ? (
            <span className="min-w-0 truncate text-muted" title={agentPresentation.label}>
              {agentPresentation.label}
            </span>
          ) : null}
          {effort ? (
            <span
              className="shrink-0 whitespace-nowrap text-muted"
              title={`思考强度：${effort.fullLabel}`}
            >
              <span aria-hidden>{effort.emoji}{effort.shortLabel}</span>
            </span>
          ) : null}
          {mode ? (
            <span
              className="shrink-0 whitespace-nowrap text-muted"
              title={`${permissionAxis ? "权限" : "模式"}：${mode.fullLabel}`}
            >
              <span aria-hidden>{mode.emoji}</span>
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-[12px] text-faint md:text-[8px]" aria-hidden>
            ▾
          </span>
        </span>
      </button>

      {open ? (
        <RuntimeSettingsPanel
          id={panelId}
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
