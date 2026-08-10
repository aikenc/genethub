import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { Host } from "../host";
import { useWorkbench, type PreviewFloatTarget } from "../session/store";
import { AssetPreviewPage, type PreviewMeta } from "./AssetPreviewPage";
import { assetPreviewUrl } from "./url";

type Mode = "expanded" | "float";

/** Base before the 0.75 shrink; levels are 0.75× / 1.5× / 3× this box. */
const BASE_W = 72;
const BASE_H = 88;
const SIZE_FACTORS = [0.75, 1.5, 3] as const;
const EDGE = 8;
const SNAP = 28;
/** Visual scale of the preview document inside every float size. */
const THUMB_SCALE = 0.14;
const CLICK_DELAY_MS = 280;

/**
 * WeChat-style Preview: fullscreen by default; minimize to a free-position
 * float. Single-click cycles float size; double-click maximizes. The preview
 * document stays mounted across mode changes so Fabric reload is avoided.
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
  const [sizeLevel, setSizeLevel] = useState(0);
  const [pos, setPos] = useState(() => ({
    x: Math.max(EDGE, window.innerWidth - Math.round(BASE_W * SIZE_FACTORS[0]) - EDGE),
    y: Math.round(window.innerHeight * 0.35),
  }));
  const [meta, setMeta] = useState<PreviewMeta | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const skipClick = useRef(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const externalUrl = assetPreviewUrl(
    source.deviceHandle,
    source.workspaceHandle,
    source.path,
  );
  const fileName = useMemo(() => basename(source.path), [source.path]);
  const title = meta?.documentTitle?.trim() || fileName;
  const factor = SIZE_FACTORS[sizeLevel] ?? SIZE_FACTORS[0];
  const floatW = Math.round(BASE_W * factor);
  const floatH = Math.round(BASE_H * factor);
  const expanded = mode === "expanded";
  /** Large float: same thumb scale as mid, but content accepts input. */
  const contentInteractive = mode === "float" && sizeLevel === SIZE_FACTORS.length - 1;
  const showFloatClose = mode === "float" && sizeLevel >= 1;
  const compactFloatChrome = mode === "float" && sizeLevel >= 1;

  useEffect(() => {
    setMode("expanded");
    setSizeLevel(0);
    setInfoOpen(false);
  }, [source.path, source.workspaceHandle, source.deviceHandle]);

  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (infoOpen) {
          setInfoOpen(false);
          return;
        }
        if (mode === "expanded") setMode("float");
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onClose, infoOpen]);

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
            sizeLevel,
          },
        },
      }),
    );
  }, [mode, sizeLevel, source.path, source.workspaceHandle]);

  const clampPos = (x: number, y: number, w: number, h: number) => ({
    x: Math.min(Math.max(EDGE, x), Math.max(EDGE, window.innerWidth - w - EDGE)),
    y: Math.min(Math.max(EDGE, y), Math.max(EDGE, window.innerHeight - h - EDGE)),
  });

  const snapPos = (x: number, y: number, w: number, h: number) => {
    let nextX = x;
    if (x <= SNAP) nextX = EDGE;
    else if (x + w >= window.innerWidth - SNAP) nextX = window.innerWidth - w - EDGE;
    return clampPos(nextX, y, w, h);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (mode !== "float") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pos.x,
      originY: pos.y,
      moved: false,
    };
  };

  const onDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.hypot(dx, dy) > 4) state.moved = true;
    setPos(clampPos(state.originX + dx, state.originY + dy, floatW, floatH));
  };

  const onDragUp = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setPos((current) => snapPos(current.x, current.y, floatW, floatH));
    if (state.moved) skipClick.current = true;
  };

  const cycleSize = () => {
    setSizeLevel((level) => {
      const next = (level + 1) % SIZE_FACTORS.length;
      const nextW = Math.round(BASE_W * SIZE_FACTORS[next]!);
      const nextH = Math.round(BASE_H * SIZE_FACTORS[next]!);
      setPos((current) => clampPos(current.x, current.y, nextW, nextH));
      return next;
    });
  };

  const maximize = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    setMode("expanded");
  };

  const scheduleCycle = () => {
    if (skipClick.current) {
      skipClick.current = false;
      return;
    }
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      cycleSize();
    }, CLICK_DELAY_MS);
  };

  const preview = client ? (
    <AssetPreviewPage
      source={source}
      host={host}
      chrome="embedded"
      client={client}
      onMetaChange={setMeta}
    />
  ) : (
    <p role="status" className="m-auto p-6 text-center text-sm text-muted">
      尚未连接到设备，无法预览
    </p>
  );

  return (
    <>
      <div
        role={expanded ? "dialog" : "button"}
        aria-modal={expanded ? true : undefined}
        aria-label={expanded ? "文件预览" : `预览浮窗 ${title}`}
        tabIndex={expanded ? undefined : 0}
        className={
          expanded
            ? "fixed inset-0 z-40 flex flex-col bg-bg text-fg"
            : "fixed z-40 flex flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-lg"
        }
        style={
          expanded
            ? undefined
            : { top: pos.y, left: pos.x, width: floatW, height: floatH }
        }
        onPointerDown={expanded || contentInteractive ? undefined : beginDrag}
        onPointerMove={expanded || contentInteractive ? undefined : onDragMove}
        onPointerUp={expanded || contentInteractive ? undefined : onDragUp}
        onPointerCancel={expanded || contentInteractive ? undefined : onDragUp}
        onClick={() => {
          if (expanded || contentInteractive) return;
          scheduleCycle();
        }}
        onDoubleClick={(event) => {
          if (expanded) return;
          event.preventDefault();
          event.stopPropagation();
          maximize();
        }}
        onKeyDown={(event) => {
          if (expanded) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            maximize();
          }
        }}
      >
        {expanded ? (
          <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <button
              type="button"
              aria-label="查看预览信息"
              title="查看预览信息"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg"
              onClick={() => setInfoOpen(true)}
            >
              <InfoIcon />
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{source.path}</span>
            <button
              type="button"
              className="shrink-0 rounded px-2 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
              onClick={() => {
                setSizeLevel(0);
                setPos((current) =>
                  clampPos(
                    current.x,
                    current.y,
                    Math.round(BASE_W * SIZE_FACTORS[0]),
                    Math.round(BASE_H * SIZE_FACTORS[0]),
                  ),
                );
                setMode("float");
              }}
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
        ) : (
          <header
            className={`flex shrink-0 items-center gap-1 border-b border-line ${
              compactFloatChrome ? "h-6 px-1" : "px-1.5 py-1"
            } ${contentInteractive ? "cursor-grab active:cursor-grabbing" : ""}`}
            onPointerDown={contentInteractive ? beginDrag : undefined}
            onPointerMove={contentInteractive ? onDragMove : undefined}
            onPointerUp={contentInteractive ? onDragUp : undefined}
            onPointerCancel={contentInteractive ? onDragUp : undefined}
            onClick={(event) => {
              if (!contentInteractive) return;
              event.stopPropagation();
              scheduleCycle();
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              maximize();
            }}
          >
            <span
              className={`min-w-0 flex-1 truncate text-muted ${
                compactFloatChrome
                  ? "text-[11px] leading-none"
                  : "text-[10px] leading-tight"
              }`}
            >
              {title}
            </span>
            {showFloatClose ? (
              <button
                type="button"
                aria-label="关闭预览"
                className={`flex shrink-0 items-center justify-center rounded leading-none text-muted hover:bg-raised hover:text-fg ${
                  compactFloatChrome ? "h-5 w-5 text-base" : "h-5 w-5 text-sm"
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose();
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                ×
              </button>
            ) : null}
          </header>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden bg-bg">
          <div
            className={
              expanded
                ? "flex h-full min-h-0 flex-col"
                : `${contentInteractive ? "" : "pointer-events-none "}absolute left-0 top-0 origin-top-left`
            }
            style={
              expanded
                ? undefined
                : {
                    width: `${(100 / THUMB_SCALE).toFixed(2)}%`,
                    height: `${(100 / THUMB_SCALE).toFixed(2)}%`,
                    transform: `scale(${THUMB_SCALE})`,
                  }
            }
          >
            {preview}
          </div>
        </div>
      </div>
      {infoOpen ? (
        <PreviewInfoDialog
          path={source.path}
          title={title}
          meta={meta}
          onClose={() => setInfoOpen(false)}
        />
      ) : null}
    </>
  );
}

function PreviewInfoDialog({
  path,
  title,
  meta,
  onClose,
}: {
  path: string;
  title: string;
  meta: PreviewMeta | null;
  onClose(): void;
}) {
  const lines = meta?.infoLines?.length
    ? meta.infoLines
    : ["预览信息尚未就绪，请稍候再打开。"];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="presentation"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="预览信息"
        className="flex max-h-[min(80vh,36rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">预览信息</h2>
          <button
            type="button"
            aria-label="关闭信息"
            className="rounded px-2 text-lg leading-none text-muted hover:bg-raised"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
          <dl className="space-y-2 text-xs">
            <div>
              <dt className="text-faint">标题</dt>
              <dd className="break-words text-fg">{title}</dd>
            </div>
            <div>
              <dt className="text-faint">路径</dt>
              <dd className="break-all font-mono text-fg">{path}</dd>
            </div>
          </dl>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-xs leading-relaxed text-muted">
            {lines.map((line) => (
              <li key={line} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 7v4.5M8 5.25h.01"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}
