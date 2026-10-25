import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import type { Endpoint, Target } from "./target";
import { Client, type ClientOptions, type ProtocolDial } from "./client";

export interface SummarySource { targets():Promise<Target[]>; openTarget(id:string,options?:{remember?:boolean}):Promise<Endpoint>; }
export type SummaryState = "waiting" | "loading" | "ready" | "offline" | "denied" | "timeout" | "unavailable" | "notChecked" | "partial" | "rateLimited";
export interface MachineSummary {
  target: Target;
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
  private clients = new Map<string, Client>();
  private previous = new Map<string, MachineSummary>();
  private controller: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private directoryDenied = false;
  private rows: MachineSummary[] = [];
  private observer: ((value: SummaryDirectory) => void) | null = null;
  constructor(private source: SummarySource, private options: Pick<ClientOptions, "socketFactory" | "onDiagnostic"> = {}) {}

  async refresh(onUpdate: (value: SummaryDirectory) => void, signal?: AbortSignal): Promise<SummaryDirectory> {
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
        this.source.targets(),
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
      const activeKeys = new Set(targets.slice(0, MAX_SOURCES).map(target => target.id));
      for (const [id, client] of this.clients) if (!activeKeys.has(id)) { client.close(); this.clients.delete(id); this.previous.delete(id); }
      for (const id of this.previous.keys()) if (!keys.has(id)) this.previous.delete(id);
      const rows = targets.map((target, index): MachineSummary => ({
        target, stateSource: "directory", observedAt: new Date().toISOString(), state: index >= MAX_SOURCES ? "notChecked" : target.online === false ? "offline" : "waiting",
        updatedAt: this.previous.get(target.id)?.updatedAt ?? null,
        sessionTotal: this.previous.get(target.id)?.sessionTotal ?? 0, workspaceTotal: this.previous.get(target.id)?.workspaceTotal ?? 0,
        sessions: this.previous.get(target.id)?.sessions ?? [], workspaces: this.previous.get(target.id)?.workspaces ?? [],
      }));
      this.rows = rows;
      const emit = () => { if (!controller.signal.aborted && this.generation === generation) this.emit(); };
      let index = 0;
      emit();
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (!controller.signal.aborted && this.generation === generation) {
          const current = index++;
          if (current >= Math.min(rows.length, MAX_SOURCES)) return;
          const row = rows[current]!;
          if (row.state === "offline") { this.clients.get(row.target.id)?.close(); this.clients.delete(row.target.id); continue; }
          row.state = "loading"; emit();
          try {
            const value = await this.read(row.target, controller.signal);
            if (controller.signal.aborted || this.generation !== generation) return;
            if (!this.canPublish(row)) { emit(); continue; }
            Object.assign(row, value, { state: value.sessionTotal > MAX_ITEMS_PER_SOURCE || value.workspaceTotal > MAX_ITEMS_PER_SOURCE ? "partial" : "ready", stateSource: "daemon", observedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            this.previous.delete(row.target.id); this.previous.set(row.target.id, { ...row });
            while (this.previous.size > MAX_SOURCES) this.previous.delete(this.previous.keys().next().value!);
          } catch (error) {
            if (controller.signal.aborted || this.generation !== generation) return;
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
        const clients = [...this.clients.values()]; this.clients.clear();
        for (const client of clients) client.close();
        this.diagnostic("summary.directory", "denied"); this.emit();
        return this.snapshot();
      }
      throw error;
    } finally { signal?.removeEventListener("abort", abort); if (this.controller === controller) this.controller = null; }
  }

  close(): void {
    this.disposed = true; this.observer = null; this.rows = []; this.generation++; this.controller?.abort(); this.controller = null;
    for (const client of this.clients.values()) client.close();
    this.clients.clear(); this.previous.clear();
  }

  private canPublish(row: MachineSummary): boolean { return !this.disposed && !this.directoryDenied && row.state !== "denied"; }
  private snapshot(): SummaryDirectory {
    return { sources: this.rows.map(row => ({ ...row })), complete: !this.directoryDenied && this.rows.every(row => row.state === "ready"), checked: this.rows.filter(row => !["waiting","loading","notChecked"].includes(row.state)).length };
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
    Object.assign(row, {state:"denied",stateSource:"request",observedAt:new Date().toISOString(),sessions:[],workspaces:[],sessionTotal:0,workspaceTotal:0,updatedAt:null});
  }
  private observeClient(id: string, client: Client): void {
    client.onStateChange(state => {
      if (state !== "closed" || this.disposed || this.clients.get(id) !== client || !["unauthorized","unauthenticated","forbidden"].includes(client.failure?.code ?? "")) return;
      this.clients.delete(id); this.previous.delete(id);
      for (const row of this.rows) if (row.target.id === id) this.deny(row);
      this.diagnostic("summary.authority", "denied", id); this.emit();
    });
  }

  private async read(target: Target, signal: AbortSignal): Promise<Pick<MachineSummary, "sessions" | "workspaces" | "sessionTotal" | "workspaceTotal">> {
    const parentSignal = signal, reading = new AbortController();
    const cancelReading = () => reading.abort();
    parentSignal.addEventListener("abort", cancelReading, { once: true });
    if (parentSignal.aborted) cancelReading();
    signal = reading.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let client = this.clients.get(target.id);
    const check = () => { if (signal.aborted || this.disposed) throw signal.reason ?? new DOMException("Cancelled", "AbortError"); };
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => rejectAbort(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    const operation = (async () => {
      check();
      if (!client || client.connectionState === "closed") {
        const endpoint = await this.source.openTarget(target.id, { remember: false }); check();
        const dial = (e: Endpoint): ProtocolDial => ({ url:e.url, channelCredential:e.channelCredential, fabricRouteTicket:e.fabricRouteTicket, fabricAuthorizationExpiresAt:e.fabricAuthorizationExpiresAt, localServerProof:e.localServerProof });
        client = new Client({ ...this.options,
          onDiagnostic: event => { try { this.options.onDiagnostic?.({ ...event, detail: { ...event.detail, summarySourceId: target.deviceHandle ?? target.id } }); } catch { /* observation cannot own a source */ } },
          ...dial(endpoint), credential:endpoint.credential, separateDataChannel:false, rtcEnabled:false,
          requestTimeoutMs:SOURCE_TIMEOUT_MS, redial:async()=>dial(await this.source.openTarget(target.id,{remember:false})),
        });
        this.clients.set(target.id,client); this.observeClient(target.id,client); client.connect();
        await new Promise<void>((resolve,reject)=>{
          let stop=()=>{};
          const finish=(error?:Error)=>{stop();signal.removeEventListener("abort",cancel);error?reject(error):resolve();};
          const cancel=()=>finish(signal.reason ?? new DOMException("Cancelled","AbortError"));
          stop=client!.onStateChange(state=>{if(state==="ready")finish();else if(state==="closed")finish(Object.assign(new Error("source connection closed"),{code:client!.failure?.code}));});
          signal.addEventListener("abort",cancel,{once:true});
          if(signal.aborted)cancel();else if(client!.connectionState==="ready")finish();
        });
        if (endpoint.fingerprint && client.identity?.fingerprint !== endpoint.fingerprint) throw Object.assign(new Error("machine identity mismatch"),{code:"unauthorized"});
      }
      check();
      if (target.deviceHandle && client.identity?.machineId !== target.deviceHandle || target.fingerprint && client.identity?.fingerprint !== target.fingerprint) {
        throw Object.assign(new Error("summary source identity mismatch"),{code:"unauthorized"});
      }
      const [sessions, workspaces] = await Promise.all([
        client.call({type:"session.list",payload:{workspaceId:null,includeArchived:false}}), client.call({type:"workspace.list"}),
      ]);
      check();
      if(sessions?.type!=="sessions" || workspaces?.type!=="workspaces") throw new Error("invalid source summary");
      return {sessions:sessions.data.slice(0,MAX_ITEMS_PER_SOURCE),workspaces:workspaces.data.slice(0,MAX_ITEMS_PER_SOURCE),sessionTotal:sessions.data.length,workspaceTotal:workspaces.data.length};
    })();
    timer=setTimeout(()=>reading.abort(Object.assign(new Error("summary source timed out"),{code:"timeout"})),SOURCE_TIMEOUT_MS);
    try { return await Promise.race([operation,aborted]); }
    catch(error){
      const failure=client?.failure;
      this.diagnostic("summary.read",failure && ["unauthorized","unauthenticated","forbidden"].includes(failure.code) ? "denied" : classify(error),target.deviceHandle ?? target.id);
      client?.close();if(this.clients.get(target.id)===client)this.clients.delete(target.id);
      if(failure && ["unauthorized","unauthenticated","forbidden"].includes(failure.code)) throw Object.assign(new Error("summary access denied"),{code:failure.code});
      throw error;
    }
    finally { if(timer)clearTimeout(timer);signal.removeEventListener("abort",abort);parentSignal.removeEventListener("abort",cancelReading); }
  }
}
function classify(error: unknown): SummaryState {
  const value=error as {status?:number;code?:string;detail?:{code?:string}};
  const code=value?.code ?? value?.detail?.code;
  if([401,403,404].includes(value?.status ?? 0) || ["forbidden","unauthenticated","unauthorized"].includes(code ?? ""))return "denied";
  if(value?.status===429)return "rateLimited";
  if(value?.status===409 || code==="machineOffline")return "offline";
  if([408,504].includes(value?.status ?? 0) || code==="timeout" || (error instanceof Error && error.name==="ClientRequestTimeoutError"))return "timeout";
  return "unavailable";
}
