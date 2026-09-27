import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.preview.registration-churn",
  title: "Service inventory tolerates registration temporary files disappearing during enumeration",
  oracle: "A real daemon returns a process inventory throughout concurrent creation/removal of unpublished registration files",
  catches: ["WASI readdir reports ENOENT for an entry deleted after enumeration", "one disappearing registration aborts the entire process inventory"],
  tags: ["network-risk-v2", "service-preview", "processes"], llm: {default: "none"},
  expectedDurationMs: 10000, timeoutMs: 60000,
  resources: {environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0},
  surfaces: ["daemon", "service-preview"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
  const directory = join(t.env.data, "service-previews");
  const observed = join(t.env.workspace, "churn-count");
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const script = `const fs=require('node:fs'),path=require('node:path');let n=0;
    function batch(){for(let i=0;i<32;i++)fs.writeFileSync(path.join(process.argv[1],i+'.pending'),'x');
      for(let i=0;i<32;i++)fs.unlinkSync(path.join(process.argv[1],i+'.pending'));
      fs.writeFileSync(process.argv[2]+'.next',String(++n));fs.renameSync(process.argv[2]+'.next',process.argv[2]);setImmediate(batch)};batch();`;
  const child = spawn(process.execPath, ["-e", script, directory, observed], {stdio: "ignore"});
  const exited = once(child, "exit");
  try {
    await t.tools.waitUntil(() => {
      try { return Number(readFileSync(observed, "utf8")) >= 1; } catch { return false; }
    }, 5000);
    for (let i=0; i<256; i++) {
      const result = await opened.client.call({type: "process.workspaceList", payload: {workspaceId: opened.workspaceId}});
      t.assertions.assert(result?.type === "processes", `query ${i} did not return inventory`);
    }
    t.assertions.assert(Number(readFileSync(observed, "utf8")) > 1, "registration publisher did not run concurrently");
    t.note("256 process inventories completed during real registration-directory churn");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
