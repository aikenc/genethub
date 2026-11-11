import { FileText, Server } from "lucide-react";
import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";

import { useWorkbench } from "../session/store";
import { SessionCoordinationPill } from "../session/SessionCoordination";

/**
 * Project-pinned entries, shown as a single row of chips under the session
 * header. Clicking one opens the existing whole-page PreviewFloat in the
 * entry's configured initial mode (expanded by default). When the session has
 * coordination facts, a compact pill on the right carries them in this same
 * row instead of adding a second full-width bar.
 */
export function PreviewEntryStrip({ workspace, session }: {
  workspace?: WorkspaceInfo;
  session?: SessionSummary;
}) {
  const client = useWorkbench((state) => state.client);
  const openPreviewFloat = useWorkbench((state) => state.openPreviewFloat);
  const entries = workspace?.previewEntries ?? [];
  const machine = client?.identity?.machineId;
  const folder = workspace?.folders[0];
  if (!workspace || !machine || !folder || entries.length === 0) return null;
  return (
    <div
      className="flex min-h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-surface/60 px-2"
      aria-label="项目固定入口"
    >
      {entries.slice(0, 8).map((entry) => {
        const Icon = entry.kind === "service" ? Server : FileText;
        return (
          <button
            key={entry.id}
            type="button"
            title={`${entry.kind === "service" ? "服务入口" : "静态入口"} · ${entry.entry}`}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs text-fg hover:bg-raised"
            onClick={() =>
              openPreviewFloat({
                deviceHandle: machine,
                workspaceHandle: workspace.id,
                path: `${folder.rootHandle}/${entry.entry}`,
                initialMode: entry.openMode === "float" ? "float" : "expanded",
              })
            }
          >
            <Icon size={13} className="shrink-0 text-muted" aria-hidden />
            <span className="max-w-[12rem] truncate">{entry.title}</span>
          </button>
        );
      })}
      <SessionCoordinationPill session={session} />
    </div>
  );
}
