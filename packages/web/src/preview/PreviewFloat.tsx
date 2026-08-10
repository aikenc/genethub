import { useEffect } from "react";

import type { Host } from "../host";
import { AssetPreviewPage } from "./AssetPreviewPage";
import { assetPreviewUrl } from "./url";
import type { PreviewFloatTarget } from "../session/store";

/**
 * Default Preview surface inside the workbench so feedback stays on one page.
 * A separate browser tab is available from the chrome, but is not the product
 * path for filing reports.
 */
export function PreviewFloat({
  source,
  host,
  onClose,
}: {
  source: PreviewFloatTarget;
  host: Host;
  onClose(): void;
}) {
  const externalUrl = assetPreviewUrl(
    source.deviceHandle,
    source.workspaceHandle,
    source.path,
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("genehub:preview-diagnostic", {
        detail: {
          kind: "log",
          detail: {
            topic: "preview-float",
            path: source.path,
            workspaceHandle: source.workspaceHandle,
            phase: "open",
          },
        },
      }),
    );
  }, [source.path, source.workspaceHandle]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/45 p-0 sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="文件预览"
        className="flex h-full w-full max-w-5xl flex-col overflow-hidden bg-bg text-fg shadow-2xl sm:h-[min(88vh,52rem)] sm:rounded-xl sm:border sm:border-line"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{source.path}</span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 text-xs text-accent hover:bg-raised"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("genehub:preview-open", {
                  detail: { path: source.path, url: externalUrl },
                }),
              );
              window.open(externalUrl, "_blank", "noopener,noreferrer");
            }}
          >
            新窗口打开
          </button>
          <button
            type="button"
            aria-label="关闭预览"
            className="shrink-0 rounded px-2 py-1 text-lg leading-none text-muted hover:bg-raised hover:text-fg"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <AssetPreviewPage source={source} host={host} chrome="embedded" />
        </div>
      </section>
    </div>
  );
}
