import type { ForkTarget } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  MachineGrid,
  useMachineCatalog,
  WorkspaceList,
  type MachineCatalog,
  type MachineOption,
} from "./MachineCatalogPicker";
import { ModelPicker } from "./ModelPicker";

export type ForkMachineOption = MachineOption;
export type ForkCatalog = MachineCatalog;

export interface ForkSelection {
  machine: ForkMachineOption;
  workspaceId: string;
  target: ForkTarget | null;
}

export function ForkDialog({
  sourceMachine,
  sourceWorkspaceId,
  sourceAgentId,
  sourceModelId,
  sourceTags,
  sourceMediaTags = [],
  sourceCatalog,
  hasNativeCheckpoint,
  listMachines,
  loadCatalog,
  onClose,
  onConfirm,
}: {
  sourceMachine: ForkMachineOption;
  sourceWorkspaceId: string;
  sourceAgentId: string;
  sourceModelId: string | null;
  sourceTags?: string[];
  sourceMediaTags?: string[];
  sourceCatalog: ForkCatalog;
  hasNativeCheckpoint: boolean;
  listMachines?(): Promise<ForkMachineOption[]>;
  loadCatalog?(machine: ForkMachineOption): Promise<ForkCatalog>;
  onClose(): void;
  onConfirm(selection: ForkSelection): Promise<boolean>;
}) {
  const {
    machines,
    selectedMachine,
    catalog,
    workspaceId: selectedWorkspaceId,
    setWorkspaceId: setSelectedWorkspaceId,
    tags: selectedTags,
    setTags: setSelectedTags,
    preferences,
    route: selectedRoute,
    pickRoute,
    loadingMachines,
    loadingCatalog,
    problem,
    setProblem,
    pickMachine,
  } = useMachineCatalog({
    sourceMachine,
    sourceCatalog,
    sourceWorkspaceId,
    sourceTags,
    automaticTags: sourceMediaTags,
    sourceAgentId,
    sourceModelId,
    listMachines,
    loadCatalog,
  });
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", dismiss);
    const frame = window.requestAnimationFrame(() => {
      const checked = dialog.current?.querySelector<HTMLInputElement>(
        'input[type="radio"]:checked:not(:disabled)',
      );
      (checked ?? close.current)?.focus();
    });
    return () => {
      document.removeEventListener("keydown", dismiss);
      window.cancelAnimationFrame(frame);
    };
  }, [busy, onClose]);

  const selectedWorkspace = catalog.workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );
  const unchanged =
    selectedMachine.id === sourceMachine.id &&
    selectedWorkspaceId === sourceWorkspaceId &&
    selectedRoute?.agent.id === sourceAgentId &&
    selectedRoute?.modelId === sourceModelId;
  const native = Boolean(
    unchanged && hasNativeCheckpoint && selectedRoute?.agent.capabilities.fork,
  );
  const valid = Boolean(
    selectedMachine.online !== false &&
      selectedWorkspace &&
      selectedRoute,
  );

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fork-title"
        className="flex max-h-[min(88dvh,52rem)] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="fork-title" className="font-medium text-fg">Fork 会话</h2>
            <p className="text-xs text-faint">
              当前 Agent 有原生 checkpoint 时走原生 Fork；否则重建会话，包括 Fork 回原 Agent。
            </p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label="关闭 Fork 设置"
            disabled={busy}
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <MachineGrid
            machines={machines}
            selectedMachineId={selectedMachine.id}
            sourceMachineId={sourceMachine.id}
            disabled={busy || loadingMachines}
            loading={loadingMachines}
            onPick={pickMachine}
          />

          <WorkspaceList
            workspaces={catalog.workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            disabled={busy || loadingCatalog}
            loading={loadingCatalog}
            onSelect={setSelectedWorkspaceId}
          />

          <fieldset disabled={busy || loadingCatalog}>
            <legend className="text-xs font-medium uppercase tracking-wide text-faint">模型选择</legend>
            <div className="mt-2">
          <ModelPicker
            agents={catalog.agents}
            preferences={preferences}
            filterTags={selectedTags}
            automaticTags={sourceMediaTags}
            disabled={busy || loadingCatalog}
            selected={{
              agentId: selectedRoute?.agent.id ?? null,
              modelId: selectedRoute?.modelId ?? null,
            }}
            onFilterTags={setSelectedTags}
            onSelect={pickRoute}
          />
            </div>
          </fieldset>

          {problem ? <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{problem}</p> : null}

          <div className={`rounded-xl border px-3 py-3 text-sm ${
            native ? "border-accent/40 bg-accent/10" : "border-line bg-raised/50"
          }`}>
            <p className="font-medium text-fg">
              {native ? "原生分支" : "重建会话"}
            </p>
            <p className="mt-1 text-xs text-muted">
              {native
                ? "保留当前 Agent 的 checkpoint 和原生线程状态。"
                : "完整历史仍留在 GeneHub；目标 Agent 接收受预算约束的可见历史胶囊，默认不超过上下文窗口的 35%。没有原生 Fork 的 Agent 也会走这条路径。"}
            </p>
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || loadingCatalog || !valid}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              if (!selectedRoute) return;
              const target = native
                ? null
                : {
                    agentId: selectedRoute.agent.id,
                    workspaceId: selectedWorkspaceId,
                    ...(selectedRoute.modelId ? { modelId: selectedRoute.modelId } : {}),
                    ...(selectedRoute.modeId ? { modeId: selectedRoute.modeId } : {}),
                    ...(selectedRoute.effortId ? { effortId: selectedRoute.effortId } : {}),
                    runtimeValues: selectedRoute.runtimeValues,
                  };
              setBusy(true);
              setProblem(null);
              void onConfirm({
                machine: selectedMachine,
                workspaceId: selectedWorkspaceId,
                target,
              })
                .then((created) => {
                  if (created) onClose();
                  else setBusy(false);
                })
                .catch((error: unknown) => {
                  setProblem(error instanceof Error ? error.message : String(error));
                  setBusy(false);
                });
            }}
          >
            {busy ? "正在创建…" : native ? "创建原生分支" : "重建到所选目标"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
