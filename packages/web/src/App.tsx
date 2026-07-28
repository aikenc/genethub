import { useEffect, useState } from "react";

import { detectHost, type Endpoint, type Host } from "./host";
import { Client } from "./protocol/client";
import { AgentControls } from "./session/AgentControls";
import { Composer } from "./session/Composer";
import { PermissionCard } from "./session/Permission";
import { Timeline } from "./session/Timeline";
import { useWorkbench } from "./session/store";

export function App({ host = detectHost() }: { host?: Host }) {
  const [endpoint, setEndpoint] = useState<Endpoint | null | "loading">("loading");
  const workbench = useWorkbench();

  useEffect(() => {
    let client: Client | null = null;
    void host.endpoint().then((found) => {
      setEndpoint(found);
      if (!found) return;
      client = new Client({ url: found.url });
      client.connect();
      void useWorkbench.getState().attach(client);
    });
    return () => client?.close();
  }, [host]);

  if (endpoint === "loading") return <Splash>正在查找这台机器…</Splash>;
  if (!endpoint) {
    return (
      <Splash>
        <p>没有可连接的机器。</p>
        <p className="text-muted">
          在桌面端点「连接」，或者从「我的机器」页面打开工作台。
        </p>
      </Splash>
    );
  }

  const session = workbench.sessions.find((item) => item.id === workbench.activeSessionId);
  const running = workbench.timeline.activeTurn !== null;

  return (
    <div className="flex h-full">
      <Sidebar />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2">
          <h1 className="truncate text-sm font-medium">{session?.title ?? "新会话"}</h1>
          <ConnectionBadge state={workbench.connection} endpoint={endpoint} />
        </header>

        <AgentControls
          agents={workbench.agents}
          agentId={session?.agentId ?? null}
          modelId={workbench.timeline.modelId}
          modeId={workbench.timeline.modeId}
          disabled={running}
          onPickAgent={(id) => {
            const workspace = workbench.workspaces[0];
            if (workspace) void workbench.createSession(workspace.id, id);
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
      </main>
    </div>
  );
}

function Sidebar() {
  const { sessions, activeSessionId, selectSession, workspaces, agents, createSession } =
    useWorkbench();
  const workspace = workspaces[0];
  const builtin = agents.find((agent) => agent.builtin) ?? agents[0];

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="border-b border-line px-3 py-2">
        <button
          type="button"
          className="w-full rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
          disabled={!workspace || !builtin}
          onClick={() => {
            if (workspace && builtin) void createSession(workspace.id, builtin.id);
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
              onClick={() => void selectSession(session.id)}
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
    <span className="ml-auto text-xs text-muted" role="status">
      {label} · {endpoint.label}
    </span>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
      {children}
    </div>
  );
}
