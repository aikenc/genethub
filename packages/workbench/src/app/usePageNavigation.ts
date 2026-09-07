import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "../session/store";
import type { WorkbenchSection } from "../shell/WorkbenchNavigation";
interface Page { section: WorkbenchSection; list: boolean; sessionId?: string | null; workspaceId?: string | null; tabId?: string | null; draftLocalId?: string }
/** Navigation history owns pages; the daemon/store still owns execution and subscriptions. */
export function usePageNavigation() {
 const initial: Page = {section: "sessions", list: true};
 const [page, setPage] = useState<Page>(() => window.history.state?.genehubPage ?? initial);
 const current = useRef(page);
 const queued = useRef(false);
 const restoring = useRef(false);
 const replacing = useRef(false);
 const update = (patch: Partial<Page>) => {
   if (restoring.current) return;
   const previous = current.current;
   const wb = useWorkbench.getState();
   const next = {...previous, ...patch, sessionId: wb.activeSessionId, workspaceId: wb.activeWorkspaceId, tabId: wb.activeTabId, draftLocalId: wb.draft?.localId};
   if (previous.section === next.section && previous.list === next.list && previous.sessionId === next.sessionId && previous.tabId === next.tabId && previous.draftLocalId === next.draftLocalId) return;
   current.current = next; setPage(next);
   if (restoring.current || queued.current) return;
   queued.current = true;
   // A conversation opened/sent from an expert has the same return destination
   // as a conversation opened from the list, rather than a trail of draft pages.
   const fromExpert = Boolean(previous.draftLocalId && next.sessionId && !next.list);
   const returnPage = fromExpert ? {...initial, sessionId: null, tabId: null, workspaceId: null, draftLocalId: undefined} : previous;
   // Switching experts replaces this page; opening a child keeps its parent entry.
   if (!replacing.current) window.history.replaceState({...window.history.state, genehubPage: returnPage, ...(fromExpert ? {genehubOverview: null, genehubParent: false} : {})}, "");
   queueMicrotask(() => {
     queued.current = false;
     const wb = useWorkbench.getState();
     current.current = {...current.current, sessionId: wb.activeSessionId, workspaceId: wb.activeWorkspaceId, tabId: wb.activeTabId, draftLocalId: wb.draft?.localId};
     const state = {...window.history.state, genehubPage: current.current, genehubParent: true};
     if (replacing.current) window.history.replaceState(state, "");
     else window.history.pushState(state, "");
     replacing.current = false;
   });
 };
 useEffect(() => {
   const restore = () => {
     const saved = window.history.state?.genehubPage as Page | undefined;
     if (!saved) return;
     restoring.current = true; current.current = saved; setPage(saved);
     const wb = useWorkbench.getState();
     if (saved.sessionId && wb.sessions.some(s => s.id === saved.sessionId)) void wb.selectSession(saved.sessionId).finally(() => {requestAnimationFrame(() => { restoring.current = false; });});
     else if (saved.draftLocalId && saved.workspaceId && wb.workspaces.some(w => w.id === saved.workspaceId)) { wb.newSession(saved.workspaceId, null, {localId:saved.draftLocalId,addressScope:"workspace"}); queueMicrotask(() => {requestAnimationFrame(() => { restoring.current=false; });}); }
     else { if (saved.tabId && wb.tabs.some(t => t.id === saved.tabId)) wb.activateTab(saved.tabId); queueMicrotask(() => {requestAnimationFrame(() => { restoring.current = false; });}); }
   };
   window.addEventListener("popstate", restore);
   return () => window.removeEventListener("popstate", restore);
 }, []);
 return {
   replaceNextPage: () => { replacing.current = true; queueMicrotask(() => { if (!queued.current) replacing.current = false; }); },
   section: page.section,
   sessionsOpen: page.list,
   setSection: (section: WorkbenchSection) => update({section}),
   setSessionsOpen: (value: boolean | ((old: boolean) => boolean)) => update({list: typeof value === "function" ? value(current.current.list) : value}),
   back: () => { if (window.history.state?.genehubParent) window.history.back(); else update({section: "sessions", list: true}); },
 };
}
