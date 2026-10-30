import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ServicePreviewClient } from "@genehub/workbench/client";
import type { RemoteDesktopInputEvent } from "@genehub/proto/remote-desktop";
import { BlockedError, daemonEndpoint, defineSpecialty, openPreviewBrowser } from "../../framework/public.ts";

// The public projection must accept the on-wire forms used by editable H5.
// This independent consumer catches an accidental externally tagged TS union.
const inputForms = [
  {type:"key",code:"KeyW",down:true}, {type:"text",text:"视图"},
  {type:"absolute",x:0.5,y:0.5}, {type:"relative",dxTotal:1,dyTotal:2},
  {type:"button",button:0,down:false}, {type:"wheel",dx:0,dy:120},
  {type:"state",keys:[],buttons:[]}, {type:"reset"},
] satisfies RemoteDesktopInputEvent[];

// Independent source-side denial oracle. This deliberately does NOT replace a
// native engine, emit fake desktop frames, or claim successful OS control.
defineSpecialty({
  id: "specialty.preview.capture-source-off",
  title: "Real Capture registration and editable H5 preserve source opt-in and the outer control gate",
  oracle: "The compiled Capture app defaults to no sharing/control, refuses session.open, exposes only public metadata, and unregisters on graceful shutdown through the real daemon/browser",
  catches: ["starting Capture silently shares a desktop", "new HTML media is rejected by the real guest", "page API leaks registration secrets", "editable page bypasses its control WS gate", "source shutdown leaves registration"],
  tags: ["network-risk-v2", "page-experience", "service-preview", "remote-desktop"],
  runner: "playwright", llm: {default: "none"}, expectedDurationMs: 15000, timeoutMs: 120000,
  resources: {environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 1, pool: "browser"},
  surfaces: ["browser", "daemon", "service-preview", "capture"],
  productInterfaces: ["@genehub/workbench/client"],
  requirements: [{kind: "command", env: "GENEHUB_CAPTURE_BINARY", args: ["--probe"], contains: '"available"'}],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  if (!t.browser || !process.env.GENEHUB_CAPTURE_BINARY) throw new BlockedError("real browser and packaged Capture binary required");
  t.assertions.assert(new Set(inputForms.map(event=>event.type)).size===8,"public input projection did not cover every H5 event tag");
  const opened=await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
  const entry=join(t.env.workspace,"remote/index.html");
  await cp(join(t.env.data,"builtin-skills/genehub-preview/assets/remote-desktop"),join(t.env.workspace,"remote"),{recursive:true});
  for (const asset of ["index.html", "client.js", "input.js", "style.css"]) {
    const shipped=await readFile(join(t.env.workspace,"remote",asset));
    const expected=await readFile(join(t.openRoot,"apps/daemon/builtin-skills/genehub-preview/assets/remote-desktop",asset));
    t.assertions.assert(shipped.equals(expected),`compiled guest shipped stale remote-desktop/${asset}; rebuild guest before testing this candidate`);
  }
  const source=spawn(process.env.GENEHUB_CAPTURE_BINARY,["--headless","--entry",entry,"--daemon-root",t.env.data],{env:{...process.env,...t.env.env,LOCALAPPDATA:join(t.env.home,"AppData/Local")},stdio:["ignore","pipe","pipe"]});
  const exited=once(source,"exit");
  let output=""; source.stdout.on("data",b=>{output=(output+b).slice(-4096)}); source.stderr.on("data",b=>{output=(output+b).slice(-4096)});
  let active: ServicePreviewClient | null=null;
  const page=await t.browser.newPage();
  let consumer: Awaited<ReturnType<typeof openPreviewBrowser>> | undefined;
  try {
    await t.tools.waitUntil(async()=>{
      if(source.exitCode!==null)throw new Error(`Capture exited before ready: ${output}`);
      active=await ServicePreviewClient.discover(opened.client,opened.workspaceId,`${opened.rootHandle}/remote/index.html`);
      return active!==null;
    },15000);
    const service=active as unknown as ServicePreviewClient;
    t.assertions.assert(service.descriptor.media?.client==="html" && service.descriptor.media.protocol==="remote-desktop/1","real descriptor lost HTML mode");
    const state=await (await service.fetch("/api/remote/state")).json();
    t.assertions.assert(state.shared===false&&state.allowControl===false&&state.viewing===false,"source did not default off");
    t.assertions.assert(!JSON.stringify(service.descriptor).match(/"(?:secret|port|sessionToken)"/),"public descriptor leaked private credentials");
    const responses: Record<string,unknown>[]=[];
    const view=await service.websocket("/api/remote/session",async packet=>{
      if(packet[0]!==0)return;
      const outer=JSON.parse(new TextDecoder().decode(packet.subarray(1)));
      if(outer.kind==="text")responses.push(JSON.parse(outer.text));
    });
    await view.send({kind:"text",text:JSON.stringify({id:"denied",method:"session.open",params:{}})});
    await t.tools.waitUntil(()=>responses.some(r=>r.id==="denied"),5000);
    const denied=responses.find(r=>r.id==="denied") as {error?:{code:string}};
    t.assertions.assert(denied.error?.code==="not_shared","source allowed a session without opt-in"); view.close();
    consumer=await openPreviewBrowser({openRoot:t.openRoot,lease:t.env,page,endpoint:daemonEndpoint(opened.daemon),refreshEndpoint:()=>daemonEndpoint(opened.daemon),workspaceId:opened.workspaceId,entryPath:`${opened.rootHandle}/remote/index.html`});
    await page.getByRole("button",{name:"预览信息",exact:true}).click({timeout:30000});
    await page.getByRole("button",{name:"允许本次预览访问登记服务",exact:true}).click({timeout:30000});
    await page.getByRole("button",{name:"关闭信息",exact:true}).click();
    const frame=page.frameLocator("iframe").first();
    // Execute the shipped modules, not just the bridge injected by Preview.
    await frame.getByRole("button",{name:"连接画面",exact:true}).click();
    await t.tools.waitUntil(async()=> (await frame.locator("#status").innerText()).includes("not_shared"),15000);
    const context=await frame.locator("body").evaluate(async element=>{
      const host=element.ownerDocument.defaultView as unknown as {genehubServicePreview:{describe():Promise<unknown>;ice():Promise<unknown>}};
      return {state:await host.genehubServicePreview.describe(),ice:await host.genehubServicePreview.ice()};
    }) as {state:{controlAllowed:boolean;descriptor:{runId:string}};ice:{iceServers:unknown[]}};
    t.assertions.assert(context.state.controlAllowed===false&&context.state.descriptor.runId===service.descriptor.runId,"page API was not scoped to this run");
    t.assertions.assert(Array.isArray(context.ice.iceServers)&&!JSON.stringify(context).includes('"secret"'),"page ICE/description leaked private state");
    const rejected=await frame.locator("body").evaluate(element=>Promise.all([
      "/api/remote/control", "/api/remote/%63ontrol", "/api/remote/control?attempt=alias",
    ].map(path=>new Promise<boolean>(resolve=>{
      const host=element.ownerDocument.defaultView!;
      const socket=new host.WebSocket(path);
      const timer=host.setTimeout(()=>{socket.close();resolve(false)},5000);
      socket.onopen=()=>{host.clearTimeout(timer);socket.close();resolve(false)};
      socket.onerror=()=>{host.clearTimeout(timer);resolve(true)};
    }))));
    t.assertions.assert(rejected.every(Boolean),"H5 opened the protected control WS through a canonical/encoded/query alias before outer consent");
    await page.getByRole("button",{name:"允许本页接管",exact:true}).click();
    const granted=await frame.locator("body").evaluate(async element=>(await (element.ownerDocument.defaultView as any).genehubServicePreview.describe()).controlAllowed);
    t.assertions.assert(granted===true,"outer page consent did not reach scoped API");
    const controlOpened=await frame.locator("body").evaluate(element=>new Promise<boolean>(resolve=>{
      const host=element.ownerDocument.defaultView as any;
      const socket=new host.WebSocket("/api/remote/control");
      host.captureGateProbe={socket,closed:false};
      const timer=host.setTimeout(()=>{socket.close();resolve(false)},5000);
      socket.onopen=()=>{host.clearTimeout(timer);resolve(true)};
      socket.onclose=()=>{host.captureGateProbe.closed=true};
      socket.onerror=()=>{host.clearTimeout(timer);resolve(false)};
    }));
    t.assertions.assert(controlOpened,"source WS did not open after outer consent");
    await page.getByRole("button",{name:"交还控制",exact:true}).click();
    await t.tools.waitUntil(()=>frame.locator("body").evaluate(element=>(element.ownerDocument.defaultView as any).captureGateProbe.closed),1500);
    const revoked=await frame.locator("body").evaluate(async element=>!(await (element.ownerDocument.defaultView as any).genehubServicePreview.describe()).controlAllowed);
    t.assertions.assert(revoked,"outer revoke left H5 control permission enabled");
    const sandbox=await page.locator("iframe").first().getAttribute("sandbox");
    t.assertions.assert(!!sandbox?.includes("allow-pointer-lock")&&!sandbox.includes("allow-same-origin"),"HTML mode lost opaque sandbox");
    const after=await (await service.fetch("/api/remote/state")).json();
    t.assertions.assert(after.shared===false&&after.viewing===false&&after.allowControl===false,"outer page consent changed source sharing policy");
    source.kill("SIGTERM"); await exited;
    t.assertions.assert(source.exitCode===0,"Capture did not exit gracefully");
    service.close(); active=null;
    t.assertions.assert(await ServicePreviewClient.discover(opened.client,opened.workspaceId,`${opened.rootHandle}/remote/index.html`)===null,"source shutdown left registration");
    t.note("Real Capture default-off and real opaque H5 API/control gate passed; no native media or OS input is claimed by this case.");
  } finally {
    (active as ServicePreviewClient|null)?.close();
    if(source.exitCode===null&&source.signalCode===null)source.kill("SIGTERM");
    await exited;
    await page.close(); await consumer?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
