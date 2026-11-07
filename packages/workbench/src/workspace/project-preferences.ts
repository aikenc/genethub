import { useEffect, useReducer } from "react";
import { localValue, saveLocalValue } from "../session/localConversation";

const event = "genehub-project-preferences";
const key = (machine: string, workspace: string) => `project-pinned:${machine}:${workspace}`;
export function projectPinned(machine: string, workspace: string, builtin = false): boolean {
  return localValue<boolean>(key(machine, workspace)) ?? builtin;
}
export function setProjectPinned(machine: string, workspace: string, pinned: boolean) {
  saveLocalValue(key(machine, workspace), pinned);
  window.dispatchEvent(new Event(event));
}
export function useProjectPreferences() {
  const [, changed] = useReducer(n => n + 1, 0);
  useEffect(() => {
    window.addEventListener(event, changed); window.addEventListener("storage", changed);
    return () => { window.removeEventListener(event, changed); window.removeEventListener("storage", changed); };
  }, []);
}
