import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";

import type { Host } from "../host";
import type { Client } from "../protocol/client";
import { useWorkbench, type PreviewFloatTarget } from "../session/store";
import { isIosStandalonePwa } from "../shell/platform";
import { AssetPreviewPage, type PreviewMeta } from "./AssetPreviewPage";
import {
  createPortablePreviewUrl,
  createPreviewPopoutChannel,
  createPreviewPopoutUrl,
  registerPreviewPopoutClient,
} from "./popout";
import type { RuntimeArtifactSubmit } from "./PreviewRuntimeControls";
import { runtimeArtifactDraftLine, uploadSessionArtifact } from "./sessionArtifactUpload";
import { assetPreviewUrl } from "./url";

type Mode = "expanded" | "float";

/** Base box; levels are 1× / 1.5× / 3× (small fits maximize + short title + close). */
const BASE_W = 80;
const BASE_H = 96;
const SIZE_FACTORS = [1, 1.5, 3] as const;
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
  const appendComposerDraftLine = useWorkbench((state) => state.appendComposerDraftLine);
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
  const popouts = useRef(new Map<string, string | null>());
  const popoutBridges = useRef(new Map<string, () => void>());
  const linkedBundles = useRef(new Set<string>());
  // iOS home-screen web apps cannot open a real browser window; there the
  // external-open button mints a one-time ticket link and copies it instead.
  const copyLinkMode = useMemo(() => isIosStandalonePwa(), []);
  const [copyState, setCopyState] = useState<"idle" | "minting" | "copied" | "failed">(
    "idle",
  );
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  /** Only the large float accepts content input; small/mid are click-to-cycle. */
  const contentInteractive = mode === "float" && sizeLevel === SIZE_FACTORS.length - 1;
  const midFloatChrome = mode === "float" && sizeLevel === 1;
  const largeFloatChrome = contentInteractive;
  const blockContentGestures = mode === "float" && !contentInteractive;
  const contentShieldRef = useRef<HTMLDivElement | null>(null);

  const clampPos = useCallback((x: number, y: number, w: number, h: number) => ({
    x: Math.min(Math.max(EDGE, x), Math.max(EDGE, window.innerWidth - w - EDGE)),
    y: Math.min(Math.max(EDGE, y), Math.max(EDGE, window.innerHeight - h - EDGE)),
  }), []);

  const shrinkToSmallFloat = useCallback(() => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    const nextW = Math.round(BASE_W * SIZE_FACTORS[0]);
    const nextH = Math.round(BASE_H * SIZE_FACTORS[0]);
    setSizeLevel(0);
    setPos((current) => clampPos(current.x, current.y, nextW, nextH));
    setMode("float");
  }, [clampPos]);

  /** Float chrome hit targets; keep left-aligned so mobile does not push controls right. */
  const chromeBtnLarge =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs leading-none text-muted hover:bg-raised hover:text-fg";
  const chromeBtnCompact =
    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-[10px] leading-none text-muted hover:bg-raised hover:text-fg";
  const chromeBtn = largeFloatChrome ? chromeBtnLarge : chromeBtnCompact;
  const expandedIconBtn =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-muted hover:bg-raised hover:text-fg";

  useEffect(() => {
    setMode("expanded");
    setSizeLevel(0);
    setInfoOpen(false);
  }, [source.path, source.workspaceHandle, source.deviceHandle]);

  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
      for (const release of popoutBridges.current.values()) release();
      popoutBridges.current.clear();
    };
  }, []);

  useEffect(() => {
    const channel = createPreviewPopoutChannel((message) => {
      const expectedSessionId = popouts.current.get(message.id);
      if (expectedSessionId === undefined || expectedSessionId !== message.sessionId) return;
      if (message.type === "ready") {
        popoutBridges.current.get(message.id)?.();
        popoutBridges.current.delete(message.id);
        return;
      }
      const bundleKey = `${message.sessionId}:${message.workspacePath}`;
      if (linkedBundles.current.has(bundleKey)) return;
      linkedBundles.current.add(bundleKey);
      appendComposerDraftLine(
        message.sessionId,
        runtimeArtifactDraftLine(message.workspacePath),
      );
    });
    return () => channel.close();
  }, [appendComposerDraftLine]);

  // iOS WebKit still delivers pan gestures into nested iframes even when the
  // scaled preview has pointer-events:none. Capture touchmove on a shield.
  useEffect(() => {
    const shield = contentShieldRef.current;
    if (!shield || !blockContentGestures) return;
    const block = (event: TouchEvent) => {
      event.preventDefault();
    };
    shield.addEventListener("touchmove", block, { passive: false });
    return () => shield.removeEventListener("touchmove", block);
  }, [blockContentGestures, mode, sizeLevel]);

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

  const submitRuntimeArtifact = useCallback<RuntimeArtifactSubmit>(
    async (artifact, onProgress) => {
      const state = useWorkbench.getState();
      if (!state.client || !source.sessionId) {
        throw new Error("尚未连接到可保存运行产物的会话");
      }
      const sessionId = source.sessionId;
      const bundle = await uploadSessionArtifact(
        state.client,
        sessionId,
        artifact,
        ({ uploadedBytes, totalBytes }) => onProgress(uploadedBytes, totalBytes),
      );

      const afterSave = useWorkbench.getState();
      afterSave.appendComposerDraftLine(
        sessionId,
        runtimeArtifactDraftLine(bundle.workspacePath),
      );
      return {
        relativePath: bundle.relativePath,
        addedToDraft: true,
      };
    },
    [source.sessionId],
  );

  const copyPortableLink = useCallback(async () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    if (!client) {
      setCopyState("failed");
      return;
    }
    setCopyState("minting");
    try {
      const url = await mintPortablePreviewUrl(client, externalUrl, source.sessionId);
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    copyResetTimer.current = setTimeout(() => {
      copyResetTimer.current = null;
      setCopyState("idle");
    }, 4_000);
  }, [client, externalUrl, source.sessionId]);

  const preview = client ? (
    <AssetPreviewPage
      source={source}
      host={host}
      chrome="embedded"
      client={client}
      onMetaChange={setMeta}
      onRuntimeArtifact={submitRuntimeArtifact}
      runtimeSessionId={source.sessionId}
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
            : {
                top: pos.y,
                left: pos.x,
                width: floatW,
                height: floatH,
                // Small/mid: block content pan/scroll so it does not fight float drag.
                ...(blockContentGestures ? { touchAction: "none" as const } : {}),
              }
        }
        onPointerDown={expanded || contentInteractive ? undefined : beginDrag}
        onPointerMove={expanded || contentInteractive ? undefined : onDragMove}
        onPointerUp={expanded || contentInteractive ? undefined : onDragUp}
        onPointerCancel={expanded || contentInteractive ? undefined : onDragUp}
        onWheel={(event) => {
          if (!blockContentGestures) return;
          event.preventDefault();
        }}
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
          <header className="flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-line px-1.5">
            <button
              type="button"
              aria-label="查看预览信息"
              title="查看预览信息"
              className={expandedIconBtn}
              onClick={() => setInfoOpen(true)}
            >
              <InfoIcon />
            </button>
            <span className="min-w-0 flex-1 truncate text-[12px] leading-none text-fg">
              {copyState === "copied"
                ? "链接已复制，粘贴到浏览器打开"
                : copyState === "failed"
                  ? "复制失败，请重试"
                  : copyState === "minting"
                    ? "正在生成预览链接…"
                    : title}
            </span>
            <button
              type="button"
              aria-label="最小化"
              title="最小化"
              className={expandedIconBtn}
              onClick={shrinkToSmallFloat}
            >
              <MinimizeIcon />
            </button>
            <button
              type="button"
              aria-label={copyLinkMode ? "复制预览链接" : "新窗口打开"}
              title={
                copyLinkMode
                  ? "复制预览链接，粘贴到浏览器打开"
                  : "新窗口打开"
              }
              className={`${expandedIconBtn} text-accent`}
              disabled={copyLinkMode && copyState === "minting"}
              onClick={() => {
                if (copyLinkMode) {
                  void copyPortableLink();
                  return;
                }
                const popout = createPreviewPopoutUrl(externalUrl, source.sessionId);
                popouts.current.set(popout.id, source.sessionId);
                if (client) {
                  const release = registerPreviewPopoutClient(
                    { id: popout.id, sessionId: source.sessionId },
                    source,
                    client,
                  );
                  const timer = window.setTimeout(release, 60_000);
                  popoutBridges.current.set(popout.id, () => {
                    window.clearTimeout(timer);
                    release();
                  });
                }
                window.dispatchEvent(
                  new CustomEvent("genehub:preview-open", {
                    detail: { path: source.path, url: popout.url },
                  }),
                );
                // Keep window.open in this exact user gesture so mobile popup
                // blockers allow it. flushSync commits the float first; if the
                // browser backgrounds this tab immediately, no later ready
                // message is needed to make the original Preview collapse.
                flushSync(() => shrinkToSmallFloat());
                try {
                  // A named same-origin window keeps `opener` just long enough
                  // for the trusted shell to take the shared Client. `_blank`
                  // is implicitly noopener in some mobile browsers.
                  const opened = window.open(popout.url, `genehub-preview-${popout.id}`);
                  if (!opened) throw new Error("浏览器阻止了新窗口");
                } catch {
                  popouts.current.delete(popout.id);
                  popoutBridges.current.get(popout.id)?.();
                  popoutBridges.current.delete(popout.id);
                  flushSync(() => maximize());
                }
              }}
            >
              {copyLinkMode ? <LinkIcon /> : <ExternalLinkIcon />}
            </button>
            <button
              type="button"
              aria-label="关闭预览"
              title="关闭"
              className={expandedIconBtn}
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </header>
        ) : (
          <header
            className={`relative z-20 flex shrink-0 items-center justify-start border-b border-line ${
              largeFloatChrome
                ? "h-[1.725rem] cursor-grab gap-0 px-0 active:cursor-grabbing"
                : "h-5 gap-0 px-0"
            }`}
            onPointerDown={contentInteractive ? beginDrag : undefined}
            onPointerMove={contentInteractive ? onDragMove : undefined}
            onPointerUp={contentInteractive ? onDragUp : undefined}
            onPointerCancel={contentInteractive ? onDragUp : undefined}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              maximize();
            }}
          >
            <button
              type="button"
              aria-label="最大化预览"
              title="最大化"
              className={chromeBtn}
              onClick={(event) => {
                event.stopPropagation();
                maximize();
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <MaximizeIcon compact={!largeFloatChrome} />
            </button>
            <span
              className={`min-w-0 flex-1 truncate text-muted ${
                largeFloatChrome
                  ? "px-0.5 text-[11px] leading-none"
                  : midFloatChrome
                    ? "px-px text-[11px] leading-none"
                    : "px-px text-[10px] leading-none"
              }`}
            >
              {title}
            </span>
            {largeFloatChrome ? (
              <button
                type="button"
                aria-label="最小化浮窗"
                title="最小化"
                className={chromeBtn}
                onClick={(event) => {
                  event.stopPropagation();
                  shrinkToSmallFloat();
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                −
              </button>
            ) : null}
            <button
              type="button"
              aria-label="关闭预览"
              title="关闭"
              className={chromeBtn}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              ×
            </button>
          </header>
        )}
        <div
          className={`relative min-h-0 flex-1 overflow-hidden bg-bg ${
            blockContentGestures ? "touch-none overscroll-none" : ""
          }`}
        >
          <div
            className={
              expanded
                ? "flex h-full min-h-0 flex-col"
                : `${
                    contentInteractive ? "" : "pointer-events-none touch-none "
                  }absolute left-0 top-0 origin-top-left overflow-hidden`
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
          {blockContentGestures ? (
            <div
              ref={contentShieldRef}
              data-testid="preview-content-shield"
              className="absolute inset-0 z-10 touch-none"
              aria-hidden="true"
            />
          ) : null}
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
          {meta?.storage ? (
            <div className="mt-4 flex items-center gap-3 border-t border-line pt-3 text-xs">
              <span className="min-w-0 flex-1 text-muted">
                本地存储：{meta.storage.count} 项（沙箱 shim，已持久化到本浏览器）
              </span>
              <button
                type="button"
                disabled={meta.storage.count === 0}
                className="shrink-0 rounded border border-line px-2 py-1 text-fg hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
                onClick={meta.storage.onClear}
              >
                清除
              </button>
            </div>
          ) : null}
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

function MaximizeIcon({ compact }: { compact?: boolean }) {
  const size = compact ? 8 : 11;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="9"
        height="9"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Mints a one-time Hub ticket for the connected machine and packs it into a
 * copyable Preview link. Requires Hub pairing: without it there is no
 * forwarding layer for the ticket to ride on.
 */
async function mintPortablePreviewUrl(
  client: Client,
  externalUrl: string,
  sessionId: string | null,
): Promise<string> {
  const status = await client.call({ type: "hub.status" });
  if (status?.type !== "hubStatus" || status.data.state !== "paired") {
    throw new Error("设备尚未加入账号，生成不了预览链接");
  }
  const ticket = await client.call({
    type: "hub.connect",
    payload: { machineId: status.data.machineId },
  });
  if (ticket?.type !== "hubTicket") throw new Error("设备暂时无法生成预览链接");
  return createPortablePreviewUrl(
    externalUrl,
    {
      url: ticket.data.url,
      fabricRouteTicket: ticket.data.fabricRouteTicket,
      channelCapability: ticket.data.channelCapability,
      channelSecret: ticket.data.channelSecret,
    },
    sessionId,
  );
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M6 8 8 6M5 9.5 3.75 10.75a1.77 1.77 0 0 1-2.5-2.5l2-2A1.77 1.77 0 0 1 5.75 5.5M9 4.5l1.25-1.25a1.77 1.77 0 0 1 2.5 2.5l-2 2A1.77 1.77 0 0 1 8.25 8.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalLinkIcon() {  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M5.5 3.5H3.75A1.25 1.25 0 0 0 2.5 4.75v5.5A1.25 1.25 0 0 0 3.75 11.5h5.5A1.25 1.25 0 0 0 10.5 10.25V8.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path
        d="M7.5 2.5H11.5V6.5M11.2 2.8 6.5 7.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M4 4l6 6M10 4l-6 6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}
