import type { AgentInfo } from "@genehub/proto";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

import { canStartAgent } from "../presentation/catalog/resolve";
import { AgentMark } from "../presentation/AgentMark";
import { normalizeAgentPreferences } from "../session/capability-preferences";
import { RuntimeSettings } from "../session/RuntimeSettings";
import { PROVIDERS_TARGET, useWorkbench } from "../session/store";
import { AgentCard } from "./AgentCard";
import { agentStatus, sortAgentsForConfig, type AgentStatusKind } from "./agentConfig";
import { ProviderManager } from "./ProviderManager";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

const DOT: Record<AgentStatusKind, string> = {
  ready: "bg-ok",
  needsLogin: "bg-accent",
  notInstalled: "bg-accent",
  busy: "bg-accent animate-pulse",
  unavailable: "bg-danger",
};

/**
 * The one place models and Agents are set up. The page is the model list: every
 * model a person can pick, grouped by where it comes from, with its cost and
 * tags. Everything about an Agent itself — install, login, an API key, its own
 * space — and about the model providers sits one level down, in a window opened
 * from the list, so the list stays what people come here for.
 *
 * Mounted once at the app shell. An Agent's own request (a login link, a key
 * box) is shown above both by `AgentRequestDialog`.
 */
export function AgentConfigDialog() {
  const config = useWorkbench((state) => state.agentConfig);
  if (!config?.open || typeof document === "undefined") return null;
  // Siblings, not nested: a nested portal would send the inner window's key
  // presses up through the list's focus trap.
  return createPortal(
    <>
      <ModelList covered={config.target !== null} />
      {config.target ? <ConfigWindow target={config.target} /> : null}
    </>,
    document.body,
  );
}

/** Focus in, Escape out, focus back where it was; shared by both windows. */
function useWindowFocus(
  panel: RefObject<HTMLElement>,
  initial: RefObject<HTMLElement>,
  dismiss: () => void,
  active: boolean,
) {
  const returnFocus = useRef<Element | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement;
    // Only when focus is not already inside: someone who started typing a key
    // before the first frame must not be moved off the box.
    // A list that opens already covered by a window leaves focus to that window.
    const frame = window.requestAnimationFrame(() => {
      if (active && !panel.current?.contains(document.activeElement)) initial.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) {
        returnFocus.current.focus();
      }
    };
    // Mount only: whether to take focus is decided once, when the window appears.
  }, [panel, initial]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss, active]);
}

function trapTab(panel: RefObject<HTMLElement>, event: ReactKeyboardEvent) {
  if (event.key !== "Tab" || !panel.current) return;
  const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.hasAttribute("hidden") &&
      (element.tagName === "SUMMARY" || element.closest("details:not([open])") === null),
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
}

function ModelList({ covered }: { covered: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
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

  // While a window sits over the list, Escape belongs to that window.
  useWindowFocus(panel, closeButton, closeAgentConfig, !covered);

  const usable = agents.filter(canStartAgent);
  const waiting = sortAgentsForConfig(agents.filter((agent) => !canStartAgent(agent)));
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
        aria-label="模型与 Agent"
        aria-hidden={covered ? true : undefined}
        className="flex h-[min(90dvh,54rem)] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
        onKeyDown={(event) => trapTab(panel, event)}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-fg">模型与 Agent</h2>
            <p className="truncate text-xs text-faint">选哪些模型、给它们打标签；账号和密钥只交给这台机器。</p>
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
            aria-label="关闭模型与 Agent"
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-muted hover:bg-raised hover:text-fg"
            onClick={closeAgentConfig}
          >
            ×
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-fg">模型</h3>
            <button
              type="button"
              className="flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-xs text-accent hover:border-accent"
              onClick={() => openAgentConfig(PROVIDERS_TARGET)}
            >
              <Plus size={13} aria-hidden /> 添加 provider
            </button>
          </div>

          {usable.length > 0 ? (
            <RuntimeSettings
              agents={agents}
              preferences={preferences}
              onSave={(next) => setAgentPreferences(next)}
              onConfigureAgent={(id) => openAgentConfig(id)}
            />
          ) : (
            <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-muted">
              还没有可用的模型。登录或安装下面的 Agent，或者添加一个模型 provider。
            </p>
          )}

          {waiting.length > 0 ? (
            <section aria-label="还不能用的 Agent" className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-fg">还不能用的 Agent</h3>
              <ul className="flex flex-col gap-2">
                {waiting.map((agent) => (
                  <WaitingAgent key={agent.id} agent={agent} onConfigure={() => openAgentConfig(agent.id)} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function WaitingAgent({ agent, onConfigure }: { agent: AgentInfo; onConfigure(): void }) {
  const status = agentStatus(agent);
  return (
    <li data-agent-id={agent.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2">
      <AgentMark agent={agent} className="h-7 w-7 shrink-0" fallbackToText={false} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fg">{agent.label}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted" data-status={status.kind}>
          <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[status.kind]}`} aria-hidden />
          <span>{status.label}</span>
        </p>
      </div>
      <button
        type="button"
        aria-label={`配置 ${agent.label}`}
        className="min-h-11 shrink-0 rounded-lg border border-line px-3 text-xs text-fg hover:border-accent"
        onClick={onConfigure}
      >
        配置
      </button>
    </li>
  );
}

/**
 * The second-level window: one Agent's card (install, login, key, own space),
 * or the model providers. Closing it returns to the list.
 */
function ConfigWindow({ target }: { target: string }) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const agents = useWorkbench((state) => state.agents);
  const closeTarget = useWorkbench((state) => state.closeAgentConfigTarget);
  useWindowFocus(panel, closeButton, closeTarget, true);

  const agent = target === PROVIDERS_TARGET ? undefined : agents.find((entry) => entry.id === target);
  // The built-in Agent has no login of its own: its models come from providers.
  const providers = target === PROVIDERS_TARGET || agent?.builtin === true;
  const title = providers ? "模型 provider" : (agent?.label ?? target);

  // An Agent that went away (removed, reloaded without it) leaves nothing to show.
  useEffect(() => {
    if (target !== PROVIDERS_TARGET && agents.length > 0 && !agent) closeTarget();
  }, [target, agent, agents.length, closeTarget]);

  return (
    <div
      className="fixed inset-0 z-[88] flex items-end justify-center bg-black/50 md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeTarget();
      }}
    >
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[min(85dvh,46rem)] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
        onKeyDown={(event) => trapTab(panel, event)}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</h2>
          <button
            ref={closeButton}
            type="button"
            aria-label={`关闭${title}`}
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-muted hover:bg-raised hover:text-fg"
            onClick={closeTarget}
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {providers ? (
            <ProviderManager />
          ) : agent ? (
            <ul aria-label="Agent 配置">
              <AgentCard agent={agent} />
            </ul>
          ) : null}
        </div>
      </section>
    </div>
  );
}
