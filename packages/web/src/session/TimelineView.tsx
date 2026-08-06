import type {
  BlobOverview,
  RoundBatch,
  RoundSummary,
  RoundTrunkSummary,
  TimelineItem,
  TurnStats,
} from "@genehub/proto";
import { useEffect, useRef, useState } from "react";
import { stringify as toYaml } from "yaml";

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
  const rounds = useWorkbench((workbench) => workbench.timeline.rounds);
  const activeSessionId = useWorkbench((workbench) => workbench.activeSessionId);
  const canFork = useWorkbench((workbench) => {
    const session = workbench.sessions.find((entry) => entry.id === activeSessionId);
    const agent = workbench.agents.find((entry) => entry.id === session?.agentId);
    return agent?.capabilities.fork ?? false;
  });
  const turns = turnBlocks(state.items);
  const contextualTurns = contextualizeTurns(turns, rounds, state.items);

  // Stay at the bottom while new content arrives, unless the user scrolled up
  // to read something — then leave them where they are.
  useEffect(() => {
    if (pinned) bottom.current?.scrollIntoView({ block: "end" });
  }, [state.items, rounds, pinned]);

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
      {contextualTurns.map(
        ({ turn, startedRounds, round, finalAssistant, roundFinalText }, index) => {
          const hasRound = Boolean(round);
          const narrative =
            rounds.length === 0
              ? turn.items
              : turn.items.filter(
                  (item) =>
                    item.type !== "reasoning" &&
                    item.type !== "toolCall" &&
                    (!hasRound || item.type !== "assistantMessage"),
                );
          return (
            <section key={turn.stats?.turnId ?? `loose-${index}`} className="space-y-4">
              {narrative.map((item) => <Item key={item.id} item={item} />)}
              {startedRounds.map((startedRound) => (
                <RoundProgress
                  key={startedRound.roundId}
                  round={startedRound}
                  finalSummaryText={roundFinalText}
                />
              ))}
              {finalAssistant ? <Item item={finalAssistant} /> : null}
              {turn.stats ? (
                <TurnFooter
                  stats={turn.stats}
                  text={hasRound ? (finalAssistant?.text ?? "") : assistantText(turn.items)}
                  canFork={canFork && Boolean(turn.stats.forkCheckpoint)}
                  onFork={() => void forkSession(turn.stats!.turnId)}
                />
              ) : index === turns.length - 1 && state.activeTurn ? (
                <TurnFooter
                  liveStartedAtMs={state.activeTurnStartedAtMs ?? Date.now()}
                  liveTools={countTools(turn.items)}
                  text={hasRound ? "" : assistantText(turn.items)}
                  canFork={false}
                />
              ) : null}
            </section>
          );
        },
      )}

      {rounds
        .filter(
          (round) =>
            !round.userItemId ||
            !state.items.some(
              (item) => item.type === "userMessage" && item.id === round.userItemId,
            ),
        )
        .map((round) => <RoundProgress key={round.roundId} round={round} />)}

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

interface ContextualTurn {
  turn: TurnBlock;
  startedRounds: RoundSummary[];
  round?: RoundSummary;
  finalAssistant?: Extract<TimelineItem, { type: "assistantMessage" }>;
  roundFinalText?: string;
}

function contextualizeTurns(
  turns: TurnBlock[],
  rounds: RoundSummary[],
  items: TimelineItem[],
): ContextualTurn[] {
  const positions = new Map(items.map((item, index) => [item.id, index]));
  const positionedRounds = rounds
    .flatMap((round) => {
      const position = round.userItemId ? positions.get(round.userItemId) : undefined;
      return position === undefined ? [] : [{ round, position }];
    })
    .sort((left, right) => left.position - right.position);
  const finals = new Map<string, Extract<TimelineItem, { type: "assistantMessage" }>>();
  positionedRounds.forEach(({ round, position }, index) => {
    if (round.outcome === "running") return;
    const end = positionedRounds[index + 1]?.position ?? items.length;
    const final = finalAssistantMessage(items.slice(position, end));
    if (final) finals.set(round.roundId, final);
  });

  let currentRound: RoundSummary | undefined;
  return turns.map((turn) => {
    const itemIds = new Set(turn.items.map((item) => item.id));
    const startedRounds = rounds.filter(
      (round) => round.userItemId && itemIds.has(round.userItemId),
    );
    if (startedRounds.length > 0) currentRound = startedRounds[startedRounds.length - 1];
    const roundFinal = currentRound ? finals.get(currentRound.roundId) : undefined;
    return {
      turn,
      startedRounds,
      round: currentRound,
      finalAssistant:
        roundFinal && itemIds.has(roundFinal.id) ? roundFinal : undefined,
      roundFinalText: roundFinal?.text,
    };
  });
}

function RoundProgress({
  round,
  finalSummaryText,
}: {
  round: RoundSummary;
  finalSummaryText?: string;
}) {
  const layer = useWorkbench((state) => state.timeline.roundLayers[round.roundId]);
  const loadRound = useWorkbench((state) => state.loadRound);
  const loadOlder = useWorkbench((state) => state.loadOlderTrunks);

  useEffect(() => {
    if (!layer) void loadRound(round.roundId);
  }, [layer, loadRound, round.roundId]);

  if (!layer) return null;

  const trunks = layer.trunks.filter(
    (trunk) =>
      !(
        finalSummaryText &&
        trunk.batches.length > 0 &&
        trunk.batches.every((batch) => isFinalSummaryBatch(batch, finalSummaryText))
      ),
  );

  return (
    <div className="space-y-2" data-testid="round-progress">
      {layer.nextCursor ? (
        <button
          type="button"
          className="w-full rounded-lg px-2 py-1 text-xs text-accent hover:bg-surface"
          onClick={() => void loadOlder(round.roundId)}
        >
          加载更早过程
        </button>
      ) : null}
      {trunks.map((trunk, index) => (
        <TrunkCard
          key={trunk.index}
          round={round}
          summary={trunk}
          finalSummaryText={finalSummaryText}
          active={round.outcome === "running" && index === trunks.length - 1}
        />
      ))}
    </div>
  );
}

function TrunkCard({
  round,
  summary,
  finalSummaryText,
  active,
}: {
  round: RoundSummary;
  summary: RoundTrunkSummary;
  finalSummaryText?: string;
  active: boolean;
}) {
  const detail = useWorkbench(
    (state) => state.timeline.roundTrunks[`${round.roundId}:${summary.index}`],
  );
  const loadTrunk = useWorkbench((state) => state.loadTrunk);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open && !detail) void loadTrunk(round.roundId, summary.index);
  }, [detail, loadTrunk, open, round.roundId, summary.index]);

  const batches = detail?.batches.filter(
    (batch) => !finalSummaryText || !isFinalSummaryBatch(batch.summary, finalSummaryText),
  );

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg" data-testid="round-trunk">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 flex-1 truncate text-sm">
          {active ? "进展" : "过程"}：{normalizeProgressTitle(summary.title)}
        </span>
        <span className="text-xs text-muted">{summary.blobCount} 项</span>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-line p-2">
          {!detail ? <p className="px-2 py-1 text-xs text-muted">正在加载…</p> : null}
          {batches?.length === 1 ? (
            <BatchContent batch={batches[0]!} />
          ) : (
            batches?.map((batch) => <BatchCard key={batch.summary.index} batch={batch} />)
          )}
        </div>
      ) : null}
    </div>
  );
}

function BatchCard({ batch }: { batch: RoundBatch }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg bg-surface" data-testid="round-batch">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <span className="ml-auto text-xs text-accent">收起</span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs">{batch.summary.text}</span>
        )}
      </button>
      {open ? <BatchContent batch={batch} bordered /> : null}
    </div>
  );
}

function BatchContent({ batch, bordered = false }: { batch: RoundBatch; bordered?: boolean }) {
  return (
    <div className={`space-y-1 px-2 py-2 ${bordered ? "border-t border-line" : ""}`}>
      {batch.monologue ? (
        <div className="px-1 py-1 text-sm" data-testid="batch-monologue">
          <Markdown text={batch.monologue} />
        </div>
      ) : null}
      {batch.blobs.map((blob) => <BlobRow key={blob.itemId} blob={blob} />)}
    </div>
  );
}

function normalizeProgressTitle(title: string): string {
  const normalized = title
    .trim()
    .replace(/^我(?:会|将|要|准备)?(?:先|再|继续|开始)?\s*/, "")
    .replace(/^接下来(?:我)?(?:会|将|要)?\s*/, "")
    .replace(/^现在(?:我)?(?:会|将|要)?\s*/, "");
  return normalized || title.trim();
}

function isFinalSummaryBatch(
  batch: RoundBatch["summary"],
  finalSummaryText: string,
): boolean {
  if (batch.blobCount !== 0) return false;
  const compact = batch.text.trim();
  if (!compact) return false;
  const prefix = compact.endsWith("…") ? compact.slice(0, -1) : compact;
  return finalSummaryText.trimStart().startsWith(prefix);
}

function BlobRow({ blob }: { blob: BlobOverview }) {
  const payload = useWorkbench((state) =>
    blob.blob ? state.timeline.blobs[blob.blob.id] : undefined,
  );
  const loadBlob = useWorkbench((state) => state.loadBlob);
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md bg-bg" data-testid="blob-row">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs"
        aria-expanded={open}
        disabled={!blob.blob}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && blob.blob && !payload) void loadBlob(blob.blob);
        }}
      >
        <span className="text-muted">{blob.kind === "reasoning" ? "思考" : "工具"}</span>
        <span className="min-w-0 flex-1 truncate">{blob.overview}</span>
        {blob.blob ? <span className="text-accent">{open ? "收起" : "详情"}</span> : null}
      </button>
      {open ? (
        <div className="max-h-96 overflow-auto border-t border-line p-2 text-xs">
          {payload ? <BlobPayloadView blob={blob} value={payload.value} /> : "正在加载…"}
        </div>
      ) : null}
    </div>
  );
}

function BlobPayloadView({ blob, value }: { blob: BlobOverview; value: unknown }) {
  if (blob.kind === "reasoning") {
    const text = reasoningText(value);
    return text ? (
      <div className="whitespace-pre-wrap text-sm leading-relaxed" data-testid="reasoning-text">
        {text}
      </div>
    ) : (
      <Markdown text={yamlMarkdown(value)} />
    );
  }

  const edit = editPayload(value);
  if (edit) {
    return (
      <div className="space-y-2">
        <p className="font-mono text-xs text-muted">{edit.path}</p>
        <Diff text={edit.diff} />
      </div>
    );
  }

  return <Markdown text={yamlMarkdown(value)} />;
}

function reasoningText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = jsonObject(value);
  return typeof record?.text === "string" ? record.text : undefined;
}

function editPayload(value: unknown): { path: string; diff: string } | undefined {
  const item = jsonObject(value);
  const detail = jsonObject(item?.detail);
  if (detail?.kind !== "edit" || typeof detail.diff !== "string") return undefined;
  return {
    path: typeof detail.path === "string" ? detail.path : "",
    diff: detail.diff,
  };
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function yamlMarkdown(value: unknown): string {
  const yaml = toYaml(value, { lineWidth: 0 }).trimEnd();
  const longestFence = Math.max(
    0,
    ...Array.from(yaml.matchAll(/`+/gu), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}yaml\n${yaml}\n${fence}`;
}

function Diff({ text }: { text: string }) {
  return (
    <div
      className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed"
      data-testid="blob-diff"
    >
      {text.split("\n").map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "text-ok"
              : line.startsWith("-") && !line.startsWith("---")
                ? "text-danger"
                : line.startsWith("@@")
                  ? "text-accent"
                  : "text-muted"
          }
        >
          {line || " "}
        </div>
      ))}
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

function finalAssistantMessage(
  items: TimelineItem[],
): Extract<TimelineItem, { type: "assistantMessage" }> | undefined {
  let final: Extract<TimelineItem, { type: "assistantMessage" }> | undefined;
  let finalIndex = -1;
  let lastWorkIndex = -1;
  items.forEach((item, index) => {
    if (item.type === "assistantMessage") {
      final = item;
      finalIndex = index;
    } else if (item.type === "reasoning" || item.type === "toolCall") {
      lastWorkIndex = index;
    }
  });
  return finalIndex > lastWorkIndex ? final : undefined;
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
