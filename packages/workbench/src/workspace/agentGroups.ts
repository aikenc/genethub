import type { SessionSummary } from "@genehub/proto";
import { useEffect, useState } from "react";

export interface AgentGroup {
  id: string;
  name: string;
  workspaceIds: string[];
}
const prefix = "genehub.agent.groups.v1:";
const changed = "genehub-agent-groups";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string");
function read(machine: string): AgentGroup[] {
  const raw = localStorage.getItem(prefix + machine);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((g) => g && typeof g.id === "string" && typeof g.name === "string" && strings(g.workspaceIds))) {
    throw new Error("无法读取分组，请检查浏览器存储；原数据未覆盖。");
  }
  return value;
}
export function inAgentGroup(session: SessionSummary, group: AgentGroup): boolean {
  return group.workspaceIds.includes(session.workspaceId);
}
/** Personal navigation only: never writes Session metadata or sends a prompt. */
export function useAgentGroups(machine: string) {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const reload = () => {
      try { setGroups(read(machine)); setError(""); }
      catch (e) { setError(e instanceof Error ? e.message : "浏览器未允许保存分组。"); }
    };
    reload();
    const storage = (e: StorageEvent) => { if (e.key === prefix + machine || e.key === null) reload(); };
    window.addEventListener("storage", storage);
    window.addEventListener(changed, reload);
    return () => { window.removeEventListener("storage", storage); window.removeEventListener(changed, reload); };
  }, [machine]);
  const update = (mutate: (current: AgentGroup[]) => AgentGroup[]) => {
    if (!machine) { setError("连接设备后才能保存分组。"); return false; }
    try {
      const next = mutate(read(machine));
      localStorage.setItem(prefix + machine, JSON.stringify(next));
      setGroups(next); setError("");
      window.dispatchEvent(new Event(changed));
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "分组保存失败，请检查浏览器存储。"); return false; }
  };
  return { groups, error, update };
}
