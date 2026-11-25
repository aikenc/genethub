import { useCallback, useRef, useState } from "react";

const stageLabels = {
  connecting: "连接源机",
  connected: "源机已连接",
  "discovering-service": "查询登记服务",
  "requesting-grant": "申请预览凭证",
  "grant-received": "收到预览凭证",
  "restoring-storage": "恢复作品存档",
  "loading-document": "加载作品",
  "tools-delayed": "仍在等待作品或工具",
  "tools-ready": "预览工具已就绪",
  failed: "预览启动失败",
} as const;

export type PreviewStage = keyof typeof stageLabels;
export type PreviewTimelineEvent = { stage: PreviewStage; elapsedMs: number };

export function usePreviewTimeline() {
  const start = useRef(performance.now());
  const [previewId] = useState(() => crypto.randomUUID());
  const [events, setEvents] = useState<PreviewTimelineEvent[]>([]);
  const mark = useCallback((stage: PreviewStage) => {
    const elapsedMs = Math.round(performance.now() - start.current);
    setEvents(prior => prior.some(event => event.stage === stage) ? prior : [...prior, { stage, elapsedMs }]);
  }, []);
  return { previewId, events, mark };
}

export function previewStageLabel(event: PreviewTimelineEvent | undefined) {
  return stageLabels[event?.stage ?? "connecting"];
}

export function PreviewTimeline({ previewId, events }: { previewId: string; events: PreviewTimelineEvent[] }) {
  const payload = JSON.stringify({ previewId, events }, null, 2);
  return <section className="space-y-2" aria-label="加载时间线">
    <div className="flex items-center justify-between gap-2">
      <strong>加载时间线</strong>
      <a className="text-accent underline" download="preview-timeline.json"
        href={`data:application/json;charset=utf-8,${encodeURIComponent(payload)}`}>导出 JSON</a>
    </div>
    <ol className="space-y-1">
      {events.map(event => <li key={event.stage} className="flex justify-between gap-2">
        <span>{previewStageLabel(event)}</span>
        <span className="whitespace-nowrap tabular-nums">{event.elapsedMs} ms</span>
      </li>)}
    </ol>
  </section>;
}
