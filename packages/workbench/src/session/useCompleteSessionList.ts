import { useEffect, useId } from "react";
import { useWorkbench } from "./store";

/** Explicit full-range views share one loader without clearing each other's demand. */
export function useCompleteSessionList(enabled: boolean) {
  const client = useWorkbench(state => state.client);
  const owner = useId();
  useEffect(() => {
    if (!client?.identity?.features?.includes("session.page.v1")) return;
    useWorkbench.getState().setSessionGlobalView(enabled, owner);
    return () => {
      if (useWorkbench.getState().client === client) useWorkbench.getState().setSessionGlobalView(false, owner);
    };
  }, [client, enabled, owner]);
}
