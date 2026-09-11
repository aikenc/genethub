import type { AgentInfo } from "@genehub/proto";
import { useCallback, useId, useRef, useState } from "react";

import { AgentMark } from "../presentation/AgentMark";
import { EffortMeter } from "../presentation/EffortMeter";
import {
  resolveAgentAvailability,
  resolveAgentPresentation,
  resolveAgentProfile,
  resolveEffortBadge,
  resolveModeBadge,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import { resolveRuntimeSelection } from "./runtime-selection";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";

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
  runtimeValues,
  disabled,
  agentLocked,
  onOpenChange,
  onPickAgent,
  onPickModel,
  onPickMode,
  onPickEffort,
  onPickRuntimeAxis,
  onRefreshAgents,
}: {
  agents: AgentInfo[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
  runtimeValues?: Record<string, string> | null;
  disabled?: boolean;
  agentLocked?: boolean;
  onOpenChange?(open: boolean): void;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
  onPickEffort(id: string): void;
  onPickRuntimeAxis?(axisId: string, valueId: string): void;
  onRefreshAgents?(): void;
}) {
  const [open, setOpen] = useState(false);
  const generatedId = useId();
  const panelId = `runtime-settings-${generatedId}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = resolveRuntimeSelection({
    agents,
    agentId,
    modelId,
    modeId,
    effortId,
    runtimeValues,
  });
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
  const runtimeBadges = (selection.current?.catalog.runtimeAxes ?? []).flatMap((axis) => {
    const value = axis.values.find((candidate) => candidate.id === selection.runtimeValues[axis.id]);
    return value ? [{ axis, value }] : [];
  });
  const summary = [
    selection.current
      ? `Agent：${agentPresentation?.label ?? selection.current.id}${agentAvailability ? `（${agentAvailability.fullLabel}）` : ""}`
      : "Agent：未选择",
    model ? `模型：${model.fullLabel}` : null,
    effort ? `思考强度：${effort.fullLabel}` : null,
    ...runtimeBadges.map(({ axis, value }) => `${axis.label}：${value.label}`),
    mode
      ? `${permissionAxis ? "权限" : "模式"}：${mode.fullLabel}`
      : null,
  ]
    .filter(Boolean)
    .join("；");
  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (next) onRefreshAgents?.();
  }, [onOpenChange, onRefreshAgents]);
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
        className="flex h-9 !min-h-0 !min-w-0 flex-1 items-center rounded-md px-1.5 text-left text-[14px] leading-9 text-muted hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted/60 md:h-6 md:text-[12px] md:leading-6"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden opacity-75 md:gap-1.5">
          {selection.current ? (
            <AgentMark
              agent={selection.current}
              className="h-5 w-5 md:h-4 md:w-4"
              textClassName="max-w-24 text-[14px] md:text-[12px]"
              glyphClassName="text-[18px] md:text-[14px]"
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
              className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-muted"
              title={`思考强度：${effort.fullLabel}`}
            >
              <EffortMeter level={effort.level} className="h-3.5 w-3.5 md:h-3 md:w-3" />
              <span aria-hidden>{effort.shortLabel}</span>
            </span>
          ) : null}
          {runtimeBadges.map(({ axis, value }) => (
            <span
              key={axis.id}
              className="shrink-0 whitespace-nowrap text-muted"
              title={`${axis.label}：${value.label}`}
            >
              {value.label}
            </span>
          ))}
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
          onPickRuntimeAxis={onPickRuntimeAxis ?? (() => {})}
          onRefreshAgents={onRefreshAgents}
        />
      ) : null}
    </>
  );
}
