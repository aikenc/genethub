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

  return (
    <div
      className="rounded-lg border border-accent/50 bg-accent/5 px-3 py-3"
      role="group"
      aria-label={
        request.kind === "question"
          ? "Agent 提问"
          : request.kind === "planApproval"
            ? "Agent 计划确认"
            : "权限请求"
      }
    >
      <p className="mb-1 text-xs text-muted">
        {request.kind === "question"
          ? "任务已暂停；回答后会从原会话继续。"
          : request.kind === "planApproval"
            ? "任务已暂停；确认计划后会从原会话继续。"
            : "任务已暂停；授权后会以最高权限从原会话继续。"}
      </p>
      <p className="font-medium">{request.title}</p>
      {request.detail ? (
        <pre className="mt-1 max-h-40 max-w-full overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">
          {request.detail}
        </pre>
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
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={!complete}
              className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              提交答案
            </button>
            <button
              type="button"
              className="rounded border border-line px-3 py-1.5 text-xs text-muted"
              onClick={() => onAnswer({ outcome: "canceled" })}
            >
              取消任务
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {request.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={
                option.kind === "reject"
                  ? "rounded border border-line px-3 py-1.5 text-xs hover:border-danger hover:text-danger"
                  : "rounded bg-accent px-3 py-1.5 text-xs text-white"
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
