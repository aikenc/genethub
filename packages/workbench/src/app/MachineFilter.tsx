import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { MachineSummary } from "../protocol/summary-directory";
import { buildAgentSpaceTree } from "../workspace/agent-space-tree";

export const machineStateLabel = { deferred: "待同步", waiting: "待同步", loading: "同步中", ready: "在线", partial: "在线",
  offline: "离线", denied: "授权已撤销", timeout: "读取超时", unavailable: "暂不可用", notChecked: "未同步", rateLimited: "稍后重试" };
export const machineReady = (row: MachineSummary) => row.state === "ready" || row.state === "partial";

/** Filtering never acquires a connection or changes the current conversation. */
export function MachineFilter({ sources, value, onChange, section }: {
  sources: MachineSummary[]; value: string; onChange(value: string): void; section: "sessions" | "projects";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId(), focusAt = useRef(0);
  const selected = sources.find(row => row.target.id === value);
  const label = value ? selected?.target.label ?? "所选机器" : "全部机器";
  const online = sources.filter(machineReady).length;
  const countFor = (row: MachineSummary) => {
    if (section === "sessions") return row.sessions.length;
    const tree = buildAgentSpaceTree(row.workspaces);
    return tree.roots.length + tree.anomalies.length;
  };
  const entries = [{id: "", label: "全部机器", detail: `${online}/${sources.length} 在线`, row: undefined as MachineSummary | undefined},
    ...sources.map(row => ({id: row.target.id, label: row.target.label,
      detail: `${machineStateLabel[row.state]}${row.version ? ` · ${row.version}` : ""}`, row}))];
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    items?.[Math.min(focusAt.current, items.length - 1)]?.focus();
    const outside = (event: Event) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  }, [open]);
  const show = (last = false) => {
    focusAt.current = last ? entries.length - 1 : Math.max(0, entries.findIndex(entry => entry.id === value));
    setOpen(true);
  };
  return <div ref={root} className="min-w-0 flex-1">
    <button ref={trigger} type="button" aria-label="机器筛选" title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      className="gh-machine-filter flex min-h-11 w-full min-w-0 items-center gap-1 rounded-lg text-left font-semibold hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      onClick={() => open ? close() : show()}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(event.key === "ArrowUp"); } }}>
      <span className="min-w-0 truncate">{label}</span><ChevronDown aria-hidden size={16} className="shrink-0 text-muted" />
    </button>
    {open && <div id={id} ref={menu} role="menu" aria-label="机器筛选" className="absolute inset-x-2 top-full z-50 max-h-[min(26rem,60dvh)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-1 shadow-xl"
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === "Tab") { close(); return; }
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (current + 1) % items.length : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length : null;
        if (next !== null) { event.preventDefault(); items[next]?.focus(); }
      }}>
      {entries.map(entry => {
        const row = entry.row, ready = row ? machineReady(row) : online > 0;
        const failed = row && ["offline", "denied", "timeout", "unavailable", "rateLimited"].includes(row.state);
        const count = row ? countFor(row) : sources.reduce((n, source) => n + countFor(source), 0);
        return <button key={entry.id} type="button" role="menuitemradio" aria-checked={value === entry.id} tabIndex={-1}
          className="flex min-h-14 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-raised focus:bg-raised focus:outline-none"
          onClick={() => { onChange(entry.id); close(true); }}>
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${ready ? "bg-ok" : failed ? "bg-danger" : "bg-muted"}`} />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm" title={entry.label}>{entry.label}</span>
            <span className="mt-0.5 block break-words text-xs text-muted">{entry.detail}</span></span>
          <span className="shrink-0 text-right text-[10px] text-faint">{section === "projects" ? `${count} 项目` : `已载 ${count}`}</span>
          <span className="w-4 shrink-0">{value === entry.id && <Check size={16} aria-hidden className="text-accent" />}</span>
        </button>;
      })}
    </div>}
  </div>;
}
