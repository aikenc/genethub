import type { InteractionAnswer, PermissionOutcome, PermissionRequest } from "@genehub/proto";
import { useEffect, useMemo, useState } from "react";

/** A durable Human interaction sits beside the composer rather than in a modal. */
export function PermissionCard({
  request,
  onAnswer,
  submitting = false,
}: {
  request: PermissionRequest;
  onAnswer(outcome: PermissionOutcome): void;
  submitting?: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});
  // "I will type it myself": no option is picked, the text is the whole answer.
  // It excludes the offered choices, so a submitted answer is never a guess
  // about which parts were chosen and which parts were typed.
  const [manual, setManual] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setSelected({});
    setFreeform({});
    setManual({});
  }, [request.id]);
  const answers = useMemo<InteractionAnswer[]>(
    () =>
      (request.questions ?? []).map((question) => ({
        questionId: question.id,
        selectedOptionIds: manual[question.id] ? [] : selected[question.id] ?? [],
        freeformText: freeform[question.id]?.trim() || undefined,
      })),
    [freeform, manual, request.questions, selected],
  );
  const complete = answers.every(
    (answer) =>
      (manual[answer.questionId] ? false : answer.selectedOptionIds.length > 0)
      || Boolean(answer.freeformText),
  );
  const manualOnly =
    (request.questions?.length ?? 0) > 0
    && (request.questions ?? []).every((question) => manual[question.id]);
  const heading =
    request.kind === "question"
      ? "需要你的回答"
      : request.kind === "planApproval"
        ? "需要你的确认"
        : "需要你的授权";
  const paused =
    request.kind === "question"
      ? "等待你的回答；提交后会继续处理原问题。"
      : request.kind === "planApproval"
        ? "等待你确认计划；确认后会从原会话继续。"
        : "等待你的授权；授权后会以最高权限从原会话继续。";

  return (
    <div
      className="rounded-xl border border-accent/60 bg-raised px-4 py-4 shadow-[0_12px_32px_rgb(0_0_0_/0.22)]"
      role="group"
      aria-label={
        request.kind === "question"
          ? "Agent 提问"
          : request.kind === "planApproval"
            ? "Agent 计划确认"
            : "权限请求"
      }
    >
      <h2 className="text-base font-semibold text-fg">{heading}</h2>
      <p className="mt-1 text-sm leading-5 text-muted">{paused}</p>
      <p className="mt-3 text-sm font-medium text-fg">{request.title}</p>
      {(request.questions?.length ?? 0) > 0 ? (
        <p className="mt-1 text-xs leading-5 text-muted">
          可以选一项，也可以选「其他：我自己输入」只提交你写的内容。
        </p>
      ) : null}
      {request.detail ? (
        <div
          className={`mt-2 max-h-56 max-w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg ${
            request.kind === "permission" ? "font-mono leading-5" : "leading-6"
          }`}
        >
          {request.detail}
        </div>
      ) : null}
      {(request.questions?.length ?? 0) > 0 ? (
        <form
          className="mt-3 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (complete && !submitting) onAnswer({ outcome: "answered", answers });
          }}
        >
          {request.questions?.map((question) => {
            const own = manual[question.id] === true;
            const fieldId = `interaction-${request.id}-${question.id}-text`;
            return (
              <fieldset key={question.id} className="space-y-2">
                <legend className="text-sm font-medium">{question.prompt}</legend>
                {question.options.map((option) => {
                  const checked = !own && (selected[question.id] ?? []).includes(option.id);
                  return (
                    <label
                      key={option.id}
                      className={`flex items-center gap-2 text-sm ${own ? "opacity-50" : ""}`}
                    >
                      <input
                        type={question.allowMultiple ? "checkbox" : "radio"}
                        name={`interaction-${request.id}-${question.id}`}
                        checked={checked}
                        onChange={() => {
                          setManual((current) => ({ ...current, [question.id]: false }));
                          setSelected((current) => ({
                            ...current,
                            [question.id]: question.allowMultiple
                              ? checked
                                ? (current[question.id] ?? []).filter((id) => id !== option.id)
                                : [...(current[question.id] ?? []), option.id]
                              : [option.id],
                          }));
                        }}
                      />
                      {option.label}
                    </label>
                  );
                })}
                {question.allowFreeform && question.options.length > 0 ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type={question.allowMultiple ? "checkbox" : "radio"}
                      name={`interaction-${request.id}-${question.id}`}
                      checked={own}
                      onChange={() => {
                        setManual((current) => ({
                          ...current,
                          [question.id]: !own,
                        }));
                        setSelected((current) => ({ ...current, [question.id]: [] }));
                      }}
                    />
                    其他：我自己输入
                  </label>
                ) : null}
                {question.allowFreeform ? (
                  <div className="space-y-1">
                    <label className="block text-xs text-muted" htmlFor={fieldId}>
                      {own || question.options.length === 0
                        ? "你的回答（必填）"
                        : "补充说明（可不填）"}
                    </label>
                    <textarea
                      id={fieldId}
                      value={freeform[question.id] ?? ""}
                      onChange={(event) =>
                        setFreeform((current) => ({
                          ...current,
                          [question.id]: event.target.value,
                        }))
                      }
                      placeholder={own ? "写下你自己的回答" : "其他答案或补充说明"}
                      rows={2}
                      className="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm"
                    />
                  </div>
                ) : null}
              </fieldset>
            );
          })}
          {manualOnly ? (
            <p className="text-xs text-muted" role="status">
              未选择任何选项，只提交你写的内容。
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={!complete || submitting}
              className="min-h-11 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {manualOnly ? "提交我输入的内容" : "提交答案"}
            </button>
            <button
              type="button"
              disabled={submitting}
              className="min-h-11 rounded-lg border border-line-strong px-4 py-2.5 text-sm font-medium text-muted hover:text-fg"
              onClick={() => onAnswer({ outcome: "canceled" })}
            >
              取消本次提问
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap gap-3">
          {request.options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={submitting}
              className={
                option.kind === "reject"
                  ? "min-h-11 rounded-lg border border-line-strong px-4 py-2.5 text-sm font-medium hover:border-danger hover:text-danger disabled:opacity-50"
                  : "min-h-11 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              }
              onClick={() => onAnswer({ outcome: "selected", optionId: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {submitting ? (
        <p className="mt-3 text-sm text-muted" role="status">
          正在提交你的决定，请稍候…
        </p>
      ) : null}
    </div>
  );
}
