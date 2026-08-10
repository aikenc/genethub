import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { Host } from "../host";
import { useWorkbench, type PreviewFloatTarget } from "../session/store";
import { AssetPreviewPage } from "./AssetPreviewPage";
import { assetPreviewUrl } from "./url";

type Mode = "expanded" | "minimized";
type Dock = "left" | "right";

const BUBBLE_W = 72;
const BUBBLE_H = 88;
const EDGE = 8;
const THUMB_SCALE = 0.14;

/**
 * WeChat-style Preview: fullscreen by default; minimize to a draggable,
 * edge-docked bubble with a scaled-down live thumbnail. Feedback stays on the
 * workbench — this surface never leaves the page.
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
  const client = useWorkbench((state) => state.client);
  const [mode, setMode] = useState<Mode>("expanded");
  const [dock, setDock] = useState<Dock>("right");
  const [offsetY, setOffsetY] = useState(() => Math.round(window.innerHeight * 0.35));
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const skipClick = useRef(false);

  const externalUrl = assetPreviewUrl(
    source.deviceHandle,
    source.workspaceHandle,
    source.path,
  );
  const title = useMemo(() => basename(source.path), [source.path]);

  useEffect(() => {
    setMode("expanded");
  }, [source.path, source.workspaceHandle, source.deviceHandle]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (mode === "expanded") setMode("minimized");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onClose]);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("genehub:preview-diagnostic", {
        detail: {
          kind: "log",
          detail: {
            topic: "preview-float",
            path: source.path,
            workspaceHandle: source.workspaceHandle,
            phase: mode === "expanded" ? "open" : "minimized",
          },
        },
      }),
    );
  }, [mode, source.path, source.workspaceHandle]);

  const clampY = (y: number) =>
    Math.min(Math.max(EDGE, y), Math.max(EDGE, window.innerHeight - BUBBLE_H - EDGE));

  const onBubblePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mode !== "minimized") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originY: offsetY,
      moved: false,
    };
  };

  const onBubblePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.hypot(dx, dy) > 4) state.moved = true;
    setOffsetY(clampY(state.originY + dy));
  };

  const onBubblePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDock(event.clientX < window.innerWidth / 2 ? "left" : "right");
    setOffsetY((current) => clampY(current));
    if (state.moved) skipClick.current = true;
    else setMode("expanded");
  };

  const preview = client ? (
    <AssetPreviewPage source={source} host={host} chrome="embedded" client={client} />
  ) : (
    <p role="status" className="m-auto p-6 text-center text-sm text-muted">
      尚未连接到设备，无法预览
    </p>
  );

  const minimized = mode === "minimized";

  return (
    <div
      role={minimized ? "button" : "dialog"}
      aria-modal={minimized ? undefined : true}
      aria-label={minimized ? `展开预览 ${title}` : "文件预览"}
      tabIndex={minimized ? 0 : undefined}
      className={
        minimized
          ? "fixed z-40 flex flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-lg"
          : "fixed inset-0 z-40 flex flex-col bg-bg text-fg"
      }
      style={
        minimized
          ? {
              top: offsetY,
              width: BUBBLE_W,
              height: BUBBLE_H,
              ...(dock === "left" ? { left: EDGE } : { right: EDGE }),
            }
          : undefined
      }
      onPointerDown={onBubblePointerDown}
      onPointerMove={onBubblePointerMove}
      onPointerUp={onBubblePointerUp}
      onPointerCancel={onBubblePointerUp}
      onClick={() => {
        if (mode !== "minimized") return;
        if (skipClick.current) {
          skipClick.current = false;
          return;
        }
        setMode("expanded");
      }}
      onKeyDown={(event) => {
        if (mode !== "minimized") return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setMode("expanded");
        }
      }}
    >
      {minimized ? (
        <span className="truncate px-1.5 pt-1 text-[10px] leading-tight text-muted">{title}</span>
      ) : (
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{source.path}</span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
            onClick={() => setMode("minimized")}
          >
            最小化
          </button>
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
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg">
        <div
          className={
            minimized
              ? "pointer-events-none absolute left-0 top-0 origin-top-left"
              : "flex h-full min-h-0 flex-col"
          }
          style={
            minimized
              ? {
                  width: `${(100 / THUMB_SCALE).toFixed(2)}%`,
                  height: `${(100 / THUMB_SCALE).toFixed(2)}%`,
                  transform: `scale(${THUMB_SCALE})`,
                }
              : undefined
          }
        >
          {preview}
        </div>
      </div>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}
