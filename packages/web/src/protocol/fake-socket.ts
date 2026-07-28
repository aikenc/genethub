import type { Reply, SequencedEvent, ServerFrame } from "@genehub/proto";

import type { WebSocketLike } from "./client";

interface Sent {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * A socket the test drives by hand.
 *
 * The point is to control ordering: a reconnect that races a reply, an event
 * arriving before its subscribe returns, a gap the daemon cannot fill. None of
 * those are reachable against a real socket without sleeping and hoping.
 */
export class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  readonly sent: Sent[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }

  /** The server accepting the connection. */
  open(): void {
    this.onopen?.({});
  }

  /** Answers a request by id. */
  reply(id: string, payload: Reply | undefined): void {
    this.deliver({ type: "result", id, ok: true, payload });
  }

  fail(id: string, code = "internal", message = "nope"): void {
    this.deliver({
      type: "result",
      id,
      ok: false,
      error: { code: code as never, message },
    });
  }

  /**
   * Pushes a session event. The topic is built the way the daemon builds it,
   * because a fake that addresses events differently from the real thing is a
   * fake that hides exactly the bug it should be catching.
   */
  event(sessionId: string, event: SequencedEvent): void {
    this.deliver({ type: "event", topic: `session:${sessionId}`, payload: event });
  }

  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The last request of a given type, which is usually the one under test. */
  lastOf(type: string): Sent {
    const found = [...this.sent].reverse().find((message) => message.type === type);
    if (!found) throw new Error(`no ${type} was sent; saw ${this.sent.map((s) => s.type).join(", ")}`);
    return found;
  }

  /** Completes the handshake so a test can get to the interesting part. */
  acceptHandshake(): void {
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
export function socketQueue(): {
  factory: (url: string) => WebSocketLike;
  sockets: FakeSocket[];
  latest(): FakeSocket;
} {
  const sockets: FakeSocket[] = [];
  return {
    factory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sockets,
    latest() {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error("nothing has connected yet");
      return socket;
    },
  };
}
