/* Package code. WM may replace both its data contract and its visualizations. */
(() => {
  const list = value => Array.isArray(value) ? value : [];
  const time = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
  const frameKey = (runId, frame) => `${runId}/${frame.id}`;
  function events(profile, records = []) {
    const result = [];
    for (const row of profile.runs) {
      for (const [id, node] of Object.entries(row.nodes)) {
        if (!node.assignedAtMs) continue;
        const endMs = time(node.settledAtMs, ['running','finishing'].includes(node.status) ? profile.atMs : row.updatedAtMs);
        const scope = list(node.scope), item = scope.findLast(frame => frame.itemId)?.itemId;
        const loop = scope.findLast(frame => frame.round != null)?.round;
        const activity = node.definitionId || id;
        const phase=node.input?.phase, group={requirements:'需求验收',product:'体验验收',engineering:'变更 Review'}[node.input?.group];
        const title=phase==='quality-review'?`${node.input?.finalAudit?'最终提交':node.input?.workspace==='.'?'集成':'分支'} · ${group||'验收'}`:({'quality-planning':'拆解需求','branch-preparation':'准备分支','branch-implementation':'分支开发','mainline-integration':'合入主干','mainline-repair':'修复集成问题'}[phase]||activity);
        result.push({id: `${row.run.id}/${id}`, nodeId: id, runId: row.run.id, activity,
          title, lane: item || '公共步骤', round: loop,
          startMs: node.assignedAtMs, endMs, node, scope, row, dependsOn: new Set(),
          calls: node.activity?.llmRounds || 0, cost: node.activity?.estimatedMilliCny || 0});
      }
    }
    // Native structure gives actual sequence, loop and branch instance identity.
    // Sibling parallel/forEach items receive no invented dependency.
    const groups = new Map();
    for (const event of result) {
      event.scope.forEach((frame, index) => {
        if (!['sequence','loop'].includes(frame.kind)) return;
        const key = frameKey(event.runId, frame);
        if (!groups.has(key)) groups.set(key, {kind: frame.kind, events: []});
        groups.get(key).events.push({event, child: event.scope[index+1]?.id, round: frame.round});
      });
    }
    for (const group of groups.values()) {
      const steps = new Map();
      for (const item of group.events) {
        const key = group.kind === 'loop' ? item.round : item.child;
        if (key == null) continue;
        if (!steps.has(key)) steps.set(key, []);
        steps.get(key).push(item.event);
      }
      const ordered = [...steps.values()].sort((a,b) => Math.min(...a.map(e=>e.startMs)) - Math.min(...b.map(e=>e.startMs)));
      for (let i=1; i<ordered.length; i++) {
        for (const event of ordered[i]) for (const predecessor of ordered[i-1]) {
          if (predecessor.endMs <= event.startMs && predecessor.id !== event.id) event.dependsOn.add(predecessor.id);
        }
      }
    }
    // Files belong to this package, not to a platform scheduling schema.
    // A record can refine a native node or introduce a timed script substep.
    const lookup = new Map(result.map(event => [event.id, event]));
    for (const observation of records) {
      if (!profile.runs.some(row => row.run.id === observation.runId)) continue;
      const id = `${observation.runId}/${observation.nodeId || observation.id}`;
      let event = lookup.get(id);
      if (!event && Number.isFinite(observation.startMs) && Number.isFinite(observation.endMs)) {
        if (observation.endMs < observation.startMs) throw new Error(`依赖记录时间倒置：${id}`);
        event = {id, nodeId: observation.id, runId: observation.runId, activity: observation.id,
          title: observation.title || observation.id, lane: observation.lane || '脚本步骤',
          startMs: observation.startMs, endMs: observation.endMs, scope: [], node: {},
          dependsOn: new Set(), calls: 0, cost: 0};
        result.push(event); lookup.set(id, event);
      }
      if (event) event.observation = observation;
    }
    for (const event of result) {
      const observation = event.observation || event.node.output?.observation;
      if (observation?.dependsOn) event.dependsOn = new Set(observation.dependsOn.map(id => id.includes('/') ? id : `${event.runId}/${id}`));
      event.waits = list(observation?.waits);
    }
    return result.sort((a,b) => a.startMs-b.startMs || a.id.localeCompare(b.id));
  }
  function criticalPath(events) {
    if (!events.length) return {ids: new Set(), segments: [], incomplete: false, float: new Map()};
    const lookup = new Map(events.map(event=>[event.id,event]));
    const start = Math.min(...events.map(e=>e.startMs)), finish = Math.max(...events.map(e=>e.endMs));
    const order = [], visiting = new Set(), visited = new Set(); let incomplete = false;
    function visit(event) {
      if (visited.has(event.id)) return;
      if (visiting.has(event.id)) { incomplete = true; return; }
      visiting.add(event.id);
      for (const id of event.dependsOn) {
        const predecessor = lookup.get(id);
        if (!predecessor || predecessor.endMs > event.startMs) { incomplete = true; continue; }
        visit(predecessor);
      }
      visiting.delete(event.id); visited.add(event.id); order.push(event);
    }
    events.forEach(visit);
    // CPM on the executed graph. Preserve measured dispatch/queue intervals as
    // lag activities; reasons come from package records, never kernel guesses.
    const early = new Map(), late = new Map(), previous = new Map(), lag = new Map();
    for (const event of order) {
      const predecessors = [...event.dependsOn].map(id=>lookup.get(id)).filter(e=>e && e.endMs <= event.startMs && early.has(e.id));
      const predecessor = predecessors.reduce((best,e)=>!best || early.get(e.id).end > early.get(best.id).end ? e : best, null);
      const observedRelease = predecessors.reduce((last,e)=>Math.max(last,e.endMs),start);
      const wait = Math.max(0,event.startMs-observedRelease);
      const begin = (predecessor ? early.get(predecessor.id).end : start) + wait;
      early.set(event.id,{start:begin,end:begin+event.endMs-event.startMs});
      previous.set(event.id,predecessor); lag.set(event.id,wait);
    }
    order.slice().reverse().forEach(event => {
      const successors=events.filter(e=>e.dependsOn.has(event.id) && e.startMs>=event.endMs);
      const end=successors.reduce((last,e)=>Math.min(last,(late.get(e.id)?.start ?? finish)-lag.get(e.id)),finish);
      late.set(event.id,{start:end-(event.endMs-event.startMs),end});
    });
    const float = new Map(order.map(e=>[e.id,Math.max(0,late.get(e.id).start-early.get(e.id).start)]));
    let current=order.reduce((best,e)=>!best || early.get(e.id).end>early.get(best.id).end ? e : best,null);
    const chain=[],ids=new Set();
    while(current&&!ids.has(current.id)){ids.add(current.id);chain.unshift(current);current=previous.get(current.id);}
    const segments=[];let cursor=start;
    for(const event of chain){
      if(event.startMs>cursor){
        const waits=event.waits.filter(w=>Number.isFinite(w.startMs)&&Number.isFinite(w.endMs)&&w.endMs>w.startMs).sort((a,b)=>a.startMs-b.startMs);
        for(const wait of waits){const begin=Math.max(cursor,wait.startMs),end=Math.min(event.startMs,wait.endMs);if(end<=begin)continue;
          if(begin>cursor)segments.push({startMs:cursor,endMs:begin,title:'未分类等待／调度',kind:'wait'});
          segments.push({startMs:begin,endMs:end,title:wait.reason||'等待',kind:'wait'});cursor=end;}
        if(cursor<event.startMs)segments.push({startMs:cursor,endMs:event.startMs,title:'未分类等待／调度',kind:'wait'});
      }
      segments.push({...event,kind:event.title});cursor=event.endMs;
    }
    return {ids,segments,incomplete,float};
  }
  function burnup(checks) {
    const records=checks.flatMap(check=>check.records.map(record=>({...record,key:check.key,definition:check}))).sort((a,b)=>a.atMs-b.atMs);
    const latest=new Map(),points=[];
    for(const record of records){
      latest.set(`${record.key}/${record.scope}`,record.status);
      let passed=0,applicable=0;
      for(const check of checks){const scopes=check.required;
        const statuses=scopes.map(scope=>latest.get(`${check.key}/${scope}`)||'pending');
        if(statuses.length&&statuses.every(s=>s==='na'))continue;
        applicable++;if(statuses.length&&statuses.every(s=>s==='passed'||s==='na'))passed++;}
      points.push({atMs:record.atMs,passed,applicable});
    }
    return points;
  }
  function checklists(profile, standards) {
    const scopes = new Set(), history = new Map(), definitions = new Map();
    for (const group of ['product','engineering']) for (const item of standards[group]) definitions.set(`${group}/${item.id}`, {...item, group});
    for (const row of profile.runs) {
      for (const node of Object.values(row.nodes)) {
        const feature = node.input?.feature;
        if (feature?.id) {
          scopes.add(feature.id);
          for (const item of list(feature.criteria)) {
            if (item.id) definitions.set(`requirements/${feature.id}/${item.id}`, {...item, group: 'requirements', scope: feature.id});
          }
        }
        for (const feature of list(node.output?.features)) {
          scopes.add(feature.id);
          for (const item of list(feature.criteria)) if (item.id) definitions.set(`requirements/${feature.id}/${item.id}`, {...item, group:'requirements', scope:feature.id});
        }
        const group = node.input?.group;
        if (!group) continue;
        const scope = feature?.id || '本次交付'; scopes.add(scope);
        for (const result of list(node.output?.checklist)) {
          const key = group === 'requirements' ? `requirements/${scope}/${result.id}` : `${group}/${result.id}`;
          if (!history.has(key)) history.set(key, []);
          history.get(key).push({...result, scope, round: list(node.scope).findLast(f=>f.round!=null)?.round || 1,
            atMs: node.settledAtMs || profile.atMs, phase: node.input.finalAudit ? '最终提交' : node.input.workspace === '.' ? '集成' : '分支', sessionId: node.sessionId, commit: node.output.commit});
        }
      }
    }
    return [...definitions].map(([key,item])=>{
      const records = (history.get(key)||[]).sort((a,b)=>a.atMs-b.atMs), latest = new Map(records.map(r=>[r.scope,r]));
      const required = item.scope ? [item.scope] : [...scopes];
      const statuses = required.map(scope=>latest.get(scope)?.status || 'pending');
      const status = statuses.includes('failed') ? 'failed' : statuses.includes('unverified') ? 'unverified'
        : statuses.includes('pending') || !statuses.length ? (statuses.includes('passed') ? 'partial' : 'pending')
        : statuses.includes('disputed') ? 'disputed' : statuses.every(s=>s==='na') ? 'na' : 'passed';
      return {...item,key,records,required,latest:[...latest.values()],status};
    });
  }
  function peak(events) {
    const edges = events.flatMap(e=>[[e.startMs,1],[e.endMs,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    let active=0,max=0; for (const [,delta] of edges) {active+=delta;max=Math.max(max,active);} return max;
  }
  function occupancy(events) {
    const intervals=events.filter(e=>e.endMs>e.startMs);
    const edges=intervals.flatMap(e=>[[e.startMs,1],[e.endMs,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    let active=0,occupiedMs=0,previous;
    for(const [at,delta] of edges){if(active>0&&previous!==undefined)occupiedMs+=at-previous;active+=delta;previous=at;}
    const workerMs=intervals.reduce((sum,e)=>sum+e.endMs-e.startMs,0);
    return {workerMs,occupiedMs,parallelism:workerMs/Math.max(1,occupiedMs)};
  }
  window.WorkflowObserve = {events,criticalPath,checklists,peak,burnup,occupancy};
})();
