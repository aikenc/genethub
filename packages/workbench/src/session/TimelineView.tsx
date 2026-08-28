import type {
  BlobOverview,
  RoundBatch,
  RoundSummary,
  RoundTrunkSummary,
  SessionSummary,
  TimelineItem,
  TurnStats,
  Usage,
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
import { ForwardDialog } from "./ForwardDialog";
import { CURRENT_MACHINE } from "./MachineCatalogPicker";
import { Markdown } from "./Markdown";

import { attachmentPreviewUrl } from "./attachments";
import {
  attributeRounds,
  splitForwardEnvelope,
  type CapsuleMessage,
  type ForwardEnvelopeInfo,
  type ForwardSource,
} from "./forwardCapsule";
import {
  applySelectionAddMany,
  applySelectionClick,
  emptySelection,
  estimateSelectionTokens,
  isSelectableItem,
  toSelectable,
  MAX_FORWARD_SELECTION,
  type SelectableMessage,
  type SelectionState,
} from "./selection";
import { buildSelectionCopy } from "./selectionCopy";
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

/** Someone sitting at the end of a long transcript, dragging the content back
 * down to find what scrolled past. Only that direction counts: chasing new
 * messages towards the bottom is when the composer is most wanted, so tucking
 * it away there would be exactly wrong. */
const TRAVEL_PX_PER_MS = 1;
const TRAVEL_HOLD_MS = 280;
/** Longer than this between samples and the run has ended, whatever the last
 * pair of them said — a jump from `scrollIntoView` arrives as one lone sample
 * and so can never accumulate a hold. */
const TRAVEL_GAP_MS = 220;

export interface TimelineScrollRun {
  time: number;
  top: number;
  /** When the current unbroken run backwards began, or null between them. */
  fastSince: number | null;
  /** The hold has already fired for this run. Stays set until it ends, so a
   * ten-second scroll tucks the composer once rather than nineteen times. */
  spent: boolean;
  /** True on the one sample that crosses the hold, so the caller fires once. */
  triggered: boolean;
}

export const idleTimelineScroll = (): TimelineScrollRun => ({
  time: 0,
  top: 0,
  fastSince: null,
  spent: false,
  triggered: false,
});

export function trackTimelineScroll(
  previous: TimelineScrollRun,
  top: number,
  time: number,
): TimelineScrollRun {
  const deltaMs = time - previous.time;
  // Positive when the transcript is being pulled back towards older turns.
  const backwards = previous.top - top;
  const continuous = deltaMs > 0 && deltaMs <= TRAVEL_GAP_MS;
  if (!continuous || backwards / deltaMs < TRAVEL_PX_PER_MS) {
    return { time, top, fastSince: null, spent: false, triggered: false };
  }
  const fastSince = previous.fastSince ?? previous.time;
  const triggered = !previous.spent && time - fastSince >= TRAVEL_HOLD_MS;
  return { time, top, fastSince, spent: previous.spent || triggered, triggered };
}

/** Far enough from the end to want a way back, with the two edges apart so the
 * button does not blink in and out while the reader hovers around the line. */
export function showsReturnToBottom(distance: number, shown: boolean): boolean {
  return shown ? distance > 120 : distance > 320;
}

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

/**
 * What forwarding can do beyond the machine on screen. Without it (a host
 * that cannot reach other machines) the dialog offers the current machine
 * only, which is exactly the v1 behavior.
 */
export interface ForwardController {
  sourceMachine: ForkMachineOption;
  listMachines(): Promise<ForkMachineOption[]>;
  loadCatalog(machine: ForkMachineOption): Promise<ForkCatalog>;
  loadSessions(machine: ForkMachineOption): Promise<SessionSummary[]>;
  /**
   * Cross-machine delivery: sends the capsule to an existing session, or
   * creates one and sends. There is no composer to park a draft on over
   * there, so delivery is immediate — the dialog's preview is the review.
   */
  deliver(
    machine: ForkMachineOption,
    target: ForwardTarget,
    capsule: string,
  ): Promise<{ sessionId: string }>;
  jumpTo(machine: ForkMachineOption, sessionId: string): void;
}

export type ForwardTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "new"; workspaceId: string; agentId: string };


export function TimelineView({
  state,
  forkController,
  forwardController,
  bottomInset = 0,
  onScrollBack,
  onReturnToBottom,
}: {
  state: TimelineState;
  forkController?: ForkController;
  forwardController?: ForwardController;
  /** Overlay clearance added to scroll content without shrinking its viewport. */
  bottomInset?: number;
  /** Fired once a sustained drag back through history says the reader has left
   * the end of the transcript, so the composer can get out of the way. */
  onScrollBack?(): void;
  /** Fired when the end comes back into view, however they got there. */
  onReturnToBottom?(): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scrollRun = useRef(idleTimelineScroll());
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [adrift, setAdrift] = useState(false);
  const [forkRequest, setForkRequest] = useState<{
    turnId: string;
    hasNativeCheckpoint: boolean;
  } | null>(null);
  // Selection mode (multi-select + forward/copy). `null` is mode off; the
  // state machine itself is pure and lives in `selection.ts`.
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  // The dialog builds from the selection as it was when opened. Freezing that
  // input here keeps every later render (store polls, streaming ticks) from
  // handing the dialog fresh identities that would restart the build.
  const [forwardInput, setForwardInput] = useState<{
    source: ForwardSource;
    messages: CapsuleMessage[];
    rounds: RoundSummary[];
  } | null>(null);
  const forkSession = useWorkbench((workbench) => workbench.forkSession);
  const rounds = useWorkbench((workbench) => workbench.timeline.rounds);
  const roundLayers = useWorkbench((workbench) => workbench.timeline.roundLayers);
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
  // Compactions any loaded round layer carries as marker batches render
  // inside the batch flow; the flat narrative must not hoist a second copy
  // above the trunk cards. Markers no loaded layer owns (legacy sessions,
  // imports) keep their flat rendering.
  const absorbedCompactions = new Set(
    Object.values(roundLayers).flatMap((layer) =>
      layer.trunks.flatMap((trunk) =>
        trunk.batches.filter((batch) => batch.marker).map((batch) => batch.firstItemId),
      ),
    ),
  );

  // The selectable bubbles in render order, mirroring exactly what the turns
  // below paint: narrative items, plus the round's final assistant message.
  // Selection operates on what is visible, never on collapsed-away items.
  const selectableByTurn: SelectableMessage[][] = contextualTurns.map(
    ({ turn, round, finalAssistant }) => {
      const layerReady = Boolean(round && roundLayers[round.roundId]);
      const narrative = turnNarrativeItems(
        turn,
        Boolean(round),
        layerReady,
        absorbedCompactions,
      );
      const seen = new Set<string>();
      const selectable: SelectableMessage[] = [];
      for (const item of [...narrative, ...(finalAssistant ? [finalAssistant] : [])]) {
        if (!isSelectableItem(item) || seen.has(item.id)) continue;
        seen.add(item.id);
        selectable.push(toSelectable(item));
      }
      return selectable;
    },
  );
  const selectableOrder = selectableByTurn.flat().map((message) => message.id);
  const selectableSet = new Set(selectableOrder);

  const toggleSelectable = (id: string) => {
    setSelection((current) => {
      if (!current) return current;
      const step = applySelectionClick(current, id, selectableOrder);
      setSelectionNotice(step.notice);
      return step.next;
    });
  };

  const selectedCapsuleInput = (): {
    messages: CapsuleMessage[];
    involvedRounds: typeof rounds;
  } => {
    const selectedIds = selection?.selected ?? new Set<string>();
    const { roundIdByItem, involved } = attributeRounds(state.items, rounds, selectedIds);
    const roundById = new Map(rounds.map((round) => [round.roundId, round]));
    const messages: CapsuleMessage[] = state.items
      .filter(
        (item): item is Extract<TimelineItem, { type: "userMessage" | "assistantMessage" }> =>
          selectedIds.has(item.id) && isSelectableItem(item),
      )
      .map((item) => {
        const roundId = roundIdByItem.get(item.id) ?? null;
        const owning = roundId ? roundById.get(roundId) : undefined;
        return {
          ...toSelectable(item),
          roundId,
          atMs: owning
            ? item.type === "userMessage"
              ? owning.startedAtMs
              : owning.endedAtMs || owning.startedAtMs
            : null,
        };
      });
    return { messages, involvedRounds: involved };
  };

  const forwardSource = (): ForwardSource => {
    const session = sessions.find((entry) => entry.id === activeSessionId);
    const agent = agents.find((entry) => entry.id === session?.agentId);
    const span =
      rounds.length > 0
        ? {
            start: rounds[0]!.startedAtMs,
            end: rounds[rounds.length - 1]!.endedAtMs || rounds[rounds.length - 1]!.startedAtMs,
          }
        : null;
    return {
      sessionId: activeSessionId ?? "",
      agentLabel: agent?.label ?? session?.agentId ?? null,
      sessionTitle: session?.title ?? null,
      spanMs: span,
    };
  };

  const copySelection = async () => {
    if (!selection || selection.selected.size === 0) return;
    const { messages } = selectedCapsuleInput();
    const source = forwardSource();
    const built = buildSelectionCopy(
      {
        sessionId: source.sessionId,
        agentLabel: source.agentLabel,
        spanMs: source.spanMs,
      },
      messages,
    );
    if (
      built.exceedsSoftLimit &&
      !window.confirm("复制内容超过 200k 字符，可能不适合粘贴到输入框。仍要复制吗？")
    ) {
      return;
    }
    try {
      await navigator.clipboard.writeText(built.text);
      setSelectionNotice(`已复制 ${messages.length} 条`);
    } catch {
      setSelectionNotice("复制失败：浏览器拒绝了剪贴板访问");
    }
  };

  pinnedRef.current = pinned;

  // Stick to the end when the painted tree grows or shrinks, not when the
  // underlying arrays are replaced. Token events used to call scrollIntoView
  // even when the visible process cards had not changed, which made the
  // scrollbar jump independently of the content.
  useEffect(() => {
    const root = content.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const element = scroller.current;
      if (pinnedRef.current && element) element.scrollTo?.({ top: element.scrollHeight });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (pinned && element) element.scrollTo?.({ top: element.scrollHeight });
  }, [pinned, bottomInset]);

  useEffect(() => {
    if (!selection) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || forwardOpen) return;
      event.preventDefault();
      setSelection(null);
      setSelectionNotice(null);
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [selection, forwardOpen]);

  const returnToBottom = () => {
    const element = scroller.current;
    // A run that ends in a jump home is over, and the smooth scroll it starts
    // runs the other way anyway, so nothing left in it should be believed.
    scrollRun.current = idleTimelineScroll();
    setPinned(true);
    setAdrift(false);
    onReturnToBottom?.();
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  return (
    <>
      <div
        ref={scroller}
        className="mx-auto h-full min-w-0 max-w-chat flex-1 overflow-x-hidden overflow-y-auto px-4 py-6"
        data-testid="timeline"
        style={{ paddingBottom: `calc(1.5rem + ${bottomInset}px)` }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
          const home = distance < 40;
          setPinned(home);
          setAdrift(showsReturnToBottom(distance, adrift));
          if (home && !pinned) onReturnToBottom?.();
          const run = trackTimelineScroll(
            scrollRun.current,
            element.scrollTop,
            performance.now(),
          );
          scrollRun.current = run;
          if (run.triggered) onScrollBack?.();
        }}
      >
        <div ref={content} className="space-y-4">
        {contextualTurns.map(
          ({ turn, startedRounds, round, finalAssistant, roundFinalText }, index) => {
            const hasRound = Boolean(round);
            const layerReady = Boolean(round && roundLayers[round.roundId]);
            const narrative = turnNarrativeItems(
              turn,
              hasRound,
              layerReady,
              absorbedCompactions,
            );
            // A turn still in flight is not selectable: its items are still
            // being written, and a capsule built from them would go stale
            // before it was ever reviewed.
            const liveTurn =
              index === turns.length - 1 && Boolean(state.activeTurn) && !turn.stats;
            const turnSelectable = selectableByTurn[index] ?? [];
            const renderItem = (item: TimelineItem) => {
              if (!selection || !selectableSet.has(item.id)) {
                return <Item key={item.id} item={item} />;
              }
              const checked = selection.selected.has(item.id);
              return (
                <div
                  key={item.id}
                  role="checkbox"
                  aria-checked={checked}
                  aria-disabled={liveTurn}
                  tabIndex={liveTurn ? -1 : 0}
                  className={`flex items-start gap-2 rounded-lg transition-colors ${
                    liveTurn
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer hover:bg-surface/60"
                  } ${checked ? "bg-accent/5" : ""} ${
                    selection.anchor === item.id
                      ? "ring-1 ring-accent/40 ring-dashed"
                      : ""
                  }`}
                  onClick={() => {
                    if (!liveTurn) toggleSelectable(item.id);
                  }}
                  onKeyDown={(event) => {
                    if (liveTurn) return;
                    if (event.key === " " || event.key === "Enter") {
                      event.preventDefault();
                      toggleSelectable(item.id);
                    }
                  }}
                >
                  <span
                    aria-hidden
                    className={`mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                      checked
                        ? "border-accent bg-accent text-on-accent"
                        : "border-line-strong bg-surface text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                  <div className="min-w-0 flex-1">
                    <Item item={item} />
                  </div>
                </div>
              );
            };
            return (
              <section key={turnSectionKey(turn, index)} className="space-y-4">
                {selection && turnSelectable.length > 0 ? (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={liveTurn}
                      className="text-xs text-accent underline decoration-dotted disabled:opacity-50"
                      onClick={() => {
                        const step = applySelectionAddMany(
                          selection,
                          turnSelectable.map((message) => message.id),
                        );
                        setSelection(step.next);
                        setSelectionNotice(step.notice);
                      }}
                    >
                      选择整个 Turn（{turnSelectable.length} 条）
                    </button>
                  </div>
                ) : null}
                {narrative.map((item) => renderItem(item))}
                {startedRounds.map((startedRound) => (
                  <RoundProgress
                    key={startedRound.roundId}
                    round={startedRound}
                    finalSummaryText={roundFinalText}
                  />
                ))}
                {finalAssistant ? renderItem(finalAssistant) : null}
                {turn.stats ? (
                  <TurnFooter
                    stats={turn.stats}
                    canFork={canFork}
                    onFork={() =>
                      setForkRequest({
                        turnId: turn.stats!.turnId,
                        hasNativeCheckpoint: Boolean(turn.stats!.forkCheckpoint),
                      })
                    }
                    onSelect={
                      !selection && turnSelectable.length > 0
                        ? () => {
                            const ids = turnSelectable.map((message) => message.id);
                            const step = applySelectionAddMany(emptySelection(), ids);
                            // Anchor on the bubble the footer belongs to, so the
                            // next click above or below range-selects from here.
                            setSelection({
                              ...step.next,
                              anchor: ids[ids.length - 1] ?? null,
                            });
                            setSelectionNotice(step.notice);
                          }
                        : undefined
                    }
                  />
                ) : index === turns.length - 1 && state.activeTurn ? (
                  <TurnFooter
                    liveStartedAtMs={state.activeTurnStartedAtMs ?? Date.now()}
                    liveUsage={state.usage}
                    liveTools={countTools(turn.items)}
                    liveItems={turn.items}
                    canFork={canFork}
                    onFork={() =>
                      setForkRequest({
                        turnId: state.activeTurn!,
                        hasNativeCheckpoint: false,
                      })
                    }
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
      </div>
      <div
        className="pointer-events-none absolute inset-x-0 px-4"
        style={{ bottom: `calc(0.75rem + ${bottomInset}px)` }}
      >
        <div className="mx-auto flex max-w-chat justify-end">
          <button
            type="button"
            aria-label="回到最新消息"
            onClick={returnToBottom}
            tabIndex={adrift ? 0 : -1}
            className={`flex h-10 w-10 items-center justify-center rounded-full border border-line-strong bg-surface/95 text-muted shadow-[0_4px_16px_rgb(0_0_0_/0.35)] backdrop-blur transition-opacity hover:text-fg ${
              adrift ? "pointer-events-auto opacity-100" : "opacity-0"
            }`}
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" aria-hidden>
              <path
                d="M10 4v11m0 0 4.5-4.5M10 15l-4.5-4.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {selection ? (
        <div
          className="absolute inset-x-0 px-4"
          style={{ bottom: `calc(0.75rem + ${bottomInset}px)` }}
          data-testid="selection-bar"
        >
          <div className="mx-auto max-w-chat rounded-2xl border border-line-strong bg-surface/95 px-4 py-2.5 shadow-[0_8px_30px_rgb(0_0_0_/0.35)] backdrop-blur">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-sm text-fg">
                已选 {selection.selected.size}/{MAX_FORWARD_SELECTION} 条
              </span>
              <span className="text-xs text-muted">
                约 {formatTokenEstimate(
                  estimateSelectionTokens(
                    selectableByTurn.flat().filter((message) =>
                      selection.selected.has(message.id),
                    ),
                  ),
                )}{" "}
                tokens
              </span>
              <span className="min-w-0 flex-1" />
              <button
                type="button"
                disabled={selection.selected.size === 0}
                className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
                onClick={() => void copySelection()}
              >
                复制
              </button>
              <button
                type="button"
                disabled={selection.selected.size === 0}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
                onClick={() => {
                  const input = selectedCapsuleInput();
                  setForwardInput({
                    source: forwardSource(),
                    messages: input.messages,
                    rounds: input.involvedRounds,
                  });
                  setForwardOpen(true);
                }}
              >
                转发…
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-raised hover:text-fg"
                onClick={() => {
                  setSelection(null);
                  setSelectionNotice(null);
                }}
              >
                取消
              </button>
            </div>
            {selectionNotice ? (
              <p className="mt-1 text-xs text-muted" role="status">
                {selectionNotice}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {forwardOpen && forwardInput && activeSession ? (
        <ForwardDialog
          source={forwardInput.source}
          messages={forwardInput.messages}
          rounds={forwardInput.rounds}
          controller={forwardController}
          onClose={() => {
            setForwardOpen(false);
            setForwardInput(null);
          }}
          onConfirmed={() => {
            setForwardOpen(false);
            setForwardInput(null);
            setSelection(null);
            setSelectionNotice(null);
          }}
        />
      ) : null}
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
            return forkSession(forkRequest.turnId, {
              agentId: selection.agentId,
              workspaceId: selection.workspaceId,
            });
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

/** A short trigger label for the reasons adapters report; import-time
 * markers already carry an explanatory Chinese sentence worth showing. */
function compactionTrigger(reason: string): string {
  if (reason === "auto") return "自动";
  if (reason === "manual") return "手动";
  if (/[\u4e00-\u9fff]/.test(reason)) return reason;
  return "";
}

/** A dashed rule with a label, rendered at the exact spot a compaction
 * interrupted the work — inside the batch flow when the round layer carries
 * it, or between turns for markers no round owns (e.g. session imports). */
function CompactionMarker({ reason }: { reason: string }) {
  const trigger = compactionTrigger(reason);
  return (
    <div
      className="flex items-center gap-2 py-1"
      role="separator"
      data-testid="compaction-marker"
      title={`为腾出上下文空间，Agent 已把此线之前的对话压缩为摘要继续工作；聊天记录仍完整保留，但此前给出的细节要求可能需要重申。${reason ? `（${reason}）` : ""}`}
    >
      <span className="flex-1 border-t border-dashed border-line" aria-hidden="true" />
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <span aria-hidden="true">🗜️</span>
        上下文压缩{trigger ? ` · ${trigger}` : ""}
      </span>
      <span className="flex-1 border-t border-dashed border-line" aria-hidden="true" />
    </div>
  );
}

/**
 * A forwarded capsule parked in a user message renders as a collapsed card,
 * not a text wall (proposal §3.6). The full text is one tap away.
 */
function ForwardedHistoryCard({ text, info }: { text: string; info: ForwardEnvelopeInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-[80%] rounded-xl border border-line bg-surface px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs text-muted hover:text-fg"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span aria-hidden>↪</span>
        <span className="min-w-0 flex-1 truncate">
          转发的会话历史
          {info.messageCount !== null ? ` · ${info.messageCount} 条` : ""}
          {info.sourceSessionId ? ` · 来自 ${info.sourceSessionId}` : ""}
        </span>
        <span className="shrink-0 text-faint">{open ? "收起" : "展开"}</span>
      </button>
      {open ? (
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-line bg-raised/50 p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

function Item({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "userMessage": {
      const forwarded = splitForwardEnvelope(item.text);
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
          {forwarded ? <ForwardedHistoryCard text={forwarded.capsule} info={forwarded.info} /> : null}
          {forwarded ? (
            forwarded.rest ? (
              <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-accent px-3 py-2 text-white">
                {forwarded.rest}
              </p>
            ) : null
          ) : item.text ? (
            <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-accent px-3 py-2 text-white">
              {item.text}
            </p>
          ) : null}
        </div>
      );
    }

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
      return <CompactionMarker reason={item.reason} />;

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

function turnSectionKey(turn: TurnBlock, index: number): string {
  if (turn.stats?.turnId) return turn.stats.turnId;
  const user = turn.items.find((item) => item.type === "userMessage");
  return user?.id ?? turn.items[0]?.id ?? `loose-${index}`;
}

/** How many one-line blobs the live window keeps in view. */
const LIVE_TAIL_ROWS = 5;

/**
 * Two phone lines of Chinese at text-sm, after the icon and counts take
 * their share. Longer text stays in the expanded body; hover is not a
 * reading path on a phone.
 */
const HEADER_FULLY_VISIBLE_CHARS = 32;

const HEADER_TITLE_CLASS = "min-w-0 flex-1 break-words line-clamp-2";

/** Manual toggle wins; otherwise the card follows the default for this moment. */
function useCardOpen(defaultOpen: boolean): {
  open: boolean;
  toggle(): void;
} {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? defaultOpen;
  return { open, toggle: () => setManualOpen(!open) };
}

function formatTokenEstimate(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * What a turn paints as its narrative flow. When the round layer is ready,
 * process items (reasoning/tool calls) live in the round's cards and all but
 * the final assistant message collapse into it.
 */
function turnNarrativeItems(
  turn: TurnBlock,
  hasRound: boolean,
  layerReady: boolean,
  absorbedCompactions: ReadonlySet<string> = new Set(),
): TimelineItem[] {
  if (!layerReady) return turn.items;
  return turn.items.filter(
    (item) =>
      item.type !== "reasoning" &&
      item.type !== "toolCall" &&
      (!hasRound || item.type !== "assistantMessage") &&
      (item.type !== "compaction" || !absorbedCompactions.has(item.id)),
  );
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
    const opensNewRequest = turn.items.some((item) => item.type === "userMessage");
    if (startedRounds.length > 0) {
      currentRound = startedRounds[startedRounds.length - 1];
    } else if (opensNewRequest) {
      // A new user bubble is a new request. Inheriting the previous round
      // would hide this turn's streaming reply until the next layer refresh
      // names it.
      currentRound = undefined;
    }
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
  const live = round.outcome === "running";
  const { open, toggle } = useCardOpen(active);

  useEffect(() => {
    if (open && !detail) void loadTrunk(round.roundId, summary.index);
  }, [detail, loadTrunk, open, round.roundId, summary.index]);

  const batches = detail?.batches.filter(
    (batch) => !finalSummaryText || !isFinalSummaryBatch(batch.summary, finalSummaryText),
  );
  const firstBatch = batches?.[0];
  const flattenCompleted =
    !live && batches?.length === 1 && !firstBatch?.summary.marker ? firstBatch : undefined;
  const singleBatchTitle = splitMonologue((firstBatch ?? flattenCompleted)?.monologue ?? "").first;
  const trunkTitle = singleBatchTitle || progressTitle(summary.title);
  const liveBlobs = live ? (batches?.flatMap((batch) => batch.blobs) ?? []) : [];

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg" data-testid="round-trunk">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="shrink-0" aria-hidden="true">
          🧭
        </span>
        <span className={`${HEADER_TITLE_CLASS} text-sm font-medium`} title={trunkTitle}>
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
          {flattenCompleted ? (
            <BatchContent
              batch={flattenCompleted}
              monologue={monologueAfterTitle(flattenCompleted.monologue ?? "", trunkTitle)}
            />
          ) : (
            batches?.map((batch) =>
              batch.summary.marker ? (
                <CompactionMarker
                  key={batch.summary.firstItemId}
                  reason={batch.summary.marker}
                />
              ) : (
                <BatchCard key={batch.summary.index} batch={batch} />
              ),
            )
          )}
          {live && active ? <LiveTail blobs={liveBlobs} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function BatchCard({
  batch,
}: {
  batch: RoundBatch;
}) {
  const { open, toggle } = useCardOpen(false);
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
        onClick={toggle}
      >
        <span className="shrink-0" aria-hidden="true">
          💭
        </span>
        <span
          className={`${HEADER_TITLE_CLASS} text-xs`}
          title={monologue.first || batch.summary.text}
        >
          {monologue.first || batch.summary.text}
        </span>
        <span className="shrink-0 text-xs text-muted">{batch.summary.blobCount} 项</span>
        <span className="shrink-0 text-xs text-accent" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <BatchContent
          batch={batch}
          monologue={monologueAfterTitle(
            batch.monologue ?? "",
            monologue.first || batch.summary.text,
          )}
        />
      ) : null}
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

function LiveTail({ blobs }: { blobs: BlobOverview[] }) {
  const tail = blobs.slice(-LIVE_TAIL_ROWS);
  return (
    <div className="overflow-hidden rounded-md border border-line bg-bg" data-testid="live-tail">
      {tail.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted">进行中</p>
      ) : (
        tail.map((blob) => (
          <div
            key={blob.itemId}
            className="flex items-center gap-2 px-2 py-1.5 text-xs"
            data-testid="live-blob-row"
          >
            <span className="text-muted">{blob.kind === "reasoning" ? "思考" : "工具"}</span>
            <span className="min-w-0 flex-1 truncate">{blob.overview}</span>
          </div>
        ))
      )}
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

function headerShowsFullText(text: string): boolean {
  return [...text].filter((character) => !/\s/u.test(character)).length <= HEADER_FULLY_VISIBLE_CHARS;
}

function monologueAfterTitle(monologue: string, title: string): string {
  const { first, rest } = splitMonologue(monologue);
  if (!headerShowsFullText(first) || !headerShowsFullText(title)) return monologue;
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

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  llmRounds: 0,
  toolOutputTokens: 0,
  compactionCount: 0,
  outputRateEstimated: false,
};

function uncachedTokens(usage: Usage): number {
  return usage.inputTokens >= usage.cacheReadTokens
    ? usage.inputTokens - usage.cacheReadTokens
    : usage.inputTokens;
}

/** A token count the provider actually sent, or an em-dash when it never did. */
function reportedTokens(value: number): string {
  return value > 0 ? formatTokens(value) : "—";
}

function estimateToolOutputTokens(items: TimelineItem[]): number {
  const textOf = (item: TimelineItem): string => {
    if (item.type !== "toolCall") return "";
    switch (item.detail.kind) {
      case "overview":
      case "shell":
        return item.detail.output;
      case "read":
        return item.detail.content;
      case "edit":
        return item.detail.diff;
      case "search":
        return item.detail.matches
          .map((entry) => (entry.preview ? `${entry.path}:${entry.preview}` : entry.path))
          .join("\n");
      case "fetch":
        return item.detail.summary;
      case "plan":
        return item.detail.markdown;
      case "subAgent":
        return item.detail.items.map(textOf).join("\n");
      case "unknown": {
        const raw = item.detail.raw as { output?: unknown };
        return typeof raw.output === "string" ? raw.output : "";
      }
      default:
        return "";
    }
  };
  return items.reduce((total, item) => total + Math.floor((textOf(item).length + 3) / 4), 0);
}

function TurnFooter({
  stats,
  liveUsage,
  liveStartedAtMs,
  liveTools = 0,
  liveItems,
  canFork,
  onFork,
  onSelect,
}: {
  stats?: TurnStats;
  liveUsage?: Usage | null;
  liveStartedAtMs?: number;
  liveTools?: number;
  liveItems?: TimelineItem[];
  canFork: boolean;
  onFork?: () => void;
  /** Enters selection mode with this turn checked; absent while selecting. */
  onSelect?: () => void;
}) {
  const live = !stats;
  const [now, setNow] = useState(Date.now());
  const [details, setDetails] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), live ? 1_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [live]);

  const duration = stats?.durationMs ?? Math.max(0, now - (liveStartedAtMs ?? now));
  const usage = stats?.usage ?? liveUsage ?? (live ? EMPTY_USAGE : undefined);
  const tools = stats?.toolCalls ?? liveTools;
  const toolOut =
    usage?.toolOutputTokens ||
    (liveItems ? estimateToolOutputTokens(liveItems) : 0);
  const rounds = usage?.llmRounds ?? 0;
  const forkTitle = canFork
    ? live
      ? "从当前进行中的内容重建分支"
      : "从这个 turn 创建分支并选择 Agent"
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
        {onSelect ? (
          <button
            type="button"
            className="text-accent"
            title="进入多选并选中本 Turn，继续点选上方或下方消息可连选"
            onClick={onSelect}
          >
            选择
          </button>
        ) : null}
      </div>
      {details ? (
        <div className="mt-1 flex flex-wrap justify-end gap-x-3 rounded-md bg-raised px-2 py-1">
          <span data-testid="usage-summary">
            {usage
              ? `input(cached:${reportedTokens(usage.cacheReadTokens)}, toolcall:${reportedTokens(toolOut)}, uncached:${reportedTokens(uncachedTokens(usage))}) output ${reportedTokens(usage.outputTokens)} turn ${tools}/${rounds}`
              : "—"}
          </span>
          {usage && usage.compactionCount > 0 ? (
            <span data-testid="usage-compactions">压缩 {usage.compactionCount}</span>
          ) : null}
          {usage?.avgTtftMs != null ? (
            <span data-testid="usage-ttft">TTFT {formatDuration(usage.avgTtftMs)}</span>
          ) : null}
          {usage?.avgOutputRateTps != null ? (
            <span
              data-testid="usage-rate"
              title={
                usage.outputRateEstimated
                  ? "可见输出文本(chars/4) ÷ 各轮生成时间之和（不含 TTFT 与工具执行）；该 Agent 未上报 output token，为估算值"
                  : "Provider 上报 output tokens ÷ 各轮生成时间之和（不含 TTFT 与工具执行）"
              }
            >
              {usage.outputRateEstimated ? "~" : ""}
              {usage.avgOutputRateTps.toFixed(1)} tok/s
            </span>
          ) : null}
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
