import type { PermissionOutcome, PermissionRequest } from "@genehub/proto";

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
  return (
    <div
      className="rounded-lg border border-accent/50 bg-accent/5 px-3 py-3"
      role="group"
      aria-label={request.kind === "question" ? "Agent 提问" : "权限请求"}
    >
      <p className="mb-1 text-xs text-muted">
        {request.kind === "question"
          ? "任务已暂停；回答后会从原会话继续。"
          : "任务已暂停；授权后会以最高权限从原会话继续。"}
      </p>
      <p className="font-medium">{request.title}</p>
      {request.detail ? (
        <pre className="mt-1 max-h-40 max-w-full overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">
          {request.detail}
        </pre>
      ) : null}
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
    </div>
  );
}
