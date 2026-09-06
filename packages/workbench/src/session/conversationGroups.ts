import type { SessionSummary } from "@genehub/proto";
import { useEffect, useState } from "react";

export interface ConversationGroup {
  id: string;
  name: string;
  workspaceIds: string[];
  included: string[];
  excluded: string[];
}
const prefix = "genehub.conversation.groups.v1:";
const changed = "genehub-conversation-groups";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string");
function read(machine: string): ConversationGroup[] {
  const raw = localStorage.getItem(prefix + machine);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((g) => g && typeof g.id === "string" && typeof g.name === "string" && strings(g.workspaceIds) && strings(g.included) && strings(g.excluded))) {
    throw new Error("无法读取分组，请检查浏览器存储；原数据未覆盖。");
  }
  return value;
}
export function inConversationGroup(session: SessionSummary, group: ConversationGroup): boolean {
  return !group.excluded.includes(session.id) &&
    (group.included.includes(session.id) || group.workspaceIds.includes(session.workspaceId));
}
export function changeGroupMembers(group: ConversationGroup, ids: string[], add: boolean): ConversationGroup {
  const selected = new Set(ids);
  return {
    ...group,
    included: add ? [...new Set([...group.included, ...ids])] : group.included.filter((id) => !selected.has(id)),
    excluded: add ? group.excluded.filter((id) => !selected.has(id)) : [...new Set([...group.excluded, ...ids])],
  };
}
/** Personal navigation only: never writes Session metadata or sends a prompt. */
export function useConversationGroups(machine: string) {
  const [groups, setGroups] = useState<ConversationGroup[]>([]);
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
  const update = (mutate: (current: ConversationGroup[]) => ConversationGroup[]) => {
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
