import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.view-build",
  title: "Builder rejects broken frozen view assets and duplicate checklist identities",
  oracle: "The production draft compiler accepts the shipped package but rejects missing entries/titles/resources, escaped references, remote scripts and duplicate authored ids without starting a Run",
  catches: ["a built view fails only after the user opens it", "a script is fetched from an unfrozen URL", "duplicate ids erase checklist evidence"],
  tags: ["workflow", "workflow-authoring", "core"], llm: { default: "none" },
  expectedDurationMs: 10_000, timeoutMs: 60_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0 },
  surfaces: ["daemon", "bootstrap-pack", "workbench-client"], productInterfaces: ["workflow.check", "workflow.history"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  try {
    const source = t.flows.main.clonePackage({openRoot:t.openRoot,projectRoot:t.env.workspace});
    const index = path.join(source,"views/progress/index.html");
    const product = path.join(source,"checklists/product.yaml");
    const original = readFileSync(index,"utf8"), norms = readFileSync(product,"utf8");
    const check = async () => {
      const reply = await opened.client.call({type:"workflow.check",payload:{workspaceId:opened.workspaceId,runId:null,draft:true,packageId:"game-delivery"}});
      if(reply?.type!=="workflowCheck"||!reply.data.draft) throw new Error("draft check unavailable");
      return reply.data.draft;
    };
    t.assertions.assert((await check()).valid,"shipped package failed its static checks");
    const cases = [
      {html:original.replace(/<title>[^<]*<\/title>/,"<title> </title>"), reason:"title"},
      {html:original.replace('src="observe.js"','src="missing.js"'), reason:"不存在"},
      {html:original.replace('src="observe.js"','src="../progress/observe.js"'), reason:"越出"},
      {html:original.replace('src="observe.js"','src="https://example.invalid/code.js"'), reason:"冻结"},
    ];
    for(const scenario of cases){
      writeFileSync(index,scenario.html);
      const report=await check();
      t.assertions.assert(!report.valid&&report.diagnostics.some(d=>d.message.includes(scenario.reason)),`invalid resource did not report ${scenario.reason}`);
    }
    writeFileSync(index,original);
    writeFileSync(product,norms+'\n- id: hand-1\n  requirement: Duplicate authored identity\n');
    const report=await check();
    t.assertions.assert(!report.valid&&report.diagnostics.some(d=>d.message.includes('重复')),'duplicate standard identity was accepted');
    writeFileSync(product,norms);
    t.assertions.assert((await check()).valid,'fixing source did not restore a valid build');
    const history=await opened.client.call({type:"workflow.history",payload:{workspaceId:opened.workspaceId,limit:10}});
    t.assertions.assert(history?.type==='workflowRuns'&&!history.data.length,'read-only builder validation started a Run');
  }finally{opened.client.close();opened.daemon.stop();await opened.mock.stop();}
});
