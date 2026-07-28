import { create } from "zustand";
import { applySequenced, emptyTimeline, fromSnapshot } from "./timeline";
export const useWorkbench = create((set, get) => ({
    client: null,
    connection: "connecting",
    agents: [],
    workspaces: [],
    sessions: [],
    activeSessionId: null,
    timeline: emptyTimeline(),
    notice: null,
    hub: null,
    tree: null,
    file: null,
    git: null,
    diff: null,
    settings: null,
    async attach(client) {
        set({ client });
        client.onStateChange((connection) => set({ connection }));
        client.onNotice((_level, message) => set({ notice: message }));
        await refreshCatalog(client, set);
        await get().refreshHub();
    },
    async openWorkspace(root) {
        const client = require_(get().client);
        const reply = await client.call({ type: "workspace.open", payload: { root } });
        if (reply?.type !== "workspace")
            return;
        set((state) => ({
            workspaces: upsertBy(state.workspaces, reply.data, (w) => w.id),
        }));
        await loadSessions(client, reply.data.id, set);
    },
    async createSession(workspaceId, agentId) {
        const client = require_(get().client);
        const reply = await client.call({
            type: "session.create",
            payload: { workspaceId, agentId, modelId: null, modeId: null, title: null },
        });
        if (reply?.type !== "session")
            return;
        set((state) => ({ sessions: [reply.data, ...state.sessions] }));
        await get().selectSession(reply.data.id);
    },
    async selectSession(sessionId) {
        const client = require_(get().client);
        const previous = get().activeSessionId;
        if (previous && previous !== sessionId)
            await client.unsubscribe(previous);
        set({ activeSessionId: sessionId, timeline: emptyTimeline() });
        const { snapshot, replayed } = await client.subscribe(sessionId, {
            onEvent: (event) => {
                // Events for a session the user has already left would rewrite the
                // timeline they are looking at.
                if (get().activeSessionId !== sessionId)
                    return;
                set((state) => ({ timeline: applySequenced(state.timeline, event) }));
            },
            onResync: (resnapshot, events, reset) => {
                if (get().activeSessionId !== sessionId)
                    return;
                const base = reset
                    ? fromSnapshot(resnapshot)
                    : get().timeline;
                set({ timeline: events.reduce(applySequenced, base) });
            },
        });
        const base = fromSnapshot(snapshot);
        set({ timeline: replayed.reduce(applySequenced, base) });
    },
    async send(text) {
        const client = require_(get().client);
        const sessionId = get().activeSessionId;
        if (!sessionId)
            return;
        await client.call({ type: "session.send", payload: { sessionId, text, attachments: [] } });
    },
    async interrupt() {
        const client = require_(get().client);
        const sessionId = get().activeSessionId;
        if (!sessionId)
            return;
        await client.call({ type: "session.interrupt", payload: { sessionId } });
    },
    async setModel(modelId) {
        const client = require_(get().client);
        const sessionId = get().activeSessionId;
        if (!sessionId)
            return;
        await client.call({ type: "session.setModel", payload: { sessionId, modelId } });
    },
    async setMode(modeId) {
        const client = require_(get().client);
        const sessionId = get().activeSessionId;
        if (!sessionId)
            return;
        await client.call({ type: "session.setMode", payload: { sessionId, modeId } });
    },
    /**
     * Loads a directory's children. Passing no path loads the root.
     *
     * The reply is a subtree, and it is grafted onto the tree already on screen
     * rather than replacing it — otherwise expanding a folder would collapse
     * every other folder the user had opened.
     */
    async loadTree(path) {
        const client = require_(get().client);
        const workspaceId = currentWorkspace(get());
        if (!workspaceId)
            return;
        const reply = await client.call({
            type: "file.tree",
            payload: { workspaceId, path: path ?? null, depth: 1 },
        });
        if (reply?.type !== "fileTree")
            return;
        set((state) => ({
            tree: path && state.tree ? graft(state.tree, path, reply.data) : reply.data,
        }));
    },
    async openFile(path) {
        const client = require_(get().client);
        const workspaceId = currentWorkspace(get());
        if (!workspaceId)
            return;
        const reply = await client.call({ type: "file.read", payload: { workspaceId, path } });
        if (reply?.type === "fileContent")
            set({ file: reply.data });
    },
    async saveFile(content) {
        const client = require_(get().client);
        const workspaceId = currentWorkspace(get());
        const open = get().file;
        if (!workspaceId || !open)
            return;
        await client.call({ type: "file.write", payload: { workspaceId, path: open.path, content } });
        set({ file: { ...open, content } });
        // Saving is the most common way the change list stops being accurate.
        await get().refreshGit();
    },
    async refreshGit() {
        const client = require_(get().client);
        const workspaceId = currentWorkspace(get());
        if (!workspaceId)
            return;
        const reply = await client.call({ type: "git.status", payload: { workspaceId } });
        if (reply?.type === "gitStatus")
            set({ git: reply.data });
    },
    async loadDiff(path) {
        const client = require_(get().client);
        const workspaceId = currentWorkspace(get());
        if (!workspaceId)
            return;
        const reply = await client.call({
            type: "git.diff",
            payload: { workspaceId, path: path ?? null },
        });
        if (reply?.type === "gitDiff")
            set({ diff: reply.data.diff });
    },
    async commit(message, paths = []) {
        const client = require_(get().client);
        const workspaceId = currentWorkspace(get());
        if (!workspaceId)
            return;
        await client.call({ type: "git.commit", payload: { workspaceId, message, paths } });
        set({ diff: null });
        await get().refreshGit();
    },
    async loadSettings() {
        const reply = await require_(get().client).call({ type: "settings.get" });
        if (reply?.type === "settings")
            set({ settings: reply.data });
    },
    async setProvider({ providerId, apiKey, baseUrl }) {
        const reply = await require_(get().client).call({
            type: "settings.setProvider",
            payload: { providerId, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null },
        });
        if (reply?.type === "settings")
            set({ settings: reply.data });
        // A key that just landed can change which agents are usable.
        const agents = await require_(get().client).call({ type: "agent.refresh" });
        if (agents?.type === "agents")
            set({ agents: agents.data });
    },
    async refreshHub() {
        const reply = await require_(get().client).call({ type: "hub.status" });
        if (reply?.type === "hubStatus")
            set({ hub: reply.data });
    },
    async pair(hubUrl) {
        const reply = await require_(get().client).call({
            type: "hub.pair",
            payload: { hubUrl, displayName: null },
        });
        if (reply?.type === "hubStatus")
            set({ hub: reply.data });
    },
    async unpair() {
        const reply = await require_(get().client).call({ type: "hub.unpair" });
        if (reply?.type === "hubStatus")
            set({ hub: reply.data });
    },
    async answerPermission(outcome) {
        const client = require_(get().client);
        const sessionId = get().activeSessionId;
        const request = get().timeline.pendingPermission;
        if (!sessionId || !request)
            return;
        await client.call({
            type: "session.respondPermission",
            payload: { sessionId, requestId: request.id, outcome },
        });
    },
}));
async function refreshCatalog(client, set) {
    const [agents, workspaces] = await Promise.all([
        client.call({ type: "agent.list" }),
        client.call({ type: "workspace.list" }),
    ]);
    if (agents?.type === "agents")
        set({ agents: agents.data });
    if (workspaces?.type === "workspaces") {
        set({ workspaces: workspaces.data });
        const first = workspaces.data[0];
        if (first)
            await loadSessions(client, first.id, set);
    }
}
async function loadSessions(client, workspaceId, set) {
    const reply = await client.call({
        type: "session.list",
        payload: { workspaceId, includeArchived: false },
    });
    if (reply?.type === "sessions")
        set({ sessions: reply.data });
}
function currentWorkspace(state) {
    const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
    return session?.workspaceId ?? state.workspaces[0]?.id ?? null;
}
/** Replaces the node at `path` with a freshly loaded one, in place. */
function graft(tree, path, subtree) {
    if (tree.path === path)
        return subtree;
    if (!tree.children)
        return tree;
    return { ...tree, children: tree.children.map((child) => graft(child, path, subtree)) };
}
function upsertBy(list, item, key) {
    const index = list.findIndex((existing) => key(existing) === key(item));
    if (index === -1)
        return [...list, item];
    const next = list.slice();
    next[index] = item;
    return next;
}
function require_(client) {
    if (!client)
        throw new Error("the workbench is not connected yet");
    return client;
}
