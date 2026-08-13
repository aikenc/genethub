import { useWorkbench } from "../session/store";

/**
 * How many processes the agents left running, where the conversation is.
 *
 * Absent at zero rather than showing "0", because the only reason to look at
 * this is that it is not zero. A permanent indicator saying nothing is wrong
 * is one people stop reading, and then it is not an indicator.
 */
export function BackgroundBadge() {
  const { backgroundProcesses, openTab } = useWorkbench();
  const count = backgroundProcesses.length;
  if (count === 0) return null;

  return (
    <button
      type="button"
      aria-label={`${count} 个后台进程`}
      title="Agent 留下的进程仍在运行"
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-raised hover:text-fg"
      onClick={() => openTab("processes", "后台进程")}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
      {count}
    </button>
  );
}
