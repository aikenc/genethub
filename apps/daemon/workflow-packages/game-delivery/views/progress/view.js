(() => {
  const app = document.querySelector('#app'), gh = window.GenetHub;
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const duration = ms => ms >= 3600000 ? `${(ms/3600000).toFixed(1)}h` : ms >= 60000 ? `${Math.round(ms/60000)}m` : `${Math.round(ms/1000)}s`;
  const groups = {requirements:'需求验收项',product:'产品规范',engineering:'工程规范'};
  const labels = {passed:'通过',failed:'未通过',na:'无需验证',disputed:'规范不合理',unverified:'尚未完成验证',partial:'部分通过',pending:'待验收'};
  let profile, standards, events, checks, critical, selected=null, filter='all', mode='auto', highlight=true, disposed=false, nodeFocused=false;
  const colors = ['#57c6ad','#6c9ef8','#b495f6','#e6b766','#e37f86'];
  if (!gh) {app.innerHTML='<p>这是工作流构建内的进度视图。请从 GeneHub 的小队任务或执行会话打开；本页面需要宿主注入真实 Run 数据。</p>';return;}
  let observationFolderSeen=false;
  async function packageRecords() {
    let tree;
    try { tree=await gh.fs.readdir((gh.context.executionRoot&&gh.context.executionRoot!=='.'?gh.context.executionRoot+'/':'')+'.genethub/temp/observations'); observationFolderSeen=true; }
    catch(error){if(!observationFolderSeen&&/not found|no such file|不存在/i.test(String(error.message)))return [];throw error;}
    const files=(tree.children||[]).filter(file=>!file.isDir&&file.name.endsWith('.json'));
    if((tree.children||[]).length>=2000)throw new Error('观测目录达到文件接口的 2000 条上限，请 WM 按 Run 分目录组织');
    const records=[];
    for(let offset=0;offset<files.length;offset+=16){
      const batch=await Promise.all(files.slice(offset,offset+16).map(async file=>JSON.parse(await gh.fs.readFile(file.path))));
      records.push(...batch);
    }
    return records;
  }
  function collectStandards(value) {
    if(!value||typeof value!=='object')return;
    const fields=value.op==='object'?value.fields:null;
    const group=fields?.group?.value, checklist=fields?.checklist?.value;
    if((group==='product'||group==='engineering')&&Array.isArray(checklist))standards[group]=checklist;
    if(value.op==='literal')return;
    Object.values(value).forEach(collectStandards);
  }
  async function loadProfile() {
    const payload={workspaceId:gh.context.workspaceId,runId:gh.context.runId};
    const result=await gh.rpc('workflow.profile',payload);
    let next=result.nextOffset;
    for(let page=0;next!=null;page++){
      if(page>=128)throw new Error('观测节点分页超过工作流上限');
      const more=await gh.rpc('workflow.profile',{...payload,offset:next});
      const revisions=JSON.stringify(result.runs.map(r=>[r.run.id,r.run.revision]));
      if(revisions!==JSON.stringify(more.runs.map(r=>[r.run.id,r.run.revision])))throw new Error('运行在分页读取时更新，请刷新重读');
      for(const row of more.runs){const target=result.runs.find(r=>r.run.id===row.run.id);Object.assign(target.nodes,row.nodes);}
      next=more.nextOffset;
    }
    return result;
  }
  async function load() {
    const [fresh,records]=await Promise.all([
      loadProfile(),packageRecords()]);
    profile=fresh; standards={product:[],engineering:[]};
    for(const row of profile.runs){
      collectStandards(row.run.structure);
      for(const node of Object.values(row.nodes)){
        if(node.input?.group==='product')standards.product=node.input.checklist;
        if(node.input?.group==='engineering')standards.engineering=node.input.checklist;
      }
    }
    events=WorkflowObserve.events(profile,records);critical=WorkflowObserve.criticalPath(events);checks=WorkflowObserve.checklists(profile,standards);
    if(!nodeFocused&&gh.context.nodeId){selected=events.find(e=>e.nodeId===gh.context.nodeId)?.id||null;nodeFocused=!!selected;}
    render();
  }
  function timeline() {
    if (!events.length) return '<p class="muted">工作步骤开始后显示真实时间线。</p>';
    const start=Math.min(...events.map(e=>e.startMs)),end=Math.max(...events.map(e=>e.endMs)),span=Math.max(1,end-start);
    const groups=[...new Set(events.map(e=>e.lane))], tracks=[], assigned=new Map();
    for(const group of groups){
      const ends=[];
      for(const event of events.filter(e=>e.lane===group).sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs)){
        let slot=ends.findIndex(end=>end<=event.startMs);if(slot<0)slot=ends.length;
        ends[slot]=event.endMs;assigned.set(event.id,{group,slot});
      }
      for(let slot=0;slot<ends.length;slot++)tracks.push({group,slot,title:ends.length>1?`${group} · ${slot+1}`:group});
    }
    const lanes=tracks.map(t=>t.title), vertical=mode==='vertical'||mode==='auto'&&innerWidth<520;
    const blocks=events.map(event=>{
      const placement=assigned.get(event.id),lane=tracks.findIndex(t=>t.group===placement.group&&t.slot===placement.slot),pos=(event.startMs-start)/span*100,len=Math.max(.5,(event.endMs-event.startMs)/span*100);
      const style=vertical?`left:${lane/lanes.length*100}%;width:${100/lanes.length}%;top:${pos}%;height:${len}%`:`top:${lane*58}px;left:${pos}%;width:${len}%;height:44px`;
      return `<button class="segment ${critical.ids.has(event.id)&&highlight?'critical':''}" style="${style};--color:${colors[lane%colors.length]}" data-event="${esc(event.id)}" title="${esc(event.title)} · ${duration(event.endMs-event.startMs)}"><b>${esc(event.title)}</b><small>${event.round?`第${event.round}轮 · `:''}${duration(event.endMs-event.startMs)}</small></button>`;
    }).join('');
    const workers=events.filter(e=>e.node.uses==='agent.session');
    const sum=new Map();for(const segment of critical.segments)sum.set(segment.title,(sum.get(segment.title)||0)+segment.endMs-segment.startMs);
    return `<div class="timeline ${vertical?'vertical':'horizontal'}"><div class="lane-labels">${lanes.map(lane=>`<span>${esc(lane)}</span>`).join('')}</div><div class="tracks" style="${vertical?'height:620px':`height:${lanes.length*58}px`}">${blocks}</div><div class="axis"><span>0</span><span>${duration(span/2)}</span><span>${duration(span)}</span></div></div>
      <h3>时间花在哪 · 关键路径</h3><p class="muted">以实际任务时长、结构依赖和包内等待记录计算关键路径与余量。未分类调度间隔单独列出；这是本次执行的分析，未来用时须由 WM 试验验证。</p>
      ${critical.incomplete?'<p class="notice">有缺失或循环依赖记录，关键路径尚不能完整核对。</p>':''}
      <div class="time-distribution">${[...sum].map(([title,ms])=>`<div><span>${esc(title)}</span><b>${duration(ms)}</b><i style="width:${ms/span*100}%"></i></div>`).join('')}</div>
      <p class="muted">助手占用时长 ${duration(WorkflowObserve.occupancy(workers).workerMs)}（包含等待） · 同时峰值 ${WorkflowObserve.peak(workers)} 人</p>
      <details><summary>各步骤的时间余量</summary>${events.filter(e=>!critical.ids.has(e.id)).map(e=>`<div class="detail-row"><span>${esc(e.lane)} · ${esc(e.title)}</span><b>${duration(critical.float.get(e.id)||0)}</b></div>`).join('')||'<p>当前步骤都在关键路径上。</p>'}</details>
      ${burnup()}
      <details><summary>最慢步骤与运行细节</summary>${events.slice().sort((a,b)=>(b.endMs-b.startMs)-(a.endMs-a.startMs)).slice(0,8).map(e=>`<button class="detail-row" data-event="${esc(e.id)}"><span>${esc(e.lane)} · ${esc(e.title)}${critical.ids.has(e.id)?' · 关键路径':''}</span><b>${duration(e.endMs-e.startMs)}</b></button>`).join('')}</details>`;
  }
  function burnup() {
    const points=WorkflowObserve.burnup(checks);if(!points.length)return '';
    const start=points[0].atMs,span=Math.max(1,points.at(-1).atMs-start),total=Math.max(1,...points.map(p=>p.applicable));
    const line=points.map(p=>`${(p.atMs-start)/span*100},${100-p.passed/total*100}`).join(' ');
    return `<h3>验收推进</h3><svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100px" role="img" aria-label="清单通过数随时间变化"><polyline points="${line}" fill="none" stroke="#57c6ad" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><p class="muted">${points.at(-1).passed}/${points.at(-1).applicable} 项通过；重新未通过会回落，无需验证不计入分母。</p>`;
  }
  function features() {
    const found=new Map();
    for(const row of profile.runs)for(const node of Object.values(row.nodes)){
      for(const feature of node.output?.features||[])if(feature.id)found.set(feature.id,feature);
      if(node.input?.feature?.id)found.set(node.input.feature.id,node.input.feature);
    }
    if(!found.size)return '';
    return `<section class="card"><h2>功能线 · 并行交付</h2><p class="muted">每条线独立开发、验收、修复，先通过先合入；主干写锁串行，集成后再次验收。</p>${[...found].map(([id,feature])=>{
      const own=events.filter(e=>e.node.input?.feature?.id===id), rounds=new Map();
      for(const event of own){if(!event.round)continue;const key=`${event.node.input.finalAudit?'最终提交':event.node.input.workspace==='.'?'集成':'分支'}第 ${event.round} 轮`;if(!rounds.has(key))rounds.set(key,[]);rounds.get(key).push(event);}
      const current=own.findLast(e=>['active','finishing','pending'].includes(e.node.phase))||own.at(-1);
      return `<article class="feature-line"><div class="section-heading"><h3>${esc(feature.goal||id)}</h3><small>${esc(feature.branch||id)}</small></div><p>${esc(current?.title||'等待推进')} · ${esc(current?.node.phase==='settled'?'步骤已结算':current?.node.phase||'待派发')}</p><details><summary>逐轮记录 · ${rounds.size} 轮</summary>${[...rounds].map(([round,steps])=>`<h3>${esc(round)}</h3>${steps.map(e=>`<button class="detail-row" data-event="${esc(e.id)}"><span>${esc(e.title)} · ${esc(e.node.phase==='settled'?'已完成':e.node.phase)}</span><b>${duration(e.endMs-e.startMs)}</b></button>`).join('')}`).join('')}</details></article>`;
    }).join('')}</section>`;
  }
  function quality() {
    if (!checks.length) return '<p class="muted">这个流程尚未输出三类清单。平台只提供原始运行数据，清单由本工作流管理。</p>';
    const applicable=checks.filter(c=>c.status!=='na'),passed=checks.filter(c=>c.status==='passed').length;
    return `<div class="section-heading"><h2>交付清单</h2><b>${passed}/${applicable.length} 通过</b></div><p class="muted">需求由 owner 拆解；产品与工程规范由 WM 编写，Reviewer 验证。同一规范在全部交付单元通过才算通过。</p>
      <div class="filters">${['all','failed','pending','disputed','na'].map(key=>`<button class="${filter===key?'on':''}" data-filter="${key}">${key==='all'?'全部':key==='na'?'含无需验证':labels[key]}</button>`).join('')}</div>
      ${Object.entries(groups).map(([group,title])=>{const items=checks.filter(c=>c.group===group&&(filter==='all'||filter==='na'?filter==='all'||c.latest.some(v=>v.status==='na'):filter==='disputed'?c.latest.some(r=>r.status==='disputed'):c.status===filter));return `<section class="check-group"><h3>${title}</h3><div class="matrix">${items.map(c=>`<button class="square ${c.status}" data-check="${esc(c.key)}" aria-label="${esc(c.requirement)}：${labels[c.status]}" title="${esc(c.requirement)} · ${labels[c.status]}">${c.status==='passed'?'✓':c.status==='na'?'—':c.status==='disputed'?'!':c.status==='failed'?'×':''}</button>`).join('')}</div><p class="muted">${items.filter(c=>c.status==='passed').length} 通过 · ${items.filter(c=>c.status==='failed').length} 未通过 · ${items.filter(c=>c.status==='disputed').length} 有异议</p></section>`;}).join('')}
      <div class="legend">${Object.entries(labels).map(([key,label])=>`<span><i class="square ${key}"></i>${label}</span>`).join('')}</div>
      ${checks.some(c=>c.latest.some(r=>r.status==='disputed'))?`<div class="notice">规范有异议，已保留理由与建议，不计作通过。<button data-action="disputes">交给 PM 转 WM ›</button></div>`:''}`;
  }
  function cost() {
    const tiers={veryHigh:'超高',high:'高',medium:'中',low:'低',veryLow:'超低'};
    const rates=profile.cost.byModelRate||[];
    return `<h2>钱花在哪</h2><strong class="big">¥${(profile.cost.milliCny/1000).toFixed(2)}</strong><p class="muted">估算成本：实际 LLM 请求次数 × 当时配置的档位单价。含重试与恢复；不把 PM 整段会话重复摊入请求。</p>
      ${rates.map(row=>`<div class="detail-row"><span>${esc(row.rate.agentId)}/${esc(row.rate.modelId||'默认模型')}<small>${tiers[row.rate.level]||esc(row.rate.level)} · ${row.calls} 次 × ¥${row.rate.unitMilliCny/1000}${row.rate.levelSource==='inferred'?' · 默认档位':''}</small></span><b>¥${(row.milliCny/1000).toFixed(2)}</b></div>`).join('')}
      ${profile.cost.recoveryCalls?`<p class="muted">恢复 ${profile.cost.recoveryCalls} 次 · ¥${(profile.cost.recoveryMilliCny/1000).toFixed(2)}；恢复预算独立于业务预算。</p>`:''}
      ${profile.cost.unpricedCalls?`<p class="notice">${profile.cost.unpricedCalls} 次历史调用没有单价快照，未计价。</p>`:''}`;
  }
  function detail() {
    if(!selected)return '';
    const check=checks.find(c=>c.key===selected),event=events.find(e=>e.id===selected);
    if(check)return `<aside class="detail"><button data-action="close">关闭 ×</button><h2>${esc(check.requirement)}</h2><p>${groups[check.group]} · ${labels[check.status]}</p>${check.records.map(r=>`<article><b>${esc(r.scope)} · ${r.phase}第 ${r.round} 轮 · ${labels[r.status]||esc(r.status)}</b><p>${esc(r.reason)}</p><p class="muted">${esc(r.evidence)}</p>${r.suggestion?`<p>建议：${esc(r.suggestion)}</p>`:''}<small>版本 ${esc(r.commit)}</small><button data-session="${esc(r.sessionId)}">查看验收会话 ›</button></article>`).join('')||'<p>尚无验证记录。</p>'}</aside>`;
    if(event)return `<aside class="detail"><button data-action="close">关闭 ×</button><h2>${esc(event.title)}</h2><p>${esc(event.lane)} · ${duration(event.endMs-event.startMs)} · ${event.calls} 次调用</p><p>前驱：${esc([...event.dependsOn].join('、')||'起点')}</p><pre>${esc(JSON.stringify({input:event.node.input,output:event.node.output,evidence:event.node.evidence},null,2))}</pre>${event.node.sessionId?`<button data-session="${esc(event.node.sessionId)}">查看运行细节 ›</button>`:''}</aside>`;
    return '';
  }
  function render() {
    const budget=profile.budget,parallel=WorkflowObserve.occupancy(events.filter(e=>e.node.uses==='agent.session')).parallelism,used=Math.max(budget.observedLlmRounds/Math.max(1,budget.budget.maxLlmRounds),budget.usedRuns/Math.max(1,budget.budget.maxRuns)),wallMs=events.length?Math.max(...events.map(e=>e.endMs))-Math.min(...events.map(e=>e.startMs)):0;
    app.innerHTML=`<header class="overview"><p class="eyebrow">工作流交付</p><h1>${esc(profile.runs.find(r=>r.run.id===profile.runId)?.run.taskId||'进度')}</h1><div class="metrics"><div><b>${parallel.toFixed(1)} 人</b><small>平均并行</small></div><div><b>${duration(wallMs)}</b><small>观测时长</small></div><div><b>${Math.round(used*100)}%</b><small>预算用量</small></div></div><p class="muted">LLM 请求 ${budget.observedLlmRounds}/${budget.budget.maxLlmRounds} · Run ${budget.usedRuns}/${budget.budget.maxRuns}</p><p class="muted">并行：有助手接手的时段，平均同时占用几个助手（包含等待）。</p></header>
      ${features()}<section class="card">${quality()}</section><div class="columns"><section class="card"><div class="section-heading"><h2>时间线与时间花在哪</h2><button data-action="highlight">${highlight?'✓ ':''}关键路径</button></div><div class="filters">${['auto','horizontal','vertical'].map(key=>`<button data-mode="${key}" class="${mode===key?'on':''}">${{auto:'自动',horizontal:'横向',vertical:'竖向'}[key]}</button>`).join('')}</div>${timeline()}</section><section class="card">${cost()}</section></div><p class="muted">数据更新于 ${new Date(profile.atMs).toLocaleTimeString()} <button data-action="refresh">刷新</button></p>${detail()}`;
  }
  app.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    try {
      if(button.dataset.check||button.dataset.event){selected=button.dataset.check||button.dataset.event;render();}
      else if(button.dataset.filter){filter=button.dataset.filter;render();}
      else if(button.dataset.mode){mode=button.dataset.mode;render();}
      else if(button.dataset.session)await gh.intent.openSession({sessionId:button.dataset.session});
      else if(button.dataset.action==='close'){selected=null;render();}
      else if(button.dataset.action==='refresh')await load();
      else if(button.dataset.action==='highlight'){highlight=!highlight;render();}
      else if(button.dataset.action==='disputes')await gh.intent.draftToPM({text:'请交给 WM 核对这些规范异议，保留当前交付质量底线：\n'+checks.filter(c=>c.latest.some(r=>r.status==='disputed')).map(c=>c.requirement+'\n'+c.latest.filter(r=>r.status==='disputed').map(r=>r.reason+'；建议：'+r.suggestion).join('\n')).join('\n')});
    } catch(error){showError(error);}
  });
  function showError(error){let node=document.querySelector('#load-error');if(!node){node=document.createElement('p');node.id='load-error';node.className='notice';node.setAttribute('role','alert');app.prepend(node);}node.textContent=String(error.message||error);}
  let loading=false;
  async function refresh(){if(loading||disposed)return;loading=true;try{await load();}catch(error){showError(error);}finally{loading=false;}}
  const timer=setInterval(()=>{if(!document.hidden&&!selected)void refresh();},5000);
  addEventListener('pagehide',()=>{disposed=true;clearInterval(timer);});
  addEventListener('resize',()=>{if(profile&&mode==='auto')render();});
  void refresh();
})();
