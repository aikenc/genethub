import type { MachineSummary } from "./summary-directory";
import type { Target } from "./target";

// Only the existing directory's read cache. No credentials, task authority,
// binaries or second synchronizer; unavailable storage is a cache miss.
const DB = "genehub-directory-v1", STORE = "sources";
const MAX_BYTES = 8 * 1024 * 1024, MAX_SOURCES = 16;
let opened: Promise<IDBDatabase | null> | undefined;
let epoch = 0;
const invalidated = new Map<string, number>();
interface Record {
  key: string; version: 1; savedAt: number; checksum: string;
  row: Pick<MachineSummary, "workspaces" | "sessions" | "activeSessions" | "projectPages" | "nextCursor" | "updatedAt" | "sessionEtags" | "workspaceEtags" | "pageViews">;
}
const cleared = new Set<() => void>();
const CLEAR_KEY = "genehub.directory.cleared";
export function onDirectoryCachesCleared(listener: () => void): () => void {cleared.add(listener);return () => cleared.delete(listener);}
function invalidateReaders() {epoch++;for (const listener of cleared) {try {listener();} catch {/* One reader cannot suppress another invalidation. */}}}
if (typeof window !== "undefined") window.addEventListener("storage", event => {if (event.key === CLEAR_KEY) invalidateReaders();});
async function checksum(value: unknown): Promise<{digest:string;bytes:number} | null> {
  try {
    const bytes=new TextEncoder().encode(JSON.stringify(value));
    if (bytes.byteLength > MAX_BYTES || !globalThis.crypto?.subtle) return null;
    const hash=await crypto.subtle.digest("SHA-256",bytes);
    return {digest:[...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,"0")).join(""),bytes:bytes.byteLength};
  } catch {return null;}
}
function key(scope: string, target: Target): string | null {
  return scope && target.deviceHandle && target.fingerprint
    ? JSON.stringify([scope, target.deviceHandle, target.fingerprint]) : null;
}
function database(): Promise<IDBDatabase | null> {
  return opened ??= new Promise(resolve => {
    try {
      if (!globalThis.indexedDB) {resolve(null); return;}
      const request = indexedDB.open(DB, 2);
      request.onupgradeneeded = () => {
        const store=request.result.objectStoreNames.contains(STORE) ? request.transaction!.objectStore(STORE) : request.result.createObjectStore(STORE, {keyPath:"key"});
        if (!store.indexNames.contains("savedAt")) store.createIndex("savedAt","savedAt");
      };
      request.onerror = request.onblocked = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {db.close(); opened=undefined;};
        resolve(db);
      };
    } catch {resolve(null);}
  });
}
async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await database();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const transaction = db.transaction(STORE, mode), request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => resolve(null);
    } catch {resolve(null);}
  });
}
export async function readDirectoryCache(scope: string, target: Target): Promise<Record["row"] | null> {
  const id = key(scope,target), before = epoch;
  if (!id) return null;
  const generation = invalidated.get(id) ?? 0;
  const value = await transact<Record | undefined>("readonly", store => store.get(id));
  if (epoch !== before || (invalidated.get(id) ?? 0) !== generation) return null;
  if (!value || value.version !== 1 || value.key !== id || Date.now() - value.savedAt > 30 * 86400_000) return null;
  const row = value.row;
  if (!row || !Array.isArray(row.sessions) || !Array.isArray(row.workspaces)
      || row.sessions.length > 12_000 || row.workspaces.length > 4096
      || row.sessions.some(s => typeof s?.id !== "string" || typeof s.workspaceId !== "string")
      || row.sessions.some(s => typeof s.agentId !== "string" || typeof s.status !== "string" || !Number.isFinite(s.updatedAtMs))
      || row.workspaces.some(w => typeof w?.id !== "string" || typeof w.name !== "string" || typeof w.root !== "string")) return null;
  const hash=await checksum(row);
  if (!hash || hash.digest !== value.checksum || epoch !== before) return null;
  return row;
}
export function directoryCacheEpoch(): number {return epoch;}
export async function writeDirectoryCache(scope: string, target: Target, row: MachineSummary, before = epoch): Promise<void> {
  const id = key(scope,target);
  if (before !== epoch) return;
  if (!id || !row.activityComplete) return;
  const generation = invalidated.get(id) ?? 0;
  // Keep current obligations plus bounded opened history. Cache omission is a
  // miss on next open, never a claim that omitted work is idle or deleted.
  if (!globalThis.crypto?.subtle) return;
  const active = row.activeSessions ?? [];
  const history = [...row.sessions].sort((a,b) => b.updatedAtMs-a.updatedAtMs).slice(0,500);
  const sessions = [...new Map([...history, ...active].map(s => [s.id,s])).values()].slice(0,12_000);
  const ids = new Set(sessions.map(s => s.id));
  const record: Record = {key:id,version:1,savedAt:Date.now(),checksum:"",row:{
    sessions, activeSessions:active.filter(s => ids.has(s.id)), workspaces:row.workspaces, updatedAt:row.updatedAt,
    nextCursor:null, projectPages:undefined,
    sessionEtags:Object.fromEntries(Object.entries(row.sessionEtags ?? {}).filter(([id]) => ids.has(id))),
    workspaceEtags:row.workspaceEtags,
    pageViews:Object.fromEntries(Object.entries(row.pageViews ?? {}).filter(([,view]) => view.ids.every(id => ids.has(id)))),
  }};
  try {
    let hash=await checksum(record.row);
    while (!hash && (record.row.sessions.length || record.row.workspaces.length)) {
      if (record.row.sessions.length >= record.row.workspaces.length) record.row.sessions=record.row.sessions.slice(0,Math.floor(record.row.sessions.length/2));
      else record.row.workspaces=record.row.workspaces.slice(0,Math.floor(record.row.workspaces.length/2));
      const kept=new Set(record.row.sessions.map(s => s.id)), spaces=new Set(record.row.workspaces.map(w => w.id));
      record.row.activeSessions=record.row.activeSessions?.filter(s => kept.has(s.id));
      record.row.sessionEtags=Object.fromEntries(Object.entries(record.row.sessionEtags ?? {}).filter(([id]) => kept.has(id)));
      record.row.workspaceEtags=Object.fromEntries(Object.entries(record.row.workspaceEtags ?? {}).filter(([id]) => spaces.has(id)));
      record.row.pageViews=Object.fromEntries(Object.entries(record.row.pageViews ?? {}).filter(([,view]) => view.ids.every(id => kept.has(id))));
      hash=await checksum(record.row);
    }
    if (!hash) return;
    record.checksum=hash.digest;
    const db = await database();
    if (!db || before !== epoch || (invalidated.get(id) ?? 0) !== generation) return;
    await new Promise<void>(resolve => {
      try {
        const transaction = db.transaction(STORE,"readwrite"), store = transaction.objectStore(STORE);
        store.put(record);
        // Iterate only timestamp/index keys. Reading all cache values here
        // would deserialize up to 128 MiB on every tiny directory change.
        let count=0;
        const records = store.index("savedAt").openKeyCursor(null,"prev");
        records.onsuccess = () => {
          const cursor=records.result; if (!cursor) return;
          if (++count > MAX_SOURCES) store.delete(cursor.primaryKey);
          cursor.continue();
        };
        transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
      } catch {resolve();}
    });
  } catch { /* Quota/private-mode failures never block the workbench. */ }
}
export async function removeDirectoryCache(scope: string, target: Target): Promise<void> {
  const id = key(scope,target);
  if (!id) return;
  invalidated.set(id,(invalidated.get(id) ?? 0)+1);
  await transact("readwrite", store => store.delete(id));
}
export async function clearDirectoryCaches(): Promise<void> {
  invalidateReaders();
  try {localStorage.setItem(CLEAR_KEY,`${Date.now()}:${Math.random()}`);} catch {/* Optional tab invalidation. */}
  await transact("readwrite", store => store.clear());
}
