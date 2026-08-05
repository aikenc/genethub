import type { ResourceContent, ResourceMeta } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "./Markdown";
import { SanitizedHtml } from "./SanitizedHtml";
import { useWorkbench } from "./store";

/** Below this, an image is fetched and shown the moment its card opens. */
const IMAGE_AUTO_BYTES = 2 * 1024 * 1024;
/** Below this, text (including markdown) is fetched and shown immediately. */
const TEXT_AUTO_BYTES = 256 * 1024;

type Phase =
  | { step: "idle" }
  | { step: "stating" }
  | { step: "statError"; message: string }
  | { step: "ready"; meta: ResourceMeta }
  | { step: "loading"; meta: ResourceMeta }
  | { step: "loaded"; meta: ResourceMeta; content: ResourceContent }
  | { step: "loadError"; meta: ResourceMeta; message: string };

/**
 * Loads a workspace resource lazily: metadata first, full bytes only for a
 * small image or a small text file, or once a person asks anyway.
 *
 * Shared by the chat timeline's artifact cards (`ArtifactCard.tsx`, a person
 * clicks to start) and the files panel's non-text preview (`auto: true`,
 * opening the file is the click) — see `docs/specs/artifact-skill.md` §6 and
 * `resource-fabric.md`'s inline-size red line.
 */
export function useResourcePreview(path: string | null, options?: { auto?: boolean }) {
  const auto = options?.auto ?? false;
  const statResource = useWorkbench((state) => state.statResource);
  const readResource = useWorkbench((state) => state.readResource);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  // Guards against a slow fetch for a path the user already navigated away
  // from resolving into the card now showing a different path.
  const current = useRef(path);
  current.current = path;

  async function beginStat(target: string) {
    setPhase({ step: "stating" });
    const meta = await statResource(target).catch(() => null);
    if (current.current !== target) return;
    if (!meta) {
      setPhase({ step: "statError", message: "读取文件信息失败" });
      return;
    }
    setPhase({ step: "ready", meta });
    if (autoLoads(meta)) await beginLoad(target, meta);
  }

  async function beginLoad(target: string, meta: ResourceMeta) {
    setPhase({ step: "loading", meta });
    const content = await readResource(target).catch(() => null);
    if (current.current !== target) return;
    setPhase(
      content
        ? { step: "loaded", meta, content }
        : { step: "loadError", meta, message: "读取内容失败" },
    );
  }

  // A different path is a different resource: reset first, and — for the
  // files panel, where opening the file already was the click — go fetch it.
  useEffect(() => {
    setPhase({ step: "idle" });
    if (path && auto) void beginStat(path);
    // `beginStat` closes over the latest `statResource`/`readResource` at
    // call time; re-running this effect for their (stable) identity would
    // only re-fetch a resource nothing about actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, auto]);

  return {
    phase,
    stat: () => {
      if (path && phase.step === "idle") void beginStat(path);
    },
    loadAnyway: () => {
      if (path && phase.step === "ready") void beginLoad(path, phase.meta);
    },
  };
}

function autoLoads(meta: ResourceMeta): boolean {
  if (meta.mime.startsWith("image/")) return meta.size <= IMAGE_AUTO_BYTES;
  if (meta.mime.startsWith("text/") || meta.mime === "application/json") {
    return meta.size <= TEXT_AUTO_BYTES;
  }
  return false;
}

/**
 * Renders whatever bytes a `resource.read` came back with.
 *
 * `expanded` is the difference between a card inline in a narrow chat column
 * and the floating window (`PreviewModal.tsx`) it opens into: an image gets
 * more room, and a single HTML document — never rendered cramped inside the
 * conversation flow — only turns into markup once there is a dedicated
 * surface for it to sit on.
 */
export function ResourceBody({
  content,
  expanded = false,
}: {
  content: ResourceContent;
  expanded?: boolean;
}) {
  if (content.mime.startsWith("image/")) {
    return (
      <img
        src={`data:${content.mime};base64,${content.dataBase64}`}
        alt={content.path}
        className={
          expanded
            ? "max-h-[75vh] max-w-full rounded object-contain"
            : "max-h-96 max-w-full rounded object-contain"
        }
      />
    );
  }
  if (content.mime === "text/html") {
    if (!expanded) {
      return (
        <p className="text-xs text-muted">
          HTML 文档 · {formatBytes(content.size)}
          {content.truncated ? "（已截断）" : ""}
        </p>
      );
    }
    return <SanitizedHtml html={decodeBase64Utf8(content.dataBase64)} />;
  }
  if (content.mime.startsWith("text/") || content.mime === "application/json") {
    const text = decodeBase64Utf8(content.dataBase64);
    if (content.mime === "text/markdown") return <Markdown text={text} />;
    return (
      <pre
        className={`max-w-full overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-fg ${
          expanded ? "max-h-[70vh]" : "max-h-96"
        }`}
      >
        {text}
      </pre>
    );
  }
  return (
    <p className="text-xs text-muted">
      {content.mime} · {formatBytes(content.size)}
      {content.truncated ? "（已截断）" : ""} · 暂不支持内联预览
    </p>
  );
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
