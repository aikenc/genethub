import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openMultichannelBrowser } from "../../framework/public.ts";

for(const mode of ["rendezvous","hosted"] as const) defineSpecialty({
  id:`specialty.fabric-pool.automatic-rtc-${mode}`,title:`Automatic ${mode} body lane preserves native RTC and uses fresh authenticated endpoints after RTC loss`,
  oracle:"Real Chromium admits two independent RTC endpoints; exact previews cross RTC then fresh Fabric endpoints after real native failure",
  catches:["body splitting silently disables direct RTC", "body and control share one endpoint", "RTC loss replays an old response"],
  tags:["fabric-pool","fabric-automatic","multichannel"],runner:"playwright",llm:{default:"none"},requiredRepos:["cloud"],
  resources:{environments:1,cpu:2,memoryMb:2048,io:1,browser:1,pool:"browser"},expectedDurationMs:45000,timeoutMs:120000,
  surfaces:["browser","daemon","relay","native-webrtc"],productInterfaces:["@genehub/workbench/client"],requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],
},async t=>{
  const bytes=randomBytes(1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);writeFileSync(join(t.env.workspace,"automatic-rtc.png"),bytes);
  const expected=createHash("sha256").update(bytes).digest("hex");
  const stack=await openMultichannelBrowser(t,mode,t.browser,2);
  try{
    const owners=await stack.page.evaluate(async()=>{const m=(window as any).mc;m.body=await m.client.prepareDataChannel();return [m.client.logicalConnectionId,m.body.logicalConnectionId];});
    t.assertions.assert(owners.every(Boolean)&&owners[0]!==owners[1],"automatic companion was not admitted");
    await stack.rtc();
    await stack.page.waitForFunction(()=>(window as any).mc.body.rtcState==="connected",null,{timeout:30000});
    const transfer=()=>stack.page.evaluate(async ({workspace,path})=>{const m=(window as any).mc;const r=await m.client.preview(workspace,path);const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",r.bytes))).map(v=>v.toString(16).padStart(2,"0")).join("");return {hash,owners:[m.client.logicalConnectionId,m.body.logicalConnectionId],transport:m.operations.filter((o:any)=>o.operation==="asset.preview").at(-1)?.transport};},{workspace:stack.opened.workspaceId,path:`${stack.opened.rootHandle}/automatic-rtc.png`});
    const rtcOwners=await stack.page.evaluate(()=>{const m=(window as any).mc;return [m.client.logicalConnectionId,m.body.logicalConnectionId];});
    t.assertions.assert(rtcOwners.every((id:string,i:number)=>!!id&&id!==owners[i])&&rtcOwners[0]!==rtcOwners[1],"RTC did not authenticate independent fresh endpoints");
    const direct=await transfer();
    t.assertions.assert(direct.hash===expected&&direct.transport==="rtc"&&JSON.stringify(direct.owners)===JSON.stringify(rtcOwners),"body transfer did not retain its healthy RTC endpoints");
    const count=await stack.page.evaluate(()=>(window as any).nativePeers.filter((p:any)=>p.connectionState==="connected").length);
    t.assertions.assert(count===2,"body RTC created extra restricted owners or did not isolate physical paths");
    await stack.cutRtc();
    await stack.page.waitForFunction(()=>(window as any).mc.body.rtcState!=="connected",null,{timeout:3000});
    await stack.page.evaluate(()=>{const m=(window as any).mc;m.client.setRtcEnabled(false);});
    await stack.page.waitForFunction(()=>{const m=(window as any).mc;return m.client.connectionState==="ready"&&m.body.connectionState==="ready";},null,{timeout:30000});
    const fallback=await transfer();
    t.assertions.assert(fallback.hash===expected&&fallback.transport==="fabric"&&fallback.owners.every((id:string,i:number)=>!!id&&id!==rtcOwners[i])&&fallback.owners[0]!==fallback.owners[1],"native RTC loss did not create independent fresh Fabric endpoints");
    t.note(JSON.stringify({mode,bytes:bytes.length,rtcChannels:count,direct:direct.transport,fallback:fallback.transport,freshEndpointsAfterLoss:true}));
  }finally{await stack.stop();}
});
