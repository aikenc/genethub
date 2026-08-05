import type { ResourceContent } from "@genehub/proto";
import { useEffect } from "react";

import { ResourceBody } from "./ResourcePreview";

/**
 * The floating window an artifact card expands into.
 *
 * Chat is a narrow column; a screenshot, a long markdown report or a
 * sanitized HTML document all deserve more room than that, without leaving
 * the conversation the way opening the files panel would — see
 * `docs/specs/artifact-skill.md` §6, which asks for this over an iframe.
 *
 * Takes the already-fetched `content` rather than a path: the card that
 * opens this already paid for the `resource.read` round trip, and asking
 * again here would fetch the same bytes twice for no reason.
 */
export function PreviewModal({
  path,
  content,
  onClose,
}: {
  path: string;
  content: ResourceContent;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={path}
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl min-w-0 flex-col overflow-hidden rounded-lg bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={path}>
            {path}
          </span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 text-xs text-accent hover:bg-raised"
            onClick={onClose}
          >
            关闭 ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <ResourceBody content={content} expanded />
        </div>
      </div>
    </div>
  );
}
