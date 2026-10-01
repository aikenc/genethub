import { useEffect, useRef } from "react";
import { PreviewToolbarPortal } from "./PreviewToolbar";

export type ServiceMark =
  | { state: "absent" }
  | { state: "reachable"; name: string; policy: string }
  | { state: "unauthorized"; detail: string }
  | { state: "unreachable"; detail: string };

const LABEL = {
  absent: "无登记",
  reachable: "可达",
  unauthorized: "未授权",
  unreachable: "不可达",
} as const;

const DOT = {
  absent: "bg-current opacity-35",
  reachable: "bg-emerald-500",
  unauthorized: "bg-amber-500",
  unreachable: "bg-red-500",
} as const;

export function ServiceStatusMenu({
  mark,
  enabled,
  onToggle,
  onRecheck,
}: {
  mark: ServiceMark;
  enabled: boolean;
  onToggle: () => void;
  onRecheck: () => void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const label = LABEL[mark.state];
  const detail =
    mark.state === "absent"
      ? "这个文件没有登记本地服务。"
      : mark.state === "reachable"
        ? `${mark.name} · ${mark.policy}`
        : mark.detail;
  return (
    <PreviewToolbarPortal>
      <details
        ref={menuRef}
        className="relative"
        onKeyDown={(event) => {
          if (event.key === "Escape" && event.currentTarget.open) {
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}
      >
        <summary
          aria-label={`本地服务：${label}`}
          title={`本地服务：${label}`}
          className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg [&::-webkit-details-marker]:hidden"
        >
          <span className={`h-2.5 w-2.5 rounded-full ${DOT[mark.state]}`} />
        </summary>
        <div className="absolute right-0 top-full z-50 mt-1 flex w-56 max-w-[calc(100vw-1rem)] flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-xs shadow-lg">
          <p>本地服务：{label}</p>
          <p className="break-words text-muted">{detail}</p>
          {mark.state === "reachable" ? (
            <button type="button" className="rounded border border-line px-2 py-1 text-left hover:bg-raised" onClick={onToggle}>
              {enabled ? "暂停服务访问" : "允许本次预览访问登记服务"}
            </button>
          ) : null}
          <button type="button" className="rounded border border-line px-2 py-1 text-left hover:bg-raised" onClick={onRecheck}>
            重新检查服务
          </button>
        </div>
      </details>
    </PreviewToolbarPortal>
  );
}
