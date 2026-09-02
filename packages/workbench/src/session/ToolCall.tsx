import type { ToolCallDetail, ToolImage, ToolKind, ToolStatus } from "@genehub/proto";
import { useState } from "react";

import { ImageThumbStrip } from "./ImageStrip";

export function ToolCallView({
  name,
  detail,
  images = [],
}: {
  name: string;
  status: ToolStatus;
  detail: ToolCallDetail;
  images?: ToolImage[];
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // The daemon is authoritative, but the renderer keeps the same bound for
  // persisted data and in-memory fixtures as a final presentation boundary.
  const output = boundedOutput(toolOutput(detail));
  const summary = oneLine(summarize(detail), 64);

  return (
    <div
      className="min-w-0 max-w-full overflow-hidden rounded-lg border border-line bg-surface"
      data-testid="tool-call"
    >
      <header className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
        <span className="shrink-0 text-base" role="img" aria-label={kindLabel(toolKind(detail))}>
          {kindEmoji(toolKind(detail))}
        </span>
        <span className="shrink-0 font-mono text-fg">{name}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{summary}</span>
        <button
          type="button"
          className="shrink-0 text-accent"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "收起输出" : "查看输出"}
        </button>
      </header>
      {images.length > 0 ? (
        <div className="border-t border-line px-3 pb-2">
          <ImageThumbStrip
            images={images.map((image, index) => ({
              id: `${name}-img-${index}`,
              alt: image.alt,
              thumb: image.thumb,
              path: image.path,
            }))}
          />
        </div>
      ) : null}
      {open ? (
        <div className="min-w-0 border-t border-line px-3 py-2 text-[13px]">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-muted">输出</span>
            <button
              type="button"
              className="text-xs text-accent"
              onClick={() => {
                if (!navigator.clipboard) return;
                void navigator.clipboard.writeText(output).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                });
              }}
            >
              {copied ? "已复制" : "复制输出"}
            </button>
          </div>
          <Pre>{output || "暂无输出"}</Pre>
        </div>
      ) : null}
    </div>
  );
}

function summarize(detail: ToolCallDetail): string {
  switch (detail.kind) {
    case "overview":
      return detail.overview;
    case "shell":
      return detail.command;
    case "read":
    case "edit":
    case "write":
      return detail.path;
    case "search":
      return detail.query;
    case "fetch":
      return detail.url;
    case "plan":
      return "计划";
    case "subAgent":
      return detail.agent;
    case "unknown":
      return "";
  }
}

function toolOutput(detail: ToolCallDetail): string {
  switch (detail.kind) {
    case "overview":
    case "shell":
      return detail.output;
    case "read":
      return detail.content;
    case "write":
      return detail.content;
    case "edit":
      return detail.diff;
    case "search":
      return detail.matches
        .map((match) => `${match.path}${match.line == null ? "" : `:${match.line}`} ${match.preview}`)
        .join("\n");
    case "fetch":
      return detail.summary;
    case "plan":
      return detail.markdown;
    case "subAgent":
      return detail.items
        .map((item) =>
          item.type === "assistantMessage" || item.type === "reasoning" ? item.text : "",
        )
        .filter(Boolean)
        .join("\n");
    case "unknown":
      return JSON.stringify(detail.raw, null, 2);
  }
}

function toolKind(detail: ToolCallDetail): ToolKind {
  if (detail.kind === "overview") return detail.toolKind ?? "other";
  if (detail.kind === "subAgent") return "subAgent";
  if (detail.kind === "unknown") return "other";
  return detail.kind;
}

const EMOJI: Record<ToolKind, string> = {
  shell: "🖥️",
  read: "📖",
  write: "📝",
  edit: "✏️",
  search: "🔍",
  fetch: "🌐",
  plan: "📋",
  subAgent: "🤖",
  mcp: "🔌",
  other: "🔧",
};

const LABEL: Record<ToolKind, string> = {
  shell: "执行命令",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  search: "搜索",
  fetch: "访问网络",
  plan: "计划",
  subAgent: "子 Agent",
  mcp: "外部工具",
  other: "工具",
};

export const kindEmoji = (kind: ToolKind) => EMOJI[kind];
export const kindLabel = (kind: ToolKind) => LABEL[kind];

function clip(text: string, max: number): string {
  const characters = [...text];
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join("")}…`;
}

function oneLine(text: string, max: number): string {
  return clip(text.trim().split(/\s+/u).filter(Boolean).join(" "), max);
}

function boundedOutput(text: string): string {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  const bounded = (line: string) => clip(line, 64);
  if (lines.length <= 4) return lines.map(bounded).join("\n");
  return [
    ...lines.slice(0, 2).map(bounded),
    `… 已省略 ${lines.length - 4} 行 …`,
    ...lines.slice(-2).map(bounded),
  ].join("\n");
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-80 max-w-full overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-fg">
      {children}
    </pre>
  );
}
