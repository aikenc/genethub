import { BlockedError, defineSpecialty, openMultichannelBrowser } from "../../framework/public.ts";

// fb_AD9RqRCbH1u5 / fb_STvjY076r2nl: use real transport loss and the
// browser lifecycle, never replace the client, its clocks or logical owner.
defineSpecialty({
  id: "specialty.connectivity.hosted-wake",
  title: "Hosted browser recovers an expired logical session and resolves failed catalog reads",
  oracle: "A real failed source read preserves confirmed rows and clears its failure only after successful catalog recovery; after a frozen browser loses its logical session, the same Client automatically obtains a new owner and reads the original workspace",
  catches: ["terminal attach loses the next dial", "successful catalog recovery leaves a stale source failure"],
  tags: ["connectivity", "page-experience", "hosted-wake", "network-risk-v2"],
  runner: "playwright", llm: { default: "none" },
  expectedDurationMs: 110000, timeoutMs: 180000,
  resources: { environments: 1, cpu: 2, memoryMb: 1280, io: 1, browser: 1, pool: "browser" },
  surfaces: ["browser", "daemon", "relay", "cloud-server", "workbench-store"],
  productInterfaces: ["@genehub/workbench", "@genehub/workbench/client", "hub-http"],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  if (process.platform === "win32") throw new BlockedError("Renderer suspension requires POSIX signals");
  const stack = await openMultichannelBrowser(t, "hosted");
  const cdp = await stack.page.context().browser()!.newBrowserCDPSession();
  let suspended: number[] = [];
  try {
    const witness=await t.flows.main.createBuiltinSession(stack.opened.client,stack.opened.workspaceId);
    await stack.opened.client.call({type:"session.rename",payload:{sessionId:witness,title:"Hosted wake historical witness"}});
    await stack.page.evaluate(async () => {
      const mc = (window as any).mc, api=await mc.loadClient();
      const target={id:mc.client.identity.machineId,deviceHandle:mc.client.identity.machineId,
        fingerprint:mc.client.identity.fingerprint,label:"Hosted wake machine",kind:"remote",online:true};
      const source={async targets(){return [target];},async openTarget(){return {...await (window as any).connectionInput(),via:"relay",label:target.label};}};
      // Use the same public ownership model as App. Returning the existing
      // authenticated client through the embedding contract never swaps its ID.
      mc.connections=new api.MachineConnections(source,{connect(){return mc.client;},rtcEnabled:false});
      mc.directory=new api.MachineSummaryDirectory(mc.connections);
      await mc.directory.refresh();
      mc.store = (await mc.loadWorkbench()).useWorkbench;
      await mc.store.getState().attach(mc.client);
      mc.ownerBefore = mc.client.logicalConnectionId;
    });
    stack.fabric.blackhole("server");
    await stack.page.evaluate(async () => (window as any).mc.directory.refresh(undefined,undefined,undefined,true));
    const failed = await stack.page.evaluate(id => {
      const mc=(window as any).mc, row=mc.directory.value.sources[0];
      return {sameClient:mc.store.getState().client===mc.client,state:row.state,cached:row.cached,
        retained:row.sessions.some((s:any)=>s.id===id),storeError:mc.store.getState().sessionsError,
        reads:mc.operations.filter((e:any)=>e.operation==="catalog.sync"||e.operation==="session.page").map((e:any)=>({operation:e.operation,outcome:e.outcome}))};
    },witness);
    t.note(JSON.stringify({phase:"failed-real-catalog",...failed}));
    t.assertions.assert(failed.sameClient && failed.cached && failed.retained && failed.storeError &&
      ["timeout","unavailable","offline"].includes(failed.state) && failed.reads.some((e:any)=>e.outcome!=="ok"),
      "real failed catalog did not reach its current source/store failure state");
    stack.fabric.clearBlackhole();
    await stack.page.waitForFunction(()=>(window as any).mc.client.connectionState==="ready",null,{timeout:20000});
    await stack.page.evaluate(async () => (window as any).mc.directory.refresh(undefined,undefined,undefined,true));
    const recovered=await stack.page.evaluate(id=>{const m=(window as any).mc,row=m.directory.value.sources[0];return {
      sameClient:m.store.getState().client===m.client,state:row.state,cached:row.cached,
      retained:row.sessions.some((s:any)=>s.id===id),storeError:m.store.getState().sessionsError};},witness);
    t.assertions.assert(recovered.sameClient && !recovered.cached && recovered.retained && !recovered.storeError &&
      ["ready","partial"].includes(recovered.state),"actual catalog recovery left a stale failure or lost its historical row");
    await stack.page.evaluate(()=>{const m=(window as any).mc;m.ownerBefore=m.client.logicalConnectionId;});
    const processes = await cdp.send("SystemInfo.getProcessInfo");
    suspended = processes.processInfo.filter(p => p.type === "renderer").map(p => p.id);
    t.assertions.assert(suspended.length > 0, "no isolated Chromium renderer to suspend");
    for (const pid of suspended) process.kill(pid, "SIGSTOP");
    // OS suspension prevents even WebSocket events from waking JS. Chromium's
    // Page.setWebLifecycleState can thaw immediately on a network event.
    stack.fabric.cut();
    await new Promise(resolve => setTimeout(resolve, 80000));
    for (const pid of suspended) process.kill(pid, "SIGCONT");
    suspended = [];
    await stack.page.waitForFunction(() => {
      const mc = (window as any).mc;
      return mc.client.connectionState === "ready" && mc.client.logicalConnectionId !== mc.ownerBefore;
    }, null, { timeout: 20000 }).catch(async (error: unknown) => {
      const observed = await stack.page.evaluate(() => {
        const mc = (window as any).mc;
        return { before: mc.ownerBefore, current: mc.client.logicalConnectionId,
          state: mc.client.connectionState, states: mc.states, diagnostics: mc.diagnostics };
      });
      throw new Error(`${String(error)}; ${JSON.stringify(observed)}`);
    });
    const restored = await stack.page.evaluate(async () => {
      const mc = (window as any).mc;
      const reply = await mc.client.call({ type: "workspace.list" });
      return { reply, rtc: mc.client.rtcState, states: mc.states };
    });
    t.assertions.assert(restored.rtc === "disabled", "test unexpectedly relied on RTC");
    t.assertions.assert(restored.states.includes("reconnecting"), "browser did not traverse recovery");
    t.assertions.assert(restored.reply?.type === "workspaces" && restored.reply.data.some((w: any) => w.id === stack.opened.workspaceId),
      "new logical owner could not read the original workspace");
    t.note("Real Hosted/Fabric, public Workbench store, opaque TCP blackhole, frozen Chromium, expired logical owner, and automatic fresh admission; RTC disabled throughout.");
  } finally {
    for (const pid of suspended) { try { process.kill(pid, "SIGCONT"); } catch {} }
    await stack.page.evaluate(()=>{const m=(window as any).mc;m.directory?.close();m.connections?.close();}).catch(()=>{});
    await cdp.detach().catch(() => {});
    await stack.stop();
  }
});
