import type { AgentInfo } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentMark } from "../presentation/AgentMark";
import {
  canStartAgent,
  resolveAgentAvailability,
  resolveAgentPresentation,
} from "../presentation/catalog/resolve";

export function ForkDialog({
  agents,
  sourceAgentId,
  hasNativeCheckpoint,
  onClose,
  onConfirm,
}: {
  agents: AgentInfo[];
  sourceAgentId: string;
  hasNativeCheckpoint: boolean;
  onClose(): void;
  onConfirm(agentId: string): Promise<boolean>;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState(sourceAgentId);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  const native = Boolean(
    selectedAgentId === sourceAgentId &&
      hasNativeCheckpoint &&
      selected?.capabilities.fork,
  );

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
        aria-labelledby="fork-agent-title"
        className="flex max-h-[min(78dvh,44rem)] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="fork-agent-title" className="font-medium text-fg">
              Fork 到 Agent
            </h2>
            <p className="text-xs text-faint">默认沿用当前 Agent，也可以用可见历史重建新会话。</p>
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

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <fieldset disabled={busy}>
            <legend className="text-xs font-medium uppercase tracking-wide text-faint">
              目标 Agent
            </legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {agents.map((agent) => {
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
                        {agent.id === sourceAgentId ? "当前 Agent" : availability?.fullLabel ?? "已就绪"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div
            className={`rounded-xl border px-3 py-3 text-sm ${
              native ? "border-accent/40 bg-accent/10" : "border-line bg-raised/50"
            }`}
          >
            <p className="font-medium text-fg">{native ? "原生分支" : "重建会话"}</p>
            <p className="mt-1 text-xs text-muted">
              {native
                ? "保留当前 Agent 的 checkpoint 和原生线程状态。"
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
            disabled={busy || !selected || !canStartAgent(selected)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              setBusy(true);
              void onConfirm(selectedAgentId).then((created) => {
                if (created) onClose();
                else setBusy(false);
              });
            }}
          >
            {busy ? "正在创建…" : native ? "创建原生分支" : `用 ${selected ? resolveAgentPresentation(selected).label : "Agent"} 重建`}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
