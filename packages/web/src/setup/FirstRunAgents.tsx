import { resolveAgentAvailability } from "../presentation/catalog/resolve";
import { useWorkbench } from "../session/store";
import { BuiltinKeyForm } from "./AgentSetupWizard";

/**
 * The first-run screen when no agent can start yet: three ways out, instead
 * of one button that sends a new user to a settings form with no context.
 *
 * 1. The built-in agent with a provider key — the fastest path, inline here.
 * 2. A third-party CLI, installed or signed in through its own guided flow.
 * 3. Looking around first, which is the settings page: every agent row there
 *    opens the same wizard.
 */
export function FirstRunAgents() {
  const agents = useWorkbench((state) => state.agents);
  const openAgentSetup = useWorkbench((state) => state.openAgentSetup);
  const openTab = useWorkbench((state) => state.openTab);
  const builtin = agents.find((agent) => agent.builtin);
  const others = agents.filter((agent) => !agent.builtin);

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto p-6">
      <div className="m-auto flex w-full max-w-lg flex-col gap-3">
        <div className="mb-1 text-center">
          <p className="text-sm text-fg">先让一个 Agent 跑起来。</p>
          <p className="mt-1 text-xs text-muted">任选一种方式，之后随时可以改。</p>
        </div>

        {builtin ? (
          <section
            data-testid="first-run-builtin"
            className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3"
          >
            <h3 className="text-sm font-medium text-fg">内置 Agent（最简单）</h3>
            <BuiltinKeyForm hint="填一个模型密钥就能开始；密钥只保存在这台机器上。" />
          </section>
        ) : null}

        <section
          data-testid="first-run-third-party"
          className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3"
        >
          <h3 className="text-sm font-medium text-fg">用我已有的 Agent</h3>
          <p className="text-xs text-muted">
            Claude Code、Codex 等命令行 Agent；没装的也可以跟着引导装。
          </p>
          <ul className="flex flex-col gap-1">
            {others.map((agent) => {
              const availability = resolveAgentAvailability(agent);
              return (
                <li key={agent.id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-fg">{agent.label}</span>
                  <span
                    className={`shrink-0 text-xs ${availability ? "text-muted" : "text-faint"}`}
                  >
                    {availability?.fullLabel ?? "已就绪"}
                  </span>
                  <button
                    type="button"
                    data-testid={`first-run-setup-${agent.id}`}
                    className="shrink-0 rounded border border-line px-2.5 py-1 text-xs hover:border-accent"
                    onClick={() => openAgentSetup(agent.id)}
                  >
                    {agent.probe.state === "notInstalled" ? "安装" : "配置"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <button
          type="button"
          data-testid="first-run-browse"
          className="self-center rounded px-3 py-1.5 text-xs text-muted underline decoration-dotted hover:text-fg"
          onClick={() => openTab("settings")}
        >
          先自己看看
        </button>
      </div>
    </div>
  );
}
