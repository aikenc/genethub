import { useEffect, useState } from "react";

import { ChangesPanel } from "./changes/ChangesPanel";
import { FilesPanel } from "./files/FilesPanel";
import { detectHost, type Endpoint, type Host } from "./host";
import { Client } from "./protocol/client";
import { SettingsPanel } from "./settings/SettingsPanel";
import { AgentControls } from "./session/AgentControls";
import { Composer } from "./session/Composer";
import { PermissionCard } from "./session/Permission";
import { Timeline } from "./session/Timeline";
import { useWorkbench } from "./session/store";
import { TerminalPanel } from "./terminal/TerminalPanel";
import { OpenProject } from "./workspace/OpenProject";

const PANELS = [
  { id: "chat", label: "会话" },
  { id: "files", label: "文件" },
  { id: "changes", label: "变更" },
  { id: "terminal", label: "终端" },
  { id: "settings", label: "设置" },
] as const;

type PanelId = (typeof PANELS)[number]["id"];

/**
 * Both defaults live out here, and they have to.
 *
 * A default written inline is a new value on every render, and both of these
 * are effect dependencies: the effect below would tear down its connection and
 * open another one every time anything changed, which React rightly treats as
 * a runaway loop and answers by rendering nothing at all.
 */
const openConnection = (endpoint: Endpoint) => new Client({ url: endpoint.url });

export function App({
  host = detectHost(),
  // Injected by tests so they can drive the workbench without a real socket.
  connect = openConnection,
}: {
  host?: Host;
  connect?: (endpoint: Endpoint) => Client;
}) {
  const [endpoint, setEndpoint] = useState<Endpoint | null | "loading">("loading");
  const [panel, setPanel] = useState<PanelId>("chat");
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const workbench = useWorkbench();
  const pairing = workbench.hub?.state === "pairing";

  // While a code is on screen, approval happens somewhere else entirely, so the
  // only way to learn it succeeded is to ask. Reading the action off the store
  // rather than the render keeps the timer from being reset by every unrelated
  // update — including the ones this poll itself causes.
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => void useWorkbench.getState().refreshHub(), 2000);
    return () => clearInterval(timer);
  }, [pairing]);

  // The endpoint is asked for again whenever the shell says it moved, which is
  // what a daemon restart looks like from here: same machine, new address.
  useEffect(() => {
    const look = () => void host.endpoint().then(setEndpoint);
    look();
    return host.onEndpointChange?.(look);
  }, [host]);

  // The tray's "connect to Hub" has to land somewhere; without this it emitted
  // into a window that was not listening.
  useEffect(() => host.onPairRequested?.(() => setPanel("settings")), [host]);

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

  const session = workbench.sessions.find((item) => item.id === workbench.activeSessionId);
  const running = workbench.timeline.activeTurn !== null;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <Sessions open={sessionsOpen} host={host} onNavigate={() => setSessionsOpen(false)} />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <button
            type="button"
            aria-label="会话列表"
            className="rounded border border-line px-2 py-1 text-xs md:hidden"
            onClick={() => setSessionsOpen((open) => !open)}
          >
            ☰
          </button>
          <h1 className="truncate text-sm font-medium">{session?.title ?? "新会话"}</h1>
          <ConnectionBadge state={workbench.connection} endpoint={endpoint} />
        </header>

        {workbench.notice ? (
          <p
            role="alert"
            className="shrink-0 border-b border-line bg-raised px-3 py-1.5 text-xs text-danger"
          >
            {workbench.notice}
          </p>
        ) : null}

        <nav className="flex shrink-0 gap-1 border-b border-line bg-surface px-2" role="tablist">
          {PANELS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={panel === entry.id}
              className={`px-3 py-2 text-xs ${
                panel === entry.id
                  ? "border-b-2 border-accent text-fg"
                  : "text-muted hover:text-fg"
              }`}
              onClick={() => setPanel(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        {/* Panels stay mounted: a terminal that loses its scrollback every time
            someone glances at a diff is a terminal nobody uses. */}
        <Panel active={panel === "chat"}>
          {workbench.activeSessionId ? null : (
            <FirstRun host={host} onOpenSettings={() => setPanel("settings")} />
          )}
          <div
            className={`${workbench.activeSessionId ? "flex" : "hidden"} h-full min-h-0 flex-col`}
          >
            <AgentControls
              agents={workbench.agents}
              agentId={session?.agentId ?? null}
              modelId={workbench.timeline.modelId}
              modeId={workbench.timeline.modeId}
              disabled={running}
              onPickAgent={(id) => {
                const workspace = workbench.activeWorkspaceId ?? workbench.workspaces[0]?.id;
                if (workspace) void workbench.createSession(workspace, id);
              }}
              onPickModel={(id) => void workbench.setModel(id)}
              onPickMode={(id) => void workbench.setMode(id)}
            />

            <Timeline state={workbench.timeline} />

            {workbench.timeline.pendingPermission ? (
              <div className="px-4 pb-2">
                <PermissionCard
                  request={workbench.timeline.pendingPermission}
                  onAnswer={(outcome) => void workbench.answerPermission(outcome)}
                />
              </div>
            ) : null}

            <Composer
              running={running}
              disabled={!workbench.activeSessionId}
              onSend={(text) => void workbench.send(text)}
              onInterrupt={() => void workbench.interrupt()}
            />
          </div>
        </Panel>

        <Panel active={panel === "files"}>
          <FilesPanel />
        </Panel>
        <Panel active={panel === "changes"}>
          <ChangesPanel />
        </Panel>
        {/* The terminal is the exception: xterm measures the DOM, and measuring
            a hidden element gives it a size of zero it never recovers from. */}
        {panel === "terminal" ? (
          <Panel active>
            <TerminalPanel />
          </Panel>
        ) : null}
        <Panel active={panel === "settings"}>
          <SettingsPanel host={host} endpoint={endpoint} />
        </Panel>
      </main>
    </div>
  );
}

/**
 * What a new install shows instead of a workbench with everything greyed out.
 *
 * Three things have to be true before the first message can be sent — a project
 * to work in, a key to reach a model with, and a session — and the old empty
 * shell said none of that: the buttons were simply disabled and the reason was
 * somewhere else. This names the missing one and offers the action that fixes
 * it, one step at a time.
 */
function FirstRun({ host, onOpenSettings }: { host: Host; onOpenSettings(): void }) {
  const { workspaces, activeWorkspaceId, agents, createSession } = useWorkbench();
  const workspace = workspaces.find((entry) => entry.id === activeWorkspaceId) ?? workspaces[0];
  const builtin = agents.find((agent) => agent.builtin) ?? agents[0];
  // An agent with no models is an agent with no key: the catalog is built from
  // the providers that are actually configured.
  const usable = builtin && builtin.probe.state === "ready" && builtin.catalog.models.length > 0;

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
          className="rounded bg-accent px-3 py-1.5 text-xs text-white"
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
        className="rounded bg-accent px-3 py-1.5 text-xs text-white"
        onClick={() => builtin && void createSession(workspace.id, builtin.id)}
      >
        新建会话
      </button>
    </Splash>
  );
}

function Panel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={`min-h-0 flex-1 ${active ? "flex flex-col" : "hidden"}`}>{children}</div>
  );
}

function Sessions({
  open,
  host,
  onNavigate,
}: {
  open: boolean;
  host: Host;
  onNavigate(): void;
}) {
  const {
    sessions,
    activeSessionId,
    selectSession,
    workspaces,
    activeWorkspaceId,
    selectWorkspace,
    agents,
    createSession,
  } = useWorkbench();
  const workspace = workspaces.find((entry) => entry.id === activeWorkspaceId) ?? workspaces[0];
  const builtin = agents.find((agent) => agent.builtin) ?? agents[0];

  return (
    <aside
      className={`${
        open ? "flex" : "hidden"
      } max-h-56 w-full shrink-0 flex-col border-b border-line bg-surface md:flex md:max-h-none md:w-60 md:border-b-0 md:border-r`}
    >
      <div className="flex flex-col gap-2 border-b border-line px-3 py-2">
        {workspaces.length > 0 ? (
          <select
            aria-label="项目"
            className="w-full rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
            value={workspace?.id ?? ""}
            onChange={(event) => void selectWorkspace(event.target.value)}
          >
            {workspaces.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        ) : null}
        <OpenProject host={host} compact onOpened={onNavigate} />
      </div>

      <div className="border-b border-line px-3 py-2">
        <button
          type="button"
          className="w-full rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
          disabled={!workspace || !builtin}
          onClick={() => {
            if (workspace && builtin) void createSession(workspace.id, builtin.id);
            onNavigate();
          }}
        >
          新建会话
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto p-2 text-sm">
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              className={`w-full truncate rounded px-2 py-1.5 text-left ${
                session.id === activeSessionId ? "bg-raised" : "hover:bg-raised"
              }`}
              onClick={() => {
                void selectSession(session.id);
                onNavigate();
              }}
            >
              {session.title}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function ConnectionBadge({ state, endpoint }: { state: string; endpoint: Endpoint }) {
  const label =
    state === "ready"
      ? endpoint.via === "loopback"
        ? "本机直连"
        : endpoint.via === "lan"
          ? "局域网直连"
          : "经中转"
      : state === "reconnecting"
        ? "正在重连…"
        : state === "closed"
          ? "已断开"
          : "连接中…";

  return (
    <span className="ml-auto truncate text-xs text-muted" role="status">
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
