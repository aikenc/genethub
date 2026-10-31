import type { ConnectionAdmission } from "@genehub/proto";
import { randomNonce, type ChannelSessionKey } from "../devices/proof";
import { AuthenticatedChannel, type RecordCarrier } from "./authenticated-channel";
import { decodeDataFrame, encodeDataFrame, DataKind, type DataFrame, type ConnectionPath, type ConnectionPolicy } from "./frame";

const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
function encode(message: ConnectionAdmission): Uint8Array {
  const json = encoder.encode(JSON.stringify(message));
  if (json.length > 8188) throw new Error("connection control too large");
  const bytes = new Uint8Array(4 + json.length);
  bytes.set([4, 16, 0, 0]); bytes.set(json, 4); return bytes;
}
function decode(bytes: Uint8Array): ConnectionAdmission {
  if (bytes.length < 5 || bytes.length > 8192 || bytes[0] !== 4 || bytes[1] !== 16 || bytes[2] || bytes[3]) throw new Error("invalid connection control");
  const value: unknown = JSON.parse(decoder.decode(bytes.subarray(4)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid connection admission");
  const m = value as Record<string, unknown>;
  const fields: Record<string, readonly string[]> = { create: ["policy"], created: ["id"], error: ["code"] };
  if (typeof m.op !== "string" || !Object.hasOwn(fields, m.op) ||
      Object.keys(m).some(k => k !== "op" && !fields[m.op as string]!.includes(k)) ||
      fields[m.op]!.some(k => !Object.hasOwn(m, k))) throw new Error("incompatible connection admission fields");
  if (fields[m.op]!.some(k => typeof m[k] !== "string")) throw new Error("invalid connection admission value");
  return m as unknown as ConnectionAdmission;
}

/** Admission, local writes and heartbeat for exactly one authenticated carrier.
 * Streams and scheduling belong to DataEndpoint. No carrier attach or replay. */
export class LogicalConnection {
  private readonly wire: AuthenticatedChannel;
  private closed = false;
  private admitted = false;
  private connectionId: string | null = null;
  private lastReceive = performance.now();
  private readonly clock: ReturnType<typeof setInterval>;
  private readonly waiters = new Set<{ resolve(): void; reject(error: unknown): void }>();
  private terminal: unknown;
  constructor(private readonly options: {
    role: "client" | "server"; carrier: RecordCarrier; key: ChannelSessionKey;
    policy?: ConnectionPolicy; path?: ConnectionPath;
    onFrame(frame: DataFrame): void;
    onClose(error: unknown): void;
    onReady?(): void; onWritable?(): void;
    onDiagnostic?(detail: Record<string, string | number | boolean | null>): void;
  }) {
    if (options.policy === "direct-only" && options.path === "fabric") throw new Error("PolicyDenied");
    this.wire = new AuthenticatedChannel({ ...options,
      onPlaintext: bytes => this.receive(bytes),
      onClose: reason => this.close(reason ?? new Error("carrier closed")),
      onError: error => this.close(error),
    });
    this.clock = setInterval(() => this.tick(), 5000);
    if (options.role === "client") {
      void this.wire.send(encode({ op: "create", policy: options.policy ?? "relay-allowed" })).catch(e => this.close(e));
    }
  }
  get state(): "connecting" | "ready" | "closed" { return this.closed ? "closed" : this.admitted ? "ready" : "connecting"; }
  get path(): ConnectionPath | null { return this.admitted && !this.closed ? this.options.path ?? "loopback" : null; }
  get id(): string | null { return this.connectionId; }
  ready(): Promise<void> {
    if (this.closed) return Promise.reject(this.terminal);
    if (this.admitted) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.add({ resolve, reject }));
  }
  canSend(): boolean { return this.state === "ready"; }
  async send(frame: DataFrame): Promise<void> {
    await this.ready();
    return this.wire.send(encodeDataFrame(frame));
  }
  close(error: unknown = new Error("connection closed")): void {
    if (this.closed) return;
    this.closed = true; this.terminal = error;
    clearInterval(this.clock);
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    try { this.options.onDiagnostic?.({ phase: "carrier-lost", path: this.options.path ?? "loopback",
      role: this.options.role, reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }); } catch { /* Observers cannot prevent closure. */ }
    this.wire.close(error);
    this.options.onClose(error);
  }
  private async receive(bytes: Uint8Array): Promise<void> {
    this.lastReceive = performance.now();
    if (!this.admitted) {
      const message = decode(bytes);
      if (message.op === "error") throw new Error(String(message.code));
      if (this.options.role === "server" && message.op === "create") {
        if (!["relay-allowed", "direct-only"].includes(String(message.policy)) ||
            message.policy === "direct-only" && this.options.path === "fabric") throw new Error("PolicyDenied");
        this.connectionId = randomNonce();
        await this.wire.send(encode({ op: "created", id: this.connectionId }));
      } else if (this.options.role === "client" && message.op === "created" &&
          typeof message.id === "string" && /^[0-9a-f]{32,64}$/.test(message.id)) {
        this.connectionId = message.id;
      } else throw new Error("invalid connection admission transition");
      if (this.closed) return;
      this.admitted = true;
      // Fabric socket probes own liveness for all routed peers; one peer
      // waiting behind another peer's DATA is not a lost physical path.
      if (this.options.path === "fabric") clearInterval(this.clock);
      for (const waiter of this.waiters) waiter.resolve();
      this.waiters.clear();
      this.options.onReady?.(); this.options.onWritable?.();
      return;
    }
    const frame = decodeDataFrame(bytes);
    if (!frame) throw new Error("invalid connection frame");
    if ((frame.kind === DataKind.Ping || frame.kind === DataKind.Pong) && frame.payload.length !== 0) throw new Error("malformed heartbeat");
    if (frame.kind === DataKind.Ping) {
      await this.wire.send(encodeDataFrame({ ...frame, kind: DataKind.Pong })); return;
    }
    if (frame.kind === DataKind.Pong) return;
    this.options.onFrame(frame);
  }
  private tick(): void {
    if (this.closed) return;
    if (performance.now() - this.lastReceive >= (this.admitted ? 15_000 : 10_000)) {
      this.close(new Error("connection heartbeat timed out")); return;
    }
    if (this.admitted) void this.wire.send(encodeDataFrame({ kind: DataKind.Ping, streamId: 0, value: 0, payload: new Uint8Array() })).catch(e => this.close(e));
  }
}
