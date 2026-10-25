import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openMultichannelBrowser } from "../../framework/public.ts";

for(const mode of ["rendezvous","hosted"] as const) defineSpecialty({
  id:`specialty.fabric-pool.automatic-rtc-${mode}`,title:`Automatic ${mode} body lane preserves native RTC and falls back with its original owner`,
  oracle:"Real Chromium upgrades both original owners, preview hash and RTC transport are exact; closing native PeerConnections falls back to Fabric without changing either logical owner",
  catches:["body splitting silently disables direct RTC", "body upgrade adds another logical owner", "RTC loss loses the companion's original journal"],
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
    const direct=await transfer();
    t.assertions.assert(direct.hash===expected&&direct.transport==="rtc"&&JSON.stringify(direct.owners)===JSON.stringify(owners),"body transfer did not use its original owner over RTC");
    const count=await stack.page.evaluate(()=>(window as any).nativePeers.filter((p:any)=>p.connectionState==="connected").length);
    t.assertions.assert(count===3,"body RTC created extra restricted owners or did not isolate physical paths");
    await stack.cutRtc();
    await stack.page.waitForFunction(()=>(window as any).mc.body.rtcState!=="connected",null,{timeout:3000});
    const fallback=await transfer();
    t.assertions.assert(fallback.hash===expected&&fallback.transport==="fabric"&&JSON.stringify(fallback.owners)===JSON.stringify(owners),"native RTC loss did not retain the body owner on Fabric");
    t.note(JSON.stringify({mode,bytes:bytes.length,rtcChannels:count,direct:direct.transport,fallback:fallback.transport,originalOwnersRetained:true}));
  }finally{await stack.stop();}
});
