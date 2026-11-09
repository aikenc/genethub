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
export type MachineRetireReason = "capacity" | "idle" | "closed" | "denied" | "disposed";
/** A long-lived consumer, such as a directory subscription, of an open client. */
export interface MachineHolder {
  /** Called before the owner closes the client; the holder must stop using it. */
  retired(reason: MachineRetireReason): void;
  /** Preferred holders are displaced last. */
  preferred?(): boolean;
}
type Redial = (signal?: AbortSignal) => Promise<string | ProtocolDial>;
interface Entry {
  target: Target;
  client?: Client;
  endpoint?: Endpoint;
  ready: Promise<void>;
  users: number;
  foreground: number;
  holders: Set<MachineHolder>;
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
  connect?(endpoint: Endpoint, redial: Redial): Client;
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
  private available = new Set<() => void>();
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
  /**
   * Keeps an open client past its leases until the holder releases it or the
   * owner retires it. Returns undefined when the pool no longer owns the client.
   */
  retain(client: Client, holder: MachineHolder): (() => void) | undefined {
    const entry = [...this.entries].find(entry => entry.client === client && !entry.removed);
    if (!entry) return undefined;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.holders.add(holder);
    return () => {
      if (!entry.holders.delete(holder) || entry.removed) return;
      this.settle(entry);
      this.wake();
    };
  }
  async acquire(target: Target, options: {
    signal?: AbortSignal; foreground?: boolean; endpoint?: Endpoint; redial?: Redial;
    /** false: never close another holder's client to make room. */
    displace?: boolean;
  } = {}): Promise<MachineLease> {
    if (this.disposed) throw new Error("machine connections are closed");
    options.signal?.throwIfAborted();
    const deadlineAt = Date.now() + (this.options.timeoutMs ?? 10_000);
    const displace = options.foreground || options.displace !== false;
    let entry: Entry | undefined;
    for (;;) {
      if (this.disposed) throw new Error("machine connections are closed");
      options.signal?.throwIfAborted();
      entry = [...this.entries].find(entry => this.matches(entry, target));
      if (entry) break;
      this.trim(this.limit - 1, displace);
      const background = [...this.entries].filter(e => e.users > 0 && e.foreground === 0).length;
      if (this.entries.size < this.limit && (options.foreground || background < Math.max(1, this.limit - 1))) break;
      if (!displace && this.entries.size >= this.limit && ![...this.entries].some(e => e.users > 0 && !e.holders.size)) {
        throw Object.assign(new Error("连接名额正用于实时目录。"), { code: "capacity" });
      }
      if (this.available.size >= 64) throw new Error("连接等待已满，请稍后重试。");
      await this.waitAvailable(deadlineAt, options.signal);
    }
    if (!entry) {
      entry = { target, users: 0, foreground: 0, holders: new Set(), touched: Date.now(), removed: false, ready: Promise.resolve() };
      this.entries.add(entry);
      entry.ready = this.open(entry, options.endpoint, options.redial);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
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
      this.wake();
      if (!current.users && !current.removed) {
        this.settle(current);
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
  async use<T>(target: Target, action: (client: Client) => Promise<T>, signal?: AbortSignal, background = false, displace = true): Promise<T> {
    const lease = await this.acquire(target, { signal, foreground: !background, displace });
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
    for (const entry of [...this.entries]) this.remove(entry, false, "disposed");
    this.invalidated.clear();
    this.wake();
  }
  private wake(): void { for (const resolve of this.available) resolve(); }
  private async waitAvailable(deadlineAt: number, signal?: AbortSignal): Promise<void> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw Object.assign(new Error("连接等待超时，请重试。"), {code: "timeout"});
    let wake!: () => void;
    const waiting = new Promise<void>(resolve => { wake = resolve; this.available.add(wake); });
    try { await abortable(deadline(waiting, remaining), signal); }
    finally { this.available.delete(wake); }
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
  private async open(entry: Entry, supplied?: Endpoint, redial?: Redial): Promise<void> {
    try {
      const endpoint = supplied ?? await deadline(this.source.openTarget(entry.target.id, { remember: false }), this.options.timeoutMs ?? 10_000);
      if (entry.removed || this.disposed) throw new Error("目标机器连接已取消。");
      entry.endpoint = endpoint;
      const reconnect = async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (entry.removed) throw new Error("目标机器连接已关闭。");
        if (entry.target.id === "default" && redial) return redial(signal);
        return dialOf(await abortable(this.source.openTarget(entry.target.id, { remember: false }), signal));
      };
      const client = this.options.connect?.(endpoint, reconnect) ?? new Client({ ...this.options, ...dialOf(endpoint),
        credential: endpoint.credential, rtcEnabled: false, redial: reconnect });
      entry.client = client;
      client.setDataChannelEnabled(false);
      client.setRtcEnabled(false);
      entry.stop = client.onStateChange(state => {
        if (state === "reconnecting") this.rtc(entry);
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
      // Promotion retires the relay carrier. A background lease must retain
      // that healthy RTC connection rather than close its only live path.
      // After a real loss activePath is null, so background redials use relay.
      entry.client?.setRtcEnabled((entry.foreground > 0 || entry.client.activePath === "rtc") && (typeof this.options.rtcEnabled === "function" ? this.options.rtcEnabled() : this.options.rtcEnabled !== false));
    }
  }
  /** An unused entry stays only while held; a held client recovers itself. */
  private settle(entry: Entry): void {
    if (entry.users || entry.removed || entry.timer) return;
    if (entry.holders.size) return;
    if (!entry.client || entry.client.connectionState !== "ready") { this.remove(entry); return; }
    entry.timer = setTimeout(() => this.remove(entry, false, "idle"), this.options.idleMs ?? 60_000);
  }
  private trim(budget = this.limit, displace = true): void {
    const preferred = (entry: Entry) => [...entry.holders].some(holder => { try { return holder.preferred?.() === true; } catch { return false; } });
    const idle = [...this.entries].filter(entry => !entry.users && (displace || !entry.holders.size))
      .sort((a, b) => Number(a.holders.size > 0) - Number(b.holders.size > 0) || Number(preferred(a)) - Number(preferred(b)) || a.touched - b.touched);
    while (this.entries.size > budget && idle.length) this.remove(idle.shift()!, false, "capacity");
  }
  private remove(entry: Entry, denied = false, reason: MachineRetireReason = "closed"): void {
    if (entry.removed) return;
    entry.removed = true;
    this.entries.delete(entry);
    this.wake();
    if (entry.timer) clearTimeout(entry.timer);
    entry.stop?.();
    const holders = [...entry.holders];
    entry.holders.clear();
    for (const holder of holders) { try { holder.retired(denied ? "denied" : reason); } catch { /* holders do not own the connection */ } }
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
