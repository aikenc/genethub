import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { PreviewAnnotation, PreviewAnnotationTarget, PreviewReviewDraft } from "@genehub/proto";

import type { FileFeedbackReview } from "./fileFeedback";
import type { Client } from "../protocol/client";
import { PreviewFileFeedbackOpenContext, PreviewToolbarPortal } from "./PreviewToolbar";
import {
  MarkdownAnnotationContext,
  MarkdownAnnotationMarksContext,
  type MarkdownBlockPick,
} from "../session/Markdown";
import {
  defaultImageRect,
  PREVIEW_ANNOTATIONS_FEATURE,
  rectFromDisplayBox,
  type NaturalRect,
} from "./reviewDraft";

export type HtmlAnnotationHit = {
  selector: string;
  tag: string;
  excerpt: string;
  domFingerprint: string;
};

const RUNTIME_SOURCE = "genehub-preview-runtime";
const RUNTIME_COMMAND_SOURCE = "genehub-preview-runtime-command";

type Pending =
  | { mode: "create"; id: string; label: string; target: PreviewAnnotationTarget }
  | { mode: "edit"; id: string; label: string; comment: string };

type ReviewContextValue = {
  active: boolean;
  notes: PreviewAnnotation[];
  pickHtml: (hit: HtmlAnnotationHit) => void;
  pickImage: (rect: NaturalRect) => void;
  openNote: (id: string) => void;
  htmlSelection: string | null;
  bar: { toggle: () => void; count: number; disabled: boolean; openDraft: () => void } | null;
};

const PreviewReviewContext = createContext<ReviewContextValue | null>(null);

const emptyDraft: PreviewReviewDraft = { revision: 0, annotations: [] };

export function PreviewReviewChrome({
  client,
  sessionId,
  enabled,
  path,
  version,
  kind,
  sourceText = "",
  fileFeedback,
  children,
}: {
  client: Client;
  sessionId: string | null;
  enabled: boolean;
  path: string;
  version: string;
  kind: string;
  sourceText?: string;
  fileFeedback?: FileFeedbackReview;
  children: ReactNode;
}) {
  const supported = kind === "markdown" || kind === "html" || kind === "image";
  const available = enabled && supported && (!!fileFeedback || !!client.identity?.features?.includes(PREVIEW_ANNOTATIONS_FEATURE));
  const [draft, setDraft] = useState<PreviewReviewDraft>(emptyDraft);
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [comment, setComment] = useState("");
  const [lineRange, setLineRange] = useState<{ start: number; end: number; baseStart: number; baseEnd: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (fileFeedback) { setDraft(emptyDraft); setActive(false); setPending(null); setProblem(null); setDrawer(false); setLineRange(null); setComment(""); }
  }, [path, version, fileFeedback]);

  useEffect(() => {
    if (!enabled) setActive(false);
  }, [enabled]);

  useEffect(() => {
    if (!available || !sessionId || fileFeedback) return;
    let cancelled = false;
    void client.call({ type: "session.previewAnnotations.get", payload: { sessionId } })
      .then((reply) => {
        if (!cancelled && reply?.type === "previewAnnotations") setDraft(reply.data);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : "无法读取预览批注");
      });
    return () => {
      cancelled = true;
    };
  }, [available, client, sessionId, fileFeedback]);

  const pickMarkdown = useCallback((pick: MarkdownBlockPick) => {
    setLineRange({ start: pick.startLine, end: pick.endLine, baseStart: pick.startLine, baseEnd: pick.endLine });
    const excerpt = lineExcerpt(sourceText, pick.startLine, pick.endLine) || pick.excerpt;
    setPending({
      mode: "create",
      id: `ann-${crypto.randomUUID()}`,
      label: lineLabel(pick.startLine, pick.endLine),
      target: { kind: "markdownLines", startLine: pick.startLine, endLine: pick.endLine, excerpt },
    });
    setComment("");
    setProblem(null);
  }, [sourceText]);

  const pickHtml = useCallback((hit: HtmlAnnotationHit) => {
    setLineRange(null);
    setPending({
      mode: "create",
      id: `ann-${crypto.randomUUID()}`,
      label: `${hit.tag} ${hit.selector}`,
      target: {
        kind: "htmlElement",
        selector: hit.selector,
        tag: hit.tag,
        excerpt: hit.excerpt,
        domFingerprint: hit.domFingerprint,
      },
    });
    setComment("");
    setProblem(null);
  }, []);

  const pickImage = useCallback((rect: NaturalRect) => {
    setLineRange(null);
    setPending({
      mode: "create",
      id: `ann-${crypto.randomUUID()}`,
      label: "图片区域，编号在保存时确定",
      target: { kind: "imageRect", ...rect },
    });
    setComment("");
    setProblem(null);
  }, []);

  const openNote = useCallback((id: string) => {
    const item = draft.annotations.find((entry) => entry.id === id);
    if (!item) return;
    setPending({ mode: "edit", id, label: describe(item), comment: item.comment });
    setComment(item.comment);
    setLineRange(null);
    setDrawer(false);
    setProblem(null);
  }, [draft.annotations]);

  const save = async () => {
    if ((!sessionId && !fileFeedback) || !pending || saving) return;
    const text = comment.trim();
    if (!text) {
      setProblem("请填写批注");
      return;
    }
    if (new TextEncoder().encode(text).byteLength > 1024) {
      setProblem("单条批注不能超过 1 KiB");
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const existing = pending.mode === "edit"
        ? draft.annotations.find((item) => item.id === pending.id)
        : undefined;
      if (pending.mode === "edit" && !existing) throw new Error("这条批注已经不在草稿里");
      const annotation: PreviewAnnotation = existing
        ? { ...existing, comment: text }
        : {
            id: pending.id,
            source: { root: { kind: "primary" }, relativePath: path, contentVersion: version },
            target: pending.mode === "create" ? pending.target : existing!.target,
            comment: text,
            createdAtMs: Date.now(),
          };
      if (fileFeedback) {
        setDraft(await fileFeedback.upsert(annotation, draft.revision));
        setPending(null); setComment(""); return;
      }
      const reply = await client.call({
        type: "session.previewAnnotations.upsert",
        payload: { sessionId: sessionId!, annotation, expectedRevision: draft.revision },
      });
      if (reply?.type !== "previewAnnotations") throw new Error("保存预览批注失败");
      setDraft(reply.data);
      setPending(null);
      setComment("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "保存预览批注失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if ((!sessionId && !fileFeedback) || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      if (fileFeedback) { setDraft(await fileFeedback.remove([id], draft.revision)); setPending(null); return; }
      const reply = await client.call({
        type: "session.previewAnnotations.remove",
        payload: { sessionId: sessionId!, ids: [id], expectedRevision: draft.revision },
      });
      if (reply?.type !== "previewAnnotations") throw new Error("删除预览批注失败");
      setDraft(reply.data);
      setPending(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "删除预览批注失败");
    } finally {
      setSaving(false);
    }
  };

  const notes = draft.annotations.filter((item) => item.source.relativePath === path && item.source.contentVersion === version);
  const context: ReviewContextValue = {
    active: available && (!!sessionId || !!fileFeedback) && active,
    notes,
    pickHtml,
    pickImage,
    openNote,
    htmlSelection: pending?.mode === "create" && pending.target.kind === "htmlElement" ? pending.target.selector : null,
    bar: available
      ? {
          toggle: () => {
            setActive((value) => !value);
            if (fileFeedback) void fileFeedback.load().then(setDraft).catch(error => setProblem(String(error)));
            setPending(null);
          },
          count: draft.annotations.length,
          disabled: !sessionId && !fileFeedback,
          openDraft: () => setDrawer(true),
        }
      : null,
  };
  const markdownMarks = {
    notes: notes.flatMap((item) => item.target.kind === "markdownLines"
      ? [{ id: item.id, startLine: item.target.startLine, endLine: item.target.endLine }]
      : []),
    open: openNote,
  };

  return (
    <PreviewReviewContext.Provider value={context}>
      <MarkdownAnnotationContext.Provider value={context.active && kind === "markdown" ? pickMarkdown : null}>
        <MarkdownAnnotationMarksContext.Provider value={markdownMarks}>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {available ? <PreviewToolbarPortal><PreviewAnnotationBar /></PreviewToolbarPortal> : null}
          {problem && !pending ? <p role="alert" className="px-3 py-1 text-xs text-danger">{problem}</p> : null}
          {children}
          {pending ? (
            <form
              className="absolute inset-x-0 bottom-0 z-30 border-t border-line bg-surface p-3 shadow-lg"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <p className="text-xs text-muted">{pending.label}</p>
              {pending.mode === "create" && pending.target.kind === "markdownLines" && lineRange && lineRange.baseEnd > lineRange.baseStart ? (
                <label className="mt-2 block text-xs">
                  调整行
                  <select
                    className="ml-2 rounded border border-line bg-bg px-2 py-1"
                    value={`${lineRange.start}-${lineRange.end}`}
                    onChange={(event) => {
                      const [start, end] = event.target.value.split("-").map(Number);
                      if (!start || !end || pending.target.kind !== "markdownLines") return;
                      setLineRange({ ...lineRange, start, end });
                      setPending({
                        mode: "create",
      id: `ann-${crypto.randomUUID()}`,
                        label: lineLabel(start, end),
                        target: { ...pending.target, startLine: start, endLine: end, excerpt: lineExcerpt(sourceText, start, end) },
                      });
                    }}
                  >
                    <option value={`${lineRange.baseStart}-${lineRange.baseEnd}`}>{lineLabel(lineRange.baseStart, lineRange.baseEnd)}</option>
                    {Array.from({ length: lineRange.baseEnd - lineRange.baseStart + 1 }, (_, index) => lineRange.baseStart + index).map((line) => (
                      <option key={line} value={`${line}-${line}`}>{lineLabel(line, line)}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <textarea
                aria-label="批注"
                value={comment}
                maxLength={1000}
                rows={3}
                className="mt-2 w-full rounded border border-line bg-bg px-2 py-1 text-sm"
                onChange={(event) => setComment(event.target.value)}
              />
              {problem ? <p role="alert" className="mt-1 text-xs text-danger">{problem}</p> : null}
              <div className="mt-2 flex gap-2">
                <button type="submit" disabled={saving} className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-40">
                  {pending.mode === "edit" ? "保存" : "加入草稿"}
                </button>
                {pending.mode === "edit" ? (
                  <button type="button" disabled={saving} className="rounded border border-line px-3 py-1 text-xs" onClick={() => void remove(pending.id)}>删除</button>
                ) : null}
                <button type="button" className="rounded border border-line px-3 py-1 text-xs" onClick={() => setPending(null)}>取消</button>
              </div>
            </form>
          ) : null}
          {drawer ? (
            <aside className="absolute inset-x-0 bottom-0 z-10 max-h-[70%] overflow-auto border-t border-line bg-surface p-3" aria-label="预览批注草稿">
              <div className="mb-2 flex items-center justify-between">
                <strong className="text-sm">预览批注 · {draft.annotations.length}</strong>
                <button type="button" aria-label="关闭草稿" onClick={() => setDrawer(false)}>×</button>
              </div>
              {draft.annotations.length === 0 ? <p className="text-xs text-muted">还没有批注。</p> : draft.annotations.map((item) => (
                <article key={item.id} className="mb-2 rounded border border-line p-2 text-xs">
                  <p className="text-muted">{item.source.relativePath}</p>
                  <p>{describe(item)}</p>
                  <p className="mt-1">{item.comment}</p>
                  <button type="button" className="mt-1 underline" onClick={() => openNote(item.id)}>编辑</button>
                </article>
              ))}
            </aside>
          ) : null}
        </div>
        </MarkdownAnnotationMarksContext.Provider>
      </MarkdownAnnotationContext.Provider>
    </PreviewReviewContext.Provider>
  );
}

export function ImageAnnotationLayer({ image }: { image: HTMLImageElement | null }) {
  const review = useContext(PreviewReviewContext);
  const [draftRect, setDraftRect] = useState<NaturalRect | null>(null);
  if (!review) return null;
  const regions = review.notes.filter((item) => item.target.kind === "imageRect");
  return (
    <div
      className={`absolute inset-0 ${review.active ? "cursor-crosshair" : "pointer-events-none"}`}
      onPointerDown={(event) => {
        if (!review.active || !image) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = relativePoint(image, event.clientX, event.clientY);
        setDraftRect(rectFromDisplayBox(image.getBoundingClientRect(), image.naturalWidth, image.naturalHeight, point, point));
        event.currentTarget.dataset.originX = String(point.x);
        event.currentTarget.dataset.originY = String(point.y);
        event.currentTarget.dataset.clientX = String(event.clientX);
        event.currentTarget.dataset.clientY = String(event.clientY);
      }}
      onPointerMove={(event) => {
        if (!review.active || !image || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const origin = {
          x: Number(event.currentTarget.dataset.originX),
          y: Number(event.currentTarget.dataset.originY),
        };
        setDraftRect(rectFromDisplayBox(
          image.getBoundingClientRect(),
          image.naturalWidth,
          image.naturalHeight,
          origin,
          relativePoint(image, event.clientX, event.clientY),
        ));
      }}
      onPointerUp={(event) => {
        if (!review.active || !image || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const moved = Math.hypot(event.clientX - Number(event.currentTarget.dataset.clientX), event.clientY - Number(event.currentTarget.dataset.clientY));
        const origin = {
          x: Number(event.currentTarget.dataset.originX),
          y: Number(event.currentTarget.dataset.originY),
        };
        const point = relativePoint(image, event.clientX, event.clientY);
        const rect = moved < 6
          ? defaultImageRect(origin, image.naturalWidth, image.naturalHeight)
          : rectFromDisplayBox(image.getBoundingClientRect(), image.naturalWidth, image.naturalHeight, origin, point);
        setDraftRect(null);
        if (rect && rect.width >= 1 && rect.height >= 1) review.pickImage(rect);
      }}
    >
      {regions.map((item) => item.target.kind === "imageRect" ? (
        <button
          key={item.id}
          type="button"
          className={`absolute border-2 border-accent bg-accent/20 text-[11px] text-white ${review.active ? "pointer-events-none" : "pointer-events-auto"}`}
          style={regionStyle(item.target)}
          aria-label={`查看区域 #${item.markerNo ?? ""}`}
          onClick={(event) => {
            event.stopPropagation();
            review.openNote(item.id);
          }}
        >
          #{item.markerNo}
        </button>
      ) : null)}
      {draftRect ? <span className="pointer-events-none absolute border-2 border-accent" style={regionStyle(draftRect)} /> : null}
    </div>
  );
}

export function PreviewAnnotationBar() {
  const review = useContext(PreviewReviewContext);
  const openFileFeedback = useContext(PreviewFileFeedbackOpenContext);
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  if (!review?.bar) return null;
  const closeMenu = () => {
    if (menuRef.current) menuRef.current.open = false;
  };
  return (
    <>
      {review.active ? (
        <button
          type="button"
          aria-pressed
          aria-label="完成批注"
          className="h-7 shrink-0 rounded border border-line bg-surface px-2 text-xs text-fg hover:bg-raised"
          onClick={review.bar.toggle}
        >
          完成
        </button>
      ) : review.bar.disabled ? (
        <button
          type="button"
          aria-label="批注"
          disabled
          title="先从会话打开这个文件"
          className="h-7 shrink-0 rounded border border-line bg-surface px-2 text-xs text-fg disabled:opacity-40"
        >
          批注
        </button>
      ) : (
        <details
          ref={menuRef}
          className="relative text-xs"
          onKeyDown={(event) => {
            if (event.key === "Escape" && event.currentTarget.open) {
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            aria-label="批注"
            title="批注"
            className="flex h-7 cursor-pointer list-none items-center rounded border border-line bg-surface px-2 text-xs text-fg hover:bg-raised [&::-webkit-details-marker]:hidden"
          >
            批注
          </summary>
          <div className="absolute right-0 top-full z-50 mt-1 flex w-40 flex-col gap-1 rounded-lg border border-line bg-surface p-2 text-fg shadow-lg">
            <button
              type="button"
              className="rounded px-2 py-1 text-left hover:bg-raised"
              onClick={() => {
                closeMenu();
                review.bar?.toggle();
              }}
            >
              开始批注
            </button>
            {openFileFeedback ? (
              <button
                type="button"
                className="rounded px-2 py-1 text-left hover:bg-raised"
                onClick={() => {
                  closeMenu();
                  openFileFeedback();
                }}
              >
                提交批注反馈
              </button>
            ) : null}
          </div>
        </details>
      )}
      {review.bar.count > 0 ? (
        <button
          type="button"
          className="shrink-0 rounded border border-line bg-surface px-2 py-1 text-muted hover:bg-raised"
          aria-label={`查看批注草稿 ${review.bar.count}`}
          onClick={review.bar.openDraft}
        >
          {review.bar.count}
        </button>
      ) : null}
    </>
  );
}

type HtmlMark = { id: string; x: number; y: number; width: number; height: number };

export function HtmlAnnotationOverlay({
  frameRef,
  frameReady,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  frameReady: boolean;
}) {
  const review = useContext(PreviewReviewContext);
  const [outline, setOutline] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [marks, setMarks] = useState<HtmlMark[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const htmlNotes = review?.notes.filter((item) => item.target.kind === "htmlElement") ?? [];
  const htmlNotesRef = useRef(htmlNotes);
  htmlNotesRef.current = htmlNotes;
  const locateKey = htmlNotes.map((item) => item.target.kind === "htmlElement" ? `${item.id}:${item.target.selector}` : "").join("\n");

  useEffect(() => {
    if (!review?.active) setOutline(null);
  }, [review?.active]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const publish = () => {
      const items = htmlNotesRef.current.flatMap((item) => item.target.kind === "htmlElement"
        ? [{ id: item.id, selector: item.target.selector }]
        : []);
      frame.contentWindow?.postMessage({
        source: RUNTIME_COMMAND_SOURCE,
        command: "locate",
        requestId: "locate",
        items,
      }, "*");
    };
    frame.addEventListener("load", publish);
    publish();
    return () => frame.removeEventListener("load", publish);
  }, [frameRef, locateKey, frameReady]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; kind?: string; requestId?: string; detail?: unknown };
      if (data?.source !== RUNTIME_SOURCE) return;
      if (data.kind === "locate") {
        setMarks(parseMarks(data.detail));
        const selection = (data.detail as { selection?: HtmlAnnotationHit } | null)?.selection;
        setOutline(selection ? hitBox(selection) : null);
        return;
      }
      if (data.kind !== "hit-test" || !review?.active) return;
      if (data.requestId !== "annotation-pick") return;
      if (!isHtmlHit(data.detail)) {
        setOutline(null);
        setHint("没有点到可选元素");
        return;
      }
      const selector = clampUtf8(data.detail.selector, 512);
      const domFingerprint = clampUtf8(data.detail.domFingerprint, 128);
      if (!selector || !domFingerprint) return;
      setHint(null);
      setOutline(hitBox(data.detail));
      review.pickHtml({ ...data.detail, selector, domFingerprint });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frameRef, review]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const publish = () => frame.contentWindow?.postMessage({
      source: RUNTIME_COMMAND_SOURCE,
      command: "annotation-mode",
      requestId: "annotation-mode",
      active: Boolean(review?.active),
      selection: review?.htmlSelection ?? null,
    }, "*");
    frame.addEventListener("load", publish);
    publish();
    return () => frame.removeEventListener("load", publish);
  }, [frameRef, frameReady, review?.active, review?.htmlSelection]);

  if (!review || (!review.active && marks.length === 0)) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {review.active && outline ? <span aria-label="选中批注元素" className="pointer-events-none absolute border-2 border-accent bg-accent/10" style={{ left: outline.x, top: outline.y, width: outline.width, height: outline.height }} /> : null}
      {review.active && hint ? <span className="pointer-events-none absolute left-2 top-2 rounded bg-surface px-2 py-1 text-xs text-muted shadow">{hint}</span> : null}
      {marks.filter((mark) => {
        const frame = frameRef.current;
        return frame && mark.y + mark.height > 0 && mark.y < frame.clientHeight && mark.x + mark.width > 0 && mark.x < frame.clientWidth;
      }).map((mark) => (
        <button
          key={mark.id}
          type="button"
          data-annotation-mark=""
          className="pointer-events-auto absolute z-20 h-5 rounded-full border border-line bg-surface px-1.5 text-[10px] text-accent shadow-sm"
          style={{ left: Math.max(0, mark.x + mark.width - 36), top: Math.max(0, mark.y) }}
          aria-label="查看批注"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            review.openNote(mark.id);
          }}
        >
          批注
        </button>
      ))}
    </div>
  );
}

function relativePoint(image: HTMLImageElement, clientX: number, clientY: number) {
  const box = image.getBoundingClientRect();
  return {
    x: box.width ? (clientX - box.left) / box.width : 0,
    y: box.height ? (clientY - box.top) / box.height : 0,
  };
}

function regionStyle(rect: { x: number; y: number; width: number; height: number; naturalWidth: number; naturalHeight: number }) {
  return {
    left: `${rect.x / rect.naturalWidth * 100}%`,
    top: `${rect.y / rect.naturalHeight * 100}%`,
    width: `${rect.width / rect.naturalWidth * 100}%`,
    height: `${rect.height / rect.naturalHeight * 100}%`,
  };
}

function isHtmlHit(value: unknown): value is HtmlAnnotationHit {
  if (!value || typeof value !== "object") return false;
  const hit = value as Record<string, unknown>;
  return typeof hit.selector === "string" && hit.selector.length > 0
    && typeof hit.tag === "string" && hit.tag.length > 0 && hit.tag.length <= 32
    && typeof hit.excerpt === "string" && hit.excerpt.length <= 256
    && typeof hit.domFingerprint === "string" && hit.domFingerprint.length > 0;
}

function hitBox(hit: HtmlAnnotationHit): { x: number; y: number; width: number; height: number } | null {
  const record = hit as HtmlAnnotationHit & { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  return { x, y, width, height };
}

function parseMarks(detail: unknown): HtmlMark[] {
  if (!detail || typeof detail !== "object") return [];
  const marks = (detail as { marks?: unknown }).marks;
  if (!Array.isArray(marks)) return [];
  return marks.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const mark = item as { id?: unknown; missing?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    if (mark.missing || typeof mark.id !== "string") return [];
    const box = hitBox({
      selector: "x",
      tag: "div",
      excerpt: "",
      domFingerprint: "x",
      ...mark,
    } as HtmlAnnotationHit);
    return box ? [{ id: mark.id, ...box }] : [];
  });
}

function clampUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, mid)).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

function lineLabel(start: number, end: number): string {
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

function lineExcerpt(text: string, start: number, end: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.slice(start - 1, end).join("\n").replace(/\s+/g, " ").trim().slice(0, 256);
}

function describe(item: PreviewAnnotation): string {
  const target = item.target;
  if (target.kind === "markdownLines") return lineLabel(target.startLine, target.endLine);
  if (target.kind === "htmlElement") return `${target.tag} ${target.selector}`;
  return `#${item.markerNo ?? "?"} 区域`;
}
