import type {
  HelloResult,
  ProtocolError,
  Reply,
  Request,
  SequencedEvent,
  ServerFrame,
} from "@genehub/proto";

import { proof, randomNonce } from "../devices/proof";

export const PROTOCOL_VERSION = 1;

export type ConnectionState =
  "connecting" | "ready" | "reconnecting" | "closed";

export interface ClientOptions {
  url: string;
  /**
   * Where to dial on a *retry*, when the address above cannot be used twice.
   *
   * A forwarding ticket is spent by the connection that used it, so a client
   * that redialled `url` would fail every attempt after the first — one wifi
   * hiccup and the session is over with no sign of why. Absent means the
   * address keeps working, which is true of a loopback port and of a pairing
   * credential.
   */
  redial?: () => Promise<string>;
  clientName?: string;
  /**
   * Present when this browser paired with the machine earlier. Required by a
   * machine reached through a rendezvous relay, which vouches for nobody.
   */
  credential?: { deviceId: string; secret: string };
  /** Injected in tests, and by the desktop host when it wants its own socket. */
  socketFactory?: (url: string) => WebSocketLike;
  /** Delay before each reconnection attempt. Also injected in tests. */
  backoffMs?: (attempt: number) => number;
  now?: () => number;
}

/** The slice of `WebSocket` this client uses, so a fake is cheap to write. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * Events arrive addressed to a topic, `session:<id>`. Subscriptions are keyed
 * by the session id itself, because that is what every caller has.
 */
function sessionOf(topic: string): string {
  return topic.startsWith("session:") ? topic.slice("session:".length) : topic;
}

export class ProtocolError_ extends Error {
  constructor(public readonly detail: ProtocolError) {
    super(detail.message);
    this.name = "ProtocolError";
  }
}

type Pending = {
  resolve: (reply: Reply | undefined) => void;
  reject: (error: unknown) => void;
};

interface Subscription {
  /** Last sequence number applied, so a reconnect asks for the gap only. */
  seq: number;
  onEvent(event: SequencedEvent): void;
  /**
   * Called after a reconnect. `reset` means the gap was too old and the
   * snapshot is a fresh start rather than a continuation.
   */
  onResync(snapshot: unknown, replayed: SequencedEvent[], reset: boolean): void;
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
  private socket: WebSocketLike | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly ptyListeners = new Set<
    (ptyId: string, data: string | null) => void
  >();
  private readonly noticeListeners = new Set<
    (level: string, message: string) => void
  >();
  private nextId = 1;
  private attempt = 0;
  private stopped = false;
  private queue: string[] = [];
  private state: ConnectionState = "connecting";
  /** Why the connection gave up, when it did so for a reason worth showing. */
  failure: ProtocolError | null = null;
  /** What the daemon said it is, including the key fingerprint to compare. */
  identity: HelloResult | null = null;

  constructor(private readonly options: ClientOptions) {}

  get connectionState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onPty(listener: (ptyId: string, data: string | null) => void): () => void {
    this.ptyListeners.add(listener);
    return () => this.ptyListeners.delete(listener);
  }

  onNotice(listener: (level: string, message: string) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  connect(): void {
    if (this.stopped) return;
    const { url, redial } = this.options;
    if (this.attempt === 0 || !redial) {
      this.dial(url);
      return;
    }

    // Asking where to dial can itself fail — the control plane that mints the
    // address may be the thing that is down. That is a dropped connection like
    // any other, so it backs off and asks again rather than giving up here.
    void redial().then(
      (fresh) => {
        if (!this.stopped) this.dial(fresh);
      },
      () => this.dropped(),
    );
  }

  private dial(url: string): void {
    const factory =
      this.options.socketFactory ??
      ((at: string) => new WebSocket(at) as WebSocketLike);
    const socket = factory(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      void this.handshake();
    };
    socket.onmessage = (event) => this.receive(String(event.data));
    socket.onclose = () => this.dropped();
    socket.onerror = () => socket.close();
  }

  close(): void {
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
  async call(request: Request): Promise<Reply | undefined> {
    const id = String(this.nextId++);
    const frame = JSON.stringify({ id, ...request });
    const promise = new Promise<Reply | undefined>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    if (this.state === "ready") this.socket?.send(frame);
    // Queued rather than rejected: a request typed during a blip should land
    // when the socket comes back, not fail in the user's face.
    else this.queue.push(frame);

    return promise;
  }

  /**
   * Subscribes to a session. Returns the initial snapshot; later reconnects
   * deliver theirs through `onResync`.
   */
  async subscribe(
    sessionId: string,
    handlers: Pick<Subscription, "onEvent" | "onResync">,
  ): Promise<{
    snapshot: unknown;
    replayed: SequencedEvent[];
    reset: boolean;
  }> {
    const subscription: Subscription = { seq: 0, ...handlers };
    this.subscriptions.set(sessionId, subscription);

    const reply = await this.call({
      type: "subscribe",
      payload: { sessionId, sinceSeq: 0 },
    });
    if (reply?.type !== "subscribed") {
      this.subscriptions.delete(sessionId);
      throw new Error(`unexpected reply to subscribe: ${reply?.type}`);
    }
    for (const event of reply.data.replayed) subscription.seq = event.seq;
    return {
      snapshot: reply.data.snapshot,
      replayed: reply.data.replayed,
      reset: reply.data.reset,
    };
  }

  async unsubscribe(sessionId: string): Promise<void> {
    this.subscriptions.delete(sessionId);
    await this.call({ type: "unsubscribe", payload: { sessionId } });
  }

  // -------------------------------------------------------------------------

  private async handshake(): Promise<void> {
    const credential = this.options.credential;
    const nonce = credential ? randomNonce() : null;
    const id = String(this.nextId++);
    const frame = JSON.stringify({
      id,
      type: "hello",
      payload: {
        clientName: this.options.clientName ?? "genehub-web",
        protocolVersion: PROTOCOL_VERSION,
        device:
          credential && nonce
            ? {
                deviceId: credential.deviceId,
                nonce,
                proof: await proof("client", nonce, credential.secret),
              }
            : undefined,
      },
    });
    const promise = new Promise<Reply | undefined>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket?.send(frame);

    try {
      const reply = await promise;
      if (reply?.type === "hello") {
        // The machine has to prove itself too. Skipping this would leave the
        // door open to whoever got to the rendezvous slot first: they cannot
        // read anything, but they could impersonate the machine to the user.
        if (credential && nonce) {
          const expected = await proof("server", nonce, credential.secret);
          if (reply.data.proof !== expected) {
            throw new ProtocolError_({
              code: "unauthorized",
              message: "对面不是你配对过的那台机器，连接已断开",
            });
          }
        }
        this.identity = reply.data;
      }
    } catch (error) {
      // A refused handshake is not something retrying fixes: the versions do
      // not match, or the credential is wrong. Stop, and keep the reason so the
      // UI can say which of those it was instead of spinning forever.
      this.failure = error instanceof ProtocolError_ ? error.detail : null;
      this.close();
      return;
    }

    this.setState("ready");
    for (const frame of this.queue.splice(0)) this.socket?.send(frame);
    await this.resubscribe();
  }

  /** Asks for the gap on every open session. */
  private async resubscribe(): Promise<void> {
    for (const sessionId of [...this.subscriptions.keys()]) {
      await this.fillGap(sessionId);
    }
  }

  /**
   * Asks for whatever happened on one session since the last sequence number
   * this client saw.
   *
   * The same request serves a reconnect and a dropped-events notice, because
   * they are the same situation: this client's view stops at some sequence
   * number and the daemon's does not.
   */
  private async fillGap(sessionId: string): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) return;

    const reply = await this.call({
      type: "subscribe",
      payload: { sessionId, sinceSeq: subscription.seq },
    }).catch(() => undefined);
    if (reply?.type !== "subscribed") return;

    for (const event of reply.data.replayed) subscription.seq = event.seq;
    subscription.onResync(
      reply.data.snapshot,
      reply.data.replayed,
      reply.data.reset,
    );
  }

  private receive(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }

    switch (frame.type) {
      case "result": {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.payload);
        else {
          pending.reject(
            new ProtocolError_(
              frame.error ?? {
                code: "internal",
                message: "the daemon reported a failure",
              },
            ),
          );
        }
        return;
      }
      case "event": {
        const subscription = this.subscriptions.get(sessionOf(frame.topic));
        if (!subscription) return;
        // Out-of-order or duplicate events are dropped rather than applied:
        // the sequence number is the only thing that decides what is new.
        if (frame.payload.seq <= subscription.seq) return;
        subscription.seq = frame.payload.seq;
        subscription.onEvent(frame.payload);
        return;
      }
      case "pty":
        for (const listener of this.ptyListeners)
          listener(frame.ptyId, frame.data);
        return;
      case "ptyClosed":
        for (const listener of this.ptyListeners) listener(frame.ptyId, null);
        return;
      case "notice":
        for (const listener of this.noticeListeners)
          listener(frame.level, frame.message);
        return;
      case "desync":
        // The daemon fell behind and dropped events for this session. Nothing
        // to tell the person: the hole is closable from here, with the same
        // request used after a reconnect.
        void this.fillGap(frame.sessionId);
        return;
    }
  }

  private dropped(): void {
    if (this.stopped) return;
    this.setState("reconnecting");
    this.socket = null;

    const backoff =
      this.options.backoffMs ??
      ((attempt) => Math.min(1000 * 2 ** attempt, 15_000));
    const delay = backoff(this.attempt++);
    setTimeout(() => this.connect(), delay);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
