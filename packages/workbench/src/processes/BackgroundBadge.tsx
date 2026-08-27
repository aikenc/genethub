import { useState } from "react";

import { useWorkbench } from "../session/store";
import { SessionProcessesDialog } from "./SessionProcessesDialog";

/**
 * How many processes this conversation left running.
 *
 * Absent at zero rather than showing "0", because the only reason to look at
 * this is that it is not zero. A permanent indicator saying nothing is wrong
 * is one people stop reading, and then it is not an indicator.
 */
export function BackgroundBadge() {
  const { backgroundProcesses, activeSessionId } = useWorkbench();
  const [open, setOpen] = useState(false);
  const count = activeSessionId
    ? backgroundProcesses.filter((process) => process.sessionId === activeSessionId).length
    : 0;
  if (count === 0 || !activeSessionId) return null;

  return (
    <>
      <button
        type="button"
        aria-label={`当前会话有 ${count} 个后台进程`}
        title="查看当前会话留下的后台进程"
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-raised hover:text-fg"
        onClick={() => setOpen(true)}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
        {count}
      </button>
      {open ? <SessionProcessesDialog sessionId={activeSessionId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
