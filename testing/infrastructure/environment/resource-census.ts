import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export interface ResourceCensus { processes: number | null; ports: number | null }
interface Identity { pid: number; birth: string; parent: number; state: string }
function identity(pid: number): Identity | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { pid, birth: fields[19]!, parent: Number(fields[1]), state: fields[0]! };
  } catch { return undefined; }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Per-worker ownership, including detached descendants; never kills by name or port. */
export function trackResources(owner: string, rootPid: number) {
  const owned = new Map<number, Identity>();
  const root = identity(rootPid); if (root) owned.set(rootPid, root);
  const supported = process.platform === "linux";
  let complete = supported;
  function scan(): Identity[] {
    if (!supported) return [];
    let pids: string[];
    try { pids = readdirSync("/proc").filter(p => /^\d+$/.test(p)); } catch { complete = false; return []; }
    const live = pids.map(p => identity(Number(p))).filter((p): p is Identity => !!p);
    for (const p of live) {
      if (owned.get(p.pid)?.birth === p.birth) continue;
      try {
        if (readFileSync(`/proc/${p.pid}/environ`, "utf8").split("\0").includes("TESTCTL_RESOURCE_OWNER=" + owner)) owned.set(p.pid, p);
      } catch { /* Other users' processes are outside this lease. */ }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of live) {
        if (owned.get(p.pid)?.birth === p.birth) continue;
        const parent = live.find(other => other.pid === p.parent);
        if (parent && owned.get(parent.pid)?.birth === parent.birth) { owned.set(p.pid, p); changed = true; }
      }
    }
    return live.filter(p => owned.get(p.pid)?.birth === p.birth && p.state !== "Z");
  }
  function census(): ResourceCensus {
    const live = scan();
    if (!complete) return { processes: null, ports: null };
    const inodes = new Set<string>();
    let portsKnown = true;
    for (const p of live) {
      try {
        for (const fd of readdirSync(`/proc/${p.pid}/fd`)) {
          try { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${p.pid}/fd/${fd}`)); if (m) inodes.add(m[1]!); } catch { /* FD closed during scan. */ }
        }
      } catch { if (identity(p.pid)?.birth === p.birth) portsKnown = false; }
    }
    const ports = new Set<string>();
    for (const protocol of ["tcp", "tcp6", "udp", "udp6"]) {
      try {
        for (const line of readFileSync(`/proc/net/${protocol}`, "utf8").trim().split("\n").slice(1)) {
          const f = line.trim().split(/\s+/);
          if (inodes.has(f[9]!) && (protocol.startsWith("udp") || f[3] === "0A")) ports.add(protocol + ":" + f[1]);
        }
      } catch { portsKnown = false; }
    }
    return { processes: live.length, ports: portsKnown ? ports.size : null };
  }
  const timer = supported ? setInterval(scan, 500) : undefined;
  timer?.unref();
  scan();
  return {
    census,
    async finish() {
      if (timer) clearInterval(timer);
      // Let normal child shutdown settle before recording a leak.
      let before = census();
      const deadline = Date.now() + 1500;
      while ((before.processes ?? 0) > 0 && Date.now() < deadline) { await pause(100); before = census(); }
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        for (const p of scan()) {
          if (p.pid !== process.pid && identity(p.pid)?.birth === p.birth) {
            try { process.kill(p.pid, signal); } catch { /* Already exited. */ }
          }
        }
        if ((census().processes ?? 0) === 0) break;
        await pause(signal === "SIGTERM" ? 500 : 100);
      }
      return { before, after: census(), scope: "linux lease-tagged processes and observed descendants; TCP listeners and UDP sockets" };
    },
  };
}
