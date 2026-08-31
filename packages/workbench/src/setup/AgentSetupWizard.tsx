import type { AgentInfo } from "@genehub/proto";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Host } from "../host";
import { AgentMark } from "../presentation/AgentMark";
import {
  canStartAgent,
  resolveAgentAvailability,
  resolveAgentPresentation,
} from "../presentation/catalog/resolve";
import { useWorkbench } from "../session/store";
import { GuideTerminal } from "./GuideTerminal";
import { authBadge, envCommand, installMethodsFor, wizardStep } from "./steps";

/** Providers offered to the built-in agent before anything is configured. */
const OFFERED = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
];

/**
 * The guided answer to "这个 Agent 怎么用": install it, sign it in, hand it a
 * key — each step in the agent's own official words, run in the terminal on
 * screen, verified by re-probing.
 *
 * The dialog holds no progress state of its own. Which step is showing is
 * recomputed from the agent's live probe/auth on every refresh, so finishing
 * a sign-in in the terminal moves the wizard on by itself.
 */
export function AgentSetupWizard({ host }: { host: Host }) {
  const agentId = useWorkbench((state) => state.setupAgentId);
  const agents = useWorkbench((state) => state.agents);
  const openAgentSetup = useWorkbench((state) => state.openAgentSetup);
  const refreshAgents = useWorkbench((state) => state.refreshAgents);
  const newSession = useWorkbench((state) => state.newSession);
  const agent = agents.find((entry) => entry.id === agentId);
  const close = useRef<HTMLButtonElement>(null);

  const closeWizard = () => openAgentSetup(null);

  // While the wizard is open the machine is asked again every few seconds and
  // whenever the window regains focus — signing in happens in the terminal or
  // the browser, and both are outside our event stream.
  useEffect(() => {
    if (!agentId) return;
    const ask = () => void refreshAgents().catch(() => undefined);
    const timer = setInterval(ask, 5000);
    window.addEventListener("focus", ask);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", ask);
    };
  }, [agentId, refreshAgents]);

  useEffect(() => {
    if (!agentId) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      openAgentSetup(null);
    };
    document.addEventListener("keydown", dismiss);
    const frame = window.requestAnimationFrame(() => close.current?.focus());
    return () => {
      document.removeEventListener("keydown", dismiss);
      window.cancelAnimationFrame(frame);
    };
  }, [agentId, openAgentSetup]);

  if (!agentId || typeof document === "undefined") return null;
  if (!agent) return null;

  const presentation = resolveAgentPresentation(agent);
  const availability = resolveAgentAvailability(agent);
  const badge = authBadge(agent);
  const step = wizardStep(agent);

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeWizard();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${presentation.label} 配置引导`}
        className="flex max-h-[min(86dvh,52rem)] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <AgentMark agent={agent} className="h-7 w-7" fallbackToText />
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 font-medium text-fg">
              <span className="truncate">{presentation.label}</span>
              {agent.version ? (
                <span className="text-xs font-normal text-faint">{agent.version}</span>
              ) : null}
            </h2>
            <p className="flex flex-wrap items-center gap-2 text-xs">
              <span className={availability ? "text-danger" : "text-faint"}>
                {availability?.fullLabel ?? "已就绪"}
              </span>
              {badge ? (
                <span
                  data-testid="setup-auth-badge"
                  className={badge.tone === "ok" ? "text-faint" : "text-danger"}
                >
                  {badge.label}
                </span>
              ) : null}
            </p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label="关闭配置引导"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl text-muted hover:bg-raised hover:text-fg"
            onClick={closeWizard}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {step === "install" ? <InstallStep agent={agent} host={host} /> : null}
          {step === "credentials" ? <CredentialsStep agent={agent} host={host} /> : null}
          {step === "ready" ? (
            <ReadyStep
              agent={agent}
              onStart={() => {
                newSession(null, agent.id);
                closeWizard();
              }}
            />
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-3 text-xs text-muted">
          <span>命令会粘贴到上方终端，由你确认后执行。</span>
          <button
            type="button"
            data-testid="setup-recheck"
            className="ml-auto rounded border border-line px-2.5 py-1 hover:border-accent hover:text-fg"
            onClick={() => void refreshAgents()}
          >
            重新检测
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/** Step one: getting the binary onto the machine. */
function InstallStep({ agent, host }: { agent: AgentInfo; host: Host }) {
  const methods = installMethodsFor(agent);
  const [command, setCommand] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3" data-testid="setup-step-install">
      <p className="text-sm text-fg">先安装 {agent.label}。</p>
      {methods.length === 0 ? (
        <p className="text-xs text-muted">
          这台机器的系统没有已知的安装命令。
          {agent.setup?.docsUrl ? "请查看官方文档。" : ""}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {methods.map((method) => (
            <li
              key={method.label}
              className="flex flex-col gap-1 rounded-lg border border-line bg-raised/40 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-fg">{method.label}</span>
                <span className="ml-auto flex gap-1.5">
                  <button
                    type="button"
                    className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
                    onClick={() => void navigator.clipboard?.writeText(method.command)}
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    data-testid={`run-install-${method.label}`}
                    className="rounded bg-accent px-2 py-0.5 text-[11px] text-white"
                    onClick={() => setCommand(method.command)}
                  >
                    粘贴到终端
                  </button>
                </span>
              </div>
              <code className="select-all break-all font-mono text-[11px] text-muted">
                {method.command}
              </code>
            </li>
          ))}
        </ul>
      )}
      {agent.setup?.docsUrl ? (
        <DocsLink url={agent.setup.docsUrl} host={host} />
      ) : null}
      {command ? (
        <>
          <GuideTerminal command={command} />
          <p className="text-xs text-muted">
            命令已粘贴到终端，确认后按回车执行；装好后这里会自动继续。
          </p>
        </>
      ) : null}
    </div>
  );
}

/** Step two: sign-in and API key, the agent's own flows, side by side. */
function CredentialsStep({ agent, host }: { agent: AgentInfo; host: Host }) {
  const openAgentSetup = useWorkbench((state) => state.openAgentSetup);
  const newSession = useWorkbench((state) => state.newSession);
  const [command, setCommand] = useState<string | null>(null);
  const setup = agent.setup;
  const login = setup?.login;
  const apiKey = setup?.apiKey;
  const startable = canStartAgent(agent);

  return (
    <div className="flex flex-col gap-4" data-testid="setup-step-credentials">
      {login ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-fg">
            官方登录{agent.auth === "unauthenticated" ? "（推荐）" : ""}
          </h3>
          <p className="text-xs text-muted">{login.hint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="setup-login-run"
              className="rounded bg-accent px-3 py-1.5 text-xs text-white"
              onClick={() => setCommand(login.command)}
            >
              在内置终端中开始登录
            </button>
            {login.opensBrowser ? (
              <span className="text-[11px] text-faint">会在浏览器中完成，不用离开这里。</span>
            ) : null}
          </div>
        </section>
      ) : null}

      {apiKey?.kind === "builtinProvider" ? <BuiltinKeyForm hint={apiKey.hint} /> : null}

      {apiKey?.kind === "terminalCommand" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-fg">用 API Key</h3>
          <p className="text-xs text-muted">{apiKey.hint}</p>
          <div className="flex flex-wrap items-center gap-2">
            {apiKey.keyUrl ? (
              <button
                type="button"
                data-testid="setup-key-url"
                className="rounded border border-line px-3 py-1.5 text-xs hover:border-accent"
                onClick={() => host.openExternal(apiKey.keyUrl!)}
              >
                打开 Key 签发页
              </button>
            ) : null}
            {apiKey.command ? (
              <button
                type="button"
                data-testid="setup-apikey-run"
                className="rounded bg-accent px-3 py-1.5 text-xs text-white"
                onClick={() => setCommand(apiKey.command!)}
              >
                在内置终端中运行
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {apiKey?.kind === "environment" ? (
        <EnvKeySection agent={agent} host={host} onCommand={setCommand} />
      ) : null}

      {!login && !apiKey ? (
        <p className="text-xs text-muted">
          这个 Agent 的安装与登录方式请查阅它的官方文档；配置完成后点下方「重新检测」。
        </p>
      ) : null}

      {command ? <GuideTerminal command={command} /> : null}

      {setup?.docsUrl ? <DocsLink url={setup.docsUrl} host={host} /> : null}

      {/* Unknown auth can never flip the badge by itself (OpenCode and custom
          ACP agents publish no status to read), so this step offers the way
          out explicitly rather than keeping anyone here. */}
      {startable ? (
        <button
          type="button"
          data-testid="setup-start-anyway"
          className="self-start rounded border border-line px-3 py-1.5 text-xs text-fg hover:border-accent"
          onClick={() => {
            newSession(null, agent.id);
            openAgentSetup(null);
          }}
        >
          已配置好，开始任务
        </button>
      ) : null}
    </div>
  );
}

/**
 * The built-in agent's key form: the one credential GeneHub itself stores.
 * Same rule as the settings page — write-only, and the model list comes back
 * from the provider as the proof the key works.
 *
 * Exported for the first-run screen, where this same form is the fastest path
 * to a first task.
 */
export function BuiltinKeyForm({ hint }: { hint: string }) {
  const settings = useWorkbench((state) => state.settings);
  const loadSettings = useWorkbench((state) => state.loadSettings);
  const setProvider = useWorkbench((state) => state.setProvider);
  const client = useWorkbench((state) => state.client);
  const [providerId, setProviderId] = useState("deepseek");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (client && !settings) void loadSettings();
  }, [client, settings, loadSettings]);

  const provider = settings?.providers.find((entry) => entry.id === providerId);
  const configured = Boolean(provider?.hasApiKey);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-fg">模型密钥</h3>
      <p className="text-xs text-muted">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="provider"
          className="rounded border border-line bg-bg px-2 py-1.5 text-xs outline-none focus:border-accent"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
        >
          {OFFERED.map((offered) => (
            <option key={offered.id} value={offered.id}>
              {offered.label}
            </option>
          ))}
        </select>
        <input
          aria-label="API Key"
          type="password"
          className="min-w-40 flex-1 rounded border border-line bg-bg px-2 py-1.5 text-xs outline-none focus:border-accent"
          placeholder={configured ? "已配置，输入新值可替换" : "sk-…"}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <button
          type="button"
          data-testid="setup-save-key"
          className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
          disabled={busy || key.length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              await setProvider({ providerId, apiKey: key });
              setKey("");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
      {provider?.baseUrl ? (
        <p className="text-[11px] text-faint">密钥将发送至 {provider.baseUrl}</p>
      ) : null}
      {provider?.problem ? (
        <p role="alert" className="text-xs text-danger">
          {provider.problem}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The environment-variable path: last resort for CLIs whose key only arrives
 * that way. The commands are pasted and edited by the user; the restart note
 * is honest about why nothing changes until then.
 */
function EnvKeySection({
  agent,
  host,
  onCommand,
}: {
  agent: AgentInfo;
  host: Host;
  onCommand(command: string): void;
}) {
  const [restarting, setRestarting] = useState(false);
  const apiKey = agent.setup?.apiKey;
  if (!apiKey) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-fg">用环境变量（高级）</h3>
      <p className="text-xs text-muted">{apiKey.hint}</p>
      {apiKey.keyUrl ? (
        <button
          type="button"
          className="self-start rounded border border-line px-3 py-1.5 text-xs hover:border-accent"
          onClick={() => host.openExternal(apiKey.keyUrl!)}
        >
          打开 Key 签发页
        </button>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {apiKey.envVars.map((variable) => (
          <li
            key={variable.name}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised/40 px-3 py-2"
          >
            <code className="font-mono text-[11px] text-fg">{variable.name}</code>
            <span className="min-w-0 flex-1 text-[11px] text-muted">{variable.purpose}</span>
            <button
              type="button"
              data-testid={`setup-env-${variable.name}`}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
              onClick={() => onCommand(envCommand(variable.name, agent.platform))}
            >
              粘贴设置命令
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-faint">
        把「在此粘贴」替换成你的 Key 再回车。设置后需要重启才会对这里启动的 Agent 生效。
      </p>
      {host.retry ? (
        <button
          type="button"
          data-testid="setup-restart-daemon"
          disabled={restarting}
          className="self-start rounded border border-line px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
          onClick={() => {
            setRestarting(true);
            void host
              .retry?.()
              .finally(() => setRestarting(false));
          }}
        >
          {restarting ? "正在重启…" : "重启本机服务"}
        </button>
      ) : null}
    </section>
  );
}

/** Step three: verified, and one click from a conversation. */
function ReadyStep({ agent, onStart }: { agent: AgentInfo; onStart(): void }) {
  const startable = canStartAgent(agent);
  return (
    <div className="flex flex-col items-start gap-3" data-testid="setup-step-ready">
      {startable ? (
        <>
          <p className="text-sm text-fg">{agent.label} 已就绪。</p>
          <p className="text-xs text-muted">开一个会话，直接说你想做什么。</p>
          <button
            type="button"
            data-testid="setup-start"
            className="rounded-md bg-accent px-4 py-2 text-sm text-white"
            onClick={onStart}
          >
            开始任务
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-fg">还差一步。</p>
          <p className="text-xs text-muted">
            {agent.probe.state === "unavailable"
              ? agent.probe.reason
              : "Agent 已安装但还没有可用模型，请检查上面的配置步骤。"}
          </p>
        </>
      )}
    </div>
  );
}

function DocsLink({ url, host }: { url: string; host: Host }) {
  return (
    <button
      type="button"
      className="self-start text-xs text-muted underline decoration-dotted hover:text-accent"
      onClick={() => host.openExternal(url)}
    >
      查看官方文档
    </button>
  );
}
