import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { defineSpecialty, trackResources, BlockedError } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.resource-census", title: "Cleanup detects a detached listener and preserves an unrelated process",
  oracle: "Real detached Node listener ignores TERM; OS census observes its process and port, cleanup removes both while a different owner stays alive",
  catches: ["fixed zero leak counts", "detached child survives cleanup", "cleanup kills another case"],
  tags: ["core", "contract", "network-audit-fix"], llm: { default: "none" },
  expectedDurationMs: 3000, timeoutMs: 15000, surfaces: ["os-process", "tcp"],
}, async t => {
  if (process.platform !== "linux") throw new BlockedError("procfs census requires Linux");
  const owner = randomUUID();
  const code = "require('node:net').createServer(()=>{}).listen(0,'127.0.0.1',()=>console.log('ready')); process.on('SIGTERM',()=>{});";
  const child = spawn(process.execPath, ["-e", code], { detached: true, env: { ...process.env, TESTCTL_RESOURCE_OWNER: owner }, stdio: ["ignore", "pipe", "pipe"] });
  const outsider = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: { ...process.env, TESTCTL_RESOURCE_OWNER: randomUUID() }, stdio: "ignore" });
  const tracker = trackResources(owner, child.pid!);
  let ready = false; child.stdout?.on("data", () => { ready = true; });
  try {
    await t.tools.waitUntil(() => ready, 5000);
    const before = tracker.census();
    t.assertions.assert(before.processes === 1 && before.ports === 1, "detached listener not measured: " + JSON.stringify(before));
    const result = await tracker.finish();
    t.assertions.assert(result.before.processes === 1 && result.before.ports === 1, "pre-cleanup leak was lost");
    t.assertions.assert(result.after.processes === 0 && result.after.ports === 0, "forced cleanup did not retire the listener");
    process.kill(outsider.pid!, 0);
  } finally { await tracker.finish(); child.kill("SIGKILL"); outsider.kill("SIGKILL"); }
});
