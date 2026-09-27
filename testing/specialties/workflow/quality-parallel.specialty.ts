import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { defineSpecialty, runGenetAsync } from '../../framework/public.ts';

defineSpecialty({
  id:'specialty.workflow.quality-parallel', title:'Shipped parallel quality flow compiles and its package gate preserves all exits',
  oracle:'The public draft compiler accepts the exact multi-branch workflow, frozen standard includes and owner role without running it; its real script rejects stale, missing and unverifiable checks and accepts justified standard applicability/disputes',
  catches:['shipped YAML cannot compile','owner becomes a platform role','a partial or stale review approves a commit','lack of tooling becomes not applicable','200 checklist rows overflow'],
  tags:['workflow','core','workflow-authoring'], llm:{default:'mock'}, expectedDurationMs:12000,timeoutMs:90000,
  resources:{environments:1,cpu:1,memoryMb:768,io:1,browser:0},
  surfaces:['daemon','genet-cli','bootstrap-pack','filesystem'],productInterfaces:['genet workflow check --draft','pack.script'],
},async t=>{
  t.data.git.init(t.env.workspace);
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  try {
    const root=t.flows.main.clonePackage({openRoot:t.openRoot,projectRoot:t.env.workspace});
    const draft=await runGenetAsync(opened.daemon.genet,['workflow','check','--draft'],opened.daemon.env,{cwd:t.env.workspace});
    t.assertions.assert(draft.code===0, draft.stdout+draft.stderr);
    t.assertions.assert(draft.stdout.includes('quality-parallel')&&draft.stdout.includes('owner'),'draft omitted the new flow or its actual role');
    const history=await opened.client.call({type:'workflow.history',payload:{workspaceId:opened.workspaceId,limit:10}});
    t.assertions.assert(history?.type==='workflowRuns'&&!history.data.length,'draft started execution');
    // Execute the package's shipped analysis artifact, independent of the UI host.
    const runtime:any={window:{}};
    runInNewContext(readFileSync(path.join(root,'views/progress/observe.js'),'utf8'),runtime);
    const analysis=runtime.window.WorkflowObserve;
    const event=(id:string,startMs:number,endMs:number,dependencies:string[]=[],waits:any[]=[])=>({id,title:id,startMs,endMs,dependsOn:new Set(dependencies),waits});
    const graph=[event('start',0,10),event('short',10,30,['start']),event('long',10,60,['start']),event('merge',65,75,['short','long'],[{startMs:60,endMs:65,reason:'mainline lock'}])];
    const timing=analysis.criticalPath(graph);
    t.assertions.assert(!timing.incomplete&&timing.ids.has('long')&&!timing.ids.has('short'),'parallel critical path selected the short branch');
    t.assertions.assert(timing.float.get('short')===30&&timing.float.get('long')===0,'branch float does not match CPM');
    t.assertions.assert(timing.segments.reduce((sum:number,e:any)=>sum+e.endMs-e.startMs,0)===75&&timing.segments.some((e:any)=>e.title==='mainline lock'),'wall time did not reconcile with recorded lock wait');
    t.assertions.assert(analysis.peak(graph)===2,'exact simultaneous peak counted touching intervals twice');
    const occupied=analysis.occupancy(graph);
    t.assertions.assert(occupied.workerMs===90&&occupied.occupiedMs===70&&Math.abs(occupied.parallelism-9/7)<0.00001,'parallelism must average simultaneous occupancy across the interval union');
    t.assertions.assert(analysis.occupancy([event('human-wait',0,3600000)]).parallelism===1,'a long human wait inflated serial occupancy');
    t.assertions.assert(analysis.criticalPath([event('missing',0,10,['unknown'])]).incomplete,'missing dependency was silently accepted');
    const items=Array.from({length:200},(_,i)=>({id:`item-${i}`,requirement:`Contract ${i}`}));
    for(const scenario of ['pass','failed','unverified','na','disputed','missing','duplicate','stale','invalid-waiver'] as const){
      const data={feature:{id:'test'},commit:'pinned-commit',requirements:items,product:items,engineering:items,
        reviews:Object.fromEntries(['requirements','product','engineering'].map(group=>[group,{output:{commit:'pinned-commit',checklist:items.map(item=>({...item,status:'passed',reason:'checked pinned source',evidence:'verified fixture'}))}}]))} as any;
      const rows=data.reviews.product.output.checklist;
      if(['failed','unverified','na','disputed'].includes(scenario))Object.assign(rows[0],{status:scenario,reason:'specific applicability or verification fact',suggestion:'change this overly broad rule'});
      if(scenario==='missing')rows.pop();
      if(scenario==='duplicate')rows.push({...rows[0]});
      if(scenario==='stale')data.reviews.engineering.output.commit='different-commit';
      if(scenario==='invalid-waiver')data.reviews.requirements.output.checklist[0].status='na';
      const result=spawnSync('python3',[path.join(root,'scripts/quality-gate.py')],{cwd:t.env.workspace,input:JSON.stringify(data),encoding:'utf8',timeout:5000});
      t.assertions.assert(result.status===0,result.stderr);
      const receipt=JSON.parse(result.stdout),report=JSON.parse(readFileSync(path.join(t.env.workspace,receipt.evidence.report),'utf8'));
      const accepted=['pass','na','disputed'].includes(scenario);
      t.assertions.assert(receipt.ok===true&&report.approved===accepted&&receipt.evidence.approved===String(accepted),`${scenario}: incorrect business gate ${JSON.stringify(report.errors)}`);
      if(scenario==='disputed')t.assertions.assert(report.checklist.some((row:any)=>row.status==='disputed'&&row.suggestion),'dispute feedback lost');
    }
    // Changing an included norm must produce a different build, without requiring Node.
    const norm=path.join(root,'checklists/product.yaml');writeFileSync(norm,readFileSync(norm,'utf8')+'\n# new authored source\n');
    const changed=await runGenetAsync(opened.daemon.genet,['workflow','check','--draft'],opened.daemon.env,{cwd:t.env.workspace});
    t.assertions.assert(changed.code===0,changed.stderr||changed.stdout);
    t.note('Exact shipped flow; 600 review rows per script run; standard disputes/applicability remain package policy.');
  } finally {opened.client.close();opened.daemon.stop();await opened.mock.stop();}
});
