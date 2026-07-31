import type { PermissionOutcome, PermissionRequest } from "@genehub/proto";

/**
 * An approval sits at the bottom of the timeline rather than in a modal: the
 * user needs the surrounding context to decide, and a dialog hides exactly the
 * thing they are being asked about.
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
      aria-label="权限请求"
    >
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
