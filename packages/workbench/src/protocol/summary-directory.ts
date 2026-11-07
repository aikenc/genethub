import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import type { Endpoint, Target } from "./target";
import { type ClientOptions } from "./client";
import { MachineConnections, accessDenied } from "./machine-connections";
import { readSessionPage } from "./session-pages";

export interface SummarySource { targets():Promise<Target[]>; openTarget(id:string,options?:{remember?:boolean}):Promise<Endpoint>; }
export type SummaryState = "deferred" | "waiting" | "loading" | "ready" | "offline" | "denied" | "timeout" | "unavailable" | "notChecked" | "partial" | "rateLimited";
export interface MachineSummary {
  target: Target;
  version?: string;
  nextCursor?: string | null;
  projectPages?: Record<string, { nextCursor: string | null; error?: string | null }>;
  state: SummaryState;
  stateSource: "directory" | "daemon" | "request";
  observedAt: string;
  updatedAt: string | null;
  sessionTotal: number;
  workspaceTotal: number;
  sessions: SessionSummary[];
  workspaces: WorkspaceInfo[];
}
export interface SummaryDirectory {
  sources: MachineSummary[];
  complete: boolean;
  checked: number;
}
const MAX_SOURCES = 32;
const MAX_ITEMS_PER_SOURCE = 500;
const CONCURRENCY = 2;
const SOURCE_TIMEOUT_MS = 10000;

/** A bounded, read-only compatibility directory; business data stays on its source. */
export class MachineSummaryDirectory {
  private connections: MachineConnections;
  private ownsConnections: boolean;
  private stopInvalidation: () => void;
  private previous = new Map<string, MachineSummary>();
  private controller: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private directoryDenied = false;
  private rows: MachineSummary[] = [];
  private includeArchived = false;
  setIncludeArchived(value: boolean): void { if (value !== this.includeArchived) this.previous.clear(); this.includeArchived = value; }
  private observer: ((value: SummaryDirectory) => void) | null = null;
  constructor(source: SummarySource, private options: Pick<ClientOptions, "socketFactory" | "onDiagnostic"> & { connections?: MachineConnections } = {}) {
    this.ownsConnections = !options.connections;
    this.connections = options.connections ?? new MachineConnections(source, options);
    this.stopInvalidation = this.connections.onInvalidated(target => {
      this.previous.delete(target.id);
      for (const row of this.rows) if (row.target.id === target.id || target.deviceHandle && row.target.deviceHandle === target.deviceHandle) {
        this.previous.delete(row.target.id); this.deny(row);
      }
      this.emit();
    });
  }

  async refresh(onUpdate: (value: SummaryDirectory) => void, signal?: AbortSignal, sourceIds?: ReadonlySet<string>): Promise<SummaryDirectory> {
    if (this.disposed) throw new Error("summary directory is closed");
    this.controller?.abort();
    const controller = new AbortController(), generation = ++this.generation;
    this.controller = controller;
    this.observer = onUpdate;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      let listTimer: ReturnType<typeof setTimeout> | undefined;
      let stopList = () => {};
      const listed = await Promise.race([
        this.connections.targets(),
        new Promise<never>((_, reject) => {
          const cancel = () => reject(new DOMException("Cancelled", "AbortError"));
          stopList = () => controller.signal.removeEventListener("abort", cancel);
          controller.signal.addEventListener("abort", cancel, { once: true });
          listTimer = setTimeout(() => reject(new Error("machine directory timed out")), SOURCE_TIMEOUT_MS);
          if (controller.signal.aborted) cancel();
        }),
      ]).finally(() => { if (listTimer) clearTimeout(listTimer); stopList(); });
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      this.directoryDenied = false;
      const unique = new Map<string, Target>();
      for (const target of listed) {
        const key = target.deviceHandle ?? target.id, previous = unique.get(key);
        if (!previous || previous.online === false && target.online !== false) unique.set(key,target);
      }
      const targets = [...unique.values()];
      const keys = new Set(targets.map(target => target.id));
      // An omitted selection preserves the public bulk-directory API. The UI
      // supplies its expanded sources, including an empty set on first open.
      const activeKeys = new Set(targets.filter(target => !sourceIds || sourceIds.has(target.id)).slice(0, MAX_SOURCES).map(target => target.id));
      for (const id of this.previous.keys()) if (!keys.has(id)) this.previous.delete(id);
      const rows = targets.map((target): MachineSummary => ({
        target, stateSource: "directory", observedAt: new Date().toISOString(), state: sourceIds && !sourceIds.has(target.id) ? "deferred" : !activeKeys.has(target.id) ? "notChecked" : target.online === false ? "offline" : "waiting",
        updatedAt: this.previous.get(target.id)?.updatedAt ?? null,
        projectPages: this.previous.get(target.id)?.projectPages,
        version: this.previous.get(target.id)?.version, nextCursor: this.previous.get(target.id)?.nextCursor,
        sessionTotal: this.previous.get(target.id)?.sessionTotal ?? 0, workspaceTotal: this.previous.get(target.id)?.workspaceTotal ?? 0,
        sessions: this.previous.get(target.id)?.sessions ?? [], workspaces: this.previous.get(target.id)?.workspaces ?? [],
      }));
      this.rows = rows;
      const emit = () => { if (!controller.signal.aborted && this.generation === generation) this.emit(); };
      const pendingRows = rows.filter(row => activeKeys.has(row.target.id)).sort((a,b) => Number(this.connections.hasReady(b.target)) - Number(this.connections.hasReady(a.target)));
      let index = 0;
      emit();
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (!controller.signal.aborted && this.generation === generation) {
          const current = index++;
          if (current >= pendingRows.length) return;
          const row = pendingRows[current]!;
          if (row.state === "offline") continue;
          row.state = "loading"; emit();
          try {
            const value = await this.read(row.target, controller.signal);
            if (controller.signal.aborted || this.generation !== generation) return;
            if (!this.canPublish(row)) { emit(); continue; }
            Object.assign(row, value, { state: value.nextCursor || value.workspaceTotal > MAX_ITEMS_PER_SOURCE ? "partial" : "ready", stateSource: "daemon", observedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            this.previous.delete(row.target.id); this.previous.set(row.target.id, { ...row });
            while (this.previous.size > MAX_SOURCES) this.previous.delete(this.previous.keys().next().value!);
          } catch (error) {
            if (controller.signal.aborted || this.generation !== generation) return;
            if (!this.canPublish(row)) { emit(); continue; }
            row.state = classify(error); row.stateSource = "request"; row.observedAt = new Date().toISOString();
            // An authority rejection invalidates cached content immediately.
            if (row.state === "denied") { row.sessions = []; row.workspaces = []; row.sessionTotal = 0; row.workspaceTotal = 0; row.updatedAt = null; this.previous.delete(row.target.id); }
          }
          emit();
        }
      }));
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const result = this.snapshot(); emit(); return result;
    } catch (error) {
      if (classify(error) === "denied" && !controller.signal.aborted && generation === this.generation) {
        this.directoryDenied = true;
        for (const row of this.rows) this.deny(row);
        this.previous.clear();
        this.connections.invalidateAll();
        this.diagnostic("summary.directory", "denied"); this.emit();
        return this.snapshot();
      }
      throw error;
    } finally { signal?.removeEventListener("abort", abort); if (this.controller === controller) this.controller = null; }
  }

  close(): void {
    this.disposed = true; this.observer = null; this.rows = []; this.generation++; this.controller?.abort(); this.controller = null;
    this.stopInvalidation();
    if (this.ownsConnections) this.connections.close();
    this.previous.clear();
  }

  private canPublish(row: MachineSummary): boolean { return !this.disposed && !this.directoryDenied && row.state !== "denied"; }
  private snapshot(): SummaryDirectory {
    return { sources: this.rows.map(row => ({ ...row })), complete: !this.directoryDenied && this.rows.every(row => row.state === "ready"), checked: this.rows.filter(row => !["deferred","waiting","loading","notChecked"].includes(row.state)).length };
  }
  private emit(): void {
    if (this.disposed) return;
    try { this.observer?.(this.snapshot()); }
    catch { this.diagnostic("summary.observer", "failed"); }
  }
  private diagnostic(operation: string, outcome: string, sourceId?: string): void {
    try { this.options.onDiagnostic?.({ at: new Date().toISOString(), kind: "operation", detail: { operation, phase: "failure", outcome, sourceId: sourceId ?? null } }); } catch { /* observation cannot own a source connection */ }
  }
  private deny(row: MachineSummary): void {
    Object.assign(row, {state:"denied",stateSource:"request",observedAt:new Date().toISOString(),sessions:[],workspaces:[],sessionTotal:0,workspaceTotal:0,updatedAt:null,nextCursor:null,version:undefined});
  }
  async workspacePage(target: Target, workspaceId: string, cursor: string | null = null) {
    const page = await this.connections.use(target, client => readSessionPage(client, workspaceId, cursor, 10, this.includeArchived));
    const row = this.rows.find(row => row.target.id === target.id);
    if (row && this.canPublish(row)) {
      row.sessions = [...new Map([...row.sessions, ...page.sessions].map(s => [s.id, s])).values()];
      row.projectPages = { ...row.projectPages, [workspaceId]: {nextCursor: page.nextCursor, error: page.error} };
      this.previous.set(target.id, { ...row }); this.emit();
    }
    return page;
  }
  /** Continue a source's history without redialing or re-reading earlier pages. */
  async loadMore(target: Target, signal?: AbortSignal): Promise<void> {
    const row = this.rows.find(row => row.target.id === target.id);
    if (!row?.nextCursor || !this.canPublish(row)) return;
    const cursor = row.nextCursor;
    const page = await this.connections.use(target, client => readSessionPage(client, null, cursor, 100, this.includeArchived), signal);
    if (this.disposed || signal?.aborted || !this.canPublish(row) || row.nextCursor !== cursor) return;
    row.sessions = [...new Map([...row.sessions, ...page.sessions].map(s => [s.id, s])).values()];
    row.sessionTotal = row.sessions.length;
    row.nextCursor = page.nextCursor;
    row.state = page.nextCursor ? "partial" : "ready";
    this.previous.set(target.id, { ...row });
    this.emit();
  }
  private async read(target: Target, signal: AbortSignal): Promise<Pick<MachineSummary, "sessions" | "workspaces" | "sessionTotal" | "workspaceTotal" | "nextCursor" | "version" | "projectPages">> {
    const reading = new AbortController();
    const cancel = () => reading.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => reading.abort(Object.assign(new Error("summary source timed out"), { code: "timeout" })), SOURCE_TIMEOUT_MS);
    const operation = this.connections.use(target, async client => {
      target.deviceHandle ??= client.identity?.machineId;
      target.fingerprint ??= client.identity?.fingerprint;
      const [page, workspaces] = await Promise.all([
        readSessionPage(client, null, null, 100, this.includeArchived), client.call({ type: "workspace.list" }, { timeoutMs: 10_000 }),
      ]);
      if (workspaces?.type !== "workspaces") throw new Error("invalid source summary");
      // The newest machine-wide page may contain only busy child Spaces.
      // Fetch root conversation previews separately so opening a project always
      // shows its user-facing conversations, without reading its whole history.
      const roots = workspaces.data.filter(w => !w.agentSpace?.parentWorkspaceId &&
        workspaces.data.some(child => child.agentSpace?.parentWorkspaceId === w.id)).slice(0, 32);
      const projectPages: NonNullable<MachineSummary["projectPages"]> = {};
      const previews: SessionSummary[] = [];
      for (let at = 0; at < roots.length; at += 10) {
        const reply = await client.call({ type: "session.page", payload: {
          requests: roots.slice(at, at + 10).map(w => ({workspaceId: w.id, limit: 5, cursor: null})),
          includeArchived: this.includeArchived,
        } }, {timeoutMs: 10_000});
        if (reply?.type !== "sessionPages") throw new Error("invalid project conversation preview");
        for (const result of reply.data) if (result.workspaceId) {
          projectPages[result.workspaceId] = {nextCursor: result.nextCursor, error: result.error};
          if (!result.error) previews.push(...result.sessions);
        }
      }
      return { sessions: [...new Map([...page.sessions, ...previews].map(s => [s.id,s])).values()], workspaces: workspaces.data,
        sessionTotal: page.sessions.length, workspaceTotal: workspaces.data.length, nextCursor: page.nextCursor,
        version: client.identity?.daemonVersion, projectPages };
    }, reading.signal);
    // Cancellation discards this reader, never a client that other views use.
    const stopped = new Promise<never>((_, reject) => {
      const abort = () => reject(reading.signal.reason ?? new DOMException("Cancelled", "AbortError"));
      reading.signal.addEventListener("abort", abort, { once: true });
      operation.finally(() => reading.signal.removeEventListener("abort", abort)).catch(() => {});
      if (reading.signal.aborted) abort();
    });
    try { return await Promise.race([operation, stopped]); }
    catch (error) { this.diagnostic("summary.read", classify(error), target.deviceHandle ?? target.id); throw error; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
  }
}
function classify(error: unknown): SummaryState {
  const value = error as { status?: number; code?: string; detail?: { code?: string } };
  const code = value?.code ?? value?.detail?.code;
  if (accessDenied(error)) return "denied";
  if (value?.status === 429) return "rateLimited";
  if (value?.status === 409 || code === "machineOffline") return "offline";
  if ([408,504].includes(value?.status ?? 0) || code === "timeout" || (error instanceof Error && error.name === "ClientRequestTimeoutError")) return "timeout";
  return "unavailable";
}
