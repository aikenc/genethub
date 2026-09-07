import { MessageSquare, Compass, Folder, SlidersHorizontal } from "lucide-react";

export type WorkbenchSection = "sessions" | "spaces" | "discover" | "tools";
const entries = [
  { id: "sessions", label: "会话", Icon: MessageSquare },
  { id: "spaces", label: "专家", Icon: Folder },
  { id: "discover", label: "发现", Icon: Compass },
  { id: "tools", label: "设置", Icon: SlidersHorizontal },
] as const;

export function WorkbenchNavigation({ section, needsAttention, onChange, detail = false }: {
  detail?: boolean;
  section: WorkbenchSection;
  needsAttention: boolean;
  onChange(section: WorkbenchSection): void;
}) {
  return <nav data-detail={detail} aria-label="工作台导航" className={`${detail ? "hidden md:flex" : "flex"} weui-tabbar order-last shrink-0 border-t border-line bg-sidebar px-2 md:order-first md:w-20 md:flex-col md:gap-2 md:border-r md:border-t-0 md:py-4`} style={{ paddingBottom: "max(0.25rem, env(safe-area-inset-bottom))" }}>
    {entries.map(({ id, label, Icon }) => <button key={id} type="button" aria-current={section === id ? "page" : undefined} onClick={() => onChange(id)} className={`weui-tabbar__item relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-2 text-xs md:flex-none ${section === id ? "bg-raised text-accent" : "text-muted hover:bg-raised"}`}>
      <Icon size={19} aria-hidden />{label}
      {id === "sessions" && needsAttention ? <span className="absolute right-4 top-2 h-2 w-2 rounded-full bg-danger" aria-label="有会话需要处理" /> : null}
    </button>)}
  </nav>;
}
