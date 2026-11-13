// Real Windows executable / WebView2 probe. The build manifest binds source,
// resources and an isolated Tauri identifier; no installed App is adopted.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

if (process.platform !== "win32") throw new Error("Requires native Windows and WebView2");
const [repoArgument, manifestFile, expectedSource, cloudManifestFile, expectedCloudSource] = process.argv.slice(2);
if (!repoArgument || !manifestFile || !cloudManifestFile || !/^[a-f0-9]{40}$/.test(expectedCloudSource??"") || !/^[a-f0-9]{40}$/.test(expectedSource ?? "")) throw new Error("Explicit repository, manifest and source SHA required");
const repo:string=repoArgument;
interface Artifact {path:string;sha256:string;bytes:number}
interface Manifest {sourceSha:string;packaging:string;installerCreated:boolean;identifier:string;desktop:Artifact;runtime:Artifact[];guest:Artifact;configuration:string;configurationSha256:string}
interface CloudManifest {root:string;sourceSha:string;entry:string;node:{path:string;sha256:string};files:Array<{path:string;sha256:string}>}
interface NativeProcess {ProcessId:number;ParentProcessId:number;ExecutablePath:string|null;CreationDate:string}
interface Target {url:string;type:string;webSocketDebuggerUrl:string}
const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
const cloud=JSON.parse(readFileSync(cloudManifestFile,"utf8")) as CloudManifest;
const hash = (file:string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function check(ok:unknown,text:string): asserts ok {if(!ok)throw new Error(text);}
const ps = (script:string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15_000 }).trim();
check(manifest.sourceSha === expectedSource && manifest.packaging === "no-bundle" && manifest.installerCreated === false, "Build source or packaging mismatch");
check(/^com\.genethub\.validation\.[a-z0-9]+$/.test(manifest.identifier), "Refuse installed or unisolated App identifier");
check(cloud.sourceSha===expectedCloudSource,"Cloud source mismatch");
check(resolve(process.execPath)===resolve(cloud.node.path),"Use the verified Node runtime that built the real Hub");
const sdkFiles=["app.js","core.js","image.js","external/tslib/tslib.es6.js"];
const sdkArtifacts=sdkFiles.map(file=>{const path=join(repo,"apps/desktop/node_modules/@tauri-apps/api",file);return {path,sha256:hash(path)};});
const artifacts = [manifest.desktop, ...manifest.runtime, manifest.guest,cloud.node,...cloud.files,...sdkArtifacts];
function verify() {
  check(execFileSync("git.exe", ["-C", repo, "rev-parse", "HEAD"], {encoding:"utf8"}).trim() === expectedSource, "Native source SHA changed");
  execFileSync("git.exe", ["-C", repo, "diff", "--exit-code", "HEAD"], {stdio:"pipe"});
  check(!execFileSync("git.exe", ["-C", repo, "ls-files", "--others", "--exclude-standard"], {encoding:"utf8"}).trim(), "Untracked source inputs");
  for (const a of artifacts) check(a && existsSync(a.path) && hash(a.path) === a.sha256, "Native artifact hash changed");
  check(execFileSync("git.exe",["-C",cloud.root,"rev-parse","HEAD"],{encoding:"utf8"}).trim()===expectedCloudSource,"Cloud source changed");
  execFileSync("git.exe",["-C",cloud.root,"diff","--exit-code","HEAD"],{stdio:"pipe"});
  check(!execFileSync("git.exe",["-C",cloud.root,"ls-files","--others","--exclude-standard"],{encoding:"utf8"}).trim(),"Untracked Cloud inputs");
  check(hash(manifest.configuration) === manifest.configurationSha256, "Build configuration changed");
}
verify();
const roaming = ps("[Environment]::GetFolderPath('ApplicationData')");
const local = ps("[Environment]::GetFolderPath('LocalApplicationData')");
const dataRoots = [...new Set([join(roaming, manifest.identifier), join(local, manifest.identifier)])];
const marker = `.owned-${process.pid}`;
for (const p of dataRoots) check(!existsSync(p), "Isolated validation data already exists; reconcile prior attempt first");
let fixtureRoot:string|undefined;
const owned = new Map<number,string>();
let child:ChildProcess|undefined;
let website:Server|undefined;
let reservation:Server|undefined;
let proof:Record<string,unknown>|undefined;
const executable = resolve(manifest.desktop.path);
// Windows KnownFolder resolution can ignore APPDATA overrides. Isolation is
// supplied by the compiled Tauri identifier, not those environment variables.
function processes(): NativeProcess[] {
  return JSON.parse(ps("ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate)"));
}
check(!processes().some(p => p.ExecutablePath && resolve(p.ExecutablePath) === executable), "Candidate App is already running");
function remember() {
  let changed = true;
  const rows = processes();
  const liveOwners=new Set(rows.filter(p=>owned.get(p.ProcessId)===p.CreationDate).map(p=>p.ProcessId));
  while (changed) {
    changed = false;
    for (const p of rows) if (!owned.has(p.ProcessId) && liveOwners.has(p.ParentProcessId)) {
      owned.set(p.ProcessId,p.CreationDate);liveOwners.add(p.ProcessId);changed=true;
    }
  }
  return rows;
}
async function stop() {
  const rows = remember();
  for (const p of rows.reverse()) if (owned.get(p.ProcessId) === p.CreationDate) {
    try { execFileSync("taskkill.exe", ["/F", "/T", "/PID", String(p.ProcessId)], {stdio:"pipe",timeout:10_000}); } catch { /* Verify absence below. */ }
  }
  await pause(500);
  check(!processes().some(p => owned.get(p.ProcessId) === p.CreationDate), "Owned native process survived cleanup");
  child = undefined;
}
function isolatedEnv():NodeJS.ProcessEnv {
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(GENEHUB|GENET|HUB_|BETA_HUB_|DEV_HUB_|CLAUDE|CODEBUDDY|CURSOR|SERVER__|TRACEPARENT|BAGGAGE)/.test(key))delete env[key];
  return env;
}
function launchOwned(exe:string,args:string[],env:NodeJS.ProcessEnv,cwd:string,visible=false):ChildProcess {
  const started=spawn(exe,args,{cwd,env,stdio:["ignore","pipe","pipe"],windowsHide:!visible});
  started.on("error",()=>{});
  for(const stream of [started.stdout,started.stderr])stream?.on("data",()=>{});
  const row=processes().find(p=>p.ProcessId===started.pid);
  check(row,"Owned native process failed before identity capture");
  owned.set(row.ProcessId,row.CreationDate);
  return started;
}
function launch(port:number,hubOrigin:string) {
  const env=isolatedEnv();
  env.GENEHUB_LOCAL_HUB_URL=hubOrigin;
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=`--remote-debugging-port=${port}`;
  child=launchOwned(executable,[],env,repo,true);
}
async function listen(server:Server, port=0) {
  await new Promise<void>((ok, fail) => { server.once("error",fail); server.listen(port,"127.0.0.1",ok); });
  const address=server.address();
  check(address && typeof address!=="string","Missing bound test port");return address.port;
}
async function close(server:Server|undefined) {if(server)await new Promise<void>(ok=>server.close(()=>ok()));}
async function freePort() { const s=createServer(); const p=await listen(s); await close(s); return p; }
async function page(port:number, accept:(page:Target)=>boolean):Promise<Target> {
  const deadline=Date.now()+45_000; let last="No page";
  while(Date.now()<deadline) {
    remember();
    try {
      const targets=await (await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(1000)})).json() as Target[];
      const target=targets.find(p=>p.type==="page" && accept(p));
      if(target) return target;
      last=targets.map(p=>{try{const u=new URL(p.url);return u.origin+u.pathname;}catch{return "unparsed target";}}).join(",");
    } catch(error) {last=String(error);}
    await pause(250);
  }
  throw new Error(`WebView2 navigation timed out: ${last}`);
}
async function evaluate<T>(target:Target,expression:string):Promise<T> {
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise<void>((ok,fail)=>{ws.addEventListener("open",()=>ok(),{once:true});ws.addEventListener("error",fail,{once:true});});
    return await new Promise<T>((ok,fail)=>{
      const timer=setTimeout(()=>fail(new Error("CDP evaluate timed out")),10_000);
      ws.addEventListener("message",event=>{
        const r=JSON.parse(String(event.data)); if(r.id!==1)return;
        clearTimeout(timer);
        if(r.error||r.result.exceptionDetails)fail(new Error("CDP page expression failed; URL credentials omitted"));
        else ok(r.result.result.value);
      });
      ws.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}}));
    });
  } finally {ws.close();}
}
try {
  fixtureRoot=mkdtempSync(join(dirname(manifestFile),"webview-"));
  reservation=createServer();
  const webPort=await listen(reservation),apiPort=await freePort(),deadRelayPort=await freePort();
  const webOrigin=`http://127.0.0.1:${webPort}`,apiOrigin=`http://127.0.0.1:${apiPort}`;
  const hubEnv=isolatedEnv();
  Object.assign(hubEnv,{HUB_CHANNEL:"stable",HUB_PORT:String(apiPort),HUB_HOST:"127.0.0.1",HUB_DB:join(fixtureRoot,"hub.sqlite"),
    HUB_CONSOLE_DIR:join(fixtureRoot,"no-console"),HUB_PUBLIC_ORIGIN:webOrigin,HUB_RELAY_ORIGIN:`http://127.0.0.1:${deadRelayPort}`,HUB_RELAY_TOKEN:randomBytes(32).toString("hex")});
  const hub=launchOwned(process.execPath,[cloud.entry],hubEnv,join(cloud.root,"server"));
  let ready=false;
  for(let n=0;n<80;n++){
    check(hub.exitCode===null,"Real Hub exited before readiness");
    try{ready=(await fetch(apiOrigin+"/api/health",{signal:AbortSignal.timeout(500)})).ok;}catch{}
    if(ready)break;await pause(250);
  }
  check(ready,"Real Hub did not become ready");
  for(const p of dataRoots) {mkdirSync(p,{recursive:true});writeFileSync(join(p,marker),expectedSource,{flag:"wx"});}
  const port=await freePort();
  await close(reservation);reservation=undefined;
  launch(port,apiOrigin);
  const boot=await page(port,p=>p.url.startsWith("http://tauri.localhost")||p.url.startsWith("tauri://"));
  let state:{status:string;global:boolean}|undefined;
  for(let attempt=0;attempt<40;attempt++){
  state=await evaluate<{status:string;global:boolean}>(boot,"({status:document.getElementById('status')?.textContent??'',global:!!globalThis.__TAURI__})");
  if(/官网暂时无法访问/.test(state.status))break; await pause(250);
  }
  check(state,"Offline boot document did not render");
  check(/官网暂时无法访问/.test(state.status) && !state.global,`Offline boot page is blank or exposes native globals: ${JSON.stringify(state)}`);
  const rows=remember();
  const endpointFile=dataRoots.map(root=>join(root,"GeneHub-local/endpoint.json")).find(existsSync);
  check(endpointFile,"The isolated native daemon did not publish its endpoint");
  const endpoint=JSON.parse(readFileSync(endpointFile,"utf8")) as {pid?:number};
  check(typeof endpoint.pid==="number" && rows.some(row=>row.ProcessId===endpoint.pid && owned.get(row.ProcessId)===row.CreationDate
    && row.ExecutablePath && resolve(row.ExecutablePath)===resolve(manifest.runtime.find(a=>a.path.endsWith("genehub-host-local.exe"))!.path)),"The endpoint is not owned by the candidate native Host");
  website=createServer((req,res)=>{
    const name=sdkFiles.find(file=>req.url===`/sdk/${file}`);
    if(name){
      res.writeHead(200,{"content-type":"text/javascript"});
      res.end(readFileSync(join(repo,"apps/desktop/node_modules/@tauri-apps/api",name)));return;
    }
    if(new URL(req.url??"/",webOrigin).pathname!=="/setup"){res.writeHead(404).end();return;}
    res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
    res.end('<!doctype html><meta charset="utf-8"><main id="remote">remote</main>');
  });
  await listen(website,webPort);
  // The same real shell must recover on its own ordinary route retry. No
  // debugger navigation or synthesized product directive participates.
  const remote=await page(port,p=>{const u=new URL(p.url);return u.origin===webOrigin&&u.pathname==="/setup";});
  let rendered:{origin:string;path:string;marker:string}|undefined;
  for(let attempt=0;attempt<40;attempt++){
    rendered=await evaluate<{origin:string;path:string;marker:string}>(remote,"({origin:location.origin,path:location.pathname,marker:document.getElementById('remote')?.textContent??''})");
    if(rendered.origin===webOrigin && rendered.path==="/setup" && rendered.marker==="remote")break;
    await pause(250);
  }
  check(rendered?.origin===webOrigin && rendered.path==="/setup" && rendered.marker==="remote","Automatic route did not render the real remote document");
  const remoteState=await evaluate<{origin:string;path:string;marker:string;global:boolean;denied:boolean}>(remote,`(async()=>{const sdk=await import('${webOrigin}/sdk/app.js');let denied=false;try{await sdk.getIdentifier()}catch{denied=true}return {origin:location.origin,path:location.pathname,marker:document.getElementById('remote')?.textContent,global:!!globalThis.__TAURI__,denied}})()`);
  check(remoteState.origin===webOrigin && remoteState.path==="/setup" && remoteState.marker==="remote" && !remoteState.global && remoteState.denied,"Remote document rendered incorrectly or public Tauri API succeeded");
  proof={schema:"genehub.windows-webview-proof.v1",sourceSha:expectedSource,cloudSourceSha:expectedCloudSource,cloudManifestSha256:hash(cloudManifestFile),manifestSha256:hash(manifestFile),offlineBoot:true,nativeDaemon:true,remoteDocument:true,publicNativeReadRejected:true};
} finally {
  let cleanupError:unknown;
  try {if(child||owned.size)await stop();}catch(error){cleanupError=error;}
  await close(website);await close(reservation);
  if(cleanupError)throw cleanupError;
  for(const p of dataRoots) if(existsSync(join(p,marker)) && readFileSync(join(p,marker),"utf8")===expectedSource) rmSync(p,{recursive:true});
  if(fixtureRoot)rmSync(fixtureRoot,{recursive:true});
}
verify();
check(proof,"Native proof was not produced");
check(dataRoots.every(p=>!existsSync(p)),"Owned validation data survived cleanup");
console.log(JSON.stringify({...proof,cleanup:true}));
