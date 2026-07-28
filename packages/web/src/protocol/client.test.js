import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";
import { socketQueue } from "./fake-socket";
function event(seq, text) {
    return {
        seq,
        sessionId: "s1",
        event: {
            type: "item",
            turnId: "t1",
            item: { type: "assistantMessage", id: `a${seq}`, text },
        },
    };
}
/** Lets queued microtasks run, which is how the client's awaits progress. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function connected() {
    const queue = socketQueue();
    const client = new Client({ url: "ws://test", socketFactory: queue.factory, backoffMs: () => 0 });
    client.connect();
    queue.latest().open();
    await settle();
    queue.latest().acceptHandshake();
    await settle();
    return { client, socket: queue.latest(), queue };
}
describe("the daemon connection", () => {
    it("says hello before anything else, and only then reports itself ready", async () => {
        const queue = socketQueue();
        const client = new Client({ url: "ws://test", socketFactory: queue.factory });
        client.connect();
        queue.latest().open();
        await settle();
        expect(queue.latest().sent[0]?.type).toBe("hello");
        expect(client.connectionState).toBe("connecting");
        queue.latest().acceptHandshake();
        await settle();
        expect(client.connectionState).toBe("ready");
    });
    it("holds a request typed during a blip and sends it when the socket returns", async () => {
        const queue = socketQueue();
        const client = new Client({ url: "ws://test", socketFactory: queue.factory, backoffMs: () => 0 });
        client.connect();
        // Nothing is open yet; this must not throw and must not be lost.
        const pending = client.call({ type: "agent.list" });
        queue.latest().open();
        await settle();
        queue.latest().acceptHandshake();
        await settle();
        const sent = queue.latest().lastOf("agent.list");
        queue.latest().reply(sent.id, { type: "agents", data: [] });
        expect(await pending).toEqual({ type: "agents", data: [] });
    });
    it("turns a refused request into a rejection carrying the daemon's reason", async () => {
        const { client, socket } = await connected();
        const pending = client.call({ type: "session.get", payload: { sessionId: "nope" } });
        socket.fail(socket.lastOf("session.get").id, "notFound", "no such session");
        await expect(pending).rejects.toThrow("no such session");
    });
    it("asks for the gap by sequence number after a reconnect, not for everything", async () => {
        const { client, queue } = await connected();
        const seen = [];
        const resyncs = [];
        const subscribing = client.subscribe("s1", {
            onEvent: (e) => seen.push(e.seq),
            onResync: (_snapshot, replayed, reset) => {
                resyncs.push({ replayed: replayed.map((e) => e.seq), reset });
            },
        });
        const first = queue.latest();
        first.reply(first.lastOf("subscribe").id, {
            type: "subscribed",
            data: { snapshot: snapshot(), replayed: [], reset: false },
        });
        await subscribing;
        first.event("s1", event(1, "one"));
        first.event("s1", event(2, "two"));
        expect(seen).toEqual([1, 2]);
        first.close();
        await settle();
        expect(client.connectionState).toBe("reconnecting");
        const second = queue.latest();
        expect(second).not.toBe(first);
        second.open();
        await settle();
        second.acceptHandshake();
        await settle();
        const resubscribe = second.lastOf("subscribe");
        expect(resubscribe.payload).toEqual({ sessionId: "s1", sinceSeq: 2 });
        second.reply(resubscribe.id, {
            type: "subscribed",
            data: { snapshot: snapshot(), replayed: [event(3, "three")], reset: false },
        });
        await settle();
        expect(resyncs).toEqual([{ replayed: [3], reset: false }]);
    });
    it("passes on the daemon's admission that a gap was too old to fill", async () => {
        const { client, queue } = await connected();
        let resetSeen = null;
        const subscribing = client.subscribe("s1", {
            onEvent: () => { },
            onResync: (_snapshot, _replayed, reset) => {
                resetSeen = reset;
            },
        });
        const first = queue.latest();
        first.reply(first.lastOf("subscribe").id, {
            type: "subscribed",
            data: { snapshot: snapshot(), replayed: [], reset: false },
        });
        await subscribing;
        first.close();
        await settle();
        const second = queue.latest();
        second.open();
        await settle();
        second.acceptHandshake();
        await settle();
        second.reply(second.lastOf("subscribe").id, {
            type: "subscribed",
            data: { snapshot: snapshot(), replayed: [], reset: true },
        });
        await settle();
        expect(resetSeen).toBe(true);
    });
    it("ignores an event it has already applied", async () => {
        const { client, queue } = await connected();
        const seen = [];
        const subscribing = client.subscribe("s1", { onEvent: (e) => seen.push(e.seq), onResync: () => { } });
        const socket = queue.latest();
        socket.reply(socket.lastOf("subscribe").id, {
            type: "subscribed",
            data: { snapshot: snapshot(), replayed: [], reset: false },
        });
        await subscribing;
        socket.event("s1", event(1, "one"));
        socket.event("s1", event(1, "one again"));
        socket.event("s1", event(2, "two"));
        expect(seen).toEqual([1, 2]);
    });
    it("stops trying when the handshake itself is refused", async () => {
        const queue = socketQueue();
        const client = new Client({ url: "ws://test", socketFactory: queue.factory, backoffMs: () => 0 });
        client.connect();
        queue.latest().open();
        await settle();
        // A version mismatch is not a blip; retrying would loop forever.
        queue.latest().fail(queue.latest().lastOf("hello").id, "protocolVersion", "speak v1");
        await settle();
        expect(client.connectionState).toBe("closed");
        expect(queue.sockets).toHaveLength(1);
        expect(client.failure?.code).toBe("protocolVersion");
    });
    it("hands terminal output straight to whoever is listening", async () => {
        const { socket } = await connected();
        const chunks = [];
        const client = new Client({ url: "ws://test", socketFactory: () => socket });
        client.onPty((_id, data) => chunks.push(data));
        client.connect();
        socket.open();
        await settle();
        socket.acceptHandshake();
        await settle();
        socket.deliver({ type: "pty", ptyId: "p1", data: "hello" });
        socket.deliver({ type: "ptyClosed", ptyId: "p1", exitCode: 0 });
        expect(chunks).toEqual(["hello", null]);
    });
    it("does not reconnect after it has been closed on purpose", async () => {
        const { client, queue } = await connected();
        const reconnect = vi.fn();
        client.onStateChange(reconnect);
        client.close();
        queue.latest().close();
        await settle();
        expect(queue.sockets).toHaveLength(1);
        expect(client.connectionState).toBe("closed");
    });
});
function snapshot() {
    return {
        summary: {
            id: "s1",
            workspaceId: "w1",
            agentId: "genet",
            title: "test",
            status: "idle",
            modelId: undefined,
            modeId: undefined,
            createdAtMs: 0,
            updatedAtMs: 0,
            archived: false,
        },
        items: [],
        seq: 0,
        pendingPermissions: [],
    };
}
