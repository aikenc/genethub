import { useEffect, useState } from "react";

import { ChangesPanel } from "./changes/ChangesPanel";
import { FilesPanel } from "./files/FilesPanel";
import { detectHost, type Endpoint, type Host } from "./host";
import { Client } from "./protocol/client";
import { SettingsPanel } from "./settings/SettingsPanel";
import { Composer } from "./session/Composer";
import { PermissionCard } from "./session/Permission";
import { Timeline } from "./session/Timeline";
import { useWorkbench } from "./session/store";
import { Sidebar } from "./shell/Sidebar";
import { TabBar } from "./shell/TabBar";
import type { ExtraTab } from "./shell/tabs";
import { TerminalPanel } from "./terminal/TerminalPanel";
import { OpenProject } from "./workspace/OpenProject";

/**
 * Both defaults live out here, and they have to.
 *
 * A default written inline is a new value on every render, and both of these
 * are effect dependencies: the effect below would tear down its connection and
 * open another one every time anything changed, which React rightly treats as
 * a runaway loop and answers by rendering nothing at all.
 */
const openConnection = (endpoint: Endpoint) => new Client({ url: endpoint.url });

/**
 * The workbench shell: left session tree, closable tabs, chat in the middle,
 * Changes/Files optionally docked on the right. Chat stays open while the
 * right panel is used — looking at a diff must not hide the conversation.
 */
export function App({
  host = detectHost(),
  connect = openConnection,
  extraTabs = [],
}: {
  host?: Host;
  connect?: (endpoint: Endpoint) => Client;
  /**
   * Pages contributed by whoever embedded this package. Passing none is the
   * plain workbench, which is exactly what a self-hosted deployment wants.
   */
  extraTabs?: ExtraTab[];
}) {
  const [endpoint, setEndpoint] = useState<Endpoint | null | "loading">("loading");
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const workbench = useWorkbench();
  const pairing = workbench.hub?.state === "pairing";
  const activeTab = workbench.tabs.find((tab) => tab.id === workbench.activeTabId);
  const session = workbench.sessions.find((item) => item.id === workbench.activeSessionId);
  const running = workbench.timeline.activeTurn !== null;
  const currentAgent = workbench.agents.find((agent) => agent.id === session?.agentId);

  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => void useWorkbench.getState().refreshHub(), 2000);
    return () => clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    const look = () => void host.endpoint().then(setEndpoint);
    look();
    return host.onEndpointChange?.(look);
  }, [host]);

  useEffect(() => host.onPairRequested?.(() => useWorkbench.getState().openTab("settings")), [host]);

  useEffect(() => {
    if (endpoint === "loading" || endpoint === null) return;
    const client = connect(endpoint);
    client.connect();
    void useWorkbench.getState().attach(client);
    return () => client.close();
  }, [endpoint, connect]);

  if (endpoint === "loading") return <Splash>正在查找这台机器…</Splash>;
  if (!endpoint) {
    return (
      <Splash>
        <p>没有可连接的机器。</p>
        <p className="text-muted">在桌面端点「连接」，或者从「我的机器」页面打开工作台。</p>
      </Splash>
    );
  }

  const showChat = !activeTab || activeTab.kind === "chat";
  const kind = activeTab?.kind ?? "chat";

  return (
    <div className="flex h-full flex-col bg-bg md:flex-row">
      <Sidebar
        host={host}
        open={sessionsOpen}
        extraTabs={extraTabs}
        onNavigate={() => setSessionsOpen(false)}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-surface px-2 md:hidden">
          <button
            type="button"
            aria-label="会话列表"
            className="rounded px-2 py-2 text-xs text-muted"
            onClick={() => setSessionsOpen((open) => !open)}
          >
            ☰
          </button>
          <span className="truncate text-xs text-muted">{session?.title ?? "工作台"}</span>
          <ConnectionBadge state={workbench.connection} endpoint={endpoint} />
        </div>

        <TabBar />

        {workbench.notice ? (
          <p
            role="alert"
            className="shrink-0 border-b border-line bg-raised px-3 py-1.5 text-xs text-danger"
          >
            {workbench.notice}
          </p>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <section className="relative flex min-w-0 flex-1 flex-col">
            {showChat ? (
              workbench.activeSessionId ? (
                <>
                  <div className="hidden items-center justify-end border-b border-line px-3 py-1 md:flex">
                    <ConnectionBadge state={workbench.connection} endpoint={endpoint} />
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden pb-28">
                    <Timeline state={workbench.timeline} />
                  </div>
                  {workbench.timeline.pendingPermission ? (
                    <div className="absolute inset-x-0 bottom-28 z-20 px-4">
                      <div className="mx-auto max-w-chat">
                        <PermissionCard
                          request={workbench.timeline.pendingPermission}
                          onAnswer={(outcome) => void workbench.answerPermission(outcome)}
                        />
                      </div>
                    </div>
                  ) : null}
                  <Composer
                    running={running}
                    disabled={!workbench.activeSessionId}
                    agents={workbench.agents}
                    agentId={session?.agentId ?? null}
                    modelId={workbench.timeline.modelId}
                    modeId={workbench.timeline.modeId}
                    agentLocked={workbench.timeline.items.length > 0}
                    attachmentsSupported={currentAgent?.capabilities.attachments ?? false}
                    onSend={(text, attachments) => void workbench.send(text, attachments)}
                    onInterrupt={() => void workbench.interrupt()}
                    onPickAgent={(id) => {
                      const workspace =
                        workbench.activeWorkspaceId ?? workbench.workspaces[0]?.id;
                      if (workspace) void workbench.createSession(workspace, id);
                    }}
                    onPickModel={(id) => void workbench.setModel(id)}
                    onPickMode={(id) => void workbench.setMode(id)}
                  />
                </>
              ) : (
                <FirstRun host={host} onOpenSettings={() => workbench.openTab("settings")} />
              )
            ) : null}

            {kind === "files" ? (
              <div className="min-h-0 flex-1">
                <FilesPanel />
              </div>
            ) : null}
            {kind === "terminal" ? (
              <div className="min-h-0 flex-1">
                <TerminalPanel />
              </div>
            ) : null}
            {kind === "settings" ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SettingsPanel host={host} endpoint={endpoint} />
              </div>
            ) : null}
            {extraTabs.map((tab) =>
              kind === `extra:${tab.id}` ? (
                <div key={tab.id} className="min-h-0 flex-1 overflow-y-auto">
                  {tab.render()}
                </div>
              ) : null,
            )}
          </section>

          {workbench.rightPanel ? (
            <aside className="hidden w-[22rem] shrink-0 flex-col border-l border-line bg-surface md:flex lg:w-[26rem]">
              <div className="flex h-9 items-center justify-between border-b border-line px-3">
                <span className="text-xs text-muted">
                  {workbench.rightPanel === "changes" ? "Changes" : "Files"}
                </span>
                <button
                  type="button"
                  aria-label="关闭侧栏"
                  className="rounded px-1.5 text-faint hover:bg-raised hover:text-fg"
                  onClick={() => workbench.setRightPanel(null)}
                >
                  ×
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {workbench.rightPanel === "changes" ? <ChangesPanel /> : <FilesPanel />}
              </div>
            </aside>
          ) : null}
        </div>
      </main>
    </div>
  );
}

/**
 * What a new install shows instead of a workbench with everything greyed out.
 */
function FirstRun({ host, onOpenSettings }: { host: Host; onOpenSettings(): void }) {
  const { workspaces, activeWorkspaceId, agents, createSession, connection } = useWorkbench();
  const workspace = workspaces.find((entry) => entry.id === activeWorkspaceId) ?? workspaces[0];
  const builtin = agents.find((agent) => agent.builtin) ?? agents[0];
  const usable = builtin && builtin.probe.state === "ready" && builtin.catalog.models.length > 0;

  // An empty catalog while the socket is still coming up (or already dead) is
  // not "no project" — saying that sends people hunting for a folder when the
  // real problem is they never reached the machine.
  if (connection !== "ready") {
    return (
      <Splash>
        <p className="text-sm">{connection === "closed" ? "连不上这台机器。" : "正在连这台机器…"}</p>
        <p className="mb-3 text-xs text-muted">
          {connection === "closed"
            ? "确认地址里的端口能从你这边通到 daemon，或者改用和页面同一个端口的代理地址。"
            : "连上之后会直接进到一个会话。"}
        </p>
      </Splash>
    );
  }

  if (!workspace) {
    return (
      <Splash>
        <p className="text-sm">先打开一个项目文件夹。</p>
        <p className="mb-3 text-xs text-muted">
          agent 只能在你打开的目录里读写，这一步同时决定了它的活动范围。
        </p>
        <OpenProject host={host} />
      </Splash>
    );
  }

  if (!usable) {
    return (
      <Splash>
        <p className="text-sm">还差一个模型密钥。</p>
        <p className="mb-3 text-xs text-muted">密钥只保存在这台机器上，填好之后这里会直接可用。</p>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-xs text-white"
          onClick={onOpenSettings}
        >
          去填密钥
        </button>
      </Splash>
    );
  }

  return (
    <Splash>
      <p className="text-sm">{workspace.name} 已就绪。</p>
      <p className="mb-3 text-xs text-muted">开一个会话，直接说你想做什么。</p>
      <button
        type="button"
        className="rounded-md bg-accent px-3 py-1.5 text-xs text-white"
        onClick={() => builtin && void createSession(workspace.id, builtin.id)}
      >
        新建会话
      </button>
    </Splash>
  );
}

function ConnectionBadge({ state, endpoint }: { state: string; endpoint: Endpoint }) {
  const label =
    state === "ready"
      ? endpoint.via === "loopback"
        ? "本机"
        : endpoint.via === "lan"
          ? "局域网"
          : "中转"
      : state === "reconnecting"
        ? "重连中"
        : state === "closed"
          ? "已断开"
          : "连接中";

  return (
    <span className="ml-auto truncate text-[11px] text-faint" role="status">
      {label} · {endpoint.label}
    </span>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
      {children}
    </div>
  );
}
