import { useSyncExternalStore } from "react";
import { localValue, saveLocalValue } from "../session/localConversation";

export const agentEmojis = ["🐼", "🦊", "🐱", "🐶", "🐨", "🐯", "🦁", "🐸", "🐧", "🐬", "🦉", "🦋", "🌻", "🌵", "🍀", "🍎", "🍊", "🍋", "🚀", "🪐", "⭐", "🌈", "🎨", "🎯"];
const event = "genehub-agent-avatar";
const key = (id: string) => `avatar:${id}`;
// Workspace IDs are random. Seed by durable identity so defaults never jump on
// rerender, rename, reload or another device. Do not reuse file-type icons here.
function defaultEmoji(id: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return agentEmojis[(hash >>> 0) % agentEmojis.length]!;
}
function subscribe(listener: () => void) {
  window.addEventListener(event, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(event, listener); window.removeEventListener("storage", listener); };
}
function useEmoji(id: string) {
  return useSyncExternalStore(subscribe, () => {
    const saved = localValue<string>(key(id));
    return saved && agentEmojis.includes(saved) ? saved : defaultEmoji(id);
  }, () => defaultEmoji(id));
}
export function AgentAvatar({ id, name }: { id: string; name: string }) {
  const emoji = useEmoji(id);
  return <span role="img" aria-label={`${name}的头像`} className="entity-avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-2xl leading-none">{emoji}</span>;
}
export function AgentAvatarPicker({ id }: { id: string }) {
  const selected = useEmoji(id);
  const choose = (emoji: string | null) => { saveLocalValue(key(id), emoji); window.dispatchEvent(new Event(event)); };
  return <fieldset className="mb-4 border-b border-line pb-4">
    <legend className="mb-2 font-medium">头像</legend>
    <div className="flex flex-wrap gap-1">{agentEmojis.map(emoji =>
      <button key={emoji} type="button" aria-label={`使用 ${emoji} 头像`} aria-pressed={emoji === selected} onClick={() => choose(emoji)} className={`h-11 w-11 rounded-lg text-2xl ${emoji === selected ? "bg-accent/15 ring-1 ring-accent" : "hover:bg-raised"}`}>{emoji}</button>
    )}</div>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted"><span>自选头像保存在此浏览器。</span><button type="button" className="min-h-10 px-2 text-accent" onClick={() => choose(null)}>恢复默认头像</button></div>
  </fieldset>;
}
