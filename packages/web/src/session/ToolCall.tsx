import type { ToolCallDetail, ToolStatus } from "@genehub/proto";

import { Markdown } from "./Markdown";
import { useEffect, useState } from "react";

/**
 * Tool calls get a renderer per shape, and `unknown` gets a readable fallback.
 *
 * The fallback is not a nicety. A new agent will call tools we have never heard
 * of, and showing raw JSON is the difference between "that agent looks broken"
 * and "that tool has no custom view yet" (`architecture.md` §4).
 */
export function ToolCallView({
  name,
  status,
  detail,
}: {
  name: string;
  status: ToolStatus;
  detail: ToolCallDetail;
}) {
  // Ordinary successful tools stay out of the way until asked for; failures
  // open themselves when they settle. New sessions only carry bounded
  // overviews; old detailed shapes remain renderable during migration.
  const [open, setOpen] = useState(status === "error");
  useEffect(() => {
    if (status === "error") setOpen(true);
  }, [status]);

  return (
    <div
      className="min-w-0 max-w-full overflow-hidden rounded-lg border border-line bg-surface"
      data-testid="tool-call"
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <StatusDot status={status} />
        <span className="shrink-0 font-mono text-fg">{name}</span>
        {/* Truncate here; the body is where a long command or path is readable. */}
        <span className="min-w-0 flex-1 truncate text-muted">{summarize(detail)}</span>
        <button
          type="button"
          className="shrink-0 text-accent"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "收起详情" : "展开详情"}
        </button>
      </header>
      {open ? (
        <div className="min-w-0 px-3 py-2 text-[13px]">
          <Body detail={detail} />
        </div>
      ) : null}
    </div>
  );
}

function StatusDot({ status }: { status: ToolStatus }) {
  const colour =
    status === "ok"
      ? "bg-ok"
      : status === "error"
        ? "bg-danger"
        : status === "running"
          ? "bg-accent animate-pulse"
          : "bg-muted";
  return <i className={`h-2 w-2 shrink-0 rounded-full ${colour}`} aria-label={status} role="img" />;
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

function Body({ detail }: { detail: ToolCallDetail }) {
  switch (detail.kind) {
    case "overview":
      return (
        <div className="min-w-0 space-y-1">
          {detail.input ? <p className="break-all text-muted">输入：{detail.input}</p> : null}
          {detail.output ? <p className="break-all text-muted">输出：{detail.output}</p> : null}
        </div>
      );
    case "shell":
      return (
        <div className="min-w-0 space-y-2">
          <Pre>{detail.command}</Pre>
          <Pre>
            {detail.output || "（暂无输出）"}
            {detail.exitCode !== null && detail.exitCode !== 0
              ? `\n退出码 ${detail.exitCode}`
              : ""}
          </Pre>
        </div>
      );

    case "read":
      return (
        <Pre>
          {detail.content}
          {detail.truncated ? "\n…（已截断）" : ""}
        </Pre>
      );

    case "write":
      return <Pre>{detail.content}</Pre>;

    case "edit":
      return <Diff diff={detail.diff} />;

    case "search":
      return detail.matches.length === 0 ? (
        <p className="text-muted">没有匹配</p>
      ) : (
        <ul className="space-y-0.5 font-mono text-xs">
          {detail.matches.slice(0, 50).map((match, index) => (
            <li key={`${match.path}:${match.line ?? index}`} className="truncate">
              <span className="text-accent">{match.path}</span>
              {match.line !== null && match.line !== undefined ? `:${match.line}` : ""}
              {match.preview ? <span className="text-muted"> {match.preview}</span> : null}
            </li>
          ))}
        </ul>
      );

    case "fetch":
      return <Pre>{detail.summary}</Pre>;

    case "plan":
      // A plan is written as markdown, and it is the one tool output someone is
      // meant to read end to end before answering a permission request about it.
      return <Markdown text={detail.markdown} />;

    case "subAgent":
      return (
        <div className="space-y-2">
          <p className="text-muted">{detail.prompt}</p>
          {detail.items.length > 0 ? (
            // Indented, because whose work this is matters: these ran inside the
            // sub-agent, and reading them as the main agent's own steps is exactly
            // the confusion the nesting exists to remove.
            <ul className="space-y-2 border-l border-line pl-3" aria-label="子 agent 的步骤">
              {detail.items.map((item) => (
                <li key={item.id}>
                  {item.type === "toolCall" ? (
                    <ToolCallView name={item.name} status={item.status} detail={item.detail} />
                  ) : item.type === "assistantMessage" || item.type === "reasoning" ? (
                    <p className="text-xs text-muted">{item.text}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );

    case "unknown":
      return <Unknown raw={detail.raw} />;
  }
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-80 max-w-full overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-fg">
      {children}
    </pre>
  );
}

/** Line-level colouring. Enough to read a change; not a merge tool. */
function Diff({ diff }: { diff: string }) {
  return (
    <pre
      className="max-h-80 max-w-full overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs"
      data-testid="diff"
    >
      {diff.split("\n").map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith("+")
              ? "bg-ok/10 text-ok"
              : line.startsWith("-")
                ? "bg-danger/10 text-danger"
                : line.startsWith("@@")
                  ? "text-muted"
                  : ""
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function Unknown({ raw }: { raw: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="text-xs text-accent"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "收起原始数据" : "展开原始数据"}
      </button>
      {open ? <Pre>{JSON.stringify(raw, null, 2)}</Pre> : null}
    </div>
  );
}
