import type {
  AgentCapability,
  AgentInfo,
  AgentSelectionPreferences,
} from "@genehub/proto";
import { Brain, Code2, ScanSearch } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";

import { EffortMeter } from "../presentation/EffortMeter";
import {
  resolveAgentProfile,
  resolveEffortBadge,
  resolveModeBadge,
} from "../presentation/catalog/resolve";
import { capabilityLabel } from "./capability-preferences";
import { resolveRuntimeSelection } from "./runtime-selection";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";

/** One capability-first summary in the composer footer. */
export function ComposerControls({
  agents,
  preferences,
  capability,
  agentId,
  modelId,
  modeId,
  effortId,
  runtimeValues,
  disabled,
  agentLocked,
  onOpenChange,
  onPickCapability,
  onSavePreferences,
  onPickMode,
  onPickEffort,
  onPickRuntimeAxis,
  onRefreshAgents,
}: {
  agents: AgentInfo[];
  preferences: AgentSelectionPreferences;
  capability: AgentCapability;
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
  runtimeValues?: Record<string, string> | null;
  disabled?: boolean;
  agentLocked?: boolean;
  onOpenChange?(open: boolean): void;
  onPickCapability(capability: AgentCapability): void;
  onSavePreferences(preferences: AgentSelectionPreferences): Promise<void> | void;
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
  const agentProfile = selection.current
    ? resolveAgentProfile(selection.current.id)
    : null;
  const permissionAxis = Boolean(
    selection.current?.capabilities.permissions && agentProfile?.modeKind === "permission",
  );
  const effort =
    selection.current?.capabilities.setEffort && (selection.model?.efforts.length ?? 0) > 0
      ? resolveEffortBadge(selection.effortId)
      : null;
  const mode =
    selection.current?.capabilities.setMode && selection.mode
      ? resolveModeBadge({
          agentId: selection.current.id,
          permissions: permissionAxis,
          modeId: selection.mode.id,
          modeLabel: selection.mode.label,
        })
      : null;
  const summary = [
    `能力：${capabilityLabel(capability)}`,
    effort ? `思考强度：${effort.fullLabel}` : null,
    mode ? `${permissionAxis ? "权限" : "模式"}：${mode.fullLabel}` : null,
  ]
    .filter(Boolean)
    .join("；");
  const setPanelOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
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
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden opacity-80">
          <CapabilityIcon capability={capability} />
          <span className="truncate text-fg">{capabilityLabel(capability)}</span>
          {effort ? (
            <span
              className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-muted"
              title={`思考强度：${effort.fullLabel}`}
            >
              <EffortMeter level={effort.level} className="h-3.5 w-3.5 md:h-3 md:w-3" />
              <span aria-hidden>{effort.shortLabel}</span>
            </span>
          ) : null}
          {mode ? (
            <span
              className="shrink-0 whitespace-nowrap text-muted"
              title={`${permissionAxis ? "权限" : "模式"}：${mode.fullLabel}`}
              aria-hidden
            >
              {mode.emoji}
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
          agents={agents}
          preferences={preferences}
          capability={capability}
          disabled={disabled}
          agentLocked={agentLocked}
          returnFocusRef={trigger}
          onClose={closePanel}
          onPickCapability={onPickCapability}
          onSavePreferences={onSavePreferences}
          onPickMode={onPickMode}
          onPickEffort={onPickEffort}
          onPickRuntimeAxis={onPickRuntimeAxis ?? (() => {})}
          onRefreshAgents={onRefreshAgents}
        />
      ) : null}
    </>
  );
}

function CapabilityIcon({ capability }: { capability: AgentCapability }) {
  const className = "h-4 w-4 shrink-0 text-accent";
  if (capability === "planning") return <Brain className={className} aria-hidden />;
  if (capability === "coding") return <Code2 className={className} aria-hidden />;
  return <ScanSearch className={className} aria-hidden />;
}
