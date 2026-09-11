import { spawn } from "node:child_process";
import { cp, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlockedError, defineSpecialty, daemonEndpoint, openPreviewBrowser } from "../../framework/public.ts";

defineSpecialty({
  id:"specialty.preview.process-tree-media-entry",
  title:"Phone-sized workbench opens a registered Python video application from background processes",
  oracle:"Real App process row opens Preview, browser decodes a video file over WebRTC and disabling preview releases the media session",
  catches:["process service entry not usable on phone layout","preview navigation loses workspace","Python media requires Node","closing service access leaks media"],
  tags: ["network-risk-v2", "network-v2-diagnostic", "page-experience","service-preview-media"],runner:"playwright",llm:{default:"none"},expectedDurationMs:25000,timeoutMs:120000,
  resources:{environments:1,cpu:2,memoryMb:1536,io:1,browser:1,pool:"browser"},
  surfaces:["browser","daemon","service-preview"],productInterfaces:["@genehub/workbench"],requiredArtifacts:["genehub-host-local","genehub_guest.wasm"],
},async t=>{
  const python=process.env.GENEHUB_PREVIEW_MEDIA_PYTHON;
  if(!python||!t.browser)throw new BlockedError("Chromium and Python aiohttp/aiortc/PyAV/numpy required");
  const opened=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  const copied=join(t.env.workspace,"adapter");
  const assets=join(t.env.data,"builtin-skills/genehub-service-preview/assets");
  await cp(join(assets,"python-adapter"),copied,{recursive:true});
  const entry=join(t.env.workspace,"index.html");await copyFile(join(assets,"demo/index.html"),entry);
  const video=join(t.env.workspace,"clip.mp4");
  const fixture=join(t.env.workspace,"make_clip.py");
  await writeFile(fixture,`import av,numpy as np,sys
with av.open(sys.argv[1],'w') as out:
 stream=out.add_stream('mpeg4',rate=10);stream.width=320;stream.height=180;stream.pix_fmt='yuv420p'
 for n in range(20):
  pixels=np.zeros((180,320,3),dtype=np.uint8);pixels[:,:,1]=80;pixels[40:100,n*10:n*10+40,0]=230
  for packet in stream.encode(av.VideoFrame.from_ndarray(pixels,format='rgb24')):out.mux(packet)
 for packet in stream.encode():out.mux(packet)
`);
  let app:ReturnType<typeof spawn>|null=null;
  const page=await t.browser.newPage();await page.setViewportSize({width:390,height:844});
  let consumer:Awaited<ReturnType<typeof openPreviewBrowser>>|null=null;
  try{
    const generator=spawn(python,[fixture,video],{stdio:'ignore'});
    const code=await new Promise<number|null>(resolve=>{generator.once('error',()=>resolve(-1));generator.once('exit',resolve)});
    if(code!==0)throw new BlockedError("Python media fixture encoder unavailable");
    app=spawn(python,[join(copied,"app.py"),'--entry',entry,'--daemon-root',t.env.data,'--video',video],{cwd:copied,stdio:'ignore'});
    await t.tools.waitUntil(async()=>{
      if(app!.exitCode!==null)throw new Error('Python media application exited');
      const r=await opened.client.call({type:'process.workspaceList',payload:{workspaceId:opened.workspaceId}});
      return r?.type==='processes'&&r.data.some(p=>p.service?.reachable);
    },15000);
    consumer=await openPreviewBrowser({openRoot:t.openRoot,lease:t.env,page,endpoint:daemonEndpoint(opened.daemon),refreshEndpoint:()=>daemonEndpoint(opened.daemon),workspaceId:opened.workspaceId,entryPath:`${opened.rootHandle}/index.html`,surface:'processes'});
    await page.getByRole('button').filter({hasText:'内容过程预览（Python 示例）'}).click({timeout:30000}).catch(async () => {
      const controls = await page.getByRole("button").allTextContents();
      const rows = await opened.client.call({ type: "process.workspaceList", payload: { workspaceId: opened.workspaceId } });
      const services = rows?.type === "processes" ? rows.data.filter(p => p.service).map(p => ({ name: p.service!.name, reachable: p.service!.reachable })) : [];
      throw new Error("registered service missing from process UI: " + JSON.stringify({ services, controls: controls.slice(0, 30), errors: consumer?.errors, body: (await page.locator("body").innerText()).slice(-1800) }));
    });
    await page.getByRole('button',{name:'打开预览',exact:true}).click();
    await page.getByRole('button',{name:'允许本次预览访问登记服务',exact:true}).click({timeout:30000});
    await page.getByRole('button',{name:'连接音视频',exact:true}).click();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('video')).some(v=>v.videoWidth>0&&v.currentTime>0),{},{timeout:30000});
    await page.getByRole('button',{name:'暂停服务访问',exact:true}).click();
    // Re-enable and query application's real session inventory via its public route.
    await page.getByRole('button',{name:'允许本次预览访问登记服务',exact:true}).click();
    const frame=page.frameLocator('iframe').first();
    await frame.getByRole('button',{name:'请求后端',exact:true}).click();
    await t.tools.waitUntil(async()=>{
      const text=await frame.locator('#output').innerText();
      try{return JSON.parse(text).sessions===0}catch{return false}
    },10000);
    // Chromium reports this existing CSP directive as unsupported; it is not a page exception.
    const errors=consumer.errors.filter(e=>e !== "Unrecognized Content-Security-Policy directive 'navigate-to'.");
    t.assertions.assert(errors.length===0,`browser errors: ${errors.join(';')}`);
  }finally{
    await page.close();await consumer?.close();app?.kill('SIGTERM');opened.client.close();opened.daemon.stop();await opened.mock.stop();
  }
});
