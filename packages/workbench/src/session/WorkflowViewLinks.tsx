import { useEffect, useState } from "react";
import { useWorkbench } from "./store";

/** Entries are discovered from the pinned build; packages need no registry. */
export function WorkflowViewLinks({workspaceId, runId, nodeId, compact=false}: {workspaceId: string; runId: string; nodeId?: string; compact?: boolean}) {
  const client = useWorkbench(s => s.client);
  const [views, setViews] = useState<Array<{id: string; title: string}>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setViews([]); setError(null);
    if (client?.identity?.features?.includes("workflow.observability.v1")) void client.call({type: "workflow.view", payload: {workspaceId, runId, path: null}}).then(reply => {
      if (reply?.type !== "workflowView") throw new Error("视图入口待同步");
      const data = reply.data as {views: Array<{id: string; title: string}>};
      if (alive) setViews(data.views);
    }).catch(cause => {if (alive) setError(String(cause instanceof Error ? cause.message : cause));});
    return () => {alive = false;};
  }, [client, workspaceId, runId]);
  const primary=views.find(view=>view.id==='progress')??views[0];
  const shown=compact?(primary?[primary]:[]):views;
  return <div className={compact?"shrink-0":"flex flex-wrap gap-2"}>
    {shown.map(view => <button type="button" key={view.id} title={view.title} className={`min-h-11 text-xs text-accent ${compact?"max-w-28 truncate":""}`} onClick={() => useWorkbench.getState().openWorkflowView({workspaceId, runId, nodeId, viewId: view.id})}>{view.title} ›</button>)}
    {error && <p role="status" title={error} className={`text-xs text-muted ${compact?"max-w-28 truncate":""}`}>{error}</p>}
  </div>;
}
