import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineSpecialty, runNodeUnit } from "../../framework/public.ts";

for (const mode of ["success", "exception", "signal"] as const) defineSpecialty({
  id: "specialty.contracts.worker-late-exit-" + mode,
  title: "Worker result agrees with actual process termination: " + mode,
  oracle: "A real worker writes its normal result, then either exits cleanly, throws at beforeExit or receives SIGTERM; only clean completion passes",
  catches: ["passed JSON masks a late worker crash", "signal termination reported as success"],
  tags: ["contract", "merge-risk", "worker-exit"], llm: { default: "none" },
  expectedDurationMs: 1000, timeoutMs: 20000, surfaces: ["testctl-worker", "os-process"],
}, async t => {
  const id = "fixture.worker-exit";
  const file = join(t.env.root, "worker-fixture.mts");
  const hook = mode === "exception" ? "process.once('beforeExit',()=>{throw new Error('late-worker-failure')});"
    : mode === "signal" ? "process.once('beforeExit',()=>process.kill(process.pid,'SIGTERM'));" : "";
  writeFileSync(file, `import {defineSpecialty} from ${JSON.stringify(pathToFileURL(join(t.openRoot, "testing/framework/public.ts")).href)};
    defineSpecialty({id:${JSON.stringify(id)},title:'Worker termination fixture',oracle:'actual process',catches:[],tags:[],llm:{default:'none'}},async()=>{${hook}});`);
  const result = await runNodeUnit({ id: id + "::default", caseId: id, variant: "default",
    meta: { ...t.meta, id, file, runner: "node", timeoutMs: 10000 } }, { TESTCTL_OPEN_ROOT: t.openRoot });
  t.note("observedStatus=" + result.status + " message=" + (result.message ?? ""));
  t.assertions.assert(result.status === (mode === "success" ? "passed" : "failed"), "worker termination was misclassified: " + result.status);
  if (mode !== "success") t.assertions.assert(/exit|signal/i.test(result.message ?? ""), "failure omitted process termination evidence");
});
