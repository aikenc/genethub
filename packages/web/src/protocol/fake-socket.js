/**
 * A socket the test drives by hand.
 *
 * The point is to control ordering: a reconnect that races a reply, an event
 * arriving before its subscribe returns, a gap the daemon cannot fill. None of
 * those are reachable against a real socket without sleeping and hoping.
 */
export class FakeSocket {
    onopen = null;
    onclose = null;
    onerror = null;
    onmessage = null;
    sent = [];
    closed = false;
    send(data) {
        this.sent.push(JSON.parse(data));
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.onclose?.({});
    }
    /** The server accepting the connection. */
    open() {
        this.onopen?.({});
    }
    /** Answers a request by id. */
    reply(id, payload) {
        this.deliver({ type: "result", id, ok: true, payload });
    }
    fail(id, code = "internal", message = "nope") {
        this.deliver({
            type: "result",
            id,
            ok: false,
            error: { code: code, message },
        });
    }
    /**
     * Pushes a session event. The topic is built the way the daemon builds it,
     * because a fake that addresses events differently from the real thing is a
     * fake that hides exactly the bug it should be catching.
     */
    event(sessionId, event) {
        this.deliver({ type: "event", topic: `session:${sessionId}`, payload: event });
    }
    deliver(frame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
    /** The last request of a given type, which is usually the one under test. */
    lastOf(type) {
        const found = [...this.sent].reverse().find((message) => message.type === type);
        if (!found)
            throw new Error(`no ${type} was sent; saw ${this.sent.map((s) => s.type).join(", ")}`);
        return found;
    }
    /** Completes the handshake so a test can get to the interesting part. */
    acceptHandshake() {
        const hello = this.lastOf("hello");
        this.reply(hello.id, {
            type: "hello",
            data: {
                daemonVersion: "test",
                protocolVersion: 1,
                machineId: "m_test",
                fingerprint: "AAAA-BBBB",
                transport: "loopback",
            },
        });
    }
}
/** Hands out sockets in order, so a test can watch a reconnect happen. */
export function socketQueue() {
    const sockets = [];
    return {
        factory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        sockets,
        latest() {
            const socket = sockets[sockets.length - 1];
            if (!socket)
                throw new Error("nothing has connected yet");
            return socket;
        },
    };
}
