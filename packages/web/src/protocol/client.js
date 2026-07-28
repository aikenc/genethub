export const PROTOCOL_VERSION = 1;
/**
 * Events arrive addressed to a topic, `session:<id>`. Subscriptions are keyed
 * by the session id itself, because that is what every caller has.
 */
function sessionOf(topic) {
    return topic.startsWith("session:") ? topic.slice("session:".length) : topic;
}
export class ProtocolError_ extends Error {
    detail;
    constructor(detail) {
        super(detail.message);
        this.detail = detail;
        this.name = "ProtocolError";
    }
}
/**
 * The daemon connection.
 *
 * Reconnection is the interesting part. A dropped socket must not lose events
 * and must not replay ones already shown, so every subscription remembers the
 * last sequence number it applied and asks for the gap by number rather than
 * by time. When the gap is older than the daemon's retained window it says so,
 * and the caller starts from the snapshot instead of quietly missing history.
 */
export class Client {
    options;
    socket = null;
    pending = new Map();
    subscriptions = new Map();
    stateListeners = new Set();
    ptyListeners = new Set();
    noticeListeners = new Set();
    nextId = 1;
    attempt = 0;
    stopped = false;
    queue = [];
    state = "connecting";
    /** Why the connection gave up, when it did so for a reason worth showing. */
    failure = null;
    constructor(options) {
        this.options = options;
    }
    get connectionState() {
        return this.state;
    }
    onStateChange(listener) {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
    }
    onPty(listener) {
        this.ptyListeners.add(listener);
        return () => this.ptyListeners.delete(listener);
    }
    onNotice(listener) {
        this.noticeListeners.add(listener);
        return () => this.noticeListeners.delete(listener);
    }
    connect() {
        if (this.stopped)
            return;
        const factory = this.options.socketFactory ?? ((url) => new WebSocket(url));
        const socket = factory(this.options.url);
        this.socket = socket;
        socket.onopen = () => {
            this.attempt = 0;
            void this.handshake();
        };
        socket.onmessage = (event) => this.receive(String(event.data));
        socket.onclose = () => this.dropped();
        socket.onerror = () => socket.close();
    }
    close() {
        this.stopped = true;
        this.setState("closed");
        this.socket?.close();
        this.socket = null;
        for (const { reject } of this.pending.values()) {
            reject(new Error("the connection was closed"));
        }
        this.pending.clear();
    }
    /** Sends a request and resolves with its reply. */
    async call(request) {
        const id = String(this.nextId++);
        const frame = JSON.stringify({ id, ...request });
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        if (this.state === "ready")
            this.socket?.send(frame);
        // Queued rather than rejected: a request typed during a blip should land
        // when the socket comes back, not fail in the user's face.
        else
            this.queue.push(frame);
        return promise;
    }
    /**
     * Subscribes to a session. Returns the initial snapshot; later reconnects
     * deliver theirs through `onResync`.
     */
    async subscribe(sessionId, handlers) {
        const subscription = { seq: 0, ...handlers };
        this.subscriptions.set(sessionId, subscription);
        const reply = await this.call({
            type: "subscribe",
            payload: { sessionId, sinceSeq: 0 },
        });
        if (reply?.type !== "subscribed") {
            this.subscriptions.delete(sessionId);
            throw new Error(`unexpected reply to subscribe: ${reply?.type}`);
        }
        for (const event of reply.data.replayed)
            subscription.seq = event.seq;
        return { snapshot: reply.data.snapshot, replayed: reply.data.replayed, reset: reply.data.reset };
    }
    async unsubscribe(sessionId) {
        this.subscriptions.delete(sessionId);
        await this.call({ type: "unsubscribe", payload: { sessionId } });
    }
    // -------------------------------------------------------------------------
    async handshake() {
        const id = String(this.nextId++);
        const frame = JSON.stringify({
            id,
            type: "hello",
            payload: {
                clientName: this.options.clientName ?? "genehub-web",
                protocolVersion: PROTOCOL_VERSION,
            },
        });
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.socket?.send(frame);
        try {
            await promise;
        }
        catch (error) {
            // A refused handshake is not something retrying fixes: the versions do
            // not match, or the credential is wrong. Stop, and keep the reason so the
            // UI can say which of those it was instead of spinning forever.
            this.failure = error instanceof ProtocolError_ ? error.detail : null;
            this.close();
            return;
        }
        this.setState("ready");
        for (const frame of this.queue.splice(0))
            this.socket?.send(frame);
        await this.resubscribe();
    }
    /** Asks for the gap on every open session. */
    async resubscribe() {
        for (const [sessionId, subscription] of this.subscriptions) {
            const reply = await this.call({
                type: "subscribe",
                payload: { sessionId, sinceSeq: subscription.seq },
            }).catch(() => undefined);
            if (reply?.type !== "subscribed")
                continue;
            for (const event of reply.data.replayed)
                subscription.seq = event.seq;
            subscription.onResync(reply.data.snapshot, reply.data.replayed, reply.data.reset);
        }
    }
    receive(raw) {
        let frame;
        try {
            frame = JSON.parse(raw);
        }
        catch {
            return;
        }
        switch (frame.type) {
            case "result": {
                const pending = this.pending.get(frame.id);
                if (!pending)
                    return;
                this.pending.delete(frame.id);
                if (frame.ok)
                    pending.resolve(frame.payload);
                else {
                    pending.reject(new ProtocolError_(frame.error ?? { code: "internal", message: "the daemon reported a failure" }));
                }
                return;
            }
            case "event": {
                const subscription = this.subscriptions.get(sessionOf(frame.topic));
                if (!subscription)
                    return;
                // Out-of-order or duplicate events are dropped rather than applied:
                // the sequence number is the only thing that decides what is new.
                if (frame.payload.seq <= subscription.seq)
                    return;
                subscription.seq = frame.payload.seq;
                subscription.onEvent(frame.payload);
                return;
            }
            case "pty":
                for (const listener of this.ptyListeners)
                    listener(frame.ptyId, frame.data);
                return;
            case "ptyClosed":
                for (const listener of this.ptyListeners)
                    listener(frame.ptyId, null);
                return;
            case "notice":
                for (const listener of this.noticeListeners)
                    listener(frame.level, frame.message);
                return;
        }
    }
    dropped() {
        if (this.stopped)
            return;
        this.setState("reconnecting");
        this.socket = null;
        const backoff = this.options.backoffMs ?? ((attempt) => Math.min(1000 * 2 ** attempt, 15_000));
        const delay = backoff(this.attempt++);
        setTimeout(() => this.connect(), delay);
    }
    setState(state) {
        if (this.state === state)
            return;
        this.state = state;
        for (const listener of this.stateListeners)
            listener(state);
    }
}
