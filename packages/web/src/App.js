import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { ChangesPanel } from "./changes/ChangesPanel";
import { FilesPanel } from "./files/FilesPanel";
import { detectHost } from "./host";
import { Client } from "./protocol/client";
import { SettingsPanel } from "./settings/SettingsPanel";
import { AgentControls } from "./session/AgentControls";
import { Composer } from "./session/Composer";
import { PermissionCard } from "./session/Permission";
import { Timeline } from "./session/Timeline";
import { useWorkbench } from "./session/store";
import { TerminalPanel } from "./terminal/TerminalPanel";
const PANELS = [
    { id: "chat", label: "会话" },
    { id: "files", label: "文件" },
    { id: "changes", label: "变更" },
    { id: "terminal", label: "终端" },
    { id: "settings", label: "设置" },
];
export function App({ host = detectHost() }) {
    const [endpoint, setEndpoint] = useState("loading");
    const [panel, setPanel] = useState("chat");
    const [sessionsOpen, setSessionsOpen] = useState(false);
    const workbench = useWorkbench();
    const pairing = workbench.hub?.state === "pairing";
    // While a code is on screen, approval happens somewhere else entirely, so the
    // only way to learn it succeeded is to ask.
    useEffect(() => {
        if (!pairing)
            return;
        const timer = setInterval(() => void workbench.refreshHub(), 2000);
        return () => clearInterval(timer);
    }, [pairing, workbench]);
    useEffect(() => {
        let client = null;
        void host.endpoint().then((found) => {
            setEndpoint(found);
            if (!found)
                return;
            client = new Client({ url: found.url });
            client.connect();
            void useWorkbench.getState().attach(client);
        });
        return () => client?.close();
    }, [host]);
    if (endpoint === "loading")
        return _jsx(Splash, { children: "\u6B63\u5728\u67E5\u627E\u8FD9\u53F0\u673A\u5668\u2026" });
    if (!endpoint) {
        return (_jsxs(Splash, { children: [_jsx("p", { children: "\u6CA1\u6709\u53EF\u8FDE\u63A5\u7684\u673A\u5668\u3002" }), _jsx("p", { className: "text-muted", children: "\u5728\u684C\u9762\u7AEF\u70B9\u300C\u8FDE\u63A5\u300D\uFF0C\u6216\u8005\u4ECE\u300C\u6211\u7684\u673A\u5668\u300D\u9875\u9762\u6253\u5F00\u5DE5\u4F5C\u53F0\u3002" })] }));
    }
    const session = workbench.sessions.find((item) => item.id === workbench.activeSessionId);
    const running = workbench.timeline.activeTurn !== null;
    return (_jsxs("div", { className: "flex h-full flex-col md:flex-row", children: [_jsx(Sessions, { open: sessionsOpen, onNavigate: () => setSessionsOpen(false) }), _jsxs("main", { className: "flex min-h-0 min-w-0 flex-1 flex-col", children: [_jsxs("header", { className: "flex items-center gap-2 border-b border-line bg-surface px-3 py-2", children: [_jsx("button", { type: "button", "aria-label": "\u4F1A\u8BDD\u5217\u8868", className: "rounded border border-line px-2 py-1 text-xs md:hidden", onClick: () => setSessionsOpen((open) => !open), children: "\u2630" }), _jsx("h1", { className: "truncate text-sm font-medium", children: session?.title ?? "新会话" }), _jsx(ConnectionBadge, { state: workbench.connection, endpoint: endpoint })] }), _jsx("nav", { className: "flex shrink-0 gap-1 border-b border-line bg-surface px-2", role: "tablist", children: PANELS.map((entry) => (_jsx("button", { type: "button", role: "tab", "aria-selected": panel === entry.id, className: `px-3 py-2 text-xs ${panel === entry.id
                                ? "border-b-2 border-accent text-fg"
                                : "text-muted hover:text-fg"}`, onClick: () => setPanel(entry.id), children: entry.label }, entry.id))) }), _jsx(Panel, { active: panel === "chat", children: _jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [_jsx(AgentControls, { agents: workbench.agents, agentId: session?.agentId ?? null, modelId: workbench.timeline.modelId, modeId: workbench.timeline.modeId, disabled: running, onPickAgent: (id) => {
                                        const workspace = workbench.workspaces[0];
                                        if (workspace)
                                            void workbench.createSession(workspace.id, id);
                                    }, onPickModel: (id) => void workbench.setModel(id), onPickMode: (id) => void workbench.setMode(id) }), _jsx(Timeline, { state: workbench.timeline }), workbench.timeline.pendingPermission ? (_jsx("div", { className: "px-4 pb-2", children: _jsx(PermissionCard, { request: workbench.timeline.pendingPermission, onAnswer: (outcome) => void workbench.answerPermission(outcome) }) })) : null, _jsx(Composer, { running: running, disabled: !workbench.activeSessionId, onSend: (text) => void workbench.send(text), onInterrupt: () => void workbench.interrupt() })] }) }), _jsx(Panel, { active: panel === "files", children: _jsx(FilesPanel, {}) }), _jsx(Panel, { active: panel === "changes", children: _jsx(ChangesPanel, {}) }), panel === "terminal" ? (_jsx(Panel, { active: true, children: _jsx(TerminalPanel, {}) })) : null, _jsx(Panel, { active: panel === "settings", children: _jsx(SettingsPanel, { host: host }) })] })] }));
}
function Panel({ active, children }) {
    return (_jsx("div", { className: `min-h-0 flex-1 ${active ? "flex flex-col" : "hidden"}`, children: children }));
}
function Sessions({ open, onNavigate }) {
    const { sessions, activeSessionId, selectSession, workspaces, agents, createSession } = useWorkbench();
    const workspace = workspaces[0];
    const builtin = agents.find((agent) => agent.builtin) ?? agents[0];
    return (_jsxs("aside", { className: `${open ? "flex" : "hidden"} max-h-56 w-full shrink-0 flex-col border-b border-line bg-surface md:flex md:max-h-none md:w-60 md:border-b-0 md:border-r`, children: [_jsx("div", { className: "border-b border-line px-3 py-2", children: _jsx("button", { type: "button", className: "w-full rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40", disabled: !workspace || !builtin, onClick: () => {
                        if (workspace && builtin)
                            void createSession(workspace.id, builtin.id);
                        onNavigate();
                    }, children: "\u65B0\u5EFA\u4F1A\u8BDD" }) }), _jsx("ul", { className: "flex-1 overflow-y-auto p-2 text-sm", children: sessions.map((session) => (_jsx("li", { children: _jsx("button", { type: "button", className: `w-full truncate rounded px-2 py-1.5 text-left ${session.id === activeSessionId ? "bg-raised" : "hover:bg-raised"}`, onClick: () => {
                            void selectSession(session.id);
                            onNavigate();
                        }, children: session.title }) }, session.id))) })] }));
}
function ConnectionBadge({ state, endpoint }) {
    const label = state === "ready"
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
    return (_jsxs("span", { className: "ml-auto truncate text-xs text-muted", role: "status", children: [label, " \u00B7 ", endpoint.label] }));
}
function Splash({ children }) {
    return (_jsx("div", { className: "flex h-full flex-col items-center justify-center gap-1 p-6 text-center", children: children }));
}
