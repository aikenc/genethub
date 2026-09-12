import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import type { CaseMeta } from "../types.ts";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface Preflight {
  issues: Array<{ caseId: string; reason: string }>;
  checked: number;
  environment: { common: string; cases: Record<string, string> };
}

/** Read-only, bounded probes. Requirements are owned by case metadata, never case IDs. */
export async function preflight(cases: CaseMeta[], environment: NodeJS.ProcessEnv = process.env): Promise<Preflight> {
  const keys = new Set(cases.flatMap(item => (item.requirements ?? []).map(req => req.env)));
  const common = digest(Object.fromEntries(Object.entries(environment)
    .filter(([key]) => !keys.has(key) && !["_", "PWD", "OLDPWD", "SHLVL"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))));
  const issues: Preflight["issues"] = [];
  const fingerprints: Record<string, string> = {};
  const probes = new Map<string, { ok: boolean; identity: string; reason: string }>();
  for (const item of cases) {
    const identities: string[] = [];
    for (const req of item.requirements ?? []) {
      if (req.kind !== "python" || !/^[A-Z][A-Z0-9_]*$/.test(req.env) ||
          req.minVersion.length !== 2 || !req.minVersion.every(n => Number.isInteger(n) && n >= 0) ||
          req.modules.some(m => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(m))) {
        throw new Error(`invalid requirement metadata: ${item.id}`);
      }
      const executable = environment[req.env] ?? "";
      const key = digest([req, executable]);
      let probe = probes.get(key);
      if (!probe) {
        const reason = `${req.env} requires an absolute Python ${req.minVersion.join(".")}+ executable with ${req.modules.join(", ") || "standard library"}`;
        if (!path.isAbsolute(executable)) probe = { ok: false, identity: key, reason };
        else {
          // Do not print subprocess output: module imports can emit local paths or credentials.
          const script = "import sys,json,importlib,importlib.metadata as m; mods=json.loads(sys.argv[1]); v=tuple(json.loads(sys.argv[2])); assert sys.version_info[:2]>=v; loaded=[importlib.import_module(x) for x in mods]; print(json.dumps({'executable':sys.executable,'version':sys.version,'modules':[(x.__name__,getattr(x,'__version__',None),getattr(x,'__file__',None)) for x in loaded]}))";
          const output = await new Promise<string | null>(resolve => execFile(executable,
            ["-c", script, JSON.stringify(req.modules), JSON.stringify(req.minVersion)],
            { env: environment, timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8" },
            (error, stdout) => resolve(error ? null : stdout)));
          let identity: unknown;
          try { identity = output ? JSON.parse(output) : null; } catch { identity = null; }
          probe = { ok: identity !== null, identity: digest([key, identity]), reason };
        }
        probes.set(key, probe);
      }
      identities.push(probe.identity);
      if (!probe.ok) issues.push({ caseId: item.id, reason: probe.reason });
    }
    // Common environment is bound separately. Only explicitly declared dependencies may vary per case.
    fingerprints[item.id] = digest(identities);
  }
  return { issues, checked: probes.size, environment: { common, cases: fingerprints } };
}
