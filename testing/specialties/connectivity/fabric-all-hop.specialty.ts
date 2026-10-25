import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, collectShellResult, registerControlledAgent } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quantiles = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); const q = (p: number) => Math.round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] ?? 0); return { n: sorted.length, p50: q(.5), p95: q(.95), p99: q(.99), max: q(1) }; };
type Scenario = "download" | "duplex" | "hot-drop" | "slow-consumer" | "node-cut" | "browser-cut" | "all-cut" | "tail-close" | "interrupt";
const variants: Array<{ name: string; nodes: number; browsers: number; both: boolean; scenario: Scenario }> = [];
for (const scenario of ["download", "duplex"] as const) for (const [nodes,browsers] of [[1,1],[1,2],[2,2],[4,4]]) variants.push({ name: `${scenario}-b${browsers}-n${nodes}`, nodes: nodes!, browsers: browsers!, both: false, scenario });
for (const scenario of ["hot-drop", "slow-consumer", "node-cut", "browser-cut", "all-cut", "interrupt"] as const) for (const nodes of [1,2]) variants.push({ name: `${scenario}-b${nodes}-n${nodes}`, nodes, browsers: nodes, both: false, scenario });
for (const nodes of [1,2]) variants.push({ name: `tail-close-b2-n${nodes}`, nodes, browsers: 2, both: false, scenario: "tail-close" });
for (const nodes of [1,2]) variants.push({ name: `both-legs-b${nodes}-n${nodes}`, nodes, browsers: nodes, both: true, scenario: "download" });

for (const v of variants) defineSpecialty({
  id: `specialty.fabric-pool.${v.name}`, title: `Real same-daemon Fabric ${v.browsers} browser / ${v.nodes} node channels: ${v.scenario}${v.both ? ", both legs shaped" : ""}`,
  oracle: "Identical three real stdout producers and source bytes; management RPC remains bounded, independent owners and node TCP are proven, faults do not repeat source processes; full hash and exit after restoration, or explicit cancellation remains isolated",
  catches: ["only browser-side channels were separated", "journal or physical reader blocks independent control", "adding sockets doubles bandwidth", "old data punishes a healthy lane", "upload or paused body starves RPC"],
  tags: ["fabric-pool", "all-hop", v.scenario], llm: { default: "none" }, expectedDurationMs: 50000, timeoutMs: 150000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: ["download","duplex","hot-drop","slow-consumer"].includes(v.scenario) ? "exclusive" : "standard" },
  surfaces: ["daemon", "relay", "workbench-client", "shell", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  if (v.scenario === "interrupt") registerControlledAgent(t.env, { id: "pool-control", profile: "accept-then-silent" });
  const pool = await openFabricPool(t, v.nodes, v.browsers, v.both);
  const { opened: o, clients, link } = pool;
  const control = clients[0]!;
  const owners = clients.map(c => c.logicalConnectionId);
  const streams: ReturnType<typeof control.openShellStream>[] = [];
  const results: Array<Promise<Awaited<ReturnType<typeof collectShellResult>> | null>> = [];
  let timer: NodeJS.Timeout | undefined, faultApplied = false, hotBusy = false, finished = 0;
  let upload: Promise<{ ack: boolean; error: boolean }> | undefined;
  const loadBytes = 8*1024*1024;
  const before = link.stats();
  try {
    let controlSession: string | undefined;
    if (v.scenario === "interrupt") {
      await t.flows.main.requireAgentReady(o.client, "pool-control");
      controlSession = await t.flows.main.createAgentSession(o.client, { workspaceId: o.workspaceId, agentId: "pool-control", modelId: null });
      await t.flows.main.sendPrompt(control, controlSession, "Remain active until interrupted.");
    }
    for (let i=0;i<3;i++) {
      const client = clients[v.browsers === 1 ? 0 : 1+i%(v.browsers-1)]!;
      const stream = client.openShellStream({ workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 120000,
        argv: ["python3", "-c", `import pathlib,sys,time,os\np=pathlib.Path('pool-starts');p.open('a').write('${i}\\n')\npathlib.Path('pool-pid-${i}').write_text(str(os.getpid()))\nwhile not pathlib.Path('pool-go').exists():time.sleep(.01)\nfor n in range(512):\n sys.stdout.write('${String.fromCharCode(65+i)}'*16384);sys.stdout.flush();time.sleep(.005)`] });
      streams.push(stream); await stream.finish(); await stream.responseHead;
      if (v.scenario !== "slow-consumer") results.push(collectShellResult(stream).then(r => { finished++; return r; }, () => null));
    }
    const narrow = v.scenario === "tail-close";
    link.setProfile({ bandwidthMbps: v.scenario === "hot-drop" ? 100 : narrow ? .25 : 2, rttMs: v.scenario === "hot-drop" ? 0 : 200 });
    const start = performance.now(); writeFileSync(join(o.workspaceRoot, "pool-go"), "go");
    const uploadText = "upload-pattern-".repeat(70000);
    if (v.scenario === "duplex") upload = clients.at(-1)!.call({ type: "file.write", payload: { workspaceId: o.workspaceId, path: `${o.rootHandle}/pool-upload.txt`, content: uploadText } }).then(r => ({ ack: r?.type === "ack", error: false }), () => ({ ack: false, error: true }));
    const faultAt = v.scenario === "hot-drop" ? 2000 : 5000;
    let interruptMs: number | null = null, interruptOk = v.scenario !== "interrupt";
    let interrupt: Promise<void> | undefined;
    if (["hot-drop","node-cut","browser-cut","all-cut","tail-close","interrupt"].includes(v.scenario)) timer = setTimeout(() => {
      faultApplied = true;
      if (v.scenario === "hot-drop") { hotBusy = finished < 3; link.setProfile({ bandwidthMbps: 2, rttMs: 200 }); }
      if (v.scenario === "node-cut" || v.scenario === "all-cut") {
        const candidates = link.connections().filter(c => pool.nodeFlowIds.includes(c.id));
        if (v.scenario === "all-cut") for (const c of candidates) link.cutConnection(c.id);
        else { candidates.sort((a,b) => b.bytes[0]!-a.bytes[0]!); if (candidates[0]) link.cutConnection(candidates[0].id); }
      }
      if (v.scenario === "browser-cut" || v.scenario === "all-cut") {
        if (v.scenario === "all-cut") pool.browserFaults.forEach(f => f.cut());
        else pool.browserFaults.at(-1)!.cut();
      }
      if (v.scenario === "tail-close") clients.at(-1)!.close();
      if (v.scenario === "interrupt") {
        const began = performance.now();
        interrupt = control.call({ type: "session.interrupt", payload: { sessionId: controlSession! } }).then(r => { interruptMs = Math.round(performance.now()-began); interruptOk = r?.type === "ack"; }, () => { interruptMs = Math.round(performance.now()-began); });
      }
    }, faultAt);
    const rpc: number[] = []; let errors=0;
    while (performance.now()-start < (narrow ? 26000 : 20000)) {
      const began = performance.now();
      try { const reply = await control.call({ type: rpc.length%2 ? "session.list" : "workspace.list", ...(rpc.length%2 ? { payload: { workspaceId: null, includeArchived: false } } : {}) } as Parameters<typeof control.call>[0]); if (reply?.type !== "workspaces" && reply?.type !== "sessions") errors++; }
      catch { errors++; }
      rpc.push(performance.now()-began); await pause(250);
    }
    const busy = link.stats();
    if (interrupt) await interrupt;
    t.note(JSON.stringify({ phase: "loaded", variant: v.name, rpc: quantiles(rpc), errors, faultApplied, hotBusy,
      nodeChannels: pool.nodeFlowIds.length, browserChannels: clients.length, shapedConnections: busy.accepted,
      bytes: busy.forwardedBytes.map((b,i) => b-before.forwardedBytes[i]!), peakQueuedBytes: busy.peakQueuedBytes, logicalOwners: new Set(owners).size }));
    link.setProfile({ bandwidthMbps: 1000, rttMs: 0 });
    if (v.scenario === "slow-consumer") for (const stream of streams) results.push(collectShellResult(stream).then(r => r, () => null));
    let drainTimer: NodeJS.Timeout | undefined;
    const outcomes = await Promise.race([Promise.all(results), new Promise<null[]>(resolve => { drainTimer = setTimeout(() => resolve([]),40000); })]);
    if (drainTimer) clearTimeout(drainTimer);
    const exact = outcomes.length === 3 && outcomes.every((outcome,i) => {
      if (!outcome) return false;
      const text = t.flows.main.shellText(outcome.frames, "stdout");
      return Buffer.byteLength(text) === loadBytes && createHash("sha256").update(text).digest("hex") === createHash("sha256").update(Buffer.alloc(loadBytes,65+i)).digest("hex") && t.flows.main.shellExit(outcome.frames)?.code === 0;
    });
    let uploadOk = true;
    if (upload) { const result = await upload; uploadOk = result.ack && !result.error && existsSync(join(o.workspaceRoot,"pool-upload.txt")) && readFileSync(join(o.workspaceRoot,"pool-upload.txt"),"utf8") === uploadText; }
    const starts = readFileSync(join(o.workspaceRoot,"pool-starts"),"utf8").trim().split("\n").sort();
    let canceledPids = true;
    if (narrow) {
      streams.forEach(s => s.reset(1));
      await t.tools.waitUntil(() => [0,1,2].every(i => { const pid = Number(readFileSync(join(o.workspaceRoot,`pool-pid-${i}`),"utf8")); return !existsSync(`/proc/${pid}`); }),5000).catch(() => { canceledPids = false; });
    }
    const localAt = performance.now(); const local = await o.client.call({ type: "workspace.list" }); const localMs = Math.round(performance.now()-localAt);
    const support=await o.client.call({type:"diagnostics.snapshot"});
    if(support?.type==="diagnostics") {
      const ingress=support.data.events.filter(e=>e.operation==="peer.ingress");t.note(JSON.stringify({nativeIngress:ingress}));
      if(["node-cut","browser-cut","all-cut"].includes(v.scenario))t.assertions.assert(!ingress.some(e=>e.code?.endsWith("full")),"ordinary recovery produced ingress-overflow disconnects");
    }
    const summary = { phase: "result", variant: v.name, rpc: quantiles(rpc), errors, exact24MiB: exact, uploadOk, canceledPids,
      interruptMs, interruptOk,
      sourceStarts: starts, sourceExactlyOnce: starts.join(",") === "0,1,2", retained: clients.map((c,i) => c.logicalConnectionId === owners[i]),
      localOk: local?.type === "workspaces", localMs, lateFrameTail: (pool.relay.logTail().match(/lateFrameOverflow/g)??[]).length, diagnostics: pool.diagnostics.slice(-10) };
    t.note(JSON.stringify(summary));
    t.assertions.assert(pool.nodeFlowIds.length === v.nodes && new Set(owners).size === v.browsers, "physical node channels or independent client journals did not match the requested topology");
    t.assertions.assert(starts.join(",") === "0,1,2" && uploadOk && (narrow ? canceledPids : exact), "output, upload, source-process uniqueness or intentional cancellation did not complete correctly");
    t.assertions.assert(rpc.length >= 3 && errors === 0 && Math.max(...rpc) < 10000, "management RPC exceeded the bounded interaction budget");
    if (controlSession) {
      const stopped = await o.client.call({ type: "session.get", payload: { sessionId: controlSession } });
      t.assertions.assert(interruptOk && stopped?.type === "snapshot" && !!stopped.data.summary.inputSummary?.paused, "remote interrupt failed to retain the Human pause");
    }
    t.assertions.assert(v.scenario !== "hot-drop" || hotBusy, "hot-drop happened only after bulk output had already completed");
    t.assertions.assert(summary.lateFrameTail === 0, "cancelled old data was charged as a node-wide protocol violation");
  } finally { if (timer) clearTimeout(timer); streams.forEach(s => s.reset(1)); await pool.dispose(); }
});
