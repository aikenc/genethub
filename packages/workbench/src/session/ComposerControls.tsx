import type { AgentInfo, AgentSelectionPreferences, SessionAgentTarget } from "@genehub/proto";
import { Boxes } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";

import { EffortMeter } from "../presentation/EffortMeter";
import {
  resolveAgentPresentation,
  resolveAgentProfile,
  resolveEffortBadge,
  resolveModeBadge,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import { normalizeTags } from "./capability-preferences";
import { resolveRuntimeSelection } from "./runtime-selection";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";

/** Compact route summary plus the tag/runtime configuration entry. */
export function ComposerControls({
  agents,
  preferences,
  tags,
  mediaTags,
  agentId,
  modelId,
  modeId,
  effortId,
  fast,
  runtimeValues,
  disabled,
  busy,
  onOpenChange,
  onPickTarget,
  onSavePreferences,
  onRefreshAgents,
}: {
  agents: AgentInfo[];
  preferences: AgentSelectionPreferences;
  tags?: string[];
  mediaTags?: string[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
  fast?: boolean | null;
  runtimeValues?: Record<string, string> | null;
  disabled?: boolean;
  /** A turn is in flight: same-Agent runtime picks stay live, cross-Agent ones wait. */
  busy?: boolean;
  onOpenChange?(open: boolean): void;
  onPickTarget?(target: SessionAgentTarget, filterTags: string[]): Promise<void> | void;
  onSavePreferences(preferences: AgentSelectionPreferences): Promise<void> | void;
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
    fast,
    runtimeValues,
  });
  const selectedTags = normalizeTags(
    tags?.length ? tags : preferences.selectedTags?.length ? preferences.selectedTags : ["Flash"],
  );
  const automaticTags = normalizeTags(mediaTags ?? []);
  const agentProfile = selection.current ? resolveAgentProfile(selection.current.id) : null;
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
  const configuredProfile = preferences.modelProfiles?.find(
    (profile) =>
      profile.agentId === selection.current?.id &&
      (profile.modelId ?? null) === (selection.model?.id ?? modelId ?? null),
  );
  const routeLabel = selection.current
    ? `${resolveAgentPresentation(selection.current).label} · ${
        configuredProfile?.displayName?.trim() || (selection.model
          ? resolveModelPresentation({
              agentId: selection.current.id,
              modelId: selection.model.id,
              modelLabel: selection.model.label,
            }).fullLabel
          : modelId ?? "默认")
      }`
    : "未匹配 Agent";
  const summary = [
    `模型：${routeLabel}`,
    `筛选：${[...selectedTags, ...automaticTags].join(" + ") || "无"}`,
    effort ? `思考强度：${effort.fullLabel}` : null,
    mode ? `${permissionAxis ? "权限" : "模式"}：${mode.fullLabel}` : null,
    selection.fast && selection.model?.supportsFast ? "极速模式：已开启" : null,
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
          <Boxes className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span className="truncate text-fg">{routeLabel}</span>
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
          {selection.fast && selection.model?.supportsFast ? (
            <span
              className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-amber-500 font-medium"
              title="极速模式（⚡ Fast）：已开启"
            >
              <span className="text-[12px] leading-none" aria-hidden>⚡</span>
              <span aria-hidden>Fast</span>
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
          tags={selectedTags}
          mediaTags={automaticTags}
          disabled={disabled}
          busy={busy}
          returnFocusRef={trigger}
          onClose={closePanel}
          onPickTarget={async (target, filters) => {
            await onPickTarget?.(target, filters);
          }}
          onSavePreferences={onSavePreferences}
          onRefreshAgents={onRefreshAgents}
        />
      ) : null}
    </>
  );
}
