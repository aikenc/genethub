import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BlockedError, defineSpecialty, recoverAbandonedLeases } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.lease-recovery",
  title: "A killed coordinator leaves recoverable owned resources, while active and unowned roots survive",
  oracle: "A real coordinator registers its lease and detached TERM-resistant listener; after SIGKILL a new recovery removes that listener and directory by birth/owner identity. Another live coordinator and its child, an unmarked old directory and a forged marker are preserved; a second recovery performs no repeated cleanup",
  catches: ["SIGKILL bypasses finally and leaks permanently", "PID-only cleanup", "age-based deletion", "other run killed", "corrupt ledger treated as ownership proof"],
  tags: ["core", "contract", "durable-interaction", "resource-recovery"], llm: { default: "none" },
  expectedDurationMs: 5000, timeoutMs: 25000, requiredArtifacts: [],
  surfaces: ["testctl", "filesystem", "os-process", "tcp"],
}, async t => {
  if (process.platform !== "linux") throw new BlockedError("birth-identity recovery requires Linux procfs; other OS carriers need their own validation");
  const parent = path.join(t.env.root, "ownership-parent"); mkdirSync(parent);
  const unmarked = path.join(parent, "genehub-env-user-data"), forged = path.join(parent, "genehub-env-forged");
  mkdirSync(unmarked); mkdirSync(forged);
  writeFileSync(path.join(unmarked, "keep"), "unowned"); writeFileSync(path.join(forged, ".testctl-lease.json"), "{}");
  const require = createRequire(path.join(t.openRoot, "testing/package.json"));
  const loader = pathToFileURL(require.resolve("tsx")).href;
  const leaseModule = pathToFileURL(path.join(t.openRoot, "testing/infrastructure/public.ts")).href;
  const ownerModule = pathToFileURL(path.join(t.openRoot, "testing/infrastructure/public.ts")).href;
  const code = `import {spawn} from 'node:child_process';
import {createLease} from ${JSON.stringify(leaseModule)};
import {registerLeaseWorker} from ${JSON.stringify(ownerModule)};
const lease=createLease();
const child=spawn(process.execPath,['-e',"require('node:net').createServer(()=>{}).listen(0,'127.0.0.1',()=>console.log('ready'));process.on('SIGTERM',()=>{});"],
 {detached:true,env:{...process.env,...lease.env,TESTCTL_RESOURCE_OWNER:lease.id,TESTCTL_LEASE_ROOT:lease.root},stdio:['ignore','pipe','ignore']});
registerLeaseWorker(lease.root,child.pid);
child.stdout.once('data',()=>console.log(JSON.stringify({root:lease.root,pid:child.pid})));
setInterval(()=>{},1000);`;
  const start = async () => {
    const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", code],
      { env: { ...process.env, TMPDIR: parent }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { errors += b; });
    try {
      await t.tools.waitUntil(() => output.includes("\n"), 5000).catch(() => { throw new Error("ownership coordinator failed: " + errors.slice(-1500)); });
      return { child, receipt: JSON.parse(output.trim()) as { root: string; pid: number } };
    } catch (error) { child.kill("SIGKILL"); throw error; }
  };
  const dead = await start(), active = await start();
  const alive = (pid: number) => {
    try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; }
    catch { return false; }
  };
  try {
    dead.child.kill("SIGKILL");
    await new Promise<void>(resolve => dead.child.once("close", () => resolve()));
    t.assertions.assert(alive(dead.receipt.pid), "detached child disappeared before fault recovery");
    const result = await recoverAbandonedLeases(parent);
    t.assertions.assert(result.recovered.includes(dead.receipt.root) && !existsSync(dead.receipt.root) && !alive(dead.receipt.pid), "orphan not recovered: " + JSON.stringify(result));
    t.assertions.assert(existsSync(active.receipt.root) && alive(active.child.pid!) && alive(active.receipt.pid), "active parallel run was disturbed");
    t.assertions.assert(existsSync(path.join(unmarked, "keep")) && existsSync(forged), "unverified user data removed");
    t.assertions.assert((await recoverAbandonedLeases(parent)).recovered.length === 0, "recovery repeated a completed removal");
    t.note("SIGKILL coordinator recovered; live parallel owner, unmarked and corrupt roots retained");
  } finally {
    active.child.kill("SIGKILL"); dead.child.kill("SIGKILL");
    for (const pid of [active.receipt.pid, dead.receipt.pid]) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } }
    // The surrounding test lease owns this scratch directory; no global sweep.
  }
});
