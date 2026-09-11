import type { RoundSummary, RoundTrunkSummary, SessionSummary } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { canStartAgent } from "../presentation/catalog/resolve";
import {
  AgentGrid,
  CURRENT_MACHINE,
  MachineGrid,
  useMachineCatalog,
  WorkspaceList,
} from "./MachineCatalogPicker";
import { SessionPicker } from "./SessionPicker";
import {
  buildForwardCapsule,
  DEFAULT_FORWARD_BUDGET,
  FORWARD_BUDGET_TIERS,
  type BuiltCapsule,
  type CapsuleData,
  type CapsuleMessage,
  type ForwardSource,
} from "./forwardCapsule";
import { useWorkbench } from "./store";
import type { ForwardController } from "./TimelineView";

const BUDGET_LABELS: Record<number, string> = {
  8_000: "精要 8k",
  16_000: "标准 16k",
  32_000: "细节 32k",
  64_000: "完整 64k",
};

/** Fill iterations are bounded; each fetches up to FILL_BATCH_SIZE refs. */
const MAX_FILL_ITERATIONS = 10;

/**
 * Keep the first value whose content key is still current. Parents re-render
 * with fresh identities holding the same selection (store polls, streaming
 * ticks); only a real content change may restart the capsule build below.
 */
function useContentStable<T>(value: T, key: string): T {
  const held = useRef<{ key: string; value: T } | null>(null);
  if (held.current === null || held.current.key !== key) {
    held.current = { key, value };
  }
  return held.current.value;
}

export function ForwardDialog({
  source,
  messages,
  rounds,
  controller,
  onClose,
  onConfirmed,
}: {
  source: ForwardSource;
  /** Selected messages in timeline order, already round-attributed. */
  messages: CapsuleMessage[];
  /** Rounds the selection touches, in timeline order. */
  rounds: RoundSummary[];
  /** Machine reach. Absent on hosts that cannot dial others: current only. */
  controller?: ForwardController;
  onClose(): void;
  /** After the capsule is parked or delivered; defaults to `onClose`. */
  onConfirmed?(): void;
}) {
  const client = useWorkbench((state) => state.client);
  const agents = useWorkbench((state) => state.agents);
  const workspaces = useWorkbench((state) => state.workspaces);
  const sessions = useWorkbench((state) => state.sessions);
  const activeWorkspaceId = useWorkbench((state) => state.activeWorkspaceId);
  const fetchTrunkDetails = useWorkbench((state) => state.fetchTrunkDetails);
  const fetchBlobPayloads = useWorkbench((state) => state.fetchBlobPayloads);
  const newSession = useWorkbench((state) => state.newSession);
  const selectSession = useWorkbench((state) => state.selectSession);
  const setForwardDraft = useWorkbench((state) => state.setForwardDraft);
  const setCompletionNotice = useWorkbench((state) => state.setCompletionNotice);

  const sourceMachine = controller?.sourceMachine ?? CURRENT_MACHINE;
  const {
    machines,
    selectedMachine,
    catalog,
    workspaceId,
    setWorkspaceId,
    agentId,
    setAgentId,
    loadingMachines,
    loadingCatalog,
    problem: machineProblem,
    setProblem: setMachineProblem,
    pickMachine,
  } = useMachineCatalog({
    sourceMachine,
    sourceCatalog: { agents, workspaces },
    sourceWorkspaceId: activeWorkspaceId ?? workspaces[0]?.id ?? "",
    sourceAgentId: agents.find(canStartAgent)?.id,
    listMachines: controller?.listMachines,
    loadCatalog: controller?.loadCatalog,
  });

  // The capsule input is a snapshot of the selection at open time; identity
  // noise from the parent must not restart the build, only content may.
  const stableSource = useContentStable(
    source,
    `${source.sessionId} ${source.sessionTitle} ${source.agentLabel}`,
  );
  const stableMessages = useContentStable(
    messages,
    messages.map((message) => message.id).join(" "),
  );
  const stableRounds = useContentStable(
    rounds,
    rounds.map((round) => round.roundId).join(" "),
  );

  const [destination, setDestination] = useState<"new" | "existing">("new");
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null);
  const [remoteSessions, setRemoteSessions] = useState<SessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [budget, setBudget] = useState<number>(DEFAULT_FORWARD_BUDGET);
  const [fillDetail, setFillDetail] = useState(true);
  const [includeBlobBodies, setIncludeBlobBodies] = useState(false);
  const [built, setBuilt] = useState<BuiltCapsule | null>(null);
  const [building, setBuilding] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);

  const onSourceMachine = selectedMachine.id === sourceMachine.id;

  // The existing-session list belongs to the machine under the radio: the
  // store's list for the one on screen, a fetch for any other.
  useEffect(() => {
    setTargetSessionId(null);
    if (onSourceMachine || !controller) {
      setRemoteSessions([]);
      setLoadingSessions(false);
      return;
    }
    let cancelled = false;
    setLoadingSessions(true);
    void controller
      .loadSessions(selectedMachine)
      .then((loaded) => {
        if (!cancelled) setRemoteSessions(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRemoteSessions([]);
          setMachineProblem(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSessions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [controller, onSourceMachine, selectedMachine, setMachineProblem]);

  // Assemble the capsule, fetching detail layers in batches while the budget
  // says more would fit. Re-runs from scratch on any option change: the build
  // is pure, so a change is a fresh assembly, not a patch of the last one.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setBuilding(true);
    setProblem(null);
    void (async () => {
      try {
        const layers: CapsuleData["layers"] = {};
        for (const round of stableRounds) {
          const trunks: RoundTrunkSummary[] = [];
          let cursor: string | null = null;
          do {
            const reply = await client.call({
              type: "round.trunk.list",
              payload: { sessionId: stableSource.sessionId, roundId: round.roundId, cursor, limit: 100 },
            });
            if (reply?.type !== "roundLayer") break;
            trunks.push(...reply.data.trunks);
            cursor = reply.data.nextCursor ?? null;
          } while (cursor);
          layers[round.roundId] = trunks;
        }
        const data: CapsuleData = { layers, trunks: {}, blobs: {} };
        const options = {
          budgetTokens: budget,
          fillDetail,
          includeBlobBodies,
          sourceAccessible: true,
        };
        for (let iteration = 0; iteration < MAX_FILL_ITERATIONS; iteration += 1) {
          const current = buildForwardCapsule(stableSource, stableMessages, stableRounds, data, options);
          if (cancelled) return;
          setBuilt(current);
          const { trunks: wantedTrunks, blobs: wantedBlobs } = current.wanted;
          if (wantedTrunks.length === 0 && wantedBlobs.length === 0) break;
          if (wantedTrunks.length > 0) {
            const fetched = await fetchTrunkDetails(stableSource.sessionId, wantedTrunks);
            if (!fetched) break;
            for (const [index, trunk] of fetched.entries()) {
              const ref = wantedTrunks[index];
              if (ref) data.trunks[`${ref.roundId}:${trunk.summary.index}`] = trunk;
            }
          }
          if (wantedBlobs.length > 0) {
            const fetched = await fetchBlobPayloads(stableSource.sessionId, wantedBlobs);
            if (!fetched) break;
            for (const payload of fetched) data.blobs[payload.id] = payload;
          }
        }
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setBuilding(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, stableSource, stableMessages, stableRounds, budget, fillDetail, includeBlobBodies, fetchTrunkDetails, fetchBlobPayloads]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [busy, onClose]);

  const selectedAgent = catalog.agents.find((agent) => agent.id === agentId);
  const valid =
    built !== null &&
    !built.overBudget &&
    (destination === "new"
      ? Boolean(
          catalog.workspaces.some((workspace) => workspace.id === workspaceId) &&
            selectedAgent &&
            canStartAgent(selectedAgent),
        )
      : targetSessionId !== null);

  const confirm = () => {
    if (!built || !valid) return;
    if (onSourceMachine) {
      // Same machine: park the capsule on a composer, reviewed before sending.
      if (destination === "new") {
        newSession(workspaceId, agentId);
        setForwardDraft({
          sessionId: null,
          capsule: built.text,
          itemCount: built.stats.selectedCount,
          estimatedTokens: built.estimatedTokens,
          sourceSessionId: stableSource.sessionId,
          sourceTitle: stableSource.sessionTitle,
          ...(built.imageAttachments.length > 0
            ? { attachments: built.imageAttachments }
            : {}),
        });
      } else if (targetSessionId) {
        setForwardDraft({
          sessionId: targetSessionId,
          capsule: built.text,
          itemCount: built.stats.selectedCount,
          estimatedTokens: built.estimatedTokens,
          sourceSessionId: stableSource.sessionId,
          sourceTitle: stableSource.sessionTitle,
          ...(built.imageAttachments.length > 0
            ? { attachments: built.imageAttachments }
            : {}),
        });
        void selectSession(targetSessionId);
      }
      (onConfirmed ?? onClose)();
      return;
    }
    if (!controller) return;
    const machine = selectedMachine;
    const target =
      destination === "new"
        ? ({ kind: "new", workspaceId, agentId } as const)
        : targetSessionId
          ? ({ kind: "session", sessionId: targetSessionId } as const)
          : null;
    if (!target) return;
    setBusy(true);
    setProblem(null);
    void controller
      .deliver(machine, target, built.text)
      .then(({ sessionId }) => {
        setCompletionNotice({
          text:
            destination === "new"
              ? `已在「${machine.label}」创建会话并送入转发内容`
              : `已转发到「${machine.label}」的会话`,
          actionLabel: "前往查看",
          onAction: () => controller.jumpTo(machine, sessionId),
        });
        (onConfirmed ?? onClose)();
      })
      .catch((error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
        setBusy(false);
      });
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forward-title"
        className="flex max-h-[min(88dvh,52rem)] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="forward-title" className="font-medium text-fg">
              转发 {stableMessages.length} 条消息
            </h2>
            <p className="text-xs text-faint">
              组装成一段受预算约束的上下文。本机目标放入输入框由你审阅后发出；其他机器会直接送达。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭转发"
            disabled={busy}
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <fieldset disabled={busy}>
            <legend className="text-xs font-medium uppercase tracking-wide text-faint">去向</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  ["new", "新会话"],
                  ["existing", "既有会话"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-center justify-center rounded-xl border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10"
                >
                  <input
                    type="radio"
                    name="forward-destination"
                    value={value}
                    checked={destination === value}
                    onChange={() => setDestination(value)}
                    className="sr-only"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <MachineGrid
            machines={machines}
            selectedMachineId={selectedMachine.id}
            sourceMachineId={sourceMachine.id}
            disabled={busy || loadingMachines}
            loading={loadingMachines}
            onPick={pickMachine}
          />

          {destination === "new" ? (
            <>
              <WorkspaceList
                workspaces={catalog.workspaces}
                selectedWorkspaceId={workspaceId}
                disabled={busy || loadingCatalog}
                loading={loadingCatalog}
                onSelect={setWorkspaceId}
              />

              <AgentGrid
                agents={catalog.agents}
                selectedAgentId={agentId}
                disabled={busy || loadingCatalog}
                onSelect={setAgentId}
              />
            </>
          ) : (
            <fieldset disabled={busy || loadingSessions}>
              <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标会话</legend>
              <div className="mt-2">
                <SessionPicker
                  sessions={onSourceMachine ? sessions : remoteSessions}
                  agents={onSourceMachine ? agents : catalog.agents}
                  workspaces={onSourceMachine ? workspaces : catalog.workspaces}
                  selectedId={targetSessionId}
                  onSelect={setTargetSessionId}
                  loading={loadingSessions}
                  emptyHint={
                    onSourceMachine
                      ? "本机没有其他可接收的会话。"
                      : "目标机器没有可接收的会话。"
                  }
                  excludeId={onSourceMachine ? stableSource.sessionId : undefined}
                />
              </div>
            </fieldset>
          )}

          <fieldset disabled={busy}>
            <legend className="text-xs font-medium uppercase tracking-wide text-faint">预算</legend>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {FORWARD_BUDGET_TIERS.map((tier) => (
                <label
                  key={tier}
                  className="flex cursor-pointer items-center justify-center rounded-xl border border-line px-2 py-2 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent/10"
                >
                  <input
                    type="radio"
                    name="forward-budget"
                    value={tier}
                    checked={budget === tier}
                    onChange={() => setBudget(tier)}
                    className="sr-only"
                  />
                  {BUDGET_LABELS[tier]}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset disabled={busy}>
            <legend className="text-xs font-medium uppercase tracking-wide text-faint">细节</legend>
            <div className="mt-2 space-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={fillDetail}
                  onChange={(event) => setFillDetail(event.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
                填充工作明细（trunk 独白与工具概览，预算内自动填充）
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={includeBlobBodies}
                  onChange={(event) => setIncludeBlobBodies(event.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
                附带工具调用全文（可能包含敏感输出）
              </label>
              {includeBlobBodies ? (
                <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                  工具输出可能含有密钥、令牌或内部路径。请确认接收方有权查看。
                </p>
              ) : null}
            </div>
          </fieldset>

          <div className="rounded-xl border border-line bg-raised/50 px-3 py-3 text-sm">
            {built ? (
              <>
                <p className={built.overBudget ? "text-danger" : "text-fg"}>
                  {built.overBudget
                    ? `选中消息本身约 ${formatTokens(built.estimatedTokens)}，超出预算——请减少选择或提高预算`
                    : `组装后约 ${formatTokens(built.estimatedTokens)} / ${formatTokens(budget)} tokens${building ? "，正在填充细节…" : ""}`}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {[
                    `选中 ${built.stats.selectedCount} 条`,
                    built.stats.roundCount > 0 ? `${built.stats.roundCount} 个 round` : null,
                    built.stats.trunkTitlesTotal > 0
                      ? `trunk 标题 ${built.stats.trunkTitlesKept}/${built.stats.trunkTitlesTotal}`
                      : null,
                    fillDetail && built.stats.trunkTitlesTotal > 0
                      ? `明细填充 ${built.stats.detailFilledTrunks} 段${
                          built.stats.detailOmittedTrunks > 0
                            ? `、省略 ${built.stats.detailOmittedTrunks} 段`
                            : ""
                        }`
                      : null,
                    includeBlobBodies
                      ? `工具全文 ${built.stats.blobsFilled} 段${
                          built.stats.blobsOmitted > 0 ? `、省略 ${built.stats.blobsOmitted} 段` : ""
                        }`
                      : null,
                    built.stats.clippedMessages > 0 ? `截断 ${built.stats.clippedMessages} 条长消息` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <button
                  type="button"
                  className="mt-2 text-xs text-accent underline decoration-dotted"
                  onClick={() => setPreviewOpen((open) => !open)}
                >
                  {previewOpen ? "收起预览" : "预览组装文本"}
                </button>
                {previewOpen ? (
                  <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-line bg-surface p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">
                    {built.text}
                  </pre>
                ) : null}
              </>
            ) : (
              <p className="text-muted">正在组装…</p>
            )}
          </div>

          {problem || machineProblem ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {problem ?? machineProblem}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={!valid || building || busy || loadingCatalog}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={confirm}
          >
            {busy
              ? "正在送达…"
              : onSourceMachine
                ? "放入输入框"
                : destination === "new"
                  ? "创建并发送"
                  : "直接发送"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
