import type {
  AgentRequestDisplay,
  AgentRequestOutcome,
  AgentRequestQuestion,
  AgentUserRequest,
  InteractionAnswer,
} from "@genehub/proto";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { QrCode } from "../devices/QrCode";
import { agentRequestKey, useWorkbench } from "../session/store";

/**
 * The one place an Agent-level user request reaches a person (proposal §7):
 * a login link, an install confirmation, an API key. Mounted once at the app
 * shell; shows the oldest pending request this window has not set aside.
 * Typed values live only in this component until they leave in the answer —
 * never in the store or a log.
 */
export function AgentRequestDialog() {
  const request = useWorkbench(
    (state) =>
      state.agentRequests.find(
        (entry) => !state.hiddenAgentRequests.includes(agentRequestKey(entry.agentId, entry.id)),
      ) ?? null,
  );
  const agentLabel = useWorkbench((state) =>
    request ? state.agents.find((agent) => agent.id === request.agentId)?.label : undefined,
  );
  const answerAgentRequest = useWorkbench((state) => state.answerAgentRequest);
  const hideAgentRequest = useWorkbench((state) => state.hideAgentRequest);
  if (!request || typeof document === "undefined") return null;
  return createPortal(
    <AgentRequestCard
      // A different request starts from blank inputs, never another one's secret.
      key={agentRequestKey(request.agentId, request.id)}
      request={request}
      agentLabel={agentLabel ?? request.agentId}
      onAnswer={(outcome) => answerAgentRequest(request.agentId, request.id, outcome)}
      onDismiss={() => hideAgentRequest(request.agentId, request.id)}
    />,
    document.body,
  );
}

type Selections = Record<string, string[]>;
type Texts = Record<string, string>;

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function AgentRequestCard({
  request,
  agentLabel,
  onAnswer,
  onDismiss,
}: {
  request: AgentUserRequest;
  agentLabel: string;
  onAnswer(outcome: AgentRequestOutcome): Promise<unknown>;
  /** Sets the request aside on this window only; another device may be answering it. */
  onDismiss(): void;
}) {
  const [selections, setSelections] = useState<Selections>({});
  const [texts, setTexts] = useState<Texts>({});
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const titleId = `agent-request-${request.id}`;

  const send = (outcome: AgentRequestOutcome) => {
    if (busy) return;
    setBusy(true);
    void onAnswer(outcome).finally(() => setBusy(false));
  };

  // Escape sets the request aside. Captured on window so a dialog underneath,
  // listening on document, does not close too.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Focus moves in once, to the first thing to type into or else the first
  // choice, and goes back to wherever it was when the request leaves.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const root = panel.current;
      if (!root || root.contains(document.activeElement)) return;
      const target =
        root.querySelector<HTMLElement>('input:not([type="radio"]):not([type="checkbox"])') ??
        root.querySelector<HTMLElement>("footer button") ??
        root.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const answers = (): InteractionAnswer[] =>
    request.questions.map((question) => {
      const text = question.input ? (texts[question.id] ?? "") : "";
      return {
        questionId: question.id,
        selectedOptionIds: selections[question.id] ?? [],
        ...(question.input ? { freeformText: text } : {}),
      };
    });
  const choose = (optionId: string) => send({ type: "answered", optionId, answers: answers() });

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 md:items-center md:p-4">
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        className="flex max-h-[min(88dvh,40rem)] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="font-medium text-fg">{request.title}</h2>
            <p className="truncate text-xs text-faint">{agentLabel} 的请求 · 只有你能回答</p>
          </div>
          <button
            type="button"
            aria-label="稍后处理"
            title="稍后处理（可在设置的 Agent 列表里再打开）"
            className="flex h-11 w-11 items-center justify-center rounded-full text-xl text-muted hover:bg-raised hover:text-fg"
            onClick={onDismiss}
          >
            ×
          </button>
        </header>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            // Enter in a field means the first, offered choice.
            const first = request.options[0];
            if (first) choose(first.id);
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-sm">
            {request.detail ? (
              <p className="whitespace-pre-wrap text-muted">{request.detail}</p>
            ) : null}
            {request.display.map((item, index) => (
              <DisplayItem key={index} item={item} />
            ))}
            {request.questions.map((question) => (
              <Question
                key={question.id}
                question={question}
                selected={selections[question.id] ?? []}
                text={texts[question.id] ?? ""}
                onSelect={(ids) => setSelections((current) => ({ ...current, [question.id]: ids }))}
                onText={(value) => setTexts((current) => ({ ...current, [question.id]: value }))}
              />
            ))}
          </div>
          <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
            <button
              type="button"
              disabled={busy}
              className="mr-auto min-h-11 rounded px-3 text-sm text-muted hover:text-fg disabled:opacity-40"
              onClick={() => send({ type: "canceled" })}
            >
              取消请求
            </button>
            {request.options.map((option, index) => (
              <button
                key={option.id}
                type={index === 0 ? "submit" : "button"}
                disabled={busy}
                className={
                  index === 0
                    ? "min-h-11 rounded bg-accent px-4 text-sm text-white disabled:opacity-40"
                    : "min-h-11 rounded border border-line px-4 text-sm text-fg hover:border-accent disabled:opacity-40"
                }
                onClick={index === 0 ? undefined : () => choose(option.id)}
              >
                {option.label}
              </button>
            ))}
          </footer>
        </form>
      </section>
    </div>
  );
}

function DisplayItem({ item }: { item: AgentRequestDisplay }) {
  if (item.kind === "code") {
    return (
      <div className="flex flex-col gap-1">
        {item.label ? <span className="text-xs text-faint">{item.label}</span> : null}
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded bg-raised px-3 py-2 font-mono text-2xl tracking-widest text-fg">
            {item.value}
          </code>
          <CopyButton value={item.value} label="复制代码" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {item.label ? <span className="text-xs text-faint">{item.label}</span> : null}
      {item.render === "qr" ? <QrCode value={item.value} label="登录二维码" /> : null}
      <div className="flex items-center gap-2">
        {/^https?:\/\//i.test(item.value) ? (
          <a
            href={item.value}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 break-all text-accent underline decoration-dotted"
          >
            {item.value}
          </a>
        ) : (
          // Only web links are clickable; a script cannot hand us `javascript:`.
          <span className="min-w-0 flex-1 select-all break-all text-fg">{item.value}</span>
        )}
        <CopyButton value={item.value} label="复制链接" />
      </div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      className="min-h-11 shrink-0 rounded border border-line px-3 text-xs text-fg hover:border-accent"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function Question({
  question,
  selected,
  text,
  onSelect,
  onText,
}: {
  question: AgentRequestQuestion;
  selected: string[];
  text: string;
  onSelect(ids: string[]): void;
  onText(value: string): void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-fg">{question.prompt}</legend>
      {question.options.map((option) => {
        const checked = selected.includes(option.id);
        return (
          <label key={option.id} className="flex min-h-11 items-center gap-2 text-sm text-fg">
            <input
              type={question.allowMultiple ? "checkbox" : "radio"}
              name={`agent-request-${question.id}`}
              value={option.id}
              checked={checked}
              onChange={() =>
                onSelect(
                  question.allowMultiple
                    ? checked
                      ? selected.filter((id) => id !== option.id)
                      : [...selected, option.id]
                    : [option.id],
                )
              }
            />
            {option.label}
          </label>
        );
      })}
      {question.input ? (
        <input
          aria-label={question.prompt}
          type={question.input === "secret" ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          value={text}
          className="h-11 rounded border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
          onChange={(event) => onText(event.currentTarget.value)}
        />
      ) : null}
    </fieldset>
  );
}
