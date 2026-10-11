import { ChevronRight, Settings2 } from "lucide-react";

import { useWorkbench } from "../session/store";
import { agentConfigSummary } from "./agentConfig";

/**
 * The two doors into the one 模型与 Agent dialog. Both carry the same label and
 * icon and do the same thing; only the surrounding layout differs.
 */
export function AgentConfigEntry({ variant }: { variant: "link" | "row" }) {
  const openAgentConfig = useWorkbench((state) => state.openAgentConfig);
  const agents = useWorkbench((state) => state.agents);

  if (variant === "link") {
    return (
      <button
        type="button"
        className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-accent hover:bg-raised"
        onClick={() => openAgentConfig()}
      >
        <Settings2 size={14} aria-hidden /> 模型与 Agent
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label="模型与 Agent"
      aria-describedby="agent-config-summary"
      className="flex min-h-11 w-full items-center gap-3 rounded bg-surface px-3 py-2 text-left hover:bg-raised"
      onClick={() => openAgentConfig()}
    >
      <Settings2 size={16} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fg">模型与 Agent</span>
        <span id="agent-config-summary" className="block truncate text-xs text-muted">
          {agentConfigSummary(agents)}
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
    </button>
  );
}
