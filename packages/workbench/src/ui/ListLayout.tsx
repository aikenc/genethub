import type { ReactNode } from "react";
import { ArrowLeft, Search, X } from "lucide-react";

/** One responsive list column for both conversation and expert navigation. */
export function ListPane({label, open = true, hidden = false, children}: {
  label: string; open?: boolean; hidden?: boolean; children: ReactNode;
}) {
  return <aside aria-label={label} className={`${hidden ? "hidden" : open ? "flex" : "hidden md:flex"} list-pane min-h-0 w-full flex-1 flex-col overflow-hidden border-r border-line bg-sidebar md:w-80 md:flex-none`}>{children}</aside>;
}
export function ListHeader({children}: {children: ReactNode}) {
  return <header style={{ paddingTop: "calc(0.75rem + var(--safe-area-top))" }} className="relative shrink-0 space-y-2 border-b border-line px-3 pb-2 pt-3">{children}</header>;
}
export function ListScroll({label, children}: {label: string; children: ReactNode}) {
  return <div aria-label={label} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">{children}</div>;
}
export const listPrimaryAction = "flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-white disabled:opacity-40";
export function ListToolbar({label, searchLabel, searchOpen, onSearch, children}: {
  label: string; searchLabel: string; searchOpen: boolean; onSearch(): void; children: ReactNode;
}) {
  return <div aria-label={label} className="flex min-h-11 min-w-0 items-center gap-2">
    <button type="button" aria-label={searchLabel} aria-expanded={searchOpen} className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={onSearch}><Search size={18}/></button>
    {children}
  </div>;
}
export function ListGroupSelect({label, allLabel, value, groups, onChange}: {
  label: string; allLabel: string; value: string; groups: {id: string; name: string}[]; onChange(value: string): void;
}) {
  return <select aria-label={label} value={value} onChange={e => onChange(e.target.value)} className="min-h-11 min-w-0 flex-1 truncate rounded-lg bg-transparent text-sm font-semibold text-fg"><option value="">{allLabel}</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>;
}
export function ListSearch({label, value, onChange, onClose}: {
  label: string; value: string; onChange(value: string): void; onClose?(): void;
}) {
  return <div className="flex items-center gap-2 rounded-lg bg-raised px-3">
    <input autoFocus type="search" aria-label={label} placeholder={label} value={value} onChange={e => onChange(e.target.value)} className="min-h-11 w-full min-w-0 bg-transparent text-sm outline-none"/>
    {onClose && <button type="button" aria-label="关闭搜索" className="flex h-11 w-8 shrink-0 items-center justify-center text-muted" onClick={onClose}><X size={16}/></button>}
  </div>;
}
/** Back belongs to drill-down navigation; wide screens keep the list visible. */
export function DetailBackButton({label = "返回", onClick, listVisible = true}: {label?: string; onClick?(): void; listVisible?: boolean}) {
  return <button type="button" aria-label={label} className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised ${listVisible ? "md:hidden" : ""}`} onClick={onClick}><ArrowLeft size={20}/></button>;
}
