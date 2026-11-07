import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { AgentAvatar } from "../workspace/AgentAvatar";

export interface SpaceFilterOption {
  id: string;
  name: string;
  avatarId?: string;
  machine: string;
  status: string;
  count: number;
  activity?: ReactNode;
}

/** A source-labelled filter. Opening or searching never opens a conversation. */
export function SpaceFilter({ label, options, value, onChange }: {
  label: string; options: SpaceFilterOption[]; value: string; onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 320 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const id = useId(), selected = options.find(option => option.id === value);
  const q = query.trim().toLocaleLowerCase();
  const entries = options.filter(option => `${option.name} ${option.machine}`.toLocaleLowerCase().includes(q));
  const ids = ["", ...entries.map(option => option.id)];
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  const choose = (next: string) => { onChange(next); close(true); };
  const show = () => { setQuery(""); setActive(Math.max(0, options.findIndex(option => option.id === value) + 1)); setOpen(true); };
  useLayoutEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? window.innerHeight);
      const availableBelow = bottom - rect.bottom - 12, availableAbove = rect.top - top - 12;
      const above = availableBelow < 200 && availableAbove > availableBelow;
      const height = Math.min(360, Math.max(120, above ? availableAbove : availableBelow));
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) / scale,
        top: (above ? Math.max(top + 12, rect.top - height - 4) : rect.bottom + 4) / scale,
        width: width / scale, maxHeight: height / scale });
    };
    place(); input.current?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    const scrolled = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) place(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", place); viewport?.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", scrolled, true); window.removeEventListener("resize", place); viewport?.removeEventListener("resize", place);
    };
  }, [open]);
  useEffect(() => { panel.current?.querySelector('[data-active="true"]')?.scrollIntoView({block:"nearest"}); }, [active]);
  const highlighted = Math.min(active, ids.length - 1);
  return <div className="my-1 flex min-w-0 items-center gap-1">
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open}
      className={`flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-xs hover:bg-raised ${value ? "bg-accent/10 text-accent" : "text-muted"}`}
      onClick={() => open ? close() : show()} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") {event.preventDefault(); show();} }}>
      {selected && <AgentAvatar id={selected.avatarId ?? selected.id} name={selected.name} size="small" />}
      <span className="min-w-0 flex-1 truncate">{selected?.name ?? `全部 Space · ${options.length}`}</span>
      <ChevronDown size={16} className="shrink-0" aria-hidden />
    </button>
    {value && <button type="button" aria-label="清除Space筛选" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={() => onChange("")}><X size={16}/></button>}
    {open && createPortal(<div ref={panel} className="genehub-ui fixed z-[85] flex flex-col overflow-hidden rounded-xl border border-line-strong bg-surface text-fg shadow-xl" style={position}
      onKeyDown={event => {
        if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); close(true);}
        else if (event.key === "Tab") close();
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {event.preventDefault(); setActive((highlighted + (event.key === "ArrowDown" ? 1 : -1) + ids.length) % ids.length);}
        else if (event.key === "Enter" && event.target === input.current) {event.preventDefault(); choose(ids[highlighted]!);}
      }}>
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2">
        <Search size={16} aria-hidden className="shrink-0 text-muted"/>
        <input ref={input} role="combobox" aria-label="搜索Space或机器" aria-expanded="true" aria-autocomplete="list" aria-controls={id}
          aria-activedescendant={`${id}-${highlighted}`} value={query} onChange={event => {setQuery(event.target.value); setActive(0);}}
          placeholder="搜索 Space 或机器" className="min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"/>
        <button type="button" aria-label="关闭Space筛选" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised" onClick={() => close(true)}><X size={18}/></button>
      </div>
      <div id={id} role="listbox" aria-label={label} className="min-h-0 overflow-y-auto overscroll-contain p-1">
        <button id={`${id}-0`} type="button" role="option" aria-selected={!value} tabIndex={-1} data-active={highlighted === 0}
          className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-raised data-[active=true]:bg-raised"
          onClick={() => choose("")}><span className="flex-1">全部 Space</span><span className="text-xs text-muted">{options.length} 个</span>{!value && <Check size={16} className="text-accent"/>}</button>
        {entries.map((option,index) => <button id={`${id}-${index+1}`} key={option.id} type="button" role="option" aria-selected={value === option.id} tabIndex={-1}
          data-active={highlighted === index+1} className="flex min-h-14 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-raised data-[active=true]:bg-raised"
          onClick={() => choose(option.id)}>
          <AgentAvatar id={option.avatarId ?? option.id} name={option.name} size="medium"/>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm">{option.name}</span>
            <span className="mt-1 block truncate text-xs text-muted">{option.machine} · {option.status}</span>
            <span className="mt-1 flex items-center gap-2 text-[11px] text-faint">已加载 {option.count} 条{option.activity}</span>
          </span>
          <span className="w-4 shrink-0">{value === option.id && <Check size={16} className="text-accent"/>}</span>
        </button>)}
        {!entries.length && <p role="status" className="px-3 py-5 text-center text-sm text-muted">没有匹配的 Space</p>}
      </div>
    </div>,document.body)}
  </div>;
}
