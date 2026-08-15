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

import { canStartAgent } from "../presentation/catalog/resolve";
import {
  ForkDialog,
  type ForkCatalog,
  type ForkMachineOption,
  type ForkSelection,
} from "./ForkDialog";
import { Markdown } from "./Markdown";

import { attachmentPreviewUrl } from "./attachments";
import { useWorkbench } from "./store";
import type { PendingMessage, TimelineState } from "./timeline";
import { ToolCallView } from "./ToolCall";
import { useSessionArtifact } from "./useSessionArtifact";

/**
 * How long a send may stay silent before the wait is named.
 *
 * Under a warm agent the reply beats this and the spinner in the composer is the
 * whole story. A cold Cursor does not: it has a process to spawn and a handshake
 * to finish, and "正在启动 Cursor…" is the difference between a wait and a hang.
 */
const SLOW_START_MS = 800;

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

export interface ForkController {
  sourceMachine: ForkMachineOption;
  listMachines(): Promise<ForkMachineOption[]>;
  loadCatalog(machine: ForkMachineOption): Promise<ForkCatalog>;
  fork(turnId: string, selection: ForkSelection): Promise<boolean>;
}

const CURRENT_MACHINE: ForkMachineOption = {
  id: "current",
  routeId: "current",
  label: "当前机器",
  kind: "local",
  online: true,
};

export function TimelineView({
  state,
  forkController,
}: {
  state: TimelineState;
  forkController?: ForkController;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [forkRequest, setForkRequest] = useState<{
    turnId: string;
    hasNativeCheckpoint: boolean;
  } | null>(null);
  const forkSession = useWorkbench((workbench) => workbench.forkSession);
  const rounds = useWorkbench((workbench) => workbench.timeline.rounds);
  const activeSessionId = useWorkbench((workbench) => workbench.activeSessionId);
  const sessions = useWorkbench((workbench) => workbench.sessions);
  const agents = useWorkbench((workbench) => workbench.agents);
  const workspaces = useWorkbench((workbench) => workbench.workspaces);
  const activeSession = sessions.find((entry) => entry.id === activeSessionId);
  const canFork = Boolean(activeSession && agents.some(canStartAgent));
  const agentLabel = useWorkbench((workbench) => {
    const session = workbench.sessions.find((entry) => entry.id === activeSessionId);
    return workbench.agents.find((entry) => entry.id === session?.agentId)?.label ?? null;
  });
  const turns = turnBlocks(state.items);
  const contextualTurns = contextualizeTurns(turns, rounds, state.items);

  // Stay at the bottom while new content arrives, unless the user scrolled up
  // to read something — then leave them where they are. A message of one's own
  // counts as new content: it is the one thing the sender is certainly watching
  // for.
  useEffect(() => {
    if (pinned) bottom.current?.scrollIntoView({ block: "end" });
  }, [state.items, state.pending, rounds, pinned]);

  return (
    <>
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
                    canFork={canFork}
                    onFork={() =>
                      setForkRequest({
                        turnId: turn.stats!.turnId,
                        hasNativeCheckpoint: Boolean(turn.stats!.forkCheckpoint),
                      })
                    }
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

        {state.pending ? (
          <PendingBubble pending={state.pending} agentLabel={agentLabel} />
        ) : null}

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
      {forkRequest && activeSession ? (
        <ForkDialog
          sourceMachine={forkController?.sourceMachine ?? CURRENT_MACHINE}
          sourceWorkspaceId={activeSession.workspaceId}
          sourceAgentId={activeSession.agentId}
          sourceCatalog={{ agents, workspaces }}
          hasNativeCheckpoint={forkRequest.hasNativeCheckpoint}
          listMachines={forkController?.listMachines}
          loadCatalog={forkController?.loadCatalog}
          onClose={() => setForkRequest(null)}
          onConfirm={(selection) => {
            if (forkController) return forkController.fork(forkRequest.turnId, selection);
            const unchanged =
              selection.machine.id === CURRENT_MACHINE.id &&
              selection.workspaceId === activeSession.workspaceId &&
              selection.agentId === activeSession.agentId;
            return forkSession(
              forkRequest.turnId,
              unchanged
                ? undefined
                : { agentId: selection.agentId, workspaceId: selection.workspaceId },
            );
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The user's own message, before the daemon has echoed it back.
 *
 * Drawn where the real one will be and dimmed, so it reads as this message
 * rather than as a different kind of thing that will be replaced by one. When it
 * fails it stays put: the text is here and nowhere else, and a red line at the
 * top of the window with an empty composer below it is how a message gets lost.
 */
function PendingBubble({
  pending,
  agentLabel,
}: {
  pending: PendingMessage;
  agentLabel: string | null;
}) {
  const retry = useWorkbench((state) => state.retryPending);
  const edit = useWorkbench((state) => state.editPending);
  const [slow, setSlow] = useState(() => Date.now() - pending.sentAtMs >= SLOW_START_MS);

  useEffect(() => {
    if (pending.error) return;
    const remaining = SLOW_START_MS - (Date.now() - pending.sentAtMs);
    if (remaining <= 0) {
      setSlow(true);
      return;
    }
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), remaining);
    return () => window.clearTimeout(timer);
  }, [pending.sentAtMs, pending.error]);

  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="pending-message">
      {pending.attachments.length > 0 ? (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {pending.attachments.map((attachment, index) => {
            const url = attachmentPreviewUrl(attachment);
            return url ? (
              <img
                key={index}
                src={url}
                alt={attachment.name}
                className="h-28 w-28 rounded-xl border border-line object-cover opacity-70"
              />
            ) : null;
          })}
        </div>
      ) : null}
      {pending.text ? (
        <p
          className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-white ${
            pending.error ? "bg-accent/50" : "bg-accent/70"
          }`}
        >
          {pending.text}
        </p>
      ) : null}
      {pending.error ? (
        <div
          className="flex max-w-[80%] flex-wrap items-baseline justify-end gap-x-2 text-xs text-danger"
          role="alert"
        >
          <span className="min-w-0">发送失败：{pending.error}</span>
          <button type="button" className="text-accent" onClick={() => void retry()}>
            重试
          </button>
          <button type="button" className="text-accent" onClick={edit}>
            编辑
          </button>
        </div>
      ) : slow ? (
        <p className="text-xs text-muted" role="status">
          {agentLabel ? `正在启动 ${agentLabel}…` : "正在启动 Agent…"}
        </p>
      ) : null}
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
          <SessionMarkdown text={item.text} />
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
    // The turn summary and the round layer arrive over different paths. A fast
    // completion can therefore leave this turn completed while the last round
    // layer still says `running` (or its refresh can be lost during a reconnect).
    // Never let that projection lag hide an answer we already have: the turn's
    // own completed summary is authoritative for its final assistant message.
    const completedTurnFinal =
      currentRound && turn.stats?.outcome === "completed"
        ? lastAssistantMessage(turn.items)
        : undefined;
    return {
      turn,
      startedRounds,
      round: currentRound,
      finalAssistant:
        roundFinal && itemIds.has(roundFinal.id) ? roundFinal : completedTurnFinal,
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
  // Which trunk is the live tail changes as the round advances, so the default
  // has to be read on every render rather than captured once. A null override
  // follows that default; clicking detaches this trunk from it, so the work the
  // user opened to read does not collapse under them when the tail moves on.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? active;

  useEffect(() => {
    if (open && !detail) void loadTrunk(round.roundId, summary.index);
  }, [detail, loadTrunk, open, round.roundId, summary.index]);

  const batches = detail?.batches.filter(
    (batch) => !finalSummaryText || !isFinalSummaryBatch(batch.summary, finalSummaryText),
  );
  const singleBatch = batches?.length === 1 ? batches[0] : undefined;
  const singleBatchTitle = splitMonologue(singleBatch?.monologue ?? "").first;
  const trunkTitle = singleBatchTitle || progressTitle(summary.title);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg" data-testid="round-trunk">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
      >
        <span className="shrink-0" aria-hidden="true">
          🧭
        </span>
        <span
          className={`min-w-0 flex-1 text-sm font-medium ${
            open ? "whitespace-pre-wrap break-words" : "truncate"
          }`}
          title={trunkTitle}
        >
          {trunkTitle}
        </span>
        <span className="shrink-0 text-xs text-muted">{summary.blobCount} 项</span>
        <span className="shrink-0 text-xs text-accent" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <div className="space-y-2 px-2 pb-2">
          {!detail ? <p className="px-2 py-1 text-xs text-muted">正在加载…</p> : null}
          {singleBatch ? (
            <BatchContent
              batch={singleBatch}
              monologue={monologueAfterTitle(singleBatch.monologue ?? "", summary.title)}
            />
          ) : (
            batches?.map((batch, index) => (
              <BatchCard
                key={batch.summary.index}
                batch={batch}
                active={active && index === batches.length - 1}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function BatchCard({ batch, active }: { batch: RoundBatch; active: boolean }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? active;
  const monologue = splitMonologue(batch.monologue ?? "");
  return (
    <div
      className="overflow-hidden rounded-lg border border-line bg-surface"
      data-testid="round-batch"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
      >
        <span className="shrink-0" aria-hidden="true">
          💭
        </span>
        <span
          className={`min-w-0 flex-1 text-xs ${
            open ? "whitespace-pre-wrap break-words" : "truncate"
          }`}
          title={monologue.first || batch.summary.text}
        >
          {monologue.first || batch.summary.text}
        </span>
        <span className="shrink-0 text-xs text-muted">{batch.summary.blobCount} 项</span>
        <span className="shrink-0 text-xs text-accent" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? <BatchContent batch={batch} monologue={monologue.rest} /> : null}
    </div>
  );
}

function BatchContent({
  batch,
  monologue = batch.monologue,
}: {
  batch: RoundBatch;
  monologue?: string;
}) {
  return (
    <div className="space-y-1 px-2 pb-2">
      {monologue ? (
        <div className="px-1 py-1 text-sm" data-testid="batch-monologue">
          <SessionMarkdown text={monologue} />
        </div>
      ) : null}
      {batch.blobs.map((blob) => <BlobRow key={blob.itemId} blob={blob} />)}
    </div>
  );
}

function splitMonologue(monologue: string): { first: string; rest: string } {
  const lines = monologue.replace(/\r\n/gu, "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  const firstLine = lines.shift()?.trim() ?? "";
  const ends = [...firstLine.matchAll(/[。！？!?]|[.](?=\s|$)/gu)];
  const longEnough = ends.find(
    (match) =>
      [...firstLine.slice(0, (match.index ?? 0) + match[0].length)].filter(
        (character) => !/\s/u.test(character),
      ).length > 15,
  );
  const end = longEnough
    ? (longEnough.index ?? 0) + longEnough[0].length
    : firstLine.length;
  const first = firstLine.slice(0, end).trim().replace(/(?:\.{3}|…)+$/u, "");
  const sameLineRest = firstLine.slice(end).trim();
  const rest = [sameLineRest, ...lines].filter(Boolean).join("\n").trim();
  return { first, rest };
}

function monologueAfterTitle(monologue: string, title: string): string {
  const { first, rest } = splitMonologue(monologue);
  const comparable = (text: string) =>
    normalizeProgressTitle(text)
      .replace(/[\p{P}\p{S}\s]/gu, "")
      .toLocaleLowerCase();
  const firstKey = comparable(first);
  const titleKey = comparable(title);
  const duplicate =
    firstKey.length >= 4 &&
    titleKey.length >= 4 &&
    (firstKey.startsWith(titleKey) || titleKey.startsWith(firstKey));
  return duplicate ? rest : monologue;
}

function normalizeProgressTitle(title: string): string {
  const normalized = title
    .trim()
    .replace(/^我(?:会|将|要|准备)?(?:先|再|继续|开始)?\s*/, "")
    .replace(/^接下来(?:我)?(?:会|将|要)?\s*/, "")
    .replace(/^现在(?:我)?(?:会|将|要)?\s*/, "");
  return normalized || title.trim();
}

function progressTitle(title: string): string {
  const normalized = normalizeProgressTitle(title);
  return splitMonologue(normalized).first || normalized.replace(/(?:\.{3}|…)+$/u, "").trim();
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

function lastAssistantMessage(
  items: TimelineItem[],
): Extract<TimelineItem, { type: "assistantMessage" }> | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "assistantMessage" && item.text.length > 0) return item;
  }
  return undefined;
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
    ? "从这个 turn 创建分支并选择 Agent"
    : live
      ? "turn 完成后才能 Fork"
      : "当前没有可用的目标 Agent";

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
          <SessionMarkdown text={text} />
        </div>
      ) : null}
    </div>
  );
}

function SessionMarkdown({ text }: { text: string }) {
  const artifact = useSessionArtifact();
  return <Markdown text={text} artifact={artifact} />;
}
