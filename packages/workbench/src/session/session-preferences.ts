import { useEffect, useReducer } from "react";
import { localValue, saveLocalValue } from "./localConversation";

const event = "genehub-session-preferences";
const key = (machine: string, session: string) => `session-pinned:${machine}:${session}`;

/** Local, per-machine user override. The session view keeps its own order; a
 * pinned row is only lifted into a separate block above it. */
export function sessionPinned(machine: string, session: string): boolean {
  return localValue<boolean>(key(machine, session)) ?? false;
}

export function setSessionPinned(machine: string, session: string, pinned: boolean): void {
  saveLocalValue(key(machine, session), pinned);
  window.dispatchEvent(new Event(event));
}

/** Same-tab and same-browser tabs observe the same pin facts. */
export function useSessionPreferences(): void {
  const [, changed] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    window.addEventListener(event, changed);
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener(event, changed);
      window.removeEventListener("storage", changed);
    };
  }, []);
}
