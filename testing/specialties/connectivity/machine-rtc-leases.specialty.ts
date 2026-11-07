import { defineSpecialty, openMultichannelBrowser } from "../../framework/public.ts";

defineSpecialty({
  id:"specialty.connectivity.pooled-rtc-background",
  title:"An adopted native RTC machine survives foreground changes and reconnects through relay after real loss",
  oracle:"A real hosted browser pool preserves its client and logical RTC connection when only a background lease remains; foreground reacquisition mints no admission; real peer loss falls back to a fresh relay connection without background RTC retries",
  catches:["background lease closes the adopted RTC carrier","foreground switch creates another owner","background failure keeps reconnecting RTC"],
  tags:["machine-connections","connectivity","native-rtc"],runner:"playwright",llm:{default:"none"},requiredRepos:["cloud"],
  requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],productInterfaces:["@genehub/workbench/client"],surfaces:["browser","daemon","relay","native-webrtc"],
  resources:{environments:1,cpu:2,memoryMb:2048,io:1,browser:1,pool:"browser"},expectedDurationMs:30000,timeoutMs:120000,
},async t=>{
  const stack=await openMultichannelBrowser(t,"hosted");
  try{
    await stack.page.evaluate(`(async()=>{
      const m=window.mc,identity=m.client.identity;m.client.close();
      const {MachineConnections}=await m.loadClient();
      m.target={id:identity.machineId,deviceHandle:identity.machineId,fingerprint:identity.fingerprint,label:"RTC machine",kind:"remote",online:true};
      m.pool=new MachineConnections({targets:async()=>[m.target],openTarget:async()=>({...await window.connectionInput(),via:"relay",label:"RTC machine"})});
      m.foreground=await m.pool.acquire(m.target,{foreground:true});m.background=await m.pool.acquire(m.target);m.pooled=m.foreground.client;
    })()`);
    await stack.page.waitForFunction(()=>{const m=(window as any).mc;return m.pooled.rtcState==="connected"&&m.pooled.activePath==="rtc";},null,{timeout:30000});
    const admissions=stack.issued();
    const retained=await stack.page.evaluate(async()=>{
      const m=(window as any).mc,id=m.pooled.logicalConnectionId;m.foreground.release();
      for(let i=0;i<3;i++){
        const reply=await m.background.client.call({type:"workspace.list"});
        if(reply?.type!=="workspaces"||m.pooled.activePath!=="rtc"||m.pooled.logicalConnectionId!==id)throw Error("background lease retired a healthy RTC connection");
      }
      m.foreground=await m.pool.acquire(m.target,{foreground:true});
      if(m.foreground.client!==m.pooled||m.pooled.logicalConnectionId!==id)throw Error("foreground recreated the RTC owner");
      m.foreground.release();return id;
    });
    t.assertions.assert(stack.issued()===admissions,"foreground switching minted a new authenticated admission");
    await stack.cutRtc();
    await stack.page.waitForFunction(()=>{const m=(window as any).mc;return m.pooled.connectionState==="ready"&&m.pooled.activePath==="fabric";},null,{timeout:30000});
    const fallback=await stack.page.evaluate(async()=>{const m=(window as any).mc;const reply=await m.pooled.call({type:"workspace.list"});return {id:m.pooled.logicalConnectionId,path:m.pooled.activePath,rtc:m.pooled.rtcState,valid:reply?.type==="workspaces"};});
    t.assertions.assert(fallback.valid&&fallback.id!==retained&&fallback.path==="fabric"&&fallback.rtc!=="connected"&&stack.issued()===admissions+1,"real loss did not restore one fresh background relay connection");
    t.note(JSON.stringify({retainedAcrossForeground:true,admissionsForSwitch:0,realFailureFreshRelay:true,admissionsAfterFailure:1}));
  }finally{await stack.page.evaluate(()=>{const m=(window as any).mc;m.background?.release();m.pool?.close();}).catch(()=>{});await stack.stop();}
});
