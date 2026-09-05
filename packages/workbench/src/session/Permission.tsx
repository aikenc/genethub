import type { InteractionAnswer, PermissionOutcome, PermissionRequest } from "@genehub/proto";
import { useEffect, useMemo, useState } from "react";

/**
 * A stopped interaction sits at the bottom of the timeline rather than in a
 * modal. No Agent process or live browser connection is kept waiting for it.
 */
export function PermissionCard({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer(outcome: PermissionOutcome): void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});
  useEffect(() => {
    setSelected({});
    setFreeform({});
  }, [request.id]);
  const answers = useMemo<InteractionAnswer[]>(
    () =>
      (request.questions ?? []).map((question) => ({
        questionId: question.id,
        selectedOptionIds: selected[question.id] ?? [],
        freeformText: freeform[question.id]?.trim() || undefined,
      })),
    [freeform, request.questions, selected],
  );
  const complete = answers.every(
    (answer) => answer.selectedOptionIds.length > 0 || Boolean(answer.freeformText),
  );
  const heading =
    request.kind === "question"
      ? "需要你的回答"
      : request.kind === "planApproval"
        ? "需要你的确认"
        : "需要你的授权";
  const paused =
    request.kind === "question"
      ? "任务已暂停；回答后会从原会话继续。"
      : request.kind === "planApproval"
        ? "任务已暂停；确认计划后会从原会话继续。"
        : "任务已暂停；授权后会以最高权限从原会话继续。";

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
            if (complete) onAnswer({ outcome: "answered", answers });
          }}
        >
          {request.questions?.map((question) => (
            <fieldset key={question.id} className="space-y-2">
              <legend className="text-sm font-medium">{question.prompt}</legend>
              {question.options.map((option) => {
                const checked = (selected[question.id] ?? []).includes(option.id);
                return (
                  <label key={option.id} className="flex items-center gap-2 text-sm">
                    <input
                      type={question.allowMultiple ? "checkbox" : "radio"}
                      name={`interaction-${request.id}-${question.id}`}
                      checked={checked}
                      onChange={() =>
                        setSelected((current) => ({
                          ...current,
                          [question.id]: question.allowMultiple
                            ? checked
                              ? (current[question.id] ?? []).filter((id) => id !== option.id)
                              : [...(current[question.id] ?? []), option.id]
                            : [option.id],
                        }))
                      }
                    />
                    {option.label}
                  </label>
                );
              })}
              {question.allowFreeform ? (
                <textarea
                  value={freeform[question.id] ?? ""}
                  onChange={(event) =>
                    setFreeform((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }
                  placeholder="其他答案或补充说明"
                  rows={2}
                  className="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm"
                />
              ) : null}
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={!complete}
              className="min-h-11 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              提交答案
            </button>
            <button
              type="button"
              className="min-h-11 rounded-lg border border-line-strong px-4 py-2.5 text-sm font-medium text-muted hover:text-fg"
              onClick={() => onAnswer({ outcome: "canceled" })}
            >
              取消任务
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap gap-3">
          {request.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={
                option.kind === "reject"
                  ? "min-h-11 rounded-lg border border-line-strong px-4 py-2.5 text-sm font-medium hover:border-danger hover:text-danger"
                  : "min-h-11 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white"
              }
              onClick={() => onAnswer({ outcome: "selected", optionId: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
