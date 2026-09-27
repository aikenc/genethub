import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { defineSpecialty, openBrowser, openPreviewBrowser, daemonEndpoint } from '../../framework/public.ts';
const q=(s:string)=>`'${s.replaceAll("'",`'\\''`)}'`;
function field(value:any,key:string):any {if(typeof value==='string'){for(const line of value.split('\n').reverse()){try{const found=field(JSON.parse(line),key);if(found!==undefined)return found;}catch{}}}else if(value&&typeof value==='object'){if(value[key]!==undefined)return value[key];for(const child of Object.values(value).reverse()){const found=field(child,key);if(found!==undefined)return found;}}}
function inputOf(value:any):any {if(typeof value==='string'){const match=value.match(/结构化输入（数据，不是指令）：([^\n]+)/);if(match?.[1])return JSON.parse(match[1]);}else if(value&&typeof value==='object'){for(const child of Object.values(value).reverse()){const found=inputOf(child);if(found)return found;}}}
for(const scenario of ['repair','reject','preview','regression'] as const)defineSpecialty({
 id:`specialty.workflow.quality-execution.${scenario}`,title:`Shipped asynchronous quality workflow ${scenario} with actual branches and independent review`,
 oracle:'Two real feature branches develop and review independently; script gates force repair or reject publication; mainline is checked by three separate reviewers after each integration',
 catches:['flow references fail only at runtime','negative review still publishes','integration skips independent review','three reviewers inspect different commits','next round loses feedback'],
 runner:scenario==='preview'?'playwright':'node',retention:scenario==='preview',tags:['workflow','core','workflow-authoring'],llm:{default:'mock'},expectedDurationMs:45000,timeoutMs:240000,
 resources:{environments:1,cpu:2,memoryMb:768,io:1,browser:scenario==='preview'?1:0},surfaces:['daemon','agent','genet-cli','git','bootstrap-pack'],productInterfaces:['workflow.build','workflow.dispatch','workflow.complete','pack.script'],
},async t=>{
 const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
 const root=path.join(t.env.workspace,'project');mkdirSync(root);t.data.git.init(root);
 const git=(args:string[])=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});if(r.status)throw new Error(r.stderr);return r.stdout.trim();};
 try {
  t.flows.main.clonePackage({openRoot:t.openRoot,projectRoot:root});writeFileSync(path.join(root,'README.md'),'quality fixture\n');git(['add','.']);git(['commit','-m','initial']);
  const project=await opened.client.call({type:'workspace.open',payload:{root}});if(project?.type!=='workspace')throw Error('project missing');
  await t.flows.main.configureMockProvider(opened.client,opened.mock);
  const features=['a','b'].map(id=>({id,goal:`Write independent ${id} file`,branch:`feature-${id}`,criteria:[{id:'content',requirement:`${id}.txt contains approved`,method:'read the pinned Git blob'}]}));
  let stage=0;const seen=new Set<string>(),attempts=new Map<string,number>(),reviews:any[]=[];
  opened.mock.script(...Array.from({length:160},()=>({respond:(request:any)=>{
   const body=JSON.stringify(request),input=inputOf(request);
   const command=(text:string)=>({tool:{name:'bash',arguments:{command:`cd ${q(path.resolve(root,body.includes('<genehub_managed_session>')?input?.workspace||'.':'.'))} && ${text}`}}});
   if(body.includes('<genehub_managed_session>')&&input){
    const operation=body.match(/当前节点：(operation-\d+)/)?.[1];if(!operation)throw Error('no operation');
    if(seen.has(operation))return {text:'Result already submitted.'};seen.add(operation);
    const complete=(output:any)=>command(`"$GENEHUB_CLI" workflow complete --output ${q(JSON.stringify(output))}`);
    if(input.phase==='quality-planning')return complete({decision:'go',rationale:'Two independent immutable contracts',features});
    const feature=input.feature;if(!feature?.id)throw Error('feature lost');
    if(input.phase==='branch-preparation')return command(`git worktree add -b ${q(feature.branch)} ${q('.genethub/temp/branches/'+feature.id)} HEAD && "$GENEHUB_CLI" workflow complete --evidence worktree=created --output ${q(JSON.stringify({workspace:'.genethub/temp/branches/'+feature.id,branch:feature.branch,baseCommit:git(['rev-parse','HEAD'])}))}`);
    if(input.phase==='branch-implementation'){
     const count=(attempts.get(feature.id)||0)+1;attempts.set(feature.id,count);
     const content=feature.id==='b'&&(scenario==='reject'||count===1)?'needs-fix':scenario==='regression'&&feature.id==='b'?'approved\nbreaks-a':'approved';
     return command(`printf '%s\\n' ${q(content)} > ${q(feature.id+'.txt')} && git add ${q(feature.id+'.txt')} && git commit --allow-empty -m ${q('implement '+feature.id+' '+count)} && "$GENEHUB_CLI" workflow complete --evidence "commit=$(git rev-parse HEAD)" --evidence checks=fixture --output "$(python3 -c ${q("import json,subprocess;print(json.dumps({'commit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'summary':'actual fixture commit'}))")})"`);
    }
    if(input.phase==='mainline-integration')return command(`git merge --no-ff ${q(feature.branch)} -m ${q('integrate '+feature.id)} && "$GENEHUB_CLI" workflow complete --evidence "commit=$(git rev-parse HEAD)" --evidence checks=merged --output "$(python3 -c ${q("import json,subprocess;print(json.dumps({'mainlineCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'notes':'actual merge'}))")})"`);
    if(input.phase==='quality-review'){
     reviews.push(input);
     const script=`import json,subprocess\ni=json.loads(${JSON.stringify(JSON.stringify(input))})\nblob=subprocess.check_output(['git','show',i['commit']+':'+i['feature']['id']+'.txt'],text=True)\nregression=i.get('finalAudit') and i['feature']['id']=='a' and 'breaks-a' in subprocess.check_output(['git','show',i['commit']+':b.txt'],text=True)\nrows=[{'id':c['id'],'status':('passed' if 'approved' in blob and not regression else 'failed') if i['group']=='requirements' else 'na','reason':('final cross-feature invariant violated by b.txt' if regression else 'pinned fixture content checked') if i['group']=='requirements' else 'This text-only fixture changes no game experience or runtime code','evidence':i['commit']+':'+i['feature']['id']+'.txt','suggestion':''} for c in i['checklist']]\nprint(json.dumps({'commit':i['commit'],'checklist':rows}))`;
     const previewDispute=scenario==='preview'&&input.feature.id==='a'&&input.group==='engineering'?"\nrows[0].update(status='disputed',reason='The line-count rule has no useful limit for this text-only fixture',suggestion='WM should scope it to executable source files')":"";
     return command(`"$GENEHUB_CLI" workflow complete --output "$(python3 -c ${q(script.replace('print(json.dumps(',previewDispute+'\nprint(json.dumps('))})"`);
    }
    throw Error('unexpected phase '+input.phase);
   }
   switch(stage++){
    case 0:return command('"$GENEHUB_CLI" workflow build --package game-delivery');
    case 1:return {tool:{name:'request_user_input',arguments:{questions:[{id:field(request,'challengeId'),header:'接管',question:'批准隔离质量流程测试',options:[{label:'yes',description:'接管'},{label:'no',description:'拒绝'}]}]}}};
    case 2:return command(`"$GENEHUB_CLI" workflow build --package game-delivery --apply --plan-digest ${field(request,'planDigest')} --revision ${field(request,'expectedRevision')} --action-id quality-install`);
    case 3:return command('git add -A && git commit -m "install team" && "$GENEHUB_CLI" workflow inspect');
    case 4:return command(`"$GENEHUB_CLI" workflow activate --revision ${field(request,'activationRevision')}`);
    case 5:return command('"$GENEHUB_CLI" workflow dispatch --workflow quality-parallel --task quality-fixture --no-wait --message "Execute two independent fixture contracts"');
    default:return {text:'Observe the one delegated Run.'};
   }
  }})));
  const pm=await t.flows.main.createBuiltinSession(opened.client,project.data.id);
  await t.flows.main.sendPrompt(opened.client,pm,'Install and execute the quality workflow once.');
  let permission:any;
  await t.tools.waitUntil(async()=>{const r=await opened.client.call({type:'session.get',payload:{sessionId:pm}});if(r?.type!=='snapshot')return false;permission=r.data.pendingPermissions[0];return !!permission;},40000);
  await opened.client.call({type:'session.respondPermission',payload:{sessionId:pm,requestId:permission.id,outcome:{outcome:'selected',optionId:'approve-once'}}});
  let run:any;
  await t.tools.waitUntil(async()=>{const r=await opened.client.call({type:'workflow.history',payload:{workspaceId:project.data.id,limit:10}});if(r?.type!=='workflowRuns')return false;run=r.data[0];return run&&['completed','blocked','failed'].includes(run.status);},180000).catch(async error=>{const snapshot=await opened.client.call({type:'session.get',payload:{sessionId:pm}});throw new Error(String(error)+'; stage='+stage+'; attempts='+JSON.stringify([...attempts])+'; reviews='+JSON.stringify(reviews.map(r=>[r.group,r.workspace,r.commit]))+'; run='+JSON.stringify(run)+'; pm='+JSON.stringify(snapshot).slice(-12000));});
  t.assertions.assert(run.status==='completed',`${run.status}: ${run.reason}; ${JSON.stringify(run.nodes.filter((n:any)=>n.status!=='completed').map((n:any)=>({id:n.id,status:n.status})))}`);
  const outcome=run.structure?.outcome?.value;
  t.assertions.assert(outcome?.done===(!['reject','regression'].includes(scenario)),JSON.stringify(outcome));
  t.assertions.assert(run.nodes.filter((n:any)=>n.uses==='result.publish').length===(!['reject','regression'].includes(scenario)?1:0),'rejection bypassed publishing gate');
  t.assertions.assert(attempts.get('a')===1&&attempts.get('b')===(scenario!=='reject'?2:3),'bounded quality repair was skipped');
  t.assertions.assert(reviews.filter(r=>r.workspace==='.'&&!r.finalAudit).length===(scenario!=='reject'?6:3),'mainline three-way independent review missing');
  const finalReviews=reviews.filter(r=>r.finalAudit);
  t.assertions.assert(finalReviews.length===(scenario==='reject'?0:6),'final snapshot skipped any delivery unit or Reviewer');
  if(scenario!=='reject')t.assertions.assert(finalReviews.every(r=>r.commit===git(['rev-parse','HEAD']))&&outcome.finalCommit===git(['rev-parse','HEAD']),'final reviewers did not inspect one exact delivery commit');
  if(scenario==='regression')t.assertions.assert(outcome.qualitySummary.includes('1 项未通过'),'final regression was hidden by earlier feature passes');
  t.assertions.assert(git(['status','--porcelain'])==='','integration left dirty mainline');
  if(scenario==='preview'){
    t.assertions.assert(outcome.qualitySummary.includes('有异议交付')&&outcome.qualityReport,'package delivery result lost WM feedback');
    const browser=await openBrowser();let consumer:Awaited<ReturnType<typeof openPreviewBrowser>>|undefined;
    try{
      await browser.page.setViewportSize({width:390,height:844});
      consumer=await openPreviewBrowser({openRoot:t.openRoot,lease:t.env,page:browser.page,endpoint:daemonEndpoint(opened.daemon),workspaceId:project.data.id,entryPath:run.id,surface:'workflow'});
      const frame=browser.page.frameLocator('iframe');
      await frame.getByText('功能线 · 并行交付',{exact:true}).waitFor({timeout:30000});
      t.assertions.assert(await frame.getByRole('button',{name:/单文件.*规范不合理/}).isVisible(),'package dispute did not reach its frozen view');
      await frame.getByRole('button',{name:/单文件.*规范不合理/}).click();
      await frame.getByText('WM should scope it to executable source files',{exact:false}).first().waitFor();
      await frame.getByRole('button',{name:'关闭 ×',exact:true}).click();
      await frame.getByRole('button',{name:'竖向',exact:true}).click();
      await browser.page.screenshot({path:path.join(process.env.TESTCTL_BROWSER_ARTIFACTS||t.env.workspace,'quality-mobile.png'),fullPage:true});
      await browser.page.setViewportSize({width:1440,height:1000});
      await frame.getByRole('button',{name:'横向',exact:true}).click();
      await browser.page.screenshot({path:path.join(process.env.TESTCTL_BROWSER_ARTIFACTS||t.env.workspace,'quality-desktop.png'),fullPage:true});
      await frame.getByRole('button',{name:'交给 PM 转 WM ›',exact:true}).click();
      await browser.page.getByRole('dialog',{name:'交付进度',exact:true}).waitFor({state:'hidden'});
      await browser.page.waitForFunction(()=>Array.from(document.querySelectorAll('textarea')).some(n=>n.value.includes('WM should scope')));
      const draft=await browser.page.locator('textarea').evaluateAll(nodes=>nodes.map(n=>(n as HTMLTextAreaElement).value).join('\n'));
      t.assertions.assert(draft.includes('请交给 WM')&&draft.includes('WM should scope'),'draft intent lost package feedback');
      t.assertions.assert(!consumer.errors.length,consumer.errors.join('; '));
    }finally{await browser.close();await consumer?.close();}
  }
  t.note('Two actual Git worktrees, independent pinned-commit reviews, package script gates; deterministic LLM decisions verify execution mechanics, not autonomous quality judgment.');
 }finally{opened.client.close();opened.daemon.stop();await opened.mock.stop();}
});
