import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import type { Endpoint, Host } from "../host";
import { OpenProject } from "../workspace/OpenProject";
import { WorkspaceIcon } from "../workspace/WorkspaceIcon";
import { pickPromptSuggestions } from "./prompt-suggestions";
import { useWorkbench } from "./store";

/**
 * How many workspaces the panel offers before the rest are folded away.
 *
 * Two rows of the two-column grid. Someone who has opened twenty repositories
 * is not choosing between twenty of them right now; they are almost always
 * continuing in the one the sidebar already has selected, and that one is
 * always among these.
 */
export const NEW_SESSION_WORKSPACE_PREVIEW_LIMIT = 4;
/** @deprecated Use {@link NEW_SESSION_WORKSPACE_PREVIEW_LIMIT}. */
export const NEW_SESSION_PROJECT_PREVIEW_LIMIT = NEW_SESSION_WORKSPACE_PREVIEW_LIMIT;

/**
 * What an unstarted conversation shows instead of an empty transcript.
 *
 * Which workspace a new chat belongs to used to be readable only as a highlight
 * in the sidebar's tree, three levels down and easy to miss. It is decided
 * here, in the space the conversation has not filled yet, and stops being
 * visible the moment there is a real message to read instead.
 *
 * The Agent and model are not asked for again here. They have a permanent home
 * in the composer's own footer, one line below this panel, and asking the same
 * question twice on one screen made the first message look like it needed four
 * decisions when it needs one — what to ask for.
 *
 * Nothing here writes to the machine. The draft holds the choice until the
 * first message turns it into a session (`store.start`).
 */
export function NewSessionPanel({
  host,
  endpoint,
}: {
  host?: Host;
  endpoint?: Endpoint | null;
} = {}) {
  const workspaces = useWorkbench((state) => state.workspaces);
  const sessions = useWorkbench((state) => state.sessions);
  const draft = useWorkbench((state) => state.draft);
  const newSession = useWorkbench((state) => state.newSession);
  const appendComposerDraftLine = useWorkbench((state) => state.appendComposerDraftLine);
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const [suggestions, setSuggestions] = useState(() => pickPromptSuggestions());
  // The order is fixed when the panel opens. Sorting "the selected one first"
  // on every render meant a workspace jumped to the top of the grid under the
  // finger that had just tapped it, and everything below it moved.
  const [anchorId] = useState(() => draft?.workspaceId ?? null);

  if (!draft) return null;
  const ordered = recentFirst(workspaces, sessions, anchorId);
  const visible = showAllWorkspaces
    ? ordered
    : ordered.slice(0, NEW_SESSION_WORKSPACE_PREVIEW_LIMIT);

  return (
    <div className="mx-auto h-full min-w-0 max-w-chat overflow-y-auto px-3 py-4">
      <h2 className="text-sm font-medium text-fg">新会话</h2>
      <p className="mt-0.5 text-xs text-muted">选好工作区，然后在下面直接说要做什么。</p>

      <section className="mt-3 min-w-0" aria-labelledby="new-session-workspace">
        <div className="flex items-center justify-between gap-2">
          <h3 id="new-session-workspace" className="text-sm font-medium text-fg">
            工作区
          </h3>
          {host && endpoint ? (
            <OpenProject host={host} endpoint={endpoint} variant="inline" />
          ) : null}
        </div>
        <ul className="mt-1 grid grid-cols-2 gap-x-1">
          {visible.map((workspace) => {
            const chosen = workspace.id === draft.workspaceId;
            return (
              <li key={workspace.id} className="min-w-0">
                <button
                  type="button"
                  aria-current={chosen}
                  title={workspace.root}
                  onClick={() => newSession(workspace.id, null)}
                  className={`flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-left text-sm ${
                    chosen ? "bg-accent/10 text-fg" : "text-muted hover:bg-raised hover:text-fg"
                  }`}
                >
                  <WorkspaceIcon workspace={workspace} />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {ordered.length > visible.length || showAllWorkspaces ? (
          <button
            type="button"
            aria-expanded={showAllWorkspaces}
            className="mt-0.5 h-7 rounded px-2 text-xs text-accent hover:bg-raised"
            onClick={() => setShowAllWorkspaces((shown) => !shown)}
          >
            {showAllWorkspaces ? "收起" : `更多 ${ordered.length - visible.length}`}
          </button>
        ) : null}
      </section>

      <section className="mt-4 min-w-0" aria-labelledby="new-session-suggestions">
        <div className="flex items-center gap-1">
          <h3
            id="new-session-suggestions"
            className="text-[10px] font-medium uppercase tracking-wide text-faint"
          >
            可以先问问
          </h3>
          <button
            type="button"
            aria-label="换一批建议"
            title="换一批"
            onClick={() => setSuggestions(pickPromptSuggestions())}
            className="flex h-6 w-6 items-center justify-center rounded-full text-faint hover:bg-raised hover:text-fg"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <ul className="mt-1 flex flex-col">
          {suggestions.map((suggestion) => (
            <li key={suggestion} className="min-w-0">
              <button
                type="button"
                onClick={() => appendComposerDraftLine(null, suggestion)}
                className="w-full truncate rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-raised hover:text-fg"
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * The workspace the panel opened on, then the ones worked in most recently.
 *
 * The sidebar's selection stays first no matter how long ago it was touched —
 * being offered four workspaces that do not include the one you are looking at
 * reads as the panel having changed it.
 */
function recentFirst(
  workspaces: WorkspaceInfo[],
  sessions: SessionSummary[],
  anchorId: string | null,
): WorkspaceInfo[] {
  const touched = new Map<string, number>();
  for (const session of sessions) {
    const at = Math.max(session.updatedAtMs, session.createdAtMs);
    touched.set(session.workspaceId, Math.max(touched.get(session.workspaceId) ?? 0, at));
  }
  return [...workspaces].sort((left, right) => {
    if (left.id === anchorId) return -1;
    if (right.id === anchorId) return 1;
    return (touched.get(right.id) ?? 0) - (touched.get(left.id) ?? 0);
  });
}
