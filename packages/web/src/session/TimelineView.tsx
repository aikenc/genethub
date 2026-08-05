import type { TimelineItem, TurnStats } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "./Markdown";

import { attachmentPreviewUrl } from "./attachments";
import { useWorkbench } from "./store";
import type { TimelineState } from "./timeline";
import { ToolCallView } from "./ToolCall";

// Named for the file rather than for the thing it draws, because `timeline.ts`
// next to it holds the state: two modules whose names differ only in casing are
// the same module on Windows and on a stock macOS disk, and the import that
// resolves to the wrong one of them fails nowhere except on those machines.
/**
 * The way from a failure to the rest of the story.
 *
 * A turn that failed says one line; what the agent wrote on its way out, and
 * everything before it, is in the log. Reachable from here rather than described
 * as a path, because the reader may be on a phone.
 */
function LogLink() {
  const openTab = useWorkbench((state) => state.openTab);
  return (
    <button
      type="button"
      className="mt-1 text-xs underline decoration-dotted hover:text-fg"
      onClick={() => openTab("logs")}
    >
      查看日志
    </button>
  );
}

export function TimelineView({ state }: { state: TimelineState }) {
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const forkSession = useWorkbench((workbench) => workbench.forkSession);
  const activeSessionId = useWorkbench((workbench) => workbench.activeSessionId);
  const canFork = useWorkbench((workbench) => {
    const session = workbench.sessions.find((entry) => entry.id === activeSessionId);
    const agent = workbench.agents.find((entry) => entry.id === session?.agentId);
    return agent?.capabilities.fork ?? false;
  });
  const turns = turnBlocks(state.items);

  // Stay at the bottom while new content arrives, unless the user scrolled up
  // to read something — then leave them where they are.
  useEffect(() => {
    if (pinned) bottom.current?.scrollIntoView({ block: "end" });
  }, [state.items, pinned]);

  return (
    <div
      ref={scroller}
      className="mx-auto h-full min-w-0 max-w-chat flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-4 py-6"
      data-testid="timeline"
      onScroll={(event) => {
        const element = event.currentTarget;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        setPinned(distance < 40);
      }}
    >
      {turns.map((turn, index) => {
        const blocks = groupIntoBlocks(turn.items);
        // Only the tail of the turn currently being written should default
        // open — a long-running task's earlier tool-call batches fold away
        // as the agent moves on, instead of every batch staying expanded
        // and turning the screen into a wall of cards (the original
        // complaint this grouping exists to fix).
        const isLiveTurn = !turn.stats && index === turns.length - 1 && Boolean(state.activeTurn);
        return (
          <section key={turn.stats?.turnId ?? `loose-${index}`} className="space-y-4">
            {blocks.map((block, blockIndex) =>
              block.kind === "work" ? (
                <WorkGroup
                  key={block.items[0]!.id}
                  items={block.items}
                  defaultOpen={isLiveTurn && blockIndex === blocks.length - 1}
                />
              ) : (
                <Item key={block.item.id} item={block.item} />
              ),
            )}
            {turn.stats ? (
              <TurnFooter
                stats={turn.stats}
                text={assistantText(turn.items)}
                canFork={canFork && Boolean(turn.stats.forkCheckpoint)}
                onFork={() => void forkSession(turn.stats!.turnId)}
              />
            ) : index === turns.length - 1 && state.activeTurn ? (
              <TurnFooter
                liveStartedAtMs={state.activeTurnStartedAtMs ?? Date.now()}
                liveTools={countTools(turn.items)}
                text={assistantText(turn.items)}
                canFork={false}
              />
            ) : null}
          </section>
        );
      })}

      {state.lastError ? (
        <div
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger"
          role="alert"
        >
          <p>{state.lastError.message}</p>
          <LogLink />
        </div>
      ) : null}

      <div ref={bottom} />
    </div>
  );
}

function Item({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "userMessage":
      return (
        <div className="flex flex-col items-end gap-1.5">
          {item.attachments.length > 0 ? (
            <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
              {item.attachments.map((attachment, index) => {
                const url = attachmentPreviewUrl(attachment);
                return url ? (
                  <img
                    key={index}
                    src={url}
                    alt={attachment.name}
                    className="h-28 w-28 rounded-xl border border-line object-cover"
                  />
                ) : null;
              })}
            </div>
          ) : null}
          {item.text ? (
            <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-accent px-3 py-2 text-white">
              {item.text}
            </p>
          ) : null}
        </div>
      );

    case "assistantMessage":
      return (
        <div data-testid="assistant-message">
          <Markdown text={item.text} />
        </div>
      );

    case "reasoning":
      return <Reasoning text={item.text} />;

    case "toolCall":
      return <ToolCallView name={item.name} status={item.status} detail={item.detail} />;

    case "todo":
      return (
        <ul className="space-y-1 rounded-lg border border-line bg-surface px-3 py-2">
          {item.items.map((entry, index) => (
            <li key={index} className={entry.status === "completed" ? "text-muted line-through" : ""}>
              {entry.text}
            </li>
          ))}
        </ul>
      );

    case "compaction":
      return (
        <p className="text-center text-xs text-muted">
          —— 历史已压缩（{item.reason}）——
        </p>
      );

    case "error":
      return (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
          <p>{item.message}</p>
          <LogLink />
        </div>
      );

    case "turnSummary":
      return null;
  }
}

interface TurnBlock {
  items: TimelineItem[];
  stats: TurnStats | null;
}

function turnBlocks(items: TimelineItem[]): TurnBlock[] {
  const turns: TurnBlock[] = [];
  let current: TimelineItem[] = [];
  for (const item of items) {
    if (item.type === "userMessage" && current.some((entry) => entry.type === "userMessage")) {
      turns.push({ items: current, stats: null });
      current = [];
    }
    if (item.type === "turnSummary") {
      turns.push({ items: current, stats: item.stats });
      current = [];
    } else {
      current.push(item);
    }
  }
  if (current.length > 0 || turns.length === 0) turns.push({ items: current, stats: null });
  return turns;
}

/**
 * Groups consecutive `toolCall`/`reasoning` items into a single collapsible
 * unit — the same boundary a long-running round hits on the daemon side
 * (`apps/daemon/src/session/rounds.rs`'s `TrunkBuilder`, `TRUNK_MAX_ITEMS`),
 * mirrored here purely for display: nothing about this changes what the
 * wire sends, it only changes how many cards `TimelineView` puts on screen
 * at once. A run of length 1 is left ungrouped — wrapping a single tool
 * call in a "group of one" toggle would be a regression for the common
 * case this exists to leave alone.
 */
type RenderBlock = { kind: "single"; item: TimelineItem } | { kind: "work"; items: TimelineItem[] };

const WORK_GROUP_MAX_ITEMS = 32;

function groupIntoBlocks(items: TimelineItem[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let bucket: TimelineItem[] = [];

  const flush = () => {
    if (bucket.length === 0) return;
    if (bucket.length === 1) {
      blocks.push({ kind: "single", item: bucket[0]! });
    } else {
      blocks.push({ kind: "work", items: bucket });
    }
    bucket = [];
  };

  for (const item of items) {
    if (item.type === "reasoning" || item.type === "toolCall") {
      bucket.push(item);
      if (bucket.length >= WORK_GROUP_MAX_ITEMS) flush();
    } else {
      flush();
      blocks.push({ kind: "single", item });
    }
  }
  flush();
  return blocks;
}

/** A deterministic one-line summary for a collapsed group's header — never
 * a guess dressed up as agent prose, same rule the daemon's own fallback
 * overview follows for the persisted trunk ledger. */
function summarizeWork(items: TimelineItem[]): string {
  const toolNames: string[] = [];
  let reasoningCount = 0;
  for (const item of items) {
    if (item.type === "toolCall" && !toolNames.includes(item.name)) toolNames.push(item.name);
    if (item.type === "reasoning") reasoningCount += 1;
  }
  if (toolNames.length === 0) return `进行了 ${reasoningCount} 次思考`;
  return `运行了 ${items.length} 次工具（${toolNames.join(", ")}）`;
}

function WorkGroup({ items, defaultOpen }: { items: TimelineItem[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasError = items.some((item) => item.type === "toolCall" && item.status === "error");

  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError]);

  return (
    <div
      className={`min-w-0 max-w-full overflow-hidden rounded-lg border bg-surface ${
        hasError ? "border-danger/50" : "border-line"
      }`}
      data-testid="work-group"
    >
      <header className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
        <span className="shrink-0 text-base" role="img" aria-label="批量操作">
          📦
        </span>
        <span className="min-w-0 flex-1 truncate text-muted">{summarizeWork(items)}</span>
        <button
          type="button"
          className="shrink-0 text-accent"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "收起" : `展开 ${items.length} 项`}
        </button>
      </header>
      {open ? (
        <div className="space-y-2 border-t border-line px-3 py-2">
          {items.map((item) => (
            <Item key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function assistantText(items: TimelineItem[]): string {
  return items
    .filter((item): item is Extract<TimelineItem, { type: "assistantMessage" }> =>
      item.type === "assistantMessage",
    )
    .map((item) => item.text)
    .join("\n\n");
}

function countTools(items: TimelineItem[]): number {
  const count = (item: TimelineItem): number => {
    if (item.type !== "toolCall") return 0;
    if (item.detail.kind !== "subAgent") return 1;
    return 1 + item.detail.items.reduce((total, child) => total + count(child), 0);
  };
  return items.reduce((total, item) => total + count(item), 0);
}

function TurnFooter({
  stats,
  liveStartedAtMs,
  liveTools = 0,
  text,
  canFork,
  onFork,
}: {
  stats?: TurnStats;
  liveStartedAtMs?: number;
  liveTools?: number;
  text: string;
  canFork: boolean;
  onFork?: () => void;
}) {
  const live = !stats;
  const [now, setNow] = useState(Date.now());
  const [details, setDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), live ? 1_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [live]);

  const duration = stats?.durationMs ?? Math.max(0, now - (liveStartedAtMs ?? now));
  const usage = stats?.usage;
  const tools = stats?.toolCalls ?? liveTools;
  const forkTitle = canFork
    ? "从这个 turn 创建独立分支"
    : live
      ? "turn 完成后才能 Fork"
      : "当前 Agent 不支持从这个 turn Fork";

  return (
    <footer className="ml-auto max-w-full text-xs text-muted" data-testid="turn-footer">
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
        <span>{stats ? relativeTime(stats.finishedAtMs, now) : "进行中"}</span>
        <span aria-hidden="true">·</span>
        <span>耗时 {formatDuration(duration)}</span>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          className="text-accent"
          aria-expanded={details}
          onClick={() => setDetails((value) => !value)}
        >
          {usage ? `${formatTokens(usage.outputTokens)} 输出 tokens` : "— 输出 tokens"}
          {details ? " ▴" : " ▾"}
        </button>
        <button
          type="button"
          className="text-accent disabled:cursor-not-allowed disabled:text-faint"
          disabled={!canFork}
          title={forkTitle}
          onClick={onFork}
        >
          Fork
        </button>
        <button
          type="button"
          className="text-accent disabled:text-faint"
          disabled={!text}
          onClick={() => {
            if (!text || !navigator.clipboard) return;
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      {details ? (
        <div className="mt-1 flex flex-wrap justify-end gap-x-3 rounded-md bg-raised px-2 py-1">
          <span>Cached {usage ? formatTokens(usage.cacheReadTokens) : "—"}</span>
          <span>Input {usage ? formatTokens(usage.inputTokens) : "—"}</span>
          <span>Output {usage ? formatTokens(usage.outputTokens) : "—"}</span>
          <span>Tools {tools}</span>
        </div>
      ) : null}
    </footer>
  );
}

function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/** Collapsed by default: it is context, not the answer. */
function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-2 text-xs text-muted">
      <button type="button" onClick={() => setOpen((value) => !value)} className="text-accent">
        {open ? "收起思考过程" : "思考过程"}
      </button>
      {open ? (
        <div className="mt-1">
          <Markdown text={text} />
        </div>
      ) : null}
    </div>
  );
}
