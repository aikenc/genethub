import {join} from "node:path";
import {defineSpecialty,daemonEndpoint,openWorkbenchPage,type ClientDiagnosticEvent} from "../../framework/public.ts";

defineSpecialty({
  id:"specialty.page-experience.catalog-cache.browser-restart",
  title:"A real browser profile reopens cached directories and conditionally fetches changed state",
  oracle:"After closing and relaunching Chromium with the same profile and origin, unchanged summaries/pages transfer zero rows; offline rename/delete are repaired, daemon restart validates content, another cache namespace does not reuse the prior cache, and damaged/unavailable IndexedDB falls back without blocking the actual workbench",
  catches:["cache survives only React remount","reopen retransmits all cached rows","old browser cache resurrects deleted sessions","directory sequence reused across daemon instances","cache crosses identity namespace","storage failure blocks conversation navigation"],
  tags:["core","page-experience","catalog-sync"],runner:"playwright",llm:{default:"none"},
  requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],
  surfaces:["workbench-ui","daemon","browser-storage"],
  productInterfaces:["@genehub/workbench","Host.cacheScope","catalog.sync","session.page","session.rename","session.delete"],
  expectedDurationMs:90000,timeoutMs:300000,
  resources:{environments:1,cpu:3,memoryMb:3072,io:1,browser:1,pool:"browser"},
},async t => {
  let o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  let browser:Awaited<ReturnType<typeof openWorkbenchPage>>|undefined;
  let phase="first",scope="cache-owner-a",denyStorage=false;
  const metrics:Array<{phase:string;event:ClientDiagnosticEvent}>=[];
  const errors:string[]=[];
  const totals=(label:string)=>metrics.filter(r=>r.phase===label&&r.event.kind==="operation"&&r.event.detail.phase==="finish"&&r.event.detail.outcome==="ok")
    .reduce((r,{event:{detail:d}})=>({catalog:r.catalog+(d.operation==="catalog.receive"?Number(d.summaryRows??0):0),
      pages:r.pages+(d.operation==="session.page"?Number(d.summaryRows??0):0),
      unchanged:r.unchanged+(d.operation==="session.page"?Number(d.unchangedPages??0):0),
      removed:r.removed+(d.operation==="catalog.receive"?Number(d.removedRows??0):0)}),{catalog:0,pages:0,unchanged:0,removed:0});
  try {
    const ids:string[]=[];
    for(let n=0;n<30;n++) {
      const id=await t.flows.main.createBuiltinSession(o.client,o.workspaceId);ids.push(id);
      await o.client.call({type:"session.rename",payload:{sessionId:id,title:`缓存会话${n}`}});
    }
    t.assertions.assert(o.client.identity?.features?.includes("catalog.sync.v1")===true,"directory artifact is missing");
    const machine=o.client.identity!;
    const paired=await t.flows.main.pairDevice(o.client,o.daemon,"cached-browser");
    paired.client.close();
    const endpoint=()=>({...daemonEndpoint(o.daemon),credential:paired.credential});
    browser=await openWorkbenchPage(t.openRoot,endpoint,o.workspaceId,ids[29]!,
      {viewport:{width:744,height:1133},hasTouch:true},{trace:false,profileDir:join(t.env.root,"browser-profile"),clientDiagnostics:true,
        beforeNavigate:async page=>{
          page.on("pageerror",error=>errors.push(error.message));
          await page.exposeFunction("catalogDiagnostic",(event:ClientDiagnosticEvent)=>{metrics.push({phase,event});});
          await page.addInitScript(()=>window.addEventListener("genehub-test-client-diagnostic",event=>{
            void (window as unknown as {catalogDiagnostic(event:unknown):Promise<void>}).catalogDiagnostic((event as CustomEvent).detail);
          }));
          if(denyStorage)await page.addInitScript(()=>Object.defineProperty(globalThis,"indexedDB",{get(){throw new DOMException("storage denied","SecurityError");}}));
        }},
      {targets:()=>[{id:machine.machineId,deviceHandle:machine.machineId,fingerprint:machine.fingerprint,label:"缓存验证机器",kind:"local",online:true}],
        endpoint,cacheScope:()=>scope});
    const ready=async()=>{
      await browser!.page.getByRole("heading",{name:"缓存会话29",exact:true}).waitFor({timeout:45000});
      await t.tools.waitUntil(()=>metrics.some(r=>r.phase===phase&&r.event.detail.operation==="catalog.receive"&&r.event.detail.complete===true),15000);
    };
    // Read browser-owned cache evidence only. No private product store access
    // and no injected RPC replies; the real browser controls the actual daemon.
    const cache=async()=>browser!.page.evaluate(async()=>{
      const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open("genehub-directory-v1");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      try{return await new Promise<Array<{key:string;checksum:string;row:{sessions:Array<{id:string}>}}>>((resolve,reject)=>{
        const r=db.transaction("sources").objectStore("sources").getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      });}finally{db.close();}
    });
    await ready();
    await t.tools.waitUntil(async()=> (await cache()).some(r=>r.row.sessions.some(s=>s.id===ids[29])&&/^[0-9a-f]{64}$/.test(r.checksum)),15000);
    t.assertions.assert(totals("first").pages>=30,"initial history was not read through the public page interface");
    phase="quiet";await browser.restart();await ready();
    const quiet=totals(phase);
    t.assertions.assert(quiet.catalog===0&&quiet.pages===0&&quiet.unchanged>=1,"browser relaunch retransmitted unchanged summary rows/pages");
    phase="changed";
    await browser.restart(async()=>{
      await o.client.call({type:"session.rename",payload:{sessionId:ids[0]!,title:"关闭期间改名"}});
      await o.client.call({type:"session.delete",payload:{sessionId:ids[1]!}});
    });await ready();
    await browser.page.getByRole("complementary",{name:"会话列表",exact:true}).getByRole("button",{name:/关闭期间改名/}).waitFor();
    const changed=totals(phase);
    t.assertions.assert(changed.catalog===1&&changed.removed===1,"closed-browser repair did not isolate its rename and deletion");
    await t.tools.waitUntil(async()=> (await cache()).some(r=>r.row.sessions.length===29&&!r.row.sessions.some(s=>s.id===ids[1])),15000);
    phase="daemon-restart";const instance=o.client.identity?.daemonInstanceId;
    await browser.restart(async()=>{
      o.client.close();o.daemon.stop();await o.mock.stop();
      o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
    });await ready();
    t.assertions.assert(o.client.identity?.daemonInstanceId!==instance,"test did not restart the daemon");
    const cold=totals(phase);
    t.assertions.assert(cold.catalog===0&&cold.pages===0&&cold.unchanged>=1,"daemon restart reused an invalid sequence or retransmitted unchanged page content");
    phase="other-namespace";scope="cache-owner-b";await browser.restart();await ready();
    t.assertions.assert(totals(phase).pages>=29,"another identity namespace consumed the first identity's history cache");
    await t.tools.waitUntil(async()=> (await cache()).some(r=>r.key.includes("cache-owner-b")&&r.row.sessions.length===29),15000);
    // Deliberate local-storage corruption, separate from normal consumer setup.
    await browser.page.evaluate(async()=>{
      const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open("genehub-directory-v1");r.onsuccess=()=>resolve(r.result);});
      await new Promise<void>((resolve,reject)=>{
        const tx=db.transaction("sources","readwrite"),store=tx.objectStore("sources"),r=store.getAll();
        r.onsuccess=()=>{for(const value of r.result)if(value.key.includes("cache-owner-b"))store.put({...value,checksum:"damaged"});};
        tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
      });db.close();
    });
    phase="damaged";await browser.restart();await ready();
    t.assertions.assert(totals(phase).pages>=29,"corrupt cache was treated as confirmed content");
    phase="storage-denied";denyStorage=true;await browser.restart();await ready();
    t.assertions.assert(totals(phase).pages>=29&&errors.length===0,`unavailable storage blocked the real workbench: ${errors.slice(0,3).join("; ")}`);
    phase="revoke";denyStorage=false;await browser.restart();await ready();
    await t.tools.waitUntil(async()=> (await cache()).some(r=>r.key.includes("cache-owner-b")&&r.row.sessions.length===29),15000);
    await o.client.call({type:"device.revoke",payload:{deviceId:paired.deviceId}});
    await t.tools.waitUntil(async()=>!(await cache()).some(r=>r.key.includes("cache-owner-b")),15000);
    await t.tools.waitUntil(async()=>await browser!.page.getByRole("heading",{name:"缓存会话29",exact:true}).count()===0,15000);
    let rejected=false;try {const revoked=await t.flows.main.connectDevice(o.daemon,paired.credential);try{await revoked.call({type:"workspace.list"});}finally{revoked.close();}}catch{rejected=true;}
    t.assertions.assert(rejected,"revoked cached browser could still read the machine");
    t.note(JSON.stringify({realBrowserRelaunches:7,revokeEvicted:true,quiet,changed,cold,otherNamespace:totals("other-namespace"),damaged:totals("damaged"),storageDenied:totals("storage-denied"),pageErrors:errors.length}));
  }finally{await browser?.close();o.client.close();o.daemon.stop();await o.mock.stop();}
});
