import { useState } from "react";

import { PreviewModal } from "./PreviewModal";
import { formatBytes, ResourceBody, useResourcePreview } from "./ResourcePreview";

/**
 * One structured path from `ToolCallDetail::Overview.paths`, made clickable.
 *
 * A tool call already says "wrote out/chart.png" in its collapsed overview;
 * this is the difference between reading that sentence and actually seeing
 * the chart, without leaving the conversation for the files panel. The
 * inline body is deliberately modest (a chat column is narrow); "在浮窗中
 * 查看" reuses the same already-fetched bytes in `PreviewModal`, which is
 * the one place a single HTML document actually renders as markup.
 */
export function ArtifactCard({ path }: { path: string }) {
  const name = path.split("/").pop() || path;
  const { phase, stat, loadAnyway } = useResourcePreview(path);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-line bg-surface">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs disabled:cursor-default"
        disabled={phase.step !== "idle"}
        onClick={stat}
      >
        <span aria-hidden="true">{icon(name)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg" title={path}>
          {name}
        </span>
        <span className="shrink-0 text-accent">
          {phase.step === "idle"
            ? "预览"
            : phase.step === "stating" || phase.step === "loading"
              ? "加载中…"
              : null}
        </span>
      </button>
      {phase.step === "statError" || phase.step === "loadError" ? (
        <p className="border-t border-line px-3 py-2 text-xs text-danger">{phase.message}</p>
      ) : null}
      {phase.step === "ready" ? (
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-muted">
          <span>
            {phase.meta.mime} · {formatBytes(phase.meta.size)}
          </span>
          <button type="button" className="shrink-0 text-accent" onClick={loadAnyway}>
            仍然加载
          </button>
        </div>
      ) : null}
      {phase.step === "loaded" ? (
        <div className="border-t border-line px-3 py-2">
          <ResourceBody content={phase.content} />
          <button
            type="button"
            className="mt-1.5 text-xs text-accent"
            onClick={() => setExpanded(true)}
          >
            在浮窗中查看 ⤢
          </button>
        </div>
      ) : null}
      {expanded && phase.step === "loaded" ? (
        <PreviewModal path={path} content={phase.content} onClose={() => setExpanded(false)} />
      ) : null}
    </div>
  );
}

function icon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "🖼️";
  if (["md", "markdown"].includes(ext)) return "📄";
  if (["html", "htm"].includes(ext)) return "🌐";
  return "📎";
}
