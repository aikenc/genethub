import { Client, type ClientOptions, type ProtocolDial } from "./client";
import type { Endpoint, Target } from "./target";

export interface MachineRef extends Target {
  /** The route is a dialing instruction; deviceHandle is the daemon identity. */
  routeId: string;
}
export interface MachineSource {
  targets(options?: { requireComplete?: boolean }): Promise<Target[]>;
  openTarget(id: string, options?: { remember?: boolean }): Promise<Endpoint>;
}
export interface MachineLease {
  client: Client;
  endpoint: Endpoint;
  release(): void;
}
interface Entry {
  target: Target;
  client?: Client;
  endpoint?: Endpoint;
  ready: Promise<void>;
  users: number;
  foreground: number;
  touched: number;
  timer?: ReturnType<typeof setTimeout>;
  stop?: () => void;
  removed: boolean;
  failure?: Error;
}
export interface MachineConnectionOptions extends Pick<ClientOptions, "socketFactory" | "onDiagnostic"> {
  limit?: number;
  idleMs?: number;
  timeoutMs?: number;
  rtcEnabled?: boolean | (() => boolean);
  connect?(endpoint: Endpoint, redial: () => Promise<string | ProtocolDial>): Client;
}

export function dialOf(endpoint: Endpoint): ProtocolDial {
  return { url: endpoint.url, bulk: endpoint.bulk, channelCredential: endpoint.channelCredential,
    fabricRouteTicket: endpoint.fabricRouteTicket, fabricAuthorizationExpiresAt: endpoint.fabricAuthorizationExpiresAt,
    localServerProof: endpoint.localServerProof };
}

/** Normalize once at the directory boundary, never confuse a route with identity. */
export function machineRefs(targets: Target[]): MachineRef[] {
  const unique = new Map<string, MachineRef>();
  for (const target of targets) {
    const key = target.deviceHandle ?? target.fingerprint ?? `route:${target.id}`;
    const previous = unique.get(key);
    const rank = (entry: Target) => (entry.online === true ? 4 : entry.online === false ? 0 : 2) + (entry.kind === "local" ? 1 : 0);
    if (!previous || rank(target) > rank(previous)) {
      unique.set(key, { ...target, routeId: target.id });
    }
  }
  return [...unique.values()];
}

/** The page's sole owner of machine clients. Readers borrow; only the owner closes. */
export class MachineConnections {
  private entries = new Set<Entry>();
  private invalidated = new Set<(target: Target) => void>();
  private disposed = false;
  private limit: number;
  constructor(private source: MachineSource, private options: MachineConnectionOptions = {}) {
    this.limit = options.limit ?? 4;
  }
  async targets(): Promise<MachineRef[]> {
    try {
      const targets = machineRefs(await this.source.targets({ requireComplete: true }));
      // A successful directory read is authoritative. A failed read preserves
      // working local connections; an authorization rejection invalidates all.
      for (const entry of this.entries) {
        const target = targets.find(target => this.matches(entry, target));
        if (target) entry.target = target;
        else if (entry.target.id !== "default" || entry.client?.identity) this.remove(entry, true);
      }
      return targets;
    } catch (error) {
      if (accessDenied(error)) this.invalidateAll();
      throw error;
    }
  }
  hasReady(target: Target): boolean {
    return [...this.entries].some(entry => this.matches(entry, target) && entry.client?.connectionState === "ready");
  }
  onInvalidated(listener: (target: Target) => void): () => void {
    this.invalidated.add(listener);
    return () => this.invalidated.delete(listener);
  }
  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.trim();
  }
  async acquire(target: Target, options: {
    signal?: AbortSignal; foreground?: boolean; endpoint?: Endpoint;
    redial?: () => Promise<string | ProtocolDial>;
  } = {}): Promise<MachineLease> {
    if (this.disposed) throw new Error("machine connections are closed");
    options.signal?.throwIfAborted();
    let entry = [...this.entries].find(entry => this.matches(entry, target));
    if (!entry) {
      this.trim(this.limit - 1);
      if (this.entries.size >= this.limit) throw new Error("连接正忙，请稍后重试。");
      entry = { target, users: 0, foreground: 0, touched: Date.now(), removed: false, ready: Promise.resolve() };
      this.entries.add(entry);
      entry.ready = this.open(entry, options.endpoint, options.redial);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.users++;
    if (options.foreground) entry.foreground++;
    const current = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.users--;
      if (options.foreground) current.foreground--;
      current.touched = Date.now();
      this.rtc(current);
      if (!current.users && !current.removed) {
        if (!current.client || current.client.connectionState !== "ready") { this.remove(current); return; }
        current.timer = setTimeout(() => this.remove(current), this.options.idleMs ?? 60_000);
        this.trim();
      }
    };
    try {
      await abortable(current.ready, options.signal);
      if (current.removed || !current.client || !current.endpoint) throw new Error("目标机器连接已关闭。");
      this.verify(current, target);
      this.rtc(current);
      return { client: current.client, endpoint: current.endpoint, release };
    } catch (error) {
      if (accessDenied(error)) this.remove(current, true);
      release();
      throw error;
    }
  }
  async use<T>(target: Target, action: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lease = await this.acquire(target, { signal });
    try { return await action(lease.client); }
    catch (error) {
      if (accessDenied(error)) for (const entry of [...this.entries]) if (this.matches(entry, target)) this.remove(entry, true);
      throw error;
    } finally { lease.release(); }
  }
  invalidateAll(): void {
    for (const entry of [...this.entries]) this.remove(entry, true);
  }
  close(): void {
    this.disposed = true;
    for (const entry of [...this.entries]) this.remove(entry);
    this.invalidated.clear();
  }
  private matches(entry: Entry, target: Target): boolean {
    if (entry.removed) return false;
    const identity = entry.client?.identity;
    const device = identity?.machineId ?? entry.target.deviceHandle;
    if (target.deviceHandle && device) return target.deviceHandle === device;
    const fingerprint = identity?.fingerprint ?? entry.target.fingerprint;
    if (target.fingerprint && fingerprint) return target.fingerprint === fingerprint;
    return entry.target.id === target.id;
  }
  private async open(entry: Entry, supplied?: Endpoint, redial?: () => Promise<string | ProtocolDial>): Promise<void> {
    try {
      const endpoint = supplied ?? await deadline(this.source.openTarget(entry.target.id, { remember: false }), this.options.timeoutMs ?? 10_000);
      if (entry.removed || this.disposed) throw new Error("目标机器连接已取消。");
      entry.endpoint = endpoint;
      const reconnect = async () => entry.target.id !== "default"
        ? dialOf(await this.source.openTarget(entry.target.id, { remember: false }))
        : redial ? redial() : dialOf(await this.source.openTarget(entry.target.id, { remember: false }));
      const client = this.options.connect?.(endpoint, reconnect) ?? new Client({ ...this.options, ...dialOf(endpoint),
        credential: endpoint.credential, rtcEnabled: false, redial: reconnect });
      entry.client = client;
      client.setDataChannelEnabled(false);
      client.setRtcEnabled(false);
      entry.stop = client.onStateChange(state => {
        if (state === "ready") {
          try { this.verify(entry, entry.target); }
          catch (error) { entry.failure = error as Error; this.remove(entry, true); }
        } else if (state === "closed") this.remove(entry, accessDenied(client.failure));
      });
      // Install the waiter before connect; a loopback/test transport may become
      // ready synchronously. This deadline belongs to opening, not to a reader.
      const ready = new Promise<void>((resolve, reject) => {
        let stop = () => {};
        const finish = (error?: Error) => { clearTimeout(timer); stop(); error ? reject(error) : resolve(); };
        const timer = setTimeout(() => finish(Object.assign(new Error("目标机器连接超时。"), { code: "timeout" })), this.options.timeoutMs ?? 10_000);
        stop = client.onStateChange(state => {
          if (state === "ready") finish();
          if (state === "closed") finish(entry.failure ?? Object.assign(new Error(client.failure?.message ?? "目标机器连接已关闭。"), { code: client.failure?.code }));
        });
        client.connect();
        if (client.connectionState === "ready") finish();
        else if (client.connectionState === "closed") finish(new Error("目标机器连接已关闭。"));
      });
      await ready;
      this.verify(entry, entry.target);
    } catch (error) {
      this.remove(entry, accessDenied(error));
      throw error;
    }
  }
  private verify(entry: Entry, target: Target): void {
    const identity = entry.client?.identity;
    if (target.deviceHandle && identity?.machineId !== target.deviceHandle ||
        target.fingerprint && identity?.fingerprint !== target.fingerprint ||
        entry.endpoint?.fingerprint && identity?.fingerprint !== entry.endpoint.fingerprint) {
      throw Object.assign(new Error("目标机器身份不匹配。"), { code: "unauthorized" });
    }
  }
  private rtc(entry: Entry): void {
    if (!entry.removed) {
      entry.client?.setDataChannelEnabled(entry.foreground > 0);
      entry.client?.setRtcEnabled(entry.foreground > 0 && (typeof this.options.rtcEnabled === "function" ? this.options.rtcEnabled() : this.options.rtcEnabled !== false));
    }
  }
  private trim(budget = this.limit): void {
    const idle = [...this.entries].filter(entry => !entry.users).sort((a, b) => a.touched - b.touched);
    while (this.entries.size > budget && idle.length) this.remove(idle.shift()!);
  }
  private remove(entry: Entry, denied = false): void {
    if (entry.removed) return;
    entry.removed = true;
    this.entries.delete(entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.stop?.();
    entry.client?.close();
    if (denied) for (const listener of this.invalidated) { try { listener(entry.target); } catch { /* observers do not own the connection */ } }
  }
}
export function accessDenied(error: unknown): boolean {
  const value = error as { status?: number; code?: string; detail?: { code?: string } } | null;
  return [401, 403, 404].includes(value?.status ?? 0) || ["unauthorized", "unauthenticated", "forbidden"].includes(value?.code ?? value?.detail?.code ?? "");
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  });
}

function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("目标机器连接超时。"), { code: "timeout" })), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
