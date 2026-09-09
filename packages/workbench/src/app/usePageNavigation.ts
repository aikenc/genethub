import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "../session/store";
import type { WorkbenchSection } from "../shell/WorkbenchNavigation";

interface Page {
  section: WorkbenchSection;
  list: boolean;
  sessionId?: string | null;
  workspaceId?: string | null;
  tabId?: string | null;
  draftLocalId?: string;
  surface: string;
  depth: number;
}
const initial: Page = { section: "sessions", list: true, surface: "sessions", depth: 0 };

/** One browser history for page navigation. Root selection replaces the current
 * detail; content links push a child. Execution stays owned by the store. */
export function usePageNavigation() {
  const [page, setPage] = useState<Page>(() => ({...initial, ...window.history.state?.genehubPage}));
  const current = useRef(page);
  const queued = useRef(false);
  const restoring = useRef(false);
  const intent = useRef<"push" | "replace" | "root">("push");
  const update = (patch: Partial<Page>) => {
    if (restoring.current) return;
    const previous = current.current;
    const wb = useWorkbench.getState();
    const next = {...previous, ...patch, sessionId: wb.activeSessionId, workspaceId: wb.activeWorkspaceId,
      tabId: wb.activeTabId, draftLocalId: wb.draft?.localId};
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    current.current = next;
    if (queued.current) return;
    queued.current = true;
    // Capture the source before the store changes again. In particular, an
    // expert's draft/filter page remains the parent of a selected conversation.
    window.history.replaceState({...window.history.state, genehubPage: previous}, "");
    queueMicrotask(() => {
      queued.current = false;
      const mode = intent.current;
      intent.current = "push";
      const next = current.current;
      const root = mode === "root" || next.list;
      const replace = mode === "replace" || root && !previous.list;
      next.depth = root || previous.list ? 0 : mode === "replace" ? previous.depth : previous.depth + 1;
      current.current = {...next};
      const state = {...window.history.state, genehubPage: current.current, genehubParent: next.depth > 0};
      if (replace) window.history.replaceState(state, "");
      else window.history.pushState(state, "");
      setPage(current.current);
    });
  };
  useEffect(() => {
    const restore = () => {
      const entry = window.history.state?.genehubPage as Page | undefined;
      if (!entry) return;
      const saved = {...initial, ...entry};
      restoring.current = true;
      current.current = saved;
      setPage(saved);
      const wb = useWorkbench.getState();
      let restored: Promise<unknown> = Promise.resolve();
      if (saved.draftLocalId && saved.workspaceId && wb.workspaces.some(w => w.id === saved.workspaceId)) {
        wb.newSession(saved.workspaceId, null, {localId: saved.draftLocalId, addressScope: "workspace"});
      } else if (saved.sessionId && wb.sessions.some(s => s.id === saved.sessionId)) {
        restored = wb.selectSession(saved.sessionId);
      }
      if (saved.tabId && wb.tabs.some(t => t.id === saved.tabId) && saved.tabId !== useWorkbench.getState().activeTabId) wb.activateTab(saved.tabId);
      void restored.catch(() => useWorkbench.setState({notice: "这个会话暂时无法打开。"}))
        .finally(() => requestAnimationFrame(() => { restoring.current = false; }));
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const mark = (mode: "replace" | "root") => {
    intent.current = mode;
    queueMicrotask(() => { if (!queued.current) intent.current = "push"; });
  };
  return {
    replaceNextPage: () => mark("replace"),
    rootNextPage: () => mark("root"),
    nested: page.depth > 0,
    section: page.section,
    sessionsOpen: page.list,
    overviewSurface: page.surface,
    setOverviewSurface: (surface: string, nested = false) => {
      if (!nested) intent.current = "replace";
      update({surface});
    },
    setSection: (section: WorkbenchSection) => update({section}),
    setSessionsOpen: (value: boolean | ((old: boolean) => boolean)) => update({list: typeof value === "function" ? value(current.current.list) : value}),
    back: () => {
      if (current.current.depth > 0) window.history.back();
      else { intent.current = "replace"; update({list: true}); }
    },
  };
}

/** Per-entry view state: filters/scroll restore with Back, without changing the
 * page stack or storing execution state in browser history. */
export function usePageViewState<T>(key: string, initialValue: T, delayMs = 0) {
  const read = () => (window.history.state?.genehubViews?.[key] as T | undefined) ?? initialValue;
  const [value, setValue] = useState<T>(read);
  const pending = useRef<T | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = (resolved: T) => {
    const views = {...window.history.state?.genehubViews, [key]: resolved};
    window.history.replaceState({...window.history.state, genehubViews: views}, "");
  };
  useEffect(() => {
    const restore = () => { clearTimeout(timer.current); timer.current = undefined; pending.current = undefined; setValue(read()); };
    restore();
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      clearTimeout(timer.current); timer.current = undefined;
      if (pending.current !== undefined) save(pending.current);
      pending.current = undefined;
    };
  }, [key]);
  const update = (next: T | ((previous: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(read()) : next;
    if (!delayMs) save(resolved);
    else {
      pending.current = resolved;
      if (timer.current === undefined) timer.current = setTimeout(() => {
        timer.current = undefined;
        if (pending.current !== undefined) save(pending.current);
        pending.current = undefined;
      }, delayMs);
    }
    setValue(resolved);
  };
  return [value, update] as const;
}
