import { RefreshCw } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { normalizeAgentPreferences } from "../session/capability-preferences";
import { RuntimeSettings } from "../session/RuntimeSettings";
import { useWorkbench, type AgentConfigTab } from "../session/store";
import { AgentCard } from "./AgentCard";
import { sortAgentsForConfig } from "./agentConfig";
import { ProviderKeys } from "./ProviderKeys";

const TABS: { id: AgentConfigTab; label: string }[] = [
  { id: "agents", label: "Agent" },
  { id: "models", label: "模型与标签" },
  { id: "keys", label: "模型密钥" },
];

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The one place an Agent is configured: whether it is installed and logged in
 * (one card per Agent, the buttons its script declared), which models and tags
 * the picker offers, and the keys of the built-in Agent. System settings and
 * the model picker both open this dialog and nothing else.
 *
 * Mounted once at the app shell. An Agent's own request (a login link, a key
 * box) is shown above it by `AgentRequestDialog`.
 */
export function AgentConfigDialog() {
  const config = useWorkbench((state) => state.agentConfig);
  if (!config?.open || typeof document === "undefined") return null;
  return createPortal(<AgentConfigSurface tab={config.tab} />, document.body);
}

function AgentConfigSurface({ tab }: { tab: AgentConfigTab }) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const agents = useWorkbench((state) => state.agents);
  const settings = useWorkbench((state) => state.settings);
  const client = useWorkbench((state) => state.client);
  const loadSettings = useWorkbench((state) => state.loadSettings);
  const refreshAgents = useWorkbench((state) => state.refreshAgents);
  const openAgentConfig = useWorkbench((state) => state.openAgentConfig);
  const closeAgentConfig = useWorkbench((state) => state.closeAgentConfig);
  const setAgentPreferences = useWorkbench((state) => state.setAgentPreferences);

  useEffect(() => {
    if (client && !settings) void loadSettings();
  }, [client, settings, loadSettings]);

  // What a person sees here is the machine as it is now: opening the dialog
  // re-probes every Agent once.
  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    // Only when focus is not already inside: someone who started typing a key
    // before the first frame must not be moved off the box.
    const frame = window.requestAnimationFrame(() => {
      if (!panel.current?.contains(document.activeElement)) closeButton.current?.focus();
    });
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAgentConfig();
    };
    document.addEventListener("keydown", dismiss);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", dismiss);
      if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    };
  }, [closeAgentConfig]);

  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => !element.hasAttribute("hidden"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const moveTab = (event: ReactKeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length]!;
    openAgentConfig(next.id);
  };

  const sorted = sortAgentsForConfig(agents);
  const preferences = normalizeAgentPreferences(settings?.agentPreferences, agents);

  return (
    <div
      className="fixed inset-0 z-[85] flex items-end justify-center bg-black/60 md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeAgentConfig();
      }}
    >
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Agent 配置"
        className="flex h-[min(90dvh,54rem)] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
        onKeyDown={trapTab}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-fg">Agent 配置</h2>
            <p className="truncate text-xs text-faint">安装、登录、模型和密钥都在这里；你的账号和密钥只交给这台机器。</p>
          </div>
          <button
            type="button"
            aria-label="重新检查所有 Agent"
            title="重新检查"
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg"
            onClick={() => void refreshAgents()}
          >
            <RefreshCw size={15} aria-hidden />
          </button>
          <button
            ref={closeButton}
            type="button"
            aria-label="关闭 Agent 配置"
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-muted hover:bg-raised hover:text-fg"
            onClick={closeAgentConfig}
          >
            ×
          </button>
        </header>

        <div role="tablist" aria-label="Agent 配置分区" className="flex shrink-0 gap-1 border-b border-line px-3 pt-2">
          {TABS.map((entry, index) => (
            <button
              key={entry.id}
              id={`agent-config-tab-${entry.id}`}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              aria-controls={`agent-config-panel-${entry.id}`}
              tabIndex={tab === entry.id ? 0 : -1}
              className={`-mb-px min-h-11 rounded-t-lg border-b-2 px-3 text-xs ${
                tab === entry.id
                  ? "border-accent text-fg"
                  : "border-transparent text-muted hover:text-fg"
              }`}
              onClick={() => openAgentConfig(entry.id)}
              onKeyDown={(event) => moveTab(event, index)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div
          id={`agent-config-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`agent-config-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          {tab === "agents" ? (
            sorted.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted">这台机器上还没有可配置的 Agent。</p>
            ) : (
              <ul className="flex flex-col gap-3" aria-label="Agent 列表">
                {sorted.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} onOpenKeys={() => openAgentConfig("keys")} />
                ))}
              </ul>
            )
          ) : null}
          {tab === "models" ? (
            <RuntimeSettings
              agents={agents}
              preferences={preferences}
              onSave={(next) => setAgentPreferences(next)}
            />
          ) : null}
          {tab === "keys" ? <ProviderKeys /> : null}
        </div>
      </section>
    </div>
  );
}
