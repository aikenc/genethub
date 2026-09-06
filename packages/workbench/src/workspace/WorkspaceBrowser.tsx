import { useEffect, useMemo, useState } from "react";
import type { Host, Endpoint } from "../host";
import {
  localValue,
  draftIdentities,
  readLocalDraft,
} from "../session/localConversation";
import { useWorkbench } from "../session/store";
import { WorkspaceRow, RecentSessions } from "../shell/ConversationRows";
import {
  buildAgentSpaceTree,
  type AgentSpaceTreeNode,
} from "./agent-space-tree";
import { AgentDetails } from "./AgentDetails";
import { AgentList } from "./AgentList";
import { FilesPanel } from "../files/FilesPanel";
import { ChangesPanel } from "../changes/ChangesPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { OpenProject } from "./OpenProject";
import { ImportSessionsDialog } from "../session/ImportSessionsDialog";
import type { ExtraTab } from "../shell/tabs";

/** Browse relationships without changing the active conversation or its draft. */
export function WorkspaceBrowser({
  host,
  endpoint,
  navigationKey,
  deviceName,
  initialWorkspaceId,
  extraTabs,
  onSession,
  onNewSession,
  onExtra,
  onDepthChange,
}: {
  onDepthChange?(detail: boolean): void;
  host: Host;
  endpoint: Endpoint;
  navigationKey: number;
  deviceName: string;
  initialWorkspaceId?: string | null;
  extraTabs: ExtraTab[];
  onSession(id: string): void;
  onNewSession(id: string, localId?: string): void;
  onExtra(tab: ExtraTab, workspaceId: string): void;
}) {
  const {
    workspaces,
    sessions,
    activeSessionId,
    renameWorkspace,
    removeWorkspace,
    renameSession,
    deleteSession,
    client,
  } = useWorkbench();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialWorkspaceId ?? window.history.state?.genehubSpace?.id ?? null,
  );
  const [surface, setSurfaceState] = useState<string>(
    window.history.state?.genehubSpace?.surface ?? "sessions",
  );
  const setSurface = (value: string) => {
    window.history.replaceState(
      { ...window.history.state, genehubSpace: { id: selectedId, surface } },
      "",
    );
    window.history.pushState(
      {
        ...window.history.state,
        genehubSpace: { id: selectedId, surface: value },
        genehubParent: true,
      },
      "",
    );
    setSurfaceState(value);
  };
  useEffect(() => {
    onDepthChange?.(Boolean(selectedId));
  }, [selectedId, onDepthChange]);
  useEffect(() => {
    const restore = () => {
      const page = window.history.state?.genehubSpace;
      if (page) {
        setSelectedId(page.id);
        setSurfaceState(page.surface);
      }
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const [childrenOpen, setChildrenOpen] = useState(false);
  useEffect(() => setChildrenOpen(false), [selectedId]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    setSelectedId(
      initialWorkspaceId ?? window.history.state?.genehubSpace?.id ?? null,
    );
    setSurfaceState(
      initialWorkspaceId
        ? "sessions"
        : (window.history.state?.genehubSpace?.surface ?? "sessions"),
    );
    setQuery("");
  }, [initialWorkspaceId, navigationKey]);
  const [importOpen, setImportOpen] = useState(false);
  const [terminals, setTerminals] = useState<string[]>([]);
  const tree = useMemo(() => buildAgentSpaceTree(workspaces), [workspaces]);
  const nodes = useMemo(() => {
    const map = new Map<string, AgentSpaceTreeNode>();
    const visit = (node: AgentSpaceTreeNode) => {
      map.set(node.workspace.id, node);
      node.children.forEach(visit);
    };
    tree.roots.forEach(visit);
    tree.anomalies.forEach(visit);
    return map;
  }, [tree]);
  const node = selectedId ? nodes.get(selectedId) : undefined;
  const workspace = node?.workspace;
  const owned = sessions.filter(
    (item) =>
      item.workspaceId === workspace?.id && !item.archived && !item.unsupported,
  );
  const machine = client?.identity?.machineId ?? deviceName;
  const last = workspace
    ? localValue<string>(`last:${machine}:${workspace.id}`)
    : null;
  const continued =
    owned.find((item) => item.id === last) ??
    [...owned].sort(
      (a, b) =>
        (b.messagePreview?.atMs ?? b.updatedAtMs) -
        (a.messagePreview?.atMs ?? a.updatedAtMs),
    )[0];
  const drafts = draftIdentities(machine)
    .filter((item) => item.workspaceId === workspace?.id)
    .filter((item) => {
      const content = readLocalDraft(`${machine}:${item.localId}`);
      return (
        content.text || content.attachments.length || content.missingAttachments
      );
    });
  const browse = (id: string | null) => {
    window.history.replaceState(
      { ...window.history.state, genehubSpace: { id: selectedId, surface } },
      "",
    );
    window.history.pushState(
      {
        ...window.history.state,
        genehubSpace: { id, surface: "sessions" },
        genehubParent: true,
      },
      "",
    );
    setSelectedId(id);
    setSurfaceState("sessions");
  };
  return (
    <div className="flex h-full min-h-0 min-w-0" aria-label="Agent 浏览">
      <aside aria-label="Agent 目录导航" className="hidden w-80 shrink-0 flex-col border-r border-line bg-sidebar lg:flex">
        <header className="shrink-0 space-y-3 border-b border-line p-4"><div className="flex items-center justify-between gap-2"><h1 className="text-xl font-semibold">Agent</h1><OpenProject host={host} endpoint={endpoint} /></div><input type="search" aria-label="搜索 Agent" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称或上级 Agent" className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm" /></header>
        <div className="min-h-0 flex-1 overflow-y-auto p-2"><AgentList workspaces={workspaces} sessions={sessions} selectedId={selectedId} onPick={browse} query={query} deviceName={deviceName} /></div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Agent 面板">
      <header className="shrink-0 border-b border-line px-4 py-3 md:px-6">
        <div className="flex items-center gap-2">
          {workspace && (
            <button
              type="button"
              aria-label="返回 Agent"
              className="min-h-11 min-w-11 text-xl"
              onClick={() => {
                if (window.history.state?.genehubParent) window.history.back();
                else if (surface !== "sessions") setSurface("sessions");
                else browse(null);
              }}
            >
              ‹
            </button>
          )}
          <p className="text-xs text-muted">{deviceName}</p>
        </div>
        <nav
          aria-label="Agent 路径"
          className="mt-2 flex flex-wrap items-center gap-1 text-sm"
        >
          <button
            type="button"
            className="min-h-10 rounded-lg px-2 text-accent hover:bg-raised"
            onClick={() => browse(null)}
          >
            全部 Agent
          </button>
          {workspace && (
            <span className="truncate px-2">/ {workspace.name}</span>
          )}
        </nav>
        {workspace ? (
          <div className="mt-2 flex flex-wrap gap-1" aria-label="Agent 工具">
            {[
              ["sessions", "会话与资料"],
              ["files", "文件"],
              ["changes", "变更"],
              ["terminal", "终端"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={surface === id}
                className={`min-h-10 rounded-lg px-3 text-sm ${surface === id ? "bg-raised text-accent" : "text-muted hover:bg-raised"}`}
                onClick={() => {
                  setSurface(id!);
                  if (id === "terminal")
                    setTerminals((current) =>
                      current.includes(workspace.id)
                        ? current
                        : [...current.slice(-3), workspace.id],
                    );
                }}
              >
                {label}
              </button>
            ))}
            {extraTabs
              .filter((tab) => !tab.scope || tab.scope === "workspace")
              .map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className="min-h-10 rounded-lg px-3 text-sm text-muted hover:bg-raised"
                  onClick={() => onExtra(tab, workspace.id)}
                >
                  {tab.label}
                </button>
              ))}
          </div>
        ) : null}
      </header>
      {surface === "sessions" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:px-6">
          <div className="mx-auto max-w-4xl">
            {!workspace && (
              <div className="mb-4 flex flex-wrap items-center gap-2 lg:hidden">
                <input
                  type="search"
                  aria-label="搜索 Agent"
                  placeholder="搜索名称或上级 Agent"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-sm"
                />
                <OpenProject host={host} endpoint={endpoint} />
              </div>
            )}
            {workspace ? (
              <ul className="mb-4">
                <WorkspaceRow
                  workspace={workspace}
                  workspaces={workspaces}
                  breadcrumb={node.breadcrumb}
                  projectWorkspaceId={
                    tree.projectRootById[workspace.id] ?? workspace.id
                  }
                  relationAnomaly={tree.anomalies.some(
                    (item) => item.workspace.id === workspace.id,
                  )}
                  running={
                    sessions.filter(
                      (item) =>
                        item.workspaceId === workspace.id &&
                        ["running", "waiting"].includes(item.status),
                    ).length
                  }
                  shut
                  browse
                  active
                  deviceName={deviceName}
                  childCount={node.children.length}
                  expanded={childrenOpen}
                  onExpand={() => setChildrenOpen((value) => !value)}
                  onToggle={() => browse(workspace.id)}
                  onPick={() => browse(workspace.id)}
                  onRename={(name) => void renameWorkspace(workspace.id, name)}
                  onRemove={() => removeWorkspace(workspace.id)}
                >
                  {null}
                </WorkspaceRow>
              </ul>
            ) : null}
            {workspace && <div className="mb-5 hidden rounded-xl border border-line p-4 lg:block"><AgentDetails key={workspace.id} workspace={workspace} deviceName={deviceName} compact /></div>}
            {workspace && childrenOpen && node.children.length > 0 && (
              <section className="mb-4 rounded-xl border border-line p-2">
                {childrenOpen && (
                  <AgentList
                    key={workspace.id}
                    workspaces={workspaces}
                    rootIds={node.children.map((child) => child.workspace.id)}
                    sessions={sessions}
                    onPick={browse}
                    deviceName={deviceName}
                  />
                )}
              </section>
            )}
            {workspace && (
              <div className="mb-6 space-y-3">
                <button
                  type="button"
                  className="min-h-12 w-full rounded-xl bg-accent px-4 py-3 text-left text-on-accent"
                  onClick={() =>
                    continued
                      ? onSession(continued.id)
                      : onNewSession(workspace.id)
                  }
                >
                  {continued
                    ? `${continued.managed?.userInteraction === "readOnly" ? "查看会话" : "继续会话"} · ${continued.title ?? "未命名会话"}`
                    : "开始会话"}
                </button>
                {drafts.map((item) => (
                  <button
                    key={item.localId}
                    type="button"
                    className="block min-h-11 w-full truncate rounded-lg bg-raised px-4 text-left text-sm"
                    onClick={() => onNewSession(workspace.id, item.localId)}
                  >
                    继续草稿 ·{" "}
                    {readLocalDraft(`${machine}:${item.localId}`).text ||
                      "附件草稿"}
                  </button>
                ))}
              </div>
            )}
            {workspace ? (
              <div className="mt-6 border-t border-line pt-4">
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="mr-auto text-sm font-medium">会话</h2>
                  <button
                    type="button"
                    className="min-h-10 rounded-lg px-3 text-sm text-accent hover:bg-raised"
                    onClick={() => setImportOpen(true)}
                  >
                    导入
                  </button>
                  <button
                    type="button"
                    className="min-h-10 rounded-lg bg-accent px-3 text-sm text-white"
                    onClick={() => onNewSession(workspace.id)}
                  >
                    新会话
                  </button>
                </div>
                <RecentSessions
                  sessions={sessions
                    .filter((item) => item.workspaceId === workspace.id)
                    .map((item) => ({ ...item, unread: false }))}
                  workspaces={workspaces}
                  activeSessionId={activeSessionId}
                  onPickSession={onSession}
                  onRename={(id, title) => void renameSession(id, title)}
                  onDelete={(id) => void deleteSession(id)}
                />
              </div>
            ) : null}
            {!workspace && <p className="hidden py-16 text-center text-sm text-muted lg:block">从左侧选择一个 Agent，查看资料、会话和工具。</p>}
            {!workspace && (
              <div className="lg:hidden"><AgentList
                workspaces={workspaces}
                sessions={sessions}
                onPick={browse}
                query={query}
                deviceName={deviceName}
              /></div>
            )}
            {workspace && (
              <section
                className="mt-6 rounded-xl border border-line p-4"
                aria-label="Agent 目录"
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium">
                    目录 · {workspace.folders.length}
                  </h2>
                  {workspace.workspaceFile && (
                    <OpenProject
                      key={workspace.id}
                      host={host}
                      endpoint={endpoint}
                      directoryAction={{
                        initialDirectory: workspace.root,
                        onPick: async (root) => {
                          if (!client) throw new Error("设备尚未连接");
                          const reply = await client.call({
                            type: "workspace.addRoot",
                            payload: { workspaceId: workspace.id, root },
                          });
                          if (reply?.type !== "workspace")
                            throw new Error("未收到目录更新结果");
                          if (useWorkbench.getState().client === client)
                            await useWorkbench.getState().refreshWorkspaces();
                        },
                      }}
                    />
                  )}
                </div>
                <ul className="mt-3 space-y-2">
                  {workspace.folders.map((folder) => (
                    <li
                      key={folder.rootHandle || folder.root}
                      className="min-w-0"
                    >
                      <p className="text-sm">{folder.name}</p>
                      <p className="break-all text-xs text-muted">
                        {folder.root}
                      </p>
                    </li>
                  ))}
                </ul>
                {workspace.workspaceFile && (
                  <p className="mt-3 text-xs text-muted">
                    新增目录会写入 .code-workspace，新会话使用更新后的目录。
                  </p>
                )}
              </section>
            )}

          </div>
        </div>
      ) : null}
      {workspace && surface === "files" ? (
        <div className="min-h-0 flex-1">
          <FilesPanel key={workspace.id} workspaceId={workspace.id} />
        </div>
      ) : null}
      {workspace && surface === "changes" ? (
        <div className="min-h-0 flex-1">
          <ChangesPanel key={workspace.id} workspaceId={workspace.id} />
        </div>
      ) : null}
      {terminals
        .filter((id) => nodes.has(id))
        .map((id) => (
          <div
            key={id}
            className={
              surface === "terminal" && id === workspace?.id
                ? "min-h-0 flex-1"
                : "hidden"
            }
          >
            <TerminalPanel workspaceId={id} />
          </div>
        ))}
      {importOpen && workspace && client ? (
        <ImportSessionsDialog
          workspaceId={workspace.id}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
      </section>
    </div>
  );
}
