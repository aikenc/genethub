import type { RoundSummary, RoundTrunkSummary } from "@genehub/proto";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentMark } from "../presentation/AgentMark";
import { canStartAgent, resolveAgentPresentation } from "../presentation/catalog/resolve";
import { WorkspaceIcon } from "../workspace/WorkspaceIcon";
import {
  buildForwardCapsule,
  DEFAULT_FORWARD_BUDGET,
  FORWARD_BUDGET_TIERS,
  type BuiltCapsule,
  type CapsuleData,
  type CapsuleMessage,
  type ForwardSource,
} from "./forwardCapsule";
import { formatClock } from "./selectionCopy";
import { useWorkbench } from "./store";

const BUDGET_LABELS: Record<number, string> = {
  8_000: "精要 8k",
  16_000: "标准 16k",
  32_000: "细节 32k",
  64_000: "完整 64k",
};

/** Fill iterations are bounded; each fetches up to FILL_BATCH_SIZE refs. */
const MAX_FILL_ITERATIONS = 10;

export function ForwardDialog({
  source,
  messages,
  rounds,
  onClose,
  onConfirmed,
}: {
  source: ForwardSource;
  /** Selected messages in timeline order, already round-attributed. */
  messages: CapsuleMessage[];
  /** Rounds the selection touches, in timeline order. */
  rounds: RoundSummary[];
  onClose(): void;
  /** After the capsule is parked on a composer; defaults to `onClose`. */
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

  const [destination, setDestination] = useState<"new" | "existing">("new");
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId ?? workspaces[0]?.id ?? "");
  const [agentId, setAgentId] = useState(
    () => agents.find(canStartAgent)?.id ?? "",
  );
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null);
  const [budget, setBudget] = useState<number>(DEFAULT_FORWARD_BUDGET);
  const [fillDetail, setFillDetail] = useState(true);
  const [includeBlobBodies, setIncludeBlobBodies] = useState(false);
  const [built, setBuilt] = useState<BuiltCapsule | null>(null);
  const [building, setBuilding] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const dialog = useRef<HTMLElement>(null);

  const targets = useMemo(
    () =>
      sessions
        .filter((session) => session.id !== source.sessionId && !session.archived)
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
        .slice(0, 50),
    [sessions, source.sessionId],
  );

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
        for (const round of rounds) {
          const trunks: RoundTrunkSummary[] = [];
          let cursor: string | null = null;
          do {
            const reply = await client.call({
              type: "round.trunk.list",
              payload: { sessionId: source.sessionId, roundId: round.roundId, cursor, limit: 100 },
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
          const current = buildForwardCapsule(source, messages, rounds, data, options);
          if (cancelled) return;
          setBuilt(current);
          const { trunks: wantedTrunks, blobs: wantedBlobs } = current.wanted;
          if (wantedTrunks.length === 0 && wantedBlobs.length === 0) break;
          if (wantedTrunks.length > 0) {
            const fetched = await fetchTrunkDetails(source.sessionId, wantedTrunks);
            if (!fetched) break;
            for (const [index, trunk] of fetched.entries()) {
              const ref = wantedTrunks[index];
              if (ref) data.trunks[`${ref.roundId}:${trunk.summary.index}`] = trunk;
            }
          }
          if (wantedBlobs.length > 0) {
            const fetched = await fetchBlobPayloads(source.sessionId, wantedBlobs);
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
  }, [client, source, messages, rounds, budget, fillDetail, includeBlobBodies, fetchTrunkDetails, fetchBlobPayloads]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [onClose]);

  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const valid =
    built !== null &&
    !built.overBudget &&
    (destination === "new"
      ? Boolean(
          workspaces.some((workspace) => workspace.id === workspaceId) &&
            selectedAgent &&
            canStartAgent(selectedAgent),
        )
      : targetSessionId !== null);

  const confirm = () => {
    if (!built || !valid) return;
    if (destination === "new") {
      newSession(workspaceId, agentId);
      setForwardDraft({
        sessionId: null,
        capsule: built.text,
        itemCount: built.stats.selectedCount,
        estimatedTokens: built.estimatedTokens,
        sourceSessionId: source.sessionId,
        sourceTitle: source.sessionTitle,
      });
    } else if (targetSessionId) {
      setForwardDraft({
        sessionId: targetSessionId,
        capsule: built.text,
        itemCount: built.stats.selectedCount,
        estimatedTokens: built.estimatedTokens,
        sourceSessionId: source.sessionId,
        sourceTitle: source.sessionTitle,
      });
      void selectSession(targetSessionId);
    }
    (onConfirmed ?? onClose)();
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
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
              转发 {messages.length} 条消息
            </h2>
            <p className="text-xs text-faint">
              组装成一段受预算约束的上下文，放入目标会话的输入框，由你审阅后发出。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭转发"
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-muted hover:bg-raised hover:text-fg"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <fieldset>
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

          {destination === "new" ? (
            <>
              <fieldset>
                <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标工作区</legend>
                <div
                  role="listbox"
                  aria-label="目标工作区"
                  className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded-xl border border-line p-1"
                >
                  {workspaces.map((workspace) => {
                    const selected = workspace.id === workspaceId;
                    return (
                      <button
                        key={workspace.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        title={workspace.root}
                        onClick={() => setWorkspaceId(workspace.id)}
                        className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
                          selected ? "bg-accent/10 text-fg" : "text-muted hover:bg-raised hover:text-fg"
                        }`}
                      >
                        <WorkspaceIcon workspace={workspace} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-fg">{workspace.name}</span>
                          <span className="block truncate text-[10px] text-faint">{workspace.root}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标 Agent</legend>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {agents.map((agent) => {
                    const presentation = resolveAgentPresentation(agent);
                    return (
                      <label
                        key={agent.id}
                        className="flex min-h-14 cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                      >
                        <input
                          type="radio"
                          name="forward-agent"
                          value={agent.id}
                          aria-label={presentation.label}
                          checked={agent.id === agentId}
                          disabled={!canStartAgent(agent)}
                          onChange={() => setAgentId(agent.id)}
                          className="sr-only"
                        />
                        {presentation.kind === "text" ? null : (
                          <AgentMark agent={agent} className="h-6 w-6" fallbackToText={false} />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-fg">{presentation.label}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            </>
          ) : (
            <fieldset>
              <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标会话</legend>
              {targets.length > 0 ? (
                <div
                  role="listbox"
                  aria-label="目标会话"
                  className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-line p-1"
                >
                  {targets.map((session) => {
                    const selected = session.id === targetSessionId;
                    const agent = agents.find((entry) => entry.id === session.agentId);
                    return (
                      <button
                        key={session.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => setTargetSessionId(session.id)}
                        className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
                          selected ? "bg-accent/10 text-fg" : "text-muted hover:bg-raised hover:text-fg"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-fg">{session.title ?? "未命名会话"}</span>
                          <span className="block truncate text-[10px] text-faint">
                            {agent ? resolveAgentPresentation(agent).label : session.agentId} ·{" "}
                            {formatClock(session.updatedAtMs)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 rounded-xl border border-line bg-raised/50 px-3 py-2 text-xs text-muted">
                  本机没有其他可接收的会话。
                </p>
              )}
            </fieldset>
          )}

          <fieldset>
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

          <fieldset>
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

          {problem ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {problem}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-raised hover:text-fg"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={!valid || building}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={confirm}
          >
            放入输入框
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
