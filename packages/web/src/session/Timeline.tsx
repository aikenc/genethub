import type { TimelineItem } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";

import { ToolCallView } from "./ToolCall";
import type { TimelineState } from "./timeline";

export function Timeline({ state }: { state: TimelineState }) {
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Stay at the bottom while new content arrives, unless the user scrolled up
  // to read something — then leave them where they are.
  useEffect(() => {
    if (pinned) bottom.current?.scrollIntoView({ block: "end" });
  }, [state.items, pinned]);

  return (
    <div
      ref={scroller}
      className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
      data-testid="timeline"
      onScroll={(event) => {
        const element = event.currentTarget;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        setPinned(distance < 40);
      }}
    >
      {state.items.map((item) => (
        <Item key={item.id} item={item} />
      ))}

      {state.lastError ? (
        <p
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger"
          role="alert"
        >
          {state.lastError.message}
        </p>
      ) : null}

      <div ref={bottom} />
    </div>
  );
}

function Item({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "userMessage":
      return (
        <div className="flex justify-end">
          <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-accent px-3 py-2 text-white">
            {item.text}
          </p>
        </div>
      );

    case "assistantMessage":
      return (
        <p className="whitespace-pre-wrap" data-testid="assistant-message">
          {item.text}
        </p>
      );

    case "reasoning":
      return <Reasoning text={item.text} />;

    case "toolCall":
      return <ToolCallView name={item.name} status={item.status} detail={item.detail} />;

    case "todo":
      return (
        <ul className="space-y-1 rounded-lg border border-line bg-surface px-3 py-2">
          {item.items.map((entry, index) => (
            <li key={index} className={entry.status === "completed" ? "text-muted line-through" : ""}>
              {entry.text}
            </li>
          ))}
        </ul>
      );

    case "compaction":
      return (
        <p className="text-center text-xs text-muted">
          —— 历史已压缩（{item.reason}）——
        </p>
      );

    case "error":
      return (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
          {item.message}
        </p>
      );
  }
}

/** Collapsed by default: it is context, not the answer. */
function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-2 text-xs text-muted">
      <button type="button" onClick={() => setOpen((value) => !value)} className="text-accent">
        {open ? "收起思考过程" : "思考过程"}
      </button>
      {open ? <p className="mt-1 whitespace-pre-wrap">{text}</p> : null}
    </div>
  );
}
