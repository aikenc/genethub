import type { AgentInfo, WorkspaceInfo } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentMark } from "../presentation/AgentMark";
import {
  canStartAgent,
  resolveAgentAvailability,
  resolveAgentPresentation,
} from "../presentation/catalog/resolve";

export interface ForkMachineOption {
  /** Daemon identity. Unlike routeId, this is stable across connection paths. */
  id: string;
  /** Host-owned locator used to open the machine. */
  routeId: string;
  label: string;
  kind: "local" | "remote";
  online?: boolean;
}

export interface ForkCatalog {
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
}

export interface ForkSelection {
  machine: ForkMachineOption;
  workspaceId: string;
  agentId: string;
}

export function ForkDialog({
  sourceMachine,
  sourceWorkspaceId,
  sourceAgentId,
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
  sourceCatalog: ForkCatalog;
  hasNativeCheckpoint: boolean;
  listMachines?(): Promise<ForkMachineOption[]>;
  loadCatalog?(machine: ForkMachineOption): Promise<ForkCatalog>;
  onClose(): void;
  onConfirm(selection: ForkSelection): Promise<boolean>;
}) {
  const [machines, setMachines] = useState([sourceMachine]);
  const [selectedMachineId, setSelectedMachineId] = useState(sourceMachine.id);
  const [catalog, setCatalog] = useState<ForkCatalog>(sourceCatalog);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(sourceWorkspaceId);
  const [selectedAgentId, setSelectedAgentId] = useState(sourceAgentId);
  const [loadingMachines, setLoadingMachines] = useState(Boolean(listMachines));
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const catalogRequest = useRef(0);

  useEffect(() => {
    if (!listMachines) return;
    let cancelled = false;
    void listMachines()
      .then((found) => {
        if (cancelled) return;
        const byId = new Map(found.map((machine) => [machine.id, machine]));
        byId.set(sourceMachine.id, {
          ...byId.get(sourceMachine.id),
          ...sourceMachine,
        });
        setMachines([...byId.values()]);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(message(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingMachines(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listMachines, sourceMachine]);

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

  const pickMachine = (machine: ForkMachineOption) => {
    if (machine.id === selectedMachineId || machine.online === false) return;
    setSelectedMachineId(machine.id);
    setProblem(null);
    const request = ++catalogRequest.current;
    if (machine.id === sourceMachine.id) {
      setCatalog(sourceCatalog);
      setSelectedWorkspaceId(sourceWorkspaceId);
      setSelectedAgentId(sourceAgentId);
      setLoadingCatalog(false);
      return;
    }
    if (!loadCatalog) return;
    setLoadingCatalog(true);
    setCatalog({ agents: [], workspaces: [] });
    void loadCatalog(machine)
      .then((loaded) => {
        if (catalogRequest.current !== request) return;
        setCatalog(loaded);
        setSelectedWorkspaceId(
          loaded.workspaces.some((workspace) => workspace.id === sourceWorkspaceId)
            ? sourceWorkspaceId
            : (loaded.workspaces[0]?.id ?? ""),
        );
        setSelectedAgentId(
          loaded.agents.some((agent) => agent.id === sourceAgentId && canStartAgent(agent))
            ? sourceAgentId
            : (loaded.agents.find(canStartAgent)?.id ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (catalogRequest.current === request) setProblem(message(error));
      })
      .finally(() => {
        if (catalogRequest.current === request) setLoadingCatalog(false);
      });
  };

  const selectedMachine =
    machines.find((machine) => machine.id === selectedMachineId) ?? sourceMachine;
  const selectedAgent = catalog.agents.find((agent) => agent.id === selectedAgentId);
  const selectedWorkspace = catalog.workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );
  const unchanged =
    selectedMachine.id === sourceMachine.id &&
    selectedWorkspaceId === sourceWorkspaceId &&
    selectedAgentId === sourceAgentId;
  const native = Boolean(
    unchanged && hasNativeCheckpoint && selectedAgent?.capabilities.fork,
  );
  const currentUnavailable = unchanged && !native;
  const valid = Boolean(
    selectedMachine.online !== false &&
      selectedWorkspace &&
      selectedAgent &&
      canStartAgent(selectedAgent),
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
              保持全部目标不变时走原生 Fork；切换 Agent、机器或工作区会重建会话。
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
          <fieldset disabled={busy || loadingMachines}>
            <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标机器</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {machines.map((machine) => (
                <label
                  key={machine.id}
                  className="flex min-h-14 cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                >
                  <input
                    type="radio"
                    name="fork-machine"
                    value={machine.id}
                    aria-label={`${machine.label}${machine.online === false ? " 离线" : ""}`}
                    checked={machine.id === selectedMachineId}
                    disabled={machine.online === false}
                    onChange={() => pickMachine(machine)}
                    className="sr-only"
                  />
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${machine.online === false ? "bg-faint" : "bg-ok"}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-fg">{machine.label}</span>
                    <span className="block text-[10px] text-faint">
                      {machine.id === sourceMachine.id ? "当前机器" : machine.online === false ? "离线" : "可连接"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {loadingMachines ? <p className="mt-2 text-xs text-faint">正在读取机器列表…</p> : null}
          </fieldset>

          <fieldset disabled={busy || loadingCatalog}>
            <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标工作区</legend>
            {loadingCatalog ? (
              <p className="mt-2 text-xs text-faint">正在读取目标机器…</p>
            ) : catalog.workspaces.length > 0 ? (
              <select
                aria-label="目标工作区"
                value={selectedWorkspaceId}
                onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                className="mt-2 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              >
                {catalog.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name} — {workspace.root}</option>
                ))}
              </select>
            ) : (
              <p className="mt-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                目标机器没有可用工作区。
              </p>
            )}
          </fieldset>

          <fieldset disabled={busy || loadingCatalog}>
            <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标 Agent</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {catalog.agents.map((agent) => {
                const presentation = resolveAgentPresentation(agent);
                const availability = resolveAgentAvailability(agent);
                return (
                  <label
                    key={agent.id}
                    className="flex min-h-16 cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                  >
                    <input
                      type="radio"
                      name="fork-agent"
                      value={agent.id}
                      aria-label={`${presentation.label}${availability ? ` ${availability.fullLabel}` : ""}`}
                      checked={agent.id === selectedAgentId}
                      disabled={!canStartAgent(agent)}
                      onChange={() => setSelectedAgentId(agent.id)}
                      className="sr-only"
                    />
                    {presentation.kind === "text" ? null : (
                      <AgentMark agent={agent} className="h-6 w-6" fallbackToText={false} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-fg">{presentation.label}</span>
                      <span className={`block text-[10px] ${availability ? "text-danger" : "text-faint"}`}>
                        {agent.id === sourceAgentId && selectedMachine.id === sourceMachine.id
                          ? "当前 Agent"
                          : availability?.fullLabel ?? "已就绪"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {problem ? <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{problem}</p> : null}

          <div className={`rounded-xl border px-3 py-3 text-sm ${
            native
              ? "border-accent/40 bg-accent/10"
              : currentUnavailable
                ? "border-danger/30 bg-danger/10"
                : "border-line bg-raised/50"
          }`}>
            <p className="font-medium text-fg">
              {native ? "原生分支" : currentUnavailable ? "当前回合不可原生 Fork" : "重建会话"}
            </p>
            <p className="mt-1 text-xs text-muted">
              {native
                ? "保留当前 Agent 的 checkpoint 和原生线程状态。"
                : currentUnavailable
                  ? "当前 Agent 没有这个回合的原生 checkpoint。请选择其他 Agent、机器或工作区。"
                  : "完整历史仍留在 GeneHub；目标 Agent 接收受预算约束的可见历史胶囊，默认不超过上下文窗口的 35%。"}
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
            disabled={busy || loadingCatalog || !valid || currentUnavailable}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              setBusy(true);
              setProblem(null);
              void onConfirm({
                machine: selectedMachine,
                workspaceId: selectedWorkspaceId,
                agentId: selectedAgentId,
              })
                .then((created) => {
                  if (created) onClose();
                  else setBusy(false);
                })
                .catch((error: unknown) => {
                  setProblem(message(error));
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

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
