import { BlockedError, defineSpecialty, runBoundRemoteCli } from "../../framework/public.ts";

for (const deadline of [false, true]) defineSpecialty({
  id: `specialty.network-extremes.remote-wan-${deadline ? "deadline" : "interaction"}`,
  title: deadline ? "Real remote shell enforces its execution deadline" : "Real remote shell and workspace access coexist across the authorized WAN route",
  oracle: deadline ? "The real remote process returns a timed-out nonzero shell.exit, never a false success" : "32KiB bounded ordinary stdout and concurrent public workspace requests complete, with shell.exit zero and no truncation",
  catches: ["CLI exit zero masks remote failure", "WAN shell output prevents independent small requests", "remote shell drops completion"],
  tags: ["network-extremes-wan", "connectivity", "remote-shell"], llm: { default: "none" },
  requirements:[{kind:"environment",env:"GENEHUB_NETWORK_REMOTE_MACHINE",format:"text"},{kind:"environment",env:"GENEHUB_NETWORK_REMOTE_WORKSPACE",format:"text"},{kind:"environment",env:"GENEHUB_NETWORK_CALLER_ENV",format:"string-map"}],
  expectedDurationMs: 15000, timeoutMs: 60000,
  resources: { environments: 1, cpu: 1, memoryMb: 256, io: 1, browser: 0, pool: "standard" },
  surfaces: ["genet-cli", "remote-daemon", "wan", "shell"], productInterfaces: ["genet-cli"], retention: true,
}, async t => {
  const machine = process.env.GENEHUB_NETWORK_REMOTE_MACHINE;
  const workspace = process.env.GENEHUB_NETWORK_REMOTE_WORKSPACE;
  if (!machine || !workspace || !process.env.GENEHUB_NETWORK_CALLER_ENV) throw new BlockedError("Explicit reachable machine, registered workspace and unchanged caller environment required");
  const script = deadline ? "import os,time,pathlib\nprint('NETWORK_LAB_PID='+str(os.getpid())+':'+pathlib.Path('/proc/self/stat').read_text().split()[21],flush=True)\ntime.sleep(10)" :
    "import tempfile,pathlib,time\nwith tempfile.TemporaryDirectory(prefix='network-lab-',dir=pathlib.Path.cwd()) as d:\n pathlib.Path(d,'marker').write_text('isolated WAN canary')\n for n in range(64):\n  print('x'*512,flush=True);time.sleep(0.1)\nassert not pathlib.Path(d).exists()\nprint('NETWORK_LAB_CLEANUP',flush=True)";
  const start = performance.now();
  const shell = runBoundRemoteCli(["shell", "--machine", machine, "--workspace", workspace, "--timeout", deadline ? "1" : "25", "--max-output", "65536", "--", "python3", "-c", script]);
  const samples: Array<{ ms: number; ok: boolean }> = [];
  if (!deadline) for (let n = 0; n < 4; n++) {
    const began = performance.now();
    const result = await runBoundRemoteCli(["workspace", "list", "--machine", machine]);
    samples.push({ ms: Math.round(performance.now() - began), ok: result.code === 0 && result.records.some(r => r.type === "workspace.list") });
  }
  const result = await shell;
  const exit = result.records.find(r => r.type === "shell.exit")?.data;
  const started = result.records.find(r => r.type === "shell.started")?.data;
  const output = result.records.filter(r => r.type === "shell.output" && r.data?.stream === "stdout").map(r => String(r.data?.data ?? "")).join("");
  let processRetired: boolean | null = null;
  if (deadline) {
    const identity = /NETWORK_LAB_PID=(\d+):(\d+)/.exec(output);
    if (identity) {
      // Match process birth as well as PID, so PID reuse cannot make the
      // timed-out process look alive. Read only our own recorded process.
      const probe = `import pathlib\np=pathlib.Path('/proc/${identity[1]}/stat')\nprint('NETWORK_LAB_RETIRED='+str(not p.exists() or p.read_text().split()[21]!='${identity[2]}'))`;
      const checked = await runBoundRemoteCli(["shell", "--machine", machine, "--workspace", workspace, "--timeout", "10", "--max-output", "4096", "--", "python3", "-c", probe]);
      processRetired = checked.records.some(r => r.type === "shell.output" && String(r.data?.data).includes("NETWORK_LAB_RETIRED=True")) &&
        checked.records.some(r => r.type === "shell.exit" && r.data?.exitCode === 0 && r.data?.timedOut === false) &&
        !checked.records.some(r => r.type === "error" || r.type === "shell.truncated");
    }
  }
  const summary = { machine, workspace, deadline, elapsedMs: Math.round(performance.now() - start), cliExit: result.code,
    shellExit: exit?.exitCode, timedOut: exit?.timedOut, confinementReported: started?.confinement != null,
    truncated: result.records.some(r => r.type === "shell.truncated"), errors: result.records.filter(r => r.type === "error").map(r => r.error?.code),
    stdoutBytes: Buffer.byteLength(output), cleanupObserved: output.includes("NETWORK_LAB_CLEANUP"), processRetired, samples,
    scope: "real WAN canary; no network fault injection or live daemon modification" };
  t.note(JSON.stringify(summary));
  t.assertions.assert(!!started && !!exit && !summary.truncated && summary.errors.length === 0, "remote receipt missing, denied or truncated");
  t.assertions.assert(deadline ? exit!.timedOut === true && exit!.exitCode !== 0 && processRetired === true :
    exit!.exitCode === 0 && exit!.timedOut === false && summary.stdoutBytes >= 32768 && summary.cleanupObserved && samples.every(s => s.ok),
    "real remote execution deadline/completion/interaction contract failed");
});

defineSpecialty({
  id:"specialty.network-extremes.caller-context-isolation",title:"An ordinary test lease never inherits the live remote caller snapshot",
  oracle:"The worker has no undeclared live caller environment and a real isolated daemon shell confirms the snapshot is absent from its child environment",
  catches:["remote caller authority leaks into unrelated simulated agents"],tags:["network-extremes-wan","contract"],llm:{default:"none"},
  surfaces:["genet-cli","daemon","shell"],resources:{environments:1,cpu:2,memoryMb:1024,io:1,browser:0},expectedDurationMs:10000,timeoutMs:60000,
  requiredArtifacts:["genet","genehub-host-local","genehub_guest.wasm"],
},async t=>{
  t.assertions.assert(process.env.GENEHUB_NETWORK_CALLER_ENV===undefined,"undeclared live caller snapshot entered ordinary worker");
  const o=await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
  try{
    const result=await t.flows.main.runShell(o.client,{workspaceId:o.workspaceId,cwd:o.workspaceRoot,timeoutMs:10000,argv:["python3","-c","import os;print('PRIVATE_CALLER_ABSENT='+str('GENEHUB_NETWORK_CALLER_ENV' not in os.environ))"]});
    t.assertions.assert(t.flows.main.shellText(result.frames,"stdout").includes("PRIVATE_CALLER_ABSENT=True")&&t.flows.main.shellExit(result.frames)?.code===0,"isolated daemon inherited remote caller authority");
  }finally{o.client.close();o.daemon.stop();await o.mock.stop();}
});
