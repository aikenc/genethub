import { useEffect, useRef, useState } from "react";
import type { HistoryCoverage } from "@genehub/proto";

import { ChangesPanel } from "./changes/ChangesPanel";
import { claimMachine, deviceName } from "./devices/claim";
import { DevicesPanel } from "./devices/DevicesPanel";
import { FilesPanel } from "./files/FilesPanel";
import { detectHost, type Endpoint, type Host } from "./host";
import type { Target } from "./host";
import { LogsPanel } from "./logs/LogsPanel";
import { PreviewFloat } from "./preview/PreviewFloat";
import { Client, type ProtocolDial } from "./protocol/client";
import { SettingsPanel } from "./settings/SettingsPanel";
import { readRtcEnabled } from "./settings/rtc";
import { Composer, type ComposerPhase } from "./session/Composer";
import { PermissionCard } from "./session/Permission";
import { TimelineView } from "./session/TimelineView";
import { defaultAgent, useWorkbench } from "./session/store";
import { Sidebar } from "./shell/Sidebar";
import { DesktopToolsDrawer } from "./shell/DesktopToolsDrawer";
import { MobileToolsDrawer } from "./shell/MobileToolsDrawer";
import { TabBar } from "./shell/TabBar";
import type { ExtraTab } from "./shell/tabs";
import { TitleBar } from "./shell/TitleBar";
import { useTheme } from "./theme/store";
import { TerminalPanel } from "./terminal/TerminalPanel";
import { UpdateToast } from "./updates/UpdateToast";
import { OpenProject } from "./workspace/OpenProject";
import { WorkspaceIcon } from "./workspace/WorkspaceIcon";

/**
 * Both defaults live out here, and they have to.
 *
 * A default written inline is a new value on every render, and both of these
 * are effect dependencies: the effect below would tear down its connection and
 * open another one every time anything changed, which React rightly treats as
 * a runaway loop and answers by rendering nothing at all.
 */
const openConnection = (
  endpoint: Endpoint,
  redial: () => Promise<string | ProtocolDial>,
) =>
  new Client({
    url: endpoint.url,
    redial,
    credential: endpoint.credential,
    channelCredential: endpoint.channelCredential,
    fabricRouteTicket: endpoint.fabricRouteTicket,
    localServerProof: endpoint.localServerProof,
    rtcEnabled: readRtcEnabled(),
  });

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
  mobileTools,
  desktopTools,
}: {
  host?: Host;
  /**
   * `redial` asks the shell where to connect *now*, and is used for retries.
   * Some addresses cannot be used twice — a forwarding ticket is spent by the
   * connection that used it — so a client that kept redialling the first one
   * would give up for good at the first dropped socket.
   */
  connect?: (
    endpoint: Endpoint,
    redial: () => Promise<string | ProtocolDial>,
  ) => Client;
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
  /** Product-specific actions shown with the workbench tools on phones. */
  mobileTools?: React.ReactNode;
  /** Product-specific actions shown with the workbench tools on desktop. */
  desktopTools?: React.ReactNode;
}) {
  const [endpoint, setEndpoint] = useState<Endpoint | null | "loading">(
    "loading",
  );
  // Null means "wherever the shell points by default", which on the desktop is
  // this computer and in a browser is the address it was opened with. It only
  // becomes an id when someone picks a *remote* machine, because from then on
  // the shell's default is the wrong answer and has to stop being consulted.
  const [target, setTarget] = useState<string | null>(null);
  // Decided during the first render, not in an effect. An effect would run
  // after the one below it has already resolved an endpoint, and the page
  // would connect uncredentialed while the pairing was still in flight.
  const [claiming, setClaiming] = useState<
    "idle" | "working" | { error: string }
  >(() => (host.pendingPairing?.() ? "working" : "idle"));
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(128);
  // Two different questions. `sessionsOpen` is the phone's drawer, which starts
  // shut because it covers the conversation; `sidebarHidden` is someone on a
  // desktop asking for the room back, which starts false because the left
  // column is how the workbench is read.
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const workbench = useWorkbench();
  const theme = useTheme((state) => state.resolved);
  const pairing = workbench.hub?.state === "pairing";
  const activeTab = workbench.tabs.find(
    (tab) => tab.id === workbench.activeTabId,
  );
  const session = workbench.sessions.find(
    (item) => item.id === workbench.activeSessionId,
  );
  // `activeTurn` is learned from the live `turnStarted` event and deliberately
  // is not part of a snapshot. The durable session status is: after leaving a
  // chat and coming back while either the built-in agent or a third-party
  // adapter is still working, the snapshot says `running` even though there is
  // no turn id to restore. Using the transient id here used to turn Stop back
  // into Send and made an in-flight turn look lost.
  const running =
    workbench.timeline.status === "running" || workbench.timeline.status === "waiting";
  // Three states, not two. Between pressing send and the daemon reporting a
  // turn there is nothing to interrupt — the agent process may still be
  // starting — so that gap gets its own non-interactive treatment rather than a
  // stop button that cannot work or a send button that only earns a refusal.
  // `activeTurn` is safe to consult here, unlike on its own, because it is only
  // asked about while this client is holding a message: a reconnect into a
  // running session has no pending message and still resolves to `running`.
  const pending = workbench.timeline.pending;
  const phase: ComposerPhase =
    pending && !pending.error && !workbench.timeline.activeTurn
      ? "sending"
      : running
        ? "running"
        : "idle";
  // A draft is a conversation with nothing in it yet, so the composer answers to
  // the choices held on the draft until there is a session to hold them.
  const draft = workbench.draft;
  const agentId = session?.agentId ?? draft?.agentId ?? null;
  const currentAgent = workbench.agents.find((agent) => agent.id === agentId);
  const importedReadOnly = session?.imported?.continuation === "readOnly";
  const composing = Boolean(workbench.activeSessionId || draft);
  const composerSpace = `calc(${composerHeight}px + var(--keyboard, 0px) + max(0.75rem, env(safe-area-inset-bottom)) + 0.5rem)`;

  // The frame the compositor paints while a window is being resized is the
  // shell's, not the page's, so it has to be told which palette is in force —
  // otherwise a dark edge chases the pointer around a light workbench.
  useEffect(() => {
    host.window?.setBackground(theme === "dark");
  }, [host, theme]);

  // Tabs stay warm while they are open, so the device limit is the memory and
  // connection budget. Keep that budget in one place and react when a window
  // crosses the phone/desktop breakpoint.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 768px)");
    const syncLimit = () => useWorkbench.getState().setTabLimit(media.matches ? 16 : 6);
    syncLimit();
    media.addEventListener?.("change", syncLimit);
    return () => media.removeEventListener?.("change", syncLimit);
  }, []);

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

  // Read inside the listener below rather than closed over, because
  // unsubscribing from the shell is not instant — Tauri's `unlisten` arrives a
  // promise later — and an announcement already in flight would otherwise land
  // after the user has moved to another machine.
  const following = useRef(true);
  following.current = target === null;

  useEffect(() => {
    if (claiming !== "idle") return;
    // A restarted daemon comes back on a new port, and following that is only
    // right while we are on the machine it belongs to. Someone working on a
    // remote machine must not be yanked home because the local daemon bounced.
    if (target !== null) return;
    const look = () =>
      void host.endpoint().then((found) => {
        if (following.current) setEndpoint(found);
      });
    look();
    return host.onEndpointChange?.(look);
  }, [host, claiming, target]);

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

  useEffect(
    () =>
      host.onUpdateRequested?.(() => {
        // Asked first and shown second, for the same reason as the claim link
        // above: arriving on settings with nothing happening reads as a menu item
        // that did nothing. Every outcome, including 已是最新, lands in the
        // version section.
        void useWorkbench.getState().checkUpdates(host);
        useWorkbench.getState().openTab("settings");
      }),
    [host],
  );

  useEffect(() => {
    if (claiming !== "idle") return;
    if (endpoint === "loading" || endpoint === null) return;
    const client = connect(endpoint, async () =>
      // Asking the target again rather than replaying the address: whoever
      // supplies a remote machine may be minting a one-time forwarding ticket,
      // and a client that reuses the first one gives up for good on the first
      // dropped socket.
      target !== null && host.openTarget
        ? dialOf(await host.openTarget(target))
        : dialOf((await host.endpoint()) ?? endpoint),
    );
    client.connect();
    void useWorkbench.getState().attach(client);
    return () => client.close();
  }, [endpoint, connect, host, target]);

  const pickTarget = (picked: Target, next: Endpoint) => {
    // The local machine goes back to following the shell, which is the only
    // thing that knows where its daemon moved to.
    setTarget(picked.kind === "local" ? null : picked.id);
    // Keeping the object when the address did not move, so that picking the
    // machine you are already on does not tear the connection down and build
    // an identical one.
    setEndpoint((current) =>
      current !== "loading" && current?.url === next.url ? current : next,
    );
  };

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
    <div className="flex h-full max-w-full flex-col overflow-x-hidden bg-bg">
      <TitleBar
        host={host}
        endpoint={endpoint}
        sidebarHidden={sidebarHidden}
        onToggleSidebar={() => setSidebarHidden((hidden) => !hidden)}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <Sidebar
          host={host}
          open={sessionsOpen}
          hidden={sidebarHidden}
          endpoint={endpoint}
          onPickTarget={pickTarget}
          onNavigate={() => setSessionsOpen(false)}
        />

        <MobileToolsDrawer
          open={toolsOpen}
          extraTabs={extraTabs}
          onNavigate={() => setToolsOpen(false)}
        >
          {mobileTools}
        </MobileToolsDrawer>

        <DesktopToolsDrawer
          open={toolsOpen}
          extraTabs={extraTabs}
          onNavigate={() => setToolsOpen(false)}
        >
          {desktopTools}
        </DesktopToolsDrawer>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The phone's only permanent chrome. Three things, each a full
              44px target: where am I, how do I get to the list, how do I
              start something new. Everything else — the connection, the
              project, the panels — reads as noise at this width and lives in
              the drawer, which is one tap away. */}
          <header
            className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-1 md:hidden"
            style={{ paddingTop: "env(safe-area-inset-top)" }}
          >
            <button
              type="button"
              aria-label="会话列表"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-lg text-muted active:bg-raised"
              onClick={() => setSessionsOpen((open) => !open)}
            >
              <span aria-hidden>☰</span>
            </button>
            <span className="min-w-0 flex-1 truncate text-center text-sm font-medium text-fg">
              {session?.title ?? (draft ? "新会话" : "工作台")}
            </span>
            {/* Only when it is not what it should be. A green tick on every
                screen is one more thing to read past, and this bar has room
                for exactly three things — but a phone that has quietly lost
                the machine must say so, because nothing else here would. */}
            {workbench.connection === "ready" ? null : (
              <span
                role="status"
                className={`shrink-0 text-[11px] ${
                  workbench.connection === "closed" ? "text-danger" : "text-accent-bright"
                }`}
                title={endpoint.label}
              >
                {workbench.connection === "closed" ? "已断开" : "连接中…"}
              </span>
            )}
            <button
              type="button"
              aria-label="工作区工具"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl text-muted active:bg-raised"
              onClick={() => {
                setSessionsOpen(false);
                setToolsOpen((open) => !open);
              }}
            >
              <span aria-hidden>•••</span>
            </button>
          </header>

          <TabBar onOpenTools={() => setToolsOpen(true)} />

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
          {session?.imported ? (
            <div className="shrink-0 border-b border-line bg-raised px-3 py-1.5 text-xs text-muted">
              <span>
                已从 {session.imported.agentId} 导入 · {session.imported.continuation === "native" ? "可继续对话" : "只读历史"}
              </span>
              {session.imported.warnings.map((warning) => (
                <span key={warning} className="ml-2 text-faint">
                  {warning}
                </span>
              ))}
              {session.imported.coverage ? (
                <span className="ml-2 text-faint">
                  {importCoverageLabel(session.imported.coverage)}
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1">
            <section className="relative flex min-w-0 flex-1 flex-col">
              {showChat ? (
                composing ? (
                  <>
                    <div className="hidden items-center justify-end border-b border-line px-3 py-1 md:flex">
                      <ConnectionBadge
                        state={workbench.connection}
                        endpoint={endpoint}
                      />
                    </div>
                    <div
                      className="min-h-0 flex-1 overflow-hidden"
                      style={{ paddingBottom: composerSpace }}
                    >
                      <TimelineView state={workbench.timeline} />
                    </div>
                    {workbench.timeline.pendingPermission ? (
                      <div
                        className="absolute inset-x-0 z-20 px-4"
                        style={{ bottom: composerSpace }}
                      >
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
                      phase={phase}
                      disabled={importedReadOnly}
                      disabledReason={
                        importedReadOnly
                          ? "这是只读导入历史：原 Agent 没有提供可恢复会话。"
                          : undefined
                      }
                      agents={workbench.agents}
                      agentId={agentId}
                      modelId={workbench.timeline.modelId ?? draft?.modelId ?? null}
                      modeId={workbench.timeline.modeId ?? draft?.modeId ?? null}
                      effortId={
                        workbench.timeline.effortId ?? draft?.effortId ?? null
                      }
                      // A message in flight locks the Agent too: switching would
                      // open a new conversation and abandon it.
                      agentLocked={
                        workbench.timeline.items.length > 0 || Boolean(pending)
                      }
                      attachmentsSupported={
                        currentAgent?.capabilities.attachments ?? false
                      }
                      commands={currentAgent?.catalog.commands}
                      restoreDraft={workbench.restoreDraft}
                      onRestoreDraft={workbench.restoredDraft}
                      onHeightChange={setComposerHeight}
                      onSend={(text, attachments) =>
                        void workbench.send(text, attachments)
                      }
                      onInterrupt={() => void workbench.interrupt()}
                      // Switching agent opens an empty conversation rather than
                      // handing this one over: no adapter can pick up another's
                      // history (`ComposerControls` on why the chip locks once
                      // anything has been said). Nothing is written until that
                      // conversation is used.
                      onPickAgent={(id) => workbench.newSession(null, id)}
                      onPickModel={(id) => void workbench.setModel(id)}
                      onPickMode={(id) => void workbench.setMode(id)}
                      onPickEffort={(id) => void workbench.setEffort(id)}
                    />
                  </>
                ) : (
                  <FirstRun
                    host={host}
                    endpoint={endpoint}
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

      {/* Outside every tab, because a finished download is not about whichever
          panel happens to be open. */}
      <UpdateToast host={host} />
      {workbench.previewFloat ? (
        <PreviewFloat
          source={workbench.previewFloat}
          host={host}
          onClose={() => workbench.closePreviewFloat()}
        />
      ) : null}
    </div>
  );
}

function importCoverageLabel(coverage: HistoryCoverage): string {
  if (coverage.omittedItemCount === 0) {
    return `历史完整（${coverage.retainedItemCount} 条）`;
  }
  const source = coverage.sourceItemCount ?? coverage.retainedItemCount + coverage.omittedItemCount;
  const recovery = {
    genehub: "可在 GeneHub 继续检索",
    external: "需从原 Agent 继续检索",
    nativeOnly: "仅原 Agent 原生会话可找回",
    unavailable: "省略部分不可找回",
  }[coverage.retrieval];
  return `保留 ${coverage.retainedItemCount}/${source} 条，省略 ${coverage.omittedItemCount} 条 · ${recovery}`;
}

function dialOf(endpoint: Endpoint): ProtocolDial {
  return {
    url: endpoint.url,
    ...(endpoint.channelCredential
      ? { channelCredential: endpoint.channelCredential }
      : {}),
    ...(endpoint.fabricRouteTicket
      ? { fabricRouteTicket: endpoint.fabricRouteTicket }
      : {}),
    ...(endpoint.localServerProof
      ? { localServerProof: endpoint.localServerProof }
      : {}),
  };
}

/**
 * What a new install shows instead of a workbench with everything greyed out.
 */
function FirstRun({
  host,
  endpoint,
  onOpenSettings,
}: {
  host: Host;
  endpoint: Endpoint;
  onOpenSettings(): void;
}) {
  const {
    workspaces,
    activeWorkspaceId,
    agents,
    newSession,
    connection,
    client,
  } = useWorkbench();
  const workspace =
    workspaces.find((entry) => entry.id === activeWorkspaceId) ?? workspaces[0];
  const agent = defaultAgent(agents);

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
        <OpenProject host={host} endpoint={endpoint} />
      </Splash>
    );
  }

  if (!agent) {
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
      <p className="flex items-center gap-1.5 text-sm">
        <WorkspaceIcon workspace={workspace} />
        <span>{workspace.name} 已就绪。</span>
      </p>
      <p className="mb-3 text-xs text-muted">开一个会话，直接说你想做什么。</p>
      <button
        type="button"
        className="min-h-11 rounded-xl bg-accent px-4 text-sm text-white md:min-h-0 md:rounded-md md:px-3 md:py-1.5 md:text-xs"
        onClick={() => newSession(workspace.id, agent.id)}
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
          ? "已停用的局域网连接"
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
