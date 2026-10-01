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

export type PreviewServiceInfo = {
  label: string;
  detail: string;
  enabled: boolean;
  canToggle: boolean;
  onToggle: () => void;
  onRecheck: () => void;
};

export function previewServiceInfo(
  mark: ServiceMark,
  enabled: boolean,
  onToggle: () => void,
  onRecheck: () => void,
): PreviewServiceInfo {
  return {
    label: LABEL[mark.state],
    detail:
      mark.state === "absent"
        ? "这个文件没有登记本地服务。"
        : mark.state === "reachable"
          ? `${mark.name} · ${mark.policy}`
          : mark.detail,
    enabled,
    canToggle: mark.state === "reachable",
    onToggle,
    onRecheck,
  };
}

/** Service status lives in the preview-info dialog, not the toolbar. */
export function PreviewServiceSection({ service }: { service: PreviewServiceInfo }) {
  return (
    <section aria-label={`本地服务：${service.label}`} className="mt-4 border-t border-line pt-3 text-xs">
      <h3 className="font-medium text-fg">本地服务：{service.label}</h3>
      <p className="mt-1 break-words text-muted">{service.detail}</p>
      <div className="mt-2 flex flex-col items-start gap-2">
        {service.canToggle ? (
          <button type="button" className="rounded border border-line px-2 py-1 text-left hover:bg-raised" onClick={service.onToggle}>
            {service.enabled ? "暂停服务访问" : "允许本次预览访问登记服务"}
          </button>
        ) : null}
        <button type="button" className="rounded border border-line px-2 py-1 text-left hover:bg-raised" onClick={service.onRecheck}>
          重新检查服务
        </button>
      </div>
    </section>
  );
}
