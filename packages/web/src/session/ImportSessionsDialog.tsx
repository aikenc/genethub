import type { SessionImportListing } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useWorkbench } from "./store";

export function ImportSessionsDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose(): void;
}) {
  const listImportableSessions = useWorkbench((state) => state.listImportableSessions);
  const importSessionCandidate = useWorkbench((state) => state.importSessionCandidate);
  const [listing, setListing] = useState<SessionImportListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);

  const refresh = () => {
    setLoading(true);
    void listImportableSessions(workspaceId).then((result) => {
      setListing(result);
      setLoading(false);
    });
  };

  useEffect(() => {
    refresh();
    // The RPC method is a stable Zustand action; the workspace is the only
    // discovery scope that should reopen this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", dismiss);
    close.current?.focus();
    return () => document.removeEventListener("keydown", dismiss);
  }, [busy, onClose]);

  if (typeof document === "undefined") return null;
  const total = listing?.sources.reduce((count, source) => count + source.candidates.length, 0) ?? 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-sessions-title"
        className="flex max-h-[min(82dvh,46rem)] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="import-sessions-title" className="font-medium text-fg">
              导入 Agent 历史
            </h2>
            <p className="text-xs text-faint">
              先列出轻量候选；只有选中的会话才读取完整历史。
            </p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label="关闭导入历史"
            disabled={Boolean(busy)}
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {loading ? <p className="py-8 text-center text-sm text-muted">正在读取 Agent 会话列表…</p> : null}
          {!loading && !listing ? (
            <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-3 text-sm text-danger">
              无法读取导入列表。可查看日志后重试。
            </div>
          ) : null}
          {!loading
            ? listing?.sources.map((source) => (
                <section key={source.agentId} className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium text-fg">{source.label}</h3>
                    <span className="text-[11px] text-faint">
                      {!source.supported
                        ? "暂不支持"
                        : source.error
                          ? source.error
                          : `${source.candidates.length} 条`}
                    </span>
                  </div>
                  {source.candidates.map((candidate) => (
                    <button
                      key={candidate.candidateId}
                      type="button"
                      disabled={Boolean(busy)}
                      className="flex w-full items-start gap-3 rounded-xl border border-line px-3 py-3 text-left hover:border-accent/50 hover:bg-raised disabled:opacity-50"
                      onClick={() => {
                        setBusy(candidate.candidateId);
                        void importSessionCandidate(workspaceId, candidate.candidateId).then(
                          (imported) => {
                            if (imported) onClose();
                            else setBusy(null);
                          },
                        );
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-fg">{candidate.title}</span>
                        {candidate.preview ? (
                          <span className="mt-1 line-clamp-2 block text-xs text-muted">
                            {candidate.preview}
                          </span>
                        ) : null}
                        <span className="mt-1 block text-[11px] text-faint">
                          {candidate.continuation === "native" ? "可继续对话" : "只读历史"}
                          {candidate.updatedAtMs > 0
                            ? ` · ${new Date(candidate.updatedAtMs).toLocaleString()}`
                            : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-accent">
                        {busy === candidate.candidateId ? "导入中…" : "导入"}
                      </span>
                    </button>
                  ))}
                </section>
              ))
            : null}
          {!loading && listing && total === 0 ? (
            <p className="rounded-xl border border-line bg-raised/50 px-3 py-4 text-center text-sm text-muted">
              当前工作区没有可导入的新会话。
            </p>
          ) : null}
          {listing && listing.filteredDuplicates > 0 ? (
            <p className="text-xs text-faint">
              已隐藏 {listing.filteredDuplicates} 条已导入会话。
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            disabled={loading || Boolean(busy)}
            className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
            onClick={refresh}
          >
            刷新
          </button>
          <button
            type="button"
            disabled={Boolean(busy)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
            onClick={onClose}
          >
            完成
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
