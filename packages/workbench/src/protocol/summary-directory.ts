import type { CatalogScopeError, CatalogBatch, SessionSummary, WorkspaceInfo } from "@genehub/proto";
import type { Endpoint, Target } from "./target";
import { type Client, type ClientOptions } from "./client";
import { MachineConnections, accessDenied } from "./machine-connections";
import { readActivitySessions, readSessionPage } from "./session-pages";
import { directoryCacheEpoch, onDirectoryCachesCleared, readDirectoryCache, writeDirectoryCache, removeDirectoryCache } from "./summary-directory-cache";

export interface SummarySource { targets():Promise<Target[]>; openTarget(id:string,options?:{remember?:boolean}):Promise<Endpoint>; }
export type SummaryState = "deferred" | "waiting" | "loading" | "ready" | "offline" | "denied" | "timeout" | "unavailable" | "notChecked" | "partial" | "rateLimited";
export interface MachineSummary {
  sessionEtags?: Record<string,string>;
  workspaceEtags?: Record<string,string>;
  catalogRevision?: number;
  catalogGeneration?: number;
  daemonInstanceId?: string;
  cached?: boolean;
  catalogErrors?: CatalogScopeError[];
  pageViews?: Record<string,{etag:string;ids:string[]}>;
  target: Target;
  version?: string;
  nextCursor?: string | null;
  projectPages?: Record<string, { nextCursor: string | null; error?: string | null }>;
  state: SummaryState;
  /** Refresh progress is independent of the last confirmed source state. */
  refreshing?: boolean;
  stateSource: "directory" | "daemon" | "request";
  observedAt: string;
  updatedAt: string | null;
  sessionTotal: number;
  workspaceTotal: number;
  sessions: SessionSummary[];
  /** A complete current-work set; history paging is independent. */
  activeSessions?: SessionSummary[];
  activityComplete?: boolean;
  workspaces: WorkspaceInfo[];
}
export const machineReady = (row: MachineSummary) => row.state === "ready" || row.state === "partial";
export interface SummaryDirectory {
  sources: MachineSummary[];
  complete: boolean;
  checked: number;
}
// References/listeners only: the directory remains the sole row owner. The
// body store reads this view instead of running another summary synchronizer.
const clientSources = new WeakMap<Client, () => MachineSummary | undefined>();
const sourceReaders = new WeakMap<Client, Set<(row: MachineSummary) => void>>();
export function observeCatalogSource(client: Client, reader: (row: MachineSummary) => void): () => void {
  let readers = sourceReaders.get(client);
  if (!readers) {readers=new Set(); sourceReaders.set(client,readers);}
  readers.add(reader);
  const row = clientSources.get(client)?.(); if (row) reader(row);
  return () => readers!.delete(reader);
}
export function readCatalogSource(client: Client): Promise<MachineSummary> {
  const current = clientSources.get(client)?.();
  if (current?.catalogRevision !== undefined && machineReady(current) && !current.refreshing) return Promise.resolve(current);
  return new Promise((resolve,reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {stop(); reject(new Error("目录尚未就绪，请重试。"));}, 45_000);
    stop = observeCatalogSource(client, row => {
      if (row.catalogRevision !== undefined && machineReady(row) && !row.refreshing) {clearTimeout(timer); queueMicrotask(() => stop()); resolve(row);}
      else if (["denied","offline","timeout","unavailable"].includes(row.state)) {clearTimeout(timer); queueMicrotask(() => stop()); reject(new Error("目录读取未完成，请重试。"));}
    });
  });
}
function sameMachine(a: Target, b: Target): boolean {
  if (a.fingerprint && b.fingerprint && a.fingerprint !== b.fingerprint) return false;
  if (a.deviceHandle && b.deviceHandle) return a.deviceHandle === b.deviceHandle;
  if (a.fingerprint && b.fingerprint) return a.fingerprint === b.fingerprint;
  return a.id === b.id;
}
const MAX_SOURCES = 32;
const MAX_ITEMS_PER_SOURCE = 500;
const CONCURRENCY = 2;
// A cold large metadata catalog can take seconds in the guest. Background
// reads remain bounded and leave foreground connection capacity available.
const SOURCE_TIMEOUT_MS = 45_000;

/** A bounded, read-only compatibility directory; business data stays on its source. */
export class MachineSummaryDirectory {
  private connections: MachineConnections;
  private ownsConnections: boolean;
  private stopInvalidation: () => void;
  private controller: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private directoryDenied = false;
  private rows: MachineSummary[] = [];
  private includeArchived = false;
  private rotation = 0;
  setIncludeArchived(value: boolean): void {
    if (value !== this.includeArchived) {
      this.controller?.abort(); this.generation++;
      for (const watch of this.watches.values()) {watch.stop();clientSources.delete(watch.client);}
      this.watches.clear(); this.rows = [];
    }
    this.includeArchived = value;
  }
  private observer: ((value: SummaryDirectory) => void) | null = null;
  private observers = new Set<(value: SummaryDirectory) => void>();
  private watches = new Map<string, {client: Client; stop():void; ready:Promise<void>; repair?:Promise<void>}>();
  private cacheScope = "";
  private cacheEpoch = directoryCacheEpoch();
  private hydrated = new Set<string>();
  private stopCacheClear: () => void;
  private dirtyCache = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  get value(): SummaryDirectory {return this.snapshot();}
  subscribe(observer: (value: SummaryDirectory) => void): () => void {
    this.observers.add(observer); observer(this.snapshot()); return () => this.observers.delete(observer);
  }
  constructor(source: SummarySource | MachineConnections, private options: Pick<ClientOptions, "socketFactory" | "onDiagnostic"> & { connections?: MachineConnections; cacheScope?: () => Promise<string | null> } = {}) {
    const shared = source instanceof MachineConnections ? source : options.connections;
    this.ownsConnections = !shared;
    this.connections = shared ?? new MachineConnections(source as SummarySource, options);
    this.stopCacheClear=onDirectoryCachesCleared(() => {
      for (const row of this.rows) this.deny(row);
      this.connections.invalidateAll(); this.emit();
    });
    this.stopInvalidation = this.connections.onInvalidated(target => {
      for (const row of this.rows) if (row.target.id === target.id || target.deviceHandle && row.target.deviceHandle === target.deviceHandle) {
        this.deny(row);
      }
      this.emit();
    });
  }

  async refresh(onUpdate?: (value: SummaryDirectory) => void, signal?: AbortSignal, sourceIds?: ReadonlySet<string>, force = false): Promise<SummaryDirectory> {
    if (this.disposed) throw new Error("summary directory is closed");
    this.controller?.abort();
    const controller = new AbortController(), generation = ++this.generation;
    this.controller = controller;
    if (onUpdate) this.observer = onUpdate;
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
      let scope=this.cacheScope;
      try {scope=await this.options.cacheScope?.() ?? "";} catch {/* A transient discovery error is not an identity change. */}
      if (this.cacheScope && scope !== this.cacheScope) {
        for (const watch of this.watches.values()) watch.stop();
        this.watches.clear(); this.rows=[]; this.hydrated.clear();
      }
      this.cacheScope = scope;
      const unique = new Map<string, Target>();
      for (const target of listed) {
        const key = target.deviceHandle ?? target.id, previous = unique.get(key);
        if (!previous || previous.online === false && target.online !== false) unique.set(key,target);
      }
      const targets = [...unique.values()];
      // An omitted selection preserves the public bulk-directory API. The UI
      // supplies its expanded sources, including an empty set on first open.
      const eligible = targets.filter(target => !sourceIds || sourceIds.has(target.id));
      const start = this.rotation % Math.max(eligible.length, 1);
      const scheduled = [...eligible.slice(start), ...eligible.slice(0, start)].slice(0, MAX_SOURCES);
      this.rotation = (start + scheduled.length) % Math.max(eligible.length, 1);
      const activeKeys = new Set(scheduled.map(target => target.id));
      for (const row of this.rows) if (!targets.some(target => sameMachine(target,row.target))) this.deny(row);
      const rows = targets.map((target): MachineSummary => {
        // Retain the most recent outcome, including a failed read. A retry must
        // not resurrect an older healthy state before the source answers.
        const previous = this.rows.find(row => sameMachine(row.target,target));
        if (previous && previous.target.id !== target.id) {
          const old=this.watches.get(previous.target.id);old?.stop();
          this.watches.delete(previous.target.id); if (old) clientSources.delete(old.client);
          this.hydrated.add(target.id);
        }
        const checking = activeKeys.has(target.id) && target.online !== false;
        const confirmed = checking && (previous?.state === "ready" || previous?.state === "partial");
        const next: MachineSummary = {
        ...previous,
        target, stateSource: "directory", observedAt: new Date().toISOString(), state: sourceIds && !sourceIds.has(target.id) ? "deferred" : !activeKeys.has(target.id) ? "notChecked" : target.online === false ? "offline" : "waiting",
        ...(confirmed ? {state: previous.state, stateSource: previous.stateSource, observedAt: previous.observedAt} : {}),
        refreshing: checking,
        updatedAt: previous?.updatedAt ?? null,
        projectPages: previous?.projectPages,
        version: previous?.version, nextCursor: previous?.nextCursor,
        sessionTotal: previous?.sessionTotal ?? 0, workspaceTotal: previous?.workspaceTotal ?? 0,
        sessions: previous?.sessions ?? [], activeSessions: previous?.activeSessions, activityComplete: confirmed ? previous?.activityComplete : false, workspaces: previous?.workspaces ?? [],
      }; return previous ? Object.assign(previous,next) : next; });
      this.rows = rows;
      if (scope) await Promise.all(rows.filter(row => !this.hydrated.has(row.target.id)).map(async row => {
        this.hydrated.add(row.target.id);
        const cached = await readDirectoryCache(scope,row.target);
        if (cached && row.catalogRevision === undefined && !this.disposed && generation === this.generation && !controller.signal.aborted && row.state !== "denied") {
          Object.assign(row,cached,{cached:true,activityComplete:false,sessionTotal:cached.sessions.length,workspaceTotal:cached.workspaces.length});
        }
      }));
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
          if (row.state === "waiting") row.state = "loading";
          emit();
          try {
            const value = await this.read(row.target, controller.signal, force);
            if (controller.signal.aborted || this.generation !== generation) return;
            if (!this.canPublish(row)) { emit(); continue; }
            Object.assign(row, value, { refreshing: false, cached: false, state: (value.nextCursor || (value.workspaceTotal ?? 0) > MAX_ITEMS_PER_SOURCE || row.catalogErrors?.length) ? "partial" : "ready", stateSource: "daemon", observedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            if (row.catalogRevision === undefined) this.dirtyCache.add(row.target.id);
          } catch (error) {
            if (controller.signal.aborted || this.generation !== generation) return;
            if (!this.canPublish(row)) { emit(); continue; }
            row.refreshing = false; row.activityComplete = false; row.state = classify(error); row.stateSource = "request"; row.observedAt = new Date().toISOString();
            // An authority rejection invalidates cached content immediately.
            if (row.state === "denied") { this.deny(row); }
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
        this.connections.invalidateAll();
        this.diagnostic("summary.directory", "denied"); this.emit();
        return this.snapshot();
      }
      throw error;
    } finally { signal?.removeEventListener("abort", abort); if (this.controller === controller) this.controller = null; }
  }

  close(): void {
    this.disposed = true; this.observer = null; this.observers.clear(); this.rows = []; this.generation++; this.controller?.abort(); this.controller = null;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    for (const watch of this.watches.values()) {watch.stop(); clientSources.delete(watch.client);}
    this.watches.clear();
    this.stopInvalidation(); this.stopCacheClear();
    if (this.ownsConnections) this.connections.close();
  }

  private canPublish(row: MachineSummary): boolean { return !this.disposed && !this.directoryDenied && row.state !== "denied"; }
  private snapshot(): SummaryDirectory {
    return { sources: this.rows.map(row => ({ ...row })), complete: !this.directoryDenied && this.rows.every(row => row.state === "ready" && !row.refreshing && !row.cached && (row.catalogRevision === undefined || row.activityComplete === true)), checked: this.rows.filter(row => !row.refreshing && !["deferred","waiting","loading","notChecked"].includes(row.state)).length };
  }
  private emit(): void {
    if (this.disposed) return;
    const value = this.snapshot();
    for (const observer of [this.observer, ...this.observers]) {
      try {observer?.(value);} catch {this.diagnostic("summary.observer", "failed");}
    }
    for (const [id, watch] of this.watches) {
      const row = this.rows.find(row => row.target.id === id);
      if (row) for (const reader of sourceReaders.get(watch.client) ?? []) {try {reader(row);} catch {this.diagnostic("summary.reader", "failed");}}
    }
    if (this.cacheScope && this.dirtyCache.size && !this.persistTimer) this.persistTimer = setTimeout(() => {
      this.persistTimer=undefined;
      const dirty=this.dirtyCache; this.dirtyCache=new Set();
      for (const row of this.rows) if (dirty.has(row.target.id) && this.canPublish(row) && row.activityComplete) void writeDirectoryCache(this.cacheScope,row.target,row,this.cacheEpoch);
    }, 300);
  }
  private diagnostic(operation: string, outcome: string, sourceId?: string): void {
    try { this.options.onDiagnostic?.({ at: new Date().toISOString(), kind: "operation", detail: { operation, phase: "failure", outcome, sourceId: sourceId ?? null } }); } catch { /* observation cannot own a source connection */ }
  }
  private deny(row: MachineSummary): void {
    const watch = this.watches.get(row.target.id); watch?.stop(); this.watches.delete(row.target.id);
    if (watch) clientSources.delete(watch.client);
    void removeDirectoryCache(this.cacheScope,row.target);
    Object.assign(row, {state:"denied",refreshing:false,stateSource:"request",observedAt:new Date().toISOString(),sessions:[],activeSessions:[],activityComplete:false,workspaces:[],projectPages:undefined,sessionTotal:0,workspaceTotal:0,updatedAt:null,nextCursor:null,version:undefined,sessionEtags:undefined,workspaceEtags:undefined,catalogRevision:undefined,cached:false});
    if (watch) for (const reader of sourceReaders.get(watch.client) ?? []) {try {reader(row);} catch {this.diagnostic("summary.reader","failed");}}
  }
  async workspacePage(target: Target, workspaceId: string, cursor: string | null = null) {
    const page = await this.connections.use(target, client => this.currentPage(target,client,workspaceId,cursor,10), undefined, true);
    const row = this.rows.find(row => row.target.id === target.id);
    if (row && this.canPublish(row)) {
      if (page.catalogRevision !== undefined && page.catalogRevision !== row.catalogRevision) throw new Error("目录已更新，请重试此页。");
      row.projectPages = { ...row.projectPages, [workspaceId]: {nextCursor: page.nextCursor, error: page.error} };
      this.emit();
    }
    return page;
  }
  /** Continue a source's history without redialing or re-reading earlier pages. */
  async loadMore(target: Target, signal?: AbortSignal): Promise<void> {
    const row = this.rows.find(row => row.target.id === target.id);
    if (!row?.nextCursor || !this.canPublish(row)) return;
    const cursor = row.nextCursor;
    const page = await this.connections.use(target, client => this.currentPage(target,client,null,cursor,100), signal, true);
    if (this.disposed || signal?.aborted || !this.canPublish(row) || row.nextCursor !== cursor) return;
    if (page.catalogRevision !== undefined && page.catalogRevision !== row.catalogRevision) throw new Error("目录已更新，请重试此页。");
    row.sessionTotal = row.sessions.length;
    row.nextCursor = page.nextCursor;
    row.state = page.nextCursor ? "partial" : "ready";
    this.emit();
  }
  private async follow(target: Target, client: Client, force: boolean): Promise<void> {
    let watch = this.watches.get(target.id);
    const current = () => this.rows.find(row => row.target.id === target.id);
    if (watch?.client === client) {
      if (client.connectionState !== "ready") throw new Error("目录连接尚未恢复，上次状态仍保留。 ");
      if (force || current()?.cached) {await client.refreshCatalog(); await this.repairVisible(target,client);}
      else await watch.ready;
      return;
    }
    watch?.stop();
    clientSources.set(client,current);
    const row = current()!;
    const changedInstance = row.daemonInstanceId && row.daemonInstanceId !== client.identity?.daemonInstanceId;
    row.daemonInstanceId = client.identity?.daemonInstanceId;
    if (changedInstance) {row.nextCursor=null; row.projectPages=undefined;}
    const subscription = client.followCatalog({
      known: () => {
        const row = current();
        const active = new Set(row?.activeSessions?.map(s => s.id));
        return {sessions:(row?.sessions ?? []).filter(s => /^[0-9a-f]{64}$/.test(row?.sessionEtags?.[s.id] ?? "")).slice(0,12_000)
          .map(s => ({id:s.id,workspaceId:s.workspaceId,etag:row!.sessionEtags![s.id]!,active:active.has(s.id)})),
          workspaces:(row?.workspaces ?? []).filter(w => /^[0-9a-f]{64}$/.test(row?.workspaceEtags?.[w.id] ?? ""))
          .map(w => ({id:w.id,etag:row!.workspaceEtags![w.id]!}))};
      },
      onUnavailable: error => {
        const row = current(); if (!row || !this.canPublish(row)) return;
        row.activityComplete=false; row.catalogGeneration=(row.catalogGeneration ?? 0)+1;
        row.refreshing=!error && client.connectionState === "ready"; row.cached=true;
        if (error && client.connectionState === "ready") row.state=classify(error);
        this.emit();
      },
      onBatch: batch => {
        const row = current(); if (!row || !this.canPublish(row) || this.watches.get(target.id)?.client !== client) return;
        this.applyCatalog(row,batch);
        if (batch.snapshot && batch.complete) {
          void this.repairVisible(target,client).then(() => {
            if (!this.canPublish(row) || current() !== row) return;
            row.refreshing=false; row.cached=false;
            row.state=row.nextCursor || row.catalogErrors?.length ? "partial" : "ready";
            this.emit();
          }).catch(error => { if (this.canPublish(row)) {row.refreshing=false;row.state=classify(error);this.emit();} });
        }
        this.emit();
      },
    });
    watch = {client, ...subscription}; this.watches.set(target.id,watch);
    try {await watch.ready; await this.repairVisible(target,client);}
    catch(error) {if (client.connectionState === "closed") {watch.stop();this.watches.delete(target.id);} throw error;}
  }

  private applyCatalog(row: MachineSummary, batch: CatalogBatch): void {
    if (batch.first) {if (batch.snapshot) row.catalogGeneration=(row.catalogGeneration ?? 0)+1;row.activityComplete=false;}
    row.catalogRevision=batch.revision;
    const sessions = new Map(row.sessions.map(s => [s.id,s]));
    const active = new Map((row.activeSessions ?? []).map(s => [s.id,s]));
    const spaces = new Map(row.workspaces.map(w => [w.id,w]));
    row.sessionEtags={...row.sessionEtags}; row.workspaceEtags={...row.workspaceEtags};
    for (const ref of batch.removedSessions) {
      if (sessions.get(ref.id)?.workspaceId === ref.workspaceId) {sessions.delete(ref.id); active.delete(ref.id); delete row.sessionEtags[ref.id];}
    }
    for (const id of batch.removedWorkspaces) {
      spaces.delete(id); delete row.workspaceEtags[id];
      for (const [sid, session] of sessions) if (session.workspaceId === id) {sessions.delete(sid);active.delete(sid);delete row.sessionEtags[sid];}
    }
    for (const value of batch.sessions) {
      sessions.set(value.summary.id,value.summary);row.sessionEtags[value.summary.id]=value.etag;
      if (value.active) active.set(value.summary.id,value.summary); else active.delete(value.summary.id);
    }
    for (const ref of batch.active) {const session=sessions.get(ref.id); if (session?.workspaceId === ref.workspaceId) active.set(ref.id,session);}
    for (const ref of batch.inactive) active.delete(ref.id);
    for (const value of batch.workspaces) {spaces.set(value.workspace.id,value.workspace); row.workspaceEtags[value.workspace.id]=value.etag;}
    row.sessions=[...sessions.values()];row.activeSessions=[...active.values()];row.workspaces=[...spaces.values()];
    if (batch.scopeErrors !== null) {row.catalogErrors=batch.scopeErrors; if (!batch.snapshot && batch.scopeErrors.length === 0) row.activityComplete=true;}
    row.activityComplete=batch.complete && !row.catalogErrors?.length;
    row.sessionTotal=row.sessions.length; row.workspaceTotal=row.workspaces.length;
    row.updatedAt=new Date().toISOString(); this.dirtyCache.add(row.target.id);
  }

  private async currentPage(target: Target, client: Client, workspaceId: string | null, cursor: string | null, limit: number) {
    for (let attempt=0; attempt<3; attempt++) {
      const row = this.rows.find(row => row.target.id === target.id), generation=row?.catalogGeneration;
      const query=JSON.stringify([workspaceId,cursor,limit,this.includeArchived]);
      const view=row?.pageViews?.[query];
      const known=view && view.ids.every(id => row?.sessions.some(s => s.id === id)) ? view.etag : undefined;
      const page=await readSessionPage(client,workspaceId,cursor,limit,this.includeArchived,false,known);
      if (!row || !this.canPublish(row)) throw new DOMException("Cancelled","AbortError");
      if (client.identity?.features?.includes("catalog.sync.v1") && page.catalogRevision !== undefined && page.catalogRevision > (row.catalogRevision ?? -1)) {
        await new Promise<void>(resolve => {
          let stop=()=>{};
          const timer=setTimeout(() => {stop();resolve();},3000);
          stop=this.subscribe(() => {if ((row.catalogRevision ?? -1) >= page.catalogRevision! || generation !== row.catalogGeneration) {clearTimeout(timer);queueMicrotask(() => stop());resolve();}});
        });
      }
      if (client.identity?.features?.includes("catalog.sync.v1") &&
          (generation !== row.catalogGeneration || page.catalogRevision !== row.catalogRevision)) continue;
      row.sessionEtags={...row.sessionEtags,...Object.fromEntries(Object.entries(page.catalogEtags ?? {}).filter((entry): entry is [string,string] => typeof entry[1] === "string"))};
      row.sessions=[...new Map([...row.sessions,...page.sessions].map(s => [s.id,s])).values()];
      if (page.etag) row.pageViews={...row.pageViews,[query]:{etag:page.etag,ids:page.notModified ? view!.ids : page.sessions.map(s => s.id)}};
      this.dirtyCache.add(row.target.id);
      return page;
    }
    throw new Error("目录正在变化，请重试此页。");
  }

  private async repairVisible(target: Target, client: Client): Promise<void> {
    const watch=this.watches.get(target.id);
    if (!watch || watch.client !== client) return;
    if (watch.repair) return watch.repair;
    const operation=(async () => {
      const row=this.rows.find(row => row.target.id === target.id);
      if (!row || !this.canPublish(row)) return;
      if (!row.catalogErrors?.length) {
        const page=await this.currentPage(target,client,null,null,100);
        if (page.catalogRevision !== row.catalogRevision) throw new Error("目录已更新，请重试此页。");
        row.nextCursor=page.nextCursor;
      }
      const bad = new Set(row.catalogErrors?.map(e => e.workspaceId));
      const scopes=row.workspaces.filter(w => !bad.has(w.id) && (row.catalogErrors?.length || row.projectPages?.[w.id] || !w.agentSpace?.parentWorkspaceId && row.workspaces.some(c => c.agentSpace?.parentWorkspaceId === w.id))).slice(0,32);
      for (const workspace of scopes) {
        const page=await this.currentPage(target,client,workspace.id,null,row.projectPages?.[workspace.id] ? 10 : 5);
        if (page.catalogRevision !== row.catalogRevision) throw new Error("目录已更新，请重试此页。");
        row.projectPages={...row.projectPages,[workspace.id]:{nextCursor:page.nextCursor,error:page.error}};
      }
    })();
    watch.repair=operation;
    try {await operation;}
    finally {if (watch.repair === operation) watch.repair=undefined;}
  }

  private async read(target: Target, signal: AbortSignal, force = false): Promise<Partial<MachineSummary>> {
    const reading = new AbortController();
    const cancel = () => reading.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => reading.abort(Object.assign(new Error("summary source timed out"), { code: "timeout" })), SOURCE_TIMEOUT_MS);
    const operation = this.connections.use(target, async client => {
      target.deviceHandle ??= client.identity?.machineId;
      target.fingerprint ??= client.identity?.fingerprint;
      if (client.identity?.features?.includes("catalog.sync.v1")) {
        await this.follow(target,client,force);
        const row = this.rows.find(row => row.target.id === target.id)!;
        return {sessions:row.sessions, workspaces:row.workspaces, activeSessions:row.activeSessions,
          activityComplete:row.activityComplete, projectPages:row.projectPages, nextCursor:row.nextCursor,
          sessionTotal:row.sessions.length, workspaceTotal:row.workspaces.length, version:client.identity.daemonVersion};
      }
      const previous = this.rows.find(row => row.target.id === target.id);
      const prefix = async (workspaceId: string | null, count: number) => {
        let cursor: string | null = null;
        const sessions: SessionSummary[] = [];
        do {
          reading.signal.throwIfAborted();
          const page = await readSessionPage(client,workspaceId,cursor,Math.min(100,Math.max(1,count - sessions.length)),this.includeArchived);
          sessions.push(...page.sessions);
          if (page.nextCursor && page.nextCursor === cursor) throw new Error("history cursor did not advance");
          cursor = page.nextCursor;
        } while (cursor && sessions.length < count);
        return {sessions,nextCursor:cursor};
      };
      const [page, workspaces, activeSessions] = await Promise.all([
        prefix(null,Math.max(100,previous?.sessionTotal ?? 0)), client.call({ type: "workspace.list" }, { timeoutMs: 10_000 }),
        client.identity?.features?.includes("session.active-page.v1") ? readActivitySessions(client, null, reading.signal) : Promise.resolve(undefined),
      ]);
      if (workspaces?.type !== "workspaces") throw new Error("invalid source summary");
      // The newest machine-wide page may contain only busy child Spaces.
      // Fetch root conversation previews separately so opening a project always
      // shows its user-facing conversations, without reading its whole history.
      const roots = workspaces.data.filter(w => previous?.projectPages?.[w.id] || !w.agentSpace?.parentWorkspaceId &&
        workspaces.data.some(child => child.agentSpace?.parentWorkspaceId === w.id)).slice(0, 32);
      const projectPages: NonNullable<MachineSummary["projectPages"]> = {};
      const previews: SessionSummary[] = [];
      for (const root of roots) {
        const count = Math.max(5,previous?.sessions.filter(s => s.workspaceId === root.id).length ?? 0);
        const result = await prefix(root.id,count);
        projectPages[root.id] = {nextCursor:result.nextCursor};
        previews.push(...result.sessions);
      }
      return { activeSessions, activityComplete: activeSessions !== undefined,
        sessions: [...new Map([...page.sessions, ...previews].map(s => [s.id,s])).values()], workspaces: workspaces.data,
        sessionTotal: page.sessions.length, workspaceTotal: workspaces.data.length, nextCursor: page.nextCursor,
        version: client.identity?.daemonVersion, projectPages };
    }, reading.signal, true);
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
