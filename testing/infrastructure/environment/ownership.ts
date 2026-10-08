import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const MARKER = ".testctl-lease.json";
interface ProcessIdentity { pid: number; birth: string; uid: number; state: string }
interface Record {
  schema: "testctl.lease-owner.v1"; id: string; root: string; inode: number; device: number;
  uid: number; boot: string; coordinator: ProcessIdentity; worker?: ProcessIdentity;
}
function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { pid, birth: fields[19]!, uid: lstatSync(`/proc/${pid}`).uid, state: fields[0]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw error; // Unknown identity is never permission to kill or delete.
  }
}
const live = (id: ProcessIdentity) => {
  const current = processIdentity(id.pid);
  return current?.birth === id.birth && current.uid === id.uid && current.state !== "Z";
};
function write(root: string, record: Record): void {
  const file = path.join(root, MARKER), scratch = file + "." + randomUUID();
  const fd = openSync(scratch, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(scratch, file);
  const directory = openSync(root, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function read(root: string): Record | undefined {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) return;
  const file = path.join(root, MARKER), marker = lstatSync(file);
  if (!marker.isFile() || marker.isSymbolicLink() || marker.uid !== stat.uid || marker.size > 4096) return;
  const record = JSON.parse(readFileSync(file, "utf8")) as Record;
  if (record.schema !== "testctl.lease-owner.v1" || record.root !== root || record.inode !== stat.ino
    || record.device !== stat.dev || record.uid !== stat.uid || typeof record.id !== "string"
    || !/^[\w-]+$/.test(record.id) || typeof record.boot !== "string"
    || !Number.isInteger(record.coordinator?.pid) || record.coordinator.pid <= 0
    || typeof record.coordinator.birth !== "string" || record.coordinator.uid !== record.uid) return;
  return record;
}

/** The coordinator owns a lease; a worker does not become its owner on an
 * accidental detach. On platforms without verified process birth identity,
 * automatic orphan recovery remains explicitly unsupported. */
export function registerLease(root: string, id: string): void {
  if (process.platform !== "linux") return;
  const stat = lstatSync(root), coordinator = processIdentity(process.pid)!;
  write(root, { schema: "testctl.lease-owner.v1", id, root, inode: stat.ino, device: stat.dev,
    uid: stat.uid, boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), coordinator });
}
export function registerLeaseWorker(root: string, pid: number): void {
  if (process.platform !== "linux") return;
  const record = read(root), worker = processIdentity(pid);
  if (!record || !worker || worker.uid !== record.uid || !live(record.coordinator)) throw new Error("lease ownership cannot be verified");
  write(root, { ...record, worker });
}

export interface LeaseRecovery {
  supported: boolean; recovered: string[]; retained: Array<{ root: string; reason: string }>;
}
/** Only marked, identity-bound roots in the test temporary directory are
 * eligible. Never selects a process by name/port or a directory by age. */
export async function recoverAbandonedLeases(parent = tmpdir()): Promise<LeaseRecovery> {
  const result: LeaseRecovery = { supported: process.platform === "linux", recovered: [], retained: [] };
  if (!result.supported) return result;
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  for (const name of readdirSync(parent)) {
    if (!/^genehub-(env|legacy)-/.test(name)) continue;
    const root = path.join(parent, name);
    let record: Record | undefined;
    try { record = read(root); } catch (error) {
      // Legacy, unmarked directories are preserved. A corrupt ownership
      // marker is recorded, never treated as an abandoned lease.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.retained.push({ root, reason: "invalid-or-unreadable-owner" });
      continue;
    }
    if (!record) { result.retained.push({ root, reason: "unverified-owner" }); continue; }
    try {
      if (record.boot !== boot) { result.retained.push({ root, reason: "different-boot-requires-inspection" }); continue; }
      if (live(record.coordinator)) continue;
      const owned = (): ProcessIdentity[] => {
        const found: ProcessIdentity[] = [];
        for (const pid of readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
          const identity = processIdentity(Number(pid));
          if (!identity || identity.uid !== record!.uid || identity.state === "Z") continue;
          if (record!.worker?.pid === identity.pid && record!.worker.birth === identity.birth) { found.push(identity); continue; }
          try {
            const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
            if (env.includes("TESTCTL_RESOURCE_OWNER=" + record!.id)
              && (env.includes("TESTCTL_LEASE_ROOT=" + root) || env.includes("HOME=" + path.join(root, "home")))) found.push(identity);
          } catch (error) {
            if (live(identity)) throw error; // Cannot prove that this scan is complete.
          }
        }
        return found;
      };
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        // Recheck the directory and owner before every signal batch.
        if (read(root)?.id !== record.id || live(record.coordinator)) throw new Error("owner changed");
        for (const identity of owned()) {
          if (identity.pid !== process.pid && live(identity)) {
            try { process.kill(identity.pid, signal); }
            catch (error) { if (live(identity)) throw error; }
          }
        }
        const deadline = Date.now() + (signal === "SIGTERM" ? 500 : 1000);
        while (owned().length && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
        if (!owned().length) break;
      }
      if (owned().length || read(root)?.id !== record.id || live(record.coordinator)) {
        result.retained.push({ root, reason: "live-resources-or-changed-owner" }); continue;
      }
      rmSync(root, { recursive: true });
      result.recovered.push(root);
    } catch { result.retained.push({ root, reason: "identity-or-cleanup-unconfirmed" }); }
  }
  return result;
}
