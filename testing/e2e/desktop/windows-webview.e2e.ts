import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BlockedError, defineE2e, runBoundRemoteCli } from "../../framework/public.ts";

defineE2e({
  id: "e2e.desktop.windows-webview",
  title: "Windows WebView2 keeps its offline boot page and isolates the remote document",
  oracle: "The real Windows Desktop renders its bundled offline boot page, navigates to the isolated Hub website, and rejects a public native read from that remote page",
  catches: ["blank offline WebView", "remote page can invoke native commands", "stale or mismatched native proof", "native process survives cleanup"],
  tags: ["desktop", "e2e", "windows", "webview"], runner: "node",
  resources: { environments: 1, cpu: 1, memoryMb: 1024, io: 1, browser: 1, pool: "browser" },
  requirements: [{ kind: "environment", env: "GENEHUB_WINDOWS_NATIVE_CONTEXT", format: "string-map" },
    { kind: "environment", env: "GENEHUB_NETWORK_CALLER_ENV", format: "string-map" }],
  expectedDurationMs: 60_000, timeoutMs: 180_000,
  surfaces: ["desktop", "control-plane"], requiredRepos:["cloud"],
}, async t => {
  const raw = process.env.GENEHUB_WINDOWS_NATIVE_CONTEXT;
  if (!raw) throw new BlockedError("A built Windows candidate and explicit authorized native context are required");
  const context = JSON.parse(raw) as Record<string, string>;
  for (const key of ["machine", "workspace", "openRoot", "nodeBinary", "gitBinary", "manifest", "manifestSha256", "cloudManifest", "cloudManifestSha256"]) {
    if (!context[key]) throw new BlockedError(`Windows native context is missing ${key}`);
  }
  const source = spawnSync("git", ["-C", t.openRoot, "rev-parse", "HEAD"], {encoding:"utf8"});
  t.assertions.assert(source.status === 0 && /^[a-f0-9]{40}\s*$/.test(source.stdout), "Cannot bind Windows proof to this candidate");
  const sourceSha = source.stdout.trim();
  const cloudRoot=process.env.TESTCTL_CLOUD_ROOT;
  if(!cloudRoot)throw new BlockedError("The paired Cloud source is required");
  const cloudSource=spawnSync("git",["-C",cloudRoot,"rev-parse","HEAD"],{encoding:"utf8"});
  t.assertions.assert(cloudSource.status===0 && /^[a-f0-9]{40}\s*$/.test(cloudSource.stdout),"Cannot bind Windows Hub source");
  const cloudSourceSha=cloudSource.stdout.trim();
  const helperSha = createHash("sha256").update(readFileSync(path.join(t.openRoot, "testing/e2e/desktop/windows-webview.probe.ts"), "utf8").replace(/\r\n/g, "\n")).digest("hex");
  // The caller snapshot is transported in memory by the existing public
  // driver. The remote process receives only the explicit nonsecret context.
  const script = `import json,pathlib,subprocess,hashlib
c=json.loads(${JSON.stringify(JSON.stringify(context))})
source=${JSON.stringify(sourceSha)}
cloudSource=${JSON.stringify(cloudSourceSha)}
def wsl(p):
 if len(p)<3 or p[1]!=':' or p[2] not in ['/', chr(92)]: raise ValueError('Explicit native Windows path required')
 return pathlib.Path('/mnt/'+p[0].lower()+p[2:].replace(chr(92),'/'))
root=wsl(c['openRoot']); helper=root/'testing/e2e/desktop/windows-webview.probe.ts'; manifest=wsl(c['manifest'])
assert hashlib.sha256(helper.read_bytes().replace(bytes([13,10]),bytes([10]))).hexdigest()==${JSON.stringify(helperSha)}, 'Remote helper differs from candidate'
assert hashlib.sha256(manifest.read_bytes()).hexdigest()==c['manifestSha256'], 'Native manifest changed'
assert hashlib.sha256(wsl(c['cloudManifest']).read_bytes()).hexdigest()==c['cloudManifestSha256'], 'Native Cloud manifest changed'
assert subprocess.check_output([c['gitBinary'],'-C',c['openRoot'],'rev-parse','HEAD'],text=True).strip()==source, 'Native source mismatch'
result=subprocess.run([c['nodeBinary'],c['openRoot']+'/testing/e2e/desktop/windows-webview.probe.ts',c['openRoot'],c['manifest'],source,c['cloudManifest'],cloudSource],capture_output=True,text=True,timeout=160)
print(json.dumps({'nativeExit':result.returncode,'stdout':result.stdout[-8192:],'stderr':result.stderr[-4096:]}))
raise SystemExit(result.returncode)
`;
  const result = await runBoundRemoteCli(["shell", "--machine", context.machine!, "--workspace", context.workspace!,
    "--timeout", "170", "--max-output", "16384", "--", "/usr/bin/python3", "-c", script]);
  const exit = result.records.find(r => r.type === "shell.exit")?.data;
  const output = result.records.filter(r => r.type === "shell.output" && r.data?.stream === "stdout").map(r => String(r.data?.data ?? "")).join("");
  t.assertions.assert(result.code === 0 && exit?.exitCode === 0 && exit.timedOut === false
    && !result.records.some(r => r.type === "shell.truncated" || r.type === "error"), `Windows native transport or process failed: ${output.slice(-6000)}`);
  const native = JSON.parse(output.trim()) as {nativeExit:number;stdout:string;stderr:string};
  t.assertions.assert(native.nativeExit === 0, native.stderr);
  const proof = JSON.parse(native.stdout.trim()) as Record<string, unknown>;
  t.assertions.assert(proof.schema === "genehub.windows-webview-proof.v1" && proof.sourceSha === sourceSha
    && proof.manifestSha256 === context.manifestSha256 && proof.cloudSourceSha===cloudSourceSha
    && proof.cloudManifestSha256===context.cloudManifestSha256 && proof.offlineBoot === true && proof.nativeDaemon === true && proof.remoteDocument === true
    && proof.publicNativeReadRejected === true && proof.cleanup === true, "Windows proof lacks source, behavioral or cleanup evidence");
  t.note(JSON.stringify(proof));
});
