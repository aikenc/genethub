import type { SessionSummary } from "@genehub/proto";
import type { AttentionFilter } from "./attention";
import { sessionLatest } from "./session-order";

/** Each list owns its own query/filter state; switching sections never leaks it. */
export interface ListViewState {
  query: string;
  filter: AttentionFilter;
  includeArchived: boolean;
}
export type ListViews = Record<"sessions" | "projects", ListViewState>;

export const initialListViews = (): ListViews => ({
  sessions: { query: "", filter: "all", includeArchived: false },
  projects: { query: "", filter: "all", includeArchived: false },
});

export function patchListView(views: ListViews, section: keyof ListViews, patch: Partial<ListViewState>): ListViews {
  return { ...views, [section]: { ...views[section], ...patch } };
}

export interface ProjectSearchFields {
  name: string;
  root: string;
  memberNames: readonly string[];
  sessionTexts: readonly string[];
}

/** A project matches a query by its own name, its sessions, or its member Spaces. */
export function projectSearchMatches(query: string, project: ProjectSearchFields): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  return [project.name, project.root, ...project.memberNames, ...project.sessionTexts]
    .some(text => text.toLocaleLowerCase().includes(q));
}

/** A project's rank belongs to its own front sessions, never to internal member activity. */
export function projectFrontTime(frontSessions: readonly SessionSummary[]): number {
  return frontSessions.reduce((max, session) => Math.max(max, sessionLatest(session)), 0);
}
