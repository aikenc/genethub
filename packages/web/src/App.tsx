import { useEffect, useState } from "react";

import { ChangesPanel } from "./changes/ChangesPanel";
import { claimMachine, deviceName } from "./devices/claim";
import { DevicesPanel } from "./devices/DevicesPanel";
import { FilesPanel } from "./files/FilesPanel";
import { detectHost, type Endpoint, type Host } from "./host";
import { LogsPanel } from "./logs/LogsPanel";
import { Client } from "./protocol/client";
import { SettingsPanel } from "./settings/SettingsPanel";
import { Composer } from "./session/Composer";
import { PermissionCard } from "./session/Permission";
import { TimelineView } from "./session/TimelineView";
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
const openConnection = (endpoint: Endpoint, redial: () => Promise<string>) =>
  new Client({ url: endpoint.url, redial, credential: endpoint.credential });

/**
 * The workbench shell: left session tree, closable tabs, chat in the middle,
 * Changes/Files optionally docked on the right. Chat stays open while the
 * right panel is used — looking at a diff must not hide the conversation.
 */
export function App({
  host = detectHost(),
  connect = openConnection,
  extraTabs = [],
  claim = claimMachine,
  welcome,
}: {
  host?: Host;
  /**
   * `redial` asks the shell where to connect *now*, and is used for retries.
   * Some addresses cannot be used twice — a forwarding ticket is spent by the
   * connection that used it — so a client that kept redialling the first one
   * would give up for good at the first dropped socket.
   */
  connect?: (endpoint: Endpoint, redial: () => Promise<string>) => Client;
  /**
   * Pages contributed by whoever embedded this package. Passing none is the
   * plain workbench, which is exactly what a self-hosted deployment wants.
   */
  extraTabs?: ExtraTab[];
  claim?: typeof claimMachine;
  /**
   * What to show when this browser knows of no machine yet. A deployment that
   * can offer a way out of that — sign in, start something — puts it here.
   * Without it the page can only say what happened, which is all a self-hosted
   * copy honestly can say: someone has to pair a machine first.
   */
  welcome?: () => React.ReactNode;
}) {
  const [endpoint, setEndpoint] = useState<Endpoint | null | "loading">(
    "loading",
  );
  // Decided during the first render, not in an effect. An effect would run
  // after the one below it has already resolved an endpoint, and the page
  // would connect uncredentialed while the pairing was still in flight.
  const [claiming, setClaiming] = useState<
    "idle" | "working" | { error: string }
  >(() => (host.pendingPairing?.() ? "working" : "idle"));
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const workbench = useWorkbench();
  const pairing = workbench.hub?.state === "pairing";
  const activeTab = workbench.tabs.find(
    (tab) => tab.id === workbench.activeTabId,
  );
  const session = workbench.sessions.find(
    (item) => item.id === workbench.activeSessionId,
  );
  const running = workbench.timeline.activeTurn !== null;
  const currentAgent = workbench.agents.find(
    (agent) => agent.id === session?.agentId,
  );

  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(
      () => void useWorkbench.getState().refreshHub(),
      2000,
    );
    return () => clearInterval(timer);
  }, [pairing]);

  // Redeeming a pairing link happens before anything else and instead of
  // connecting: the invite is one-time, and the credential it returns is what
  // the connection will need a moment later.
  useEffect(() => {
    const invite = host.pendingPairing?.();
    if (!invite) return;
    let cancelled = false;
    void claim(invite.endpoint, invite.code, deviceName())
      .then((machine) => {
        if (cancelled) return;
        host.rememberPairing?.(machine);
        setClaiming("idle");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setClaiming({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [host, claim]);

  useEffect(() => {
    if (claiming !== "idle") return;
    const look = () => void host.endpoint().then(setEndpoint);
    look();
    return host.onEndpointChange?.(look);
  }, [host, claiming]);

  useEffect(
    () =>
      host.onPairRequested?.(() => useWorkbench.getState().openTab("settings")),
    [host],
  );

  useEffect(
    () =>
      host.onClaimRequested?.(() => {
        // Minted first, shown second: the tray asks for this when someone has
        // lost their way in, and landing on settings with nothing new on it
        // would look like the menu item did nothing. A machine that was never
        // connected to a Hub has no identity to hand out, and saying that is the
        // difference between a menu item that failed and one that is broken.
        void useWorkbench
          .getState()
          .claimLink()
          .catch((error: unknown) =>
            useWorkbench.setState({
              notice: error instanceof Error ? error.message : String(error),
            }),
          );
        useWorkbench.getState().openTab("settings");
      }),
    [host],
  );

  useEffect(() => {
    if (claiming !== "idle") return;
    if (endpoint === "loading" || endpoint === null) return;
    const client = connect(
      endpoint,
      async () => (await host.endpoint())?.url ?? endpoint.url,
    );
    client.connect();
    void useWorkbench.getState().attach(client);
    return () => client.close();
  }, [endpoint, connect, host]);

  if (claiming === "working") return <Splash>正在和这台机器配对…</Splash>;
  if (claiming !== "idle") {
    return (
      <Splash>
        <p>配对没有完成。</p>
        <p className="text-muted">{claiming.error}</p>
        <p className="text-xs text-faint">
          配对链接只能用一次，请在那台机器上重新生成一个。
        </p>
      </Splash>
    );
  }
  if (endpoint === "loading") return <Splash>正在查找这台机器…</Splash>;
  if (!endpoint) {
    if (welcome) return <>{welcome()}</>;
    // Inside the desktop app there is nothing for the user to choose: this
    // machine is the machine, and its absence means the daemon did not start.
    // Telling someone to "点桌面端「连接」" while they are looking at the
    // desktop app is how a broken install reads as a missing step.
    if (host.kind === "desktop") return <DaemonTrouble host={host} />;
    return (
      <Splash>
        <p>没有可连接的机器。</p>
        <p className="text-muted">
          在桌面端点「连接」，或者从「我的机器」页面打开工作台。
        </p>
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
          <span className="truncate text-xs text-muted">
            {session?.title ?? "工作台"}
          </span>
          <ConnectionBadge state={workbench.connection} endpoint={endpoint} />
        </div>

        <TabBar />

        {workbench.notice ? (
          <p
            role="alert"
            className="flex shrink-0 items-center gap-2 border-b border-line bg-raised px-3 py-1.5 text-xs text-danger"
          >
            <span className="min-w-0 flex-1">{workbench.notice}</span>
            {/* Every error gets a way to the log. What a failure can say in one
                line is rarely the whole story, and the rest is already written
                down — it was just somewhere nobody could reach. */}
            <button
              type="button"
              className="shrink-0 underline decoration-dotted hover:text-fg"
              onClick={() => workbench.openTab("logs")}
            >
              查看日志
            </button>
          </p>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <section className="relative flex min-w-0 flex-1 flex-col">
            {showChat ? (
              workbench.activeSessionId ? (
                <>
                  <div className="hidden items-center justify-end border-b border-line px-3 py-1 md:flex">
                    <ConnectionBadge
                      state={workbench.connection}
                      endpoint={endpoint}
                    />
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden pb-28">
                    <TimelineView state={workbench.timeline} />
                  </div>
                  {workbench.timeline.pendingPermission ? (
                    <div className="absolute inset-x-0 bottom-28 z-20 px-4">
                      <div className="mx-auto max-w-chat">
                        <PermissionCard
                          request={workbench.timeline.pendingPermission}
                          onAnswer={(outcome) =>
                            void workbench.answerPermission(outcome)
                          }
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
                    attachmentsSupported={
                      currentAgent?.capabilities.attachments ?? false
                    }
                    commands={currentAgent?.catalog.commands}
                    onSend={(text, attachments) =>
                      void workbench.send(text, attachments)
                    }
                    onInterrupt={() => void workbench.interrupt()}
                    onPickAgent={(id) => {
                      const workspace =
                        workbench.activeWorkspaceId ??
                        workbench.workspaces[0]?.id;
                      if (workspace)
                        void workbench.createSession(workspace, id);
                    }}
                    onPickModel={(id) => void workbench.setModel(id)}
                    onPickMode={(id) => void workbench.setMode(id)}
                  />
                </>
              ) : (
                <FirstRun
                  host={host}
                  onOpenSettings={() => workbench.openTab("settings")}
                />
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
            {kind === "logs" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <LogsPanel onOpenDirectory={host.openLogs} />
              </div>
            ) : null}
            {kind === "devices" ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <DevicesPanel host={host} />
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
                {workbench.rightPanel === "changes" ? (
                  <ChangesPanel />
                ) : (
                  <FilesPanel />
                )}
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
function FirstRun({
  host,
  onOpenSettings,
}: {
  host: Host;
  onOpenSettings(): void;
}) {
  const {
    workspaces,
    activeWorkspaceId,
    agents,
    createSession,
    connection,
    client,
  } = useWorkbench();
  const workspace =
    workspaces.find((entry) => entry.id === activeWorkspaceId) ?? workspaces[0];
  const builtin = agents.find((agent) => agent.builtin) ?? agents[0];
  const usable =
    builtin &&
    builtin.probe.state === "ready" &&
    builtin.catalog.models.length > 0;

  // An empty catalog while the socket is still coming up (or already dead) is
  // not "no project" — saying that sends people hunting for a folder when the
  // real problem is they never reached the machine.
  if (connection !== "ready") {
    // A refused handshake carries its own reason, and it is never "check the
    // port": the credential was revoked, or the two sides are different
    // versions. Showing the generic advice then sends people to fix the one
    // thing that is already working.
    const refused = connection === "closed" ? client?.failure : null;
    return (
      <Splash>
        <p className="text-sm">
          {connection === "closed" ? "连不上这台机器。" : "正在连这台机器…"}
        </p>
        <p className="mb-3 text-xs text-muted">
          {refused
            ? refused.message
            : connection === "closed"
              ? "确认地址里的端口能从你这边通到 daemon，或者改用和页面同一个端口的代理地址。"
              : "连上之后会直接进到一个会话。"}
        </p>
        {refused?.code === "unauthorized" ? (
          <p className="text-xs text-faint">
            这台机器可能已经把这个设备撤销了。到「设备」页把它忘掉，再重新配对一次。
          </p>
        ) : null}
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
        <p className="mb-3 text-xs text-muted">
          密钥只保存在这台机器上，填好之后这里会直接可用。
        </p>
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

function ConnectionBadge({
  state,
  endpoint,
}: {
  state: string;
  endpoint: Endpoint;
}) {
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

/**
 * The desktop app when its daemon is not there.
 *
 * Everything this app does runs through that process, so this screen is the
 * whole product being down. It says what went wrong in the shell's own words —
 * a path, a port, a permission — because the person reading it is the only one
 * who can see that machine.
 */
function DaemonTrouble({ host }: { host: Host }) {
  const [why, setWhy] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    void host.problem?.().then(setWhy);
  }, [host]);

  return (
    <Splash>
      <p>本机的 daemon 没有起来。</p>
      {why ? (
        <p className="max-w-lg text-xs text-muted [overflow-wrap:anywhere]">{why}</p>
      ) : null}
      <div className="mt-2 flex gap-2">
        {host.retry ? (
          <button
            type="button"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void host
                .retry?.()
                .then(() => host.problem?.().then(setWhy))
                .finally(() => setRetrying(false));
            }}
            className="rounded-md border border-line px-3 py-1.5 text-xs text-fg hover:border-accent disabled:opacity-50"
          >
            {retrying ? "正在重启…" : "重试"}
          </button>
        ) : null}
        {/* The one screen where the workbench cannot fetch a log for you: there
            is no daemon to ask. Opening the directory is the only way left, and
            this is the screen where someone most needs it. */}
        {host.openLogs ? (
          <button
            type="button"
            onClick={() => host.openLogs?.()}
            className="rounded-md border border-line px-3 py-1.5 text-xs text-fg hover:border-accent"
          >
            打开日志目录
          </button>
        ) : null}
      </div>
      <p className="pt-2 text-xs text-faint">
        重启这个 App 也可以。一直是这样的话，日志目录里的 shell.log 与 daemon.log 说得出原因。
      </p>
    </Splash>
  );
}
