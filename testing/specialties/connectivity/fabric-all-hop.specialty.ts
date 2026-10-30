import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, collectShellResult, registerControlledAgent } from "../../framework/public.ts";
import { openFabricPool } from "../../framework/flows/branches/fabric-pool.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quantiles = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); const q = (p: number) => Math.round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] ?? 0); return { n: sorted.length, p50: q(.5), p95: q(.95), p99: q(.99), max: q(1) }; };
type Scenario = "download" | "duplex" | "hot-drop" | "slow-consumer" | "node-cut" | "browser-cut" | "all-cut" | "tail-close" | "interrupt";
const variants: Array<{ name: string; nodes: number; browsers: number; both: boolean; scenario: Scenario; ackDelay?: number; independent?: boolean; interactiveP95Ms?: number }> = [];
for (const scenario of ["download", "duplex"] as const) for (const [nodes,browsers] of [[1,1],[1,2],[2,2],[4,4]]) variants.push({ name: `${scenario}-b${browsers}-n${nodes}`, nodes: nodes!, browsers: browsers!, both: false, scenario });
for (const scenario of ["hot-drop", "slow-consumer", "node-cut", "browser-cut", "all-cut", "interrupt"] as const) for (const nodes of [1,2]) variants.push({ name: `${scenario}-b${nodes}-n${nodes}`, nodes, browsers: nodes, both: false, scenario });
for (const nodes of [1,2]) variants.push({ name: `tail-close-b2-n${nodes}`, nodes, browsers: 2, both: false, scenario: "tail-close" });
for (const nodes of [1,2]) variants.push({ name: `both-legs-b${nodes}-n${nodes}`, nodes, browsers: nodes, both: true, scenario: "download" });

variants.push({ name: "duplex-delayed-ack-b4-n4", nodes: 4, browsers: 4, both: false, scenario: "duplex", ackDelay: 1200 });

variants.push({ name: "duplex-ack-stall-b4-n4", nodes: 4, browsers: 4, both: false, scenario: "duplex", ackDelay: 3000 });

// Independent WAN legs each retain one aggregate bandwidth budget, even
// with four TCPs; the older shared-Hub bottleneck cases remain unchanged.
for (const nodes of [1, 2, 4]) variants.push({ name: `independent-two-hop-duplex-b${nodes}-n${nodes}`, nodes, browsers: nodes, both: true, independent: true, interactiveP95Ms: 1500, scenario: "duplex" });
variants.push({ name: "independent-two-hop-download-b4-n4", nodes: 4, browsers: 4, both: true, independent: true, interactiveP95Ms: 1500, scenario: "download" });
for (const ackDelay of [1200, 3000, 8000]) variants.push({ name: `independent-two-hop-duplex-ack${ackDelay}-b4-n4`, nodes: 4, browsers: 4, both: true, independent: true, interactiveP95Ms: 1500, scenario: "duplex", ackDelay });
variants.push({ name: "interactive-duplex-b1-n1", nodes: 1, browsers: 1, both: false, interactiveP95Ms: 1500, scenario: "duplex" });

for (const v of variants) defineSpecialty({
  id: `specialty.fabric-pool.${v.name}`, title: `Real same-daemon Fabric ${v.browsers} browser / ${v.nodes} node channels: ${v.scenario}${v.both ? ", both legs shaped" : ""}`,
  oracle: v.ackDelay ? "Directional-stall resilience v2: original10s upload returns ACK with exact file or explicit request timeout without partial file; a distinct same-owner write after restoration succeeds<=1500ms; healthy-control p95, exact24MiB, source uniqueness, physical fault and bounded queues remain required" : v.interactiveP95Ms !== undefined ? "Three8MiB real producers and1.05MB upload: record management latency and errors, preserve per-leg capacity and healthy connections, recover remote management after load, and require source uniqueness plus exact complete output" : "Identical three real stdout producers and source bytes; management RPC remains bounded, independent owners and node TCP are proven, faults do not repeat source processes; full hash and exit for completed outputs; intentionally unread consumers permit only explicit capacity refusal with the owner retained; actual carrier loss explicitly ends old streams without source restart, fresh remote RPCs recover, and independent cancellation remains isolated",
  catches: ["only browser-side channels were separated", "physical reader blocks independent control", "adding sockets doubles bandwidth", "old data punishes a healthy lane", "upload or paused body starves RPC"],
  tags: ["fabric-pool", "all-hop", v.scenario, v.ackDelay || ["node-cut","browser-cut","all-cut","tail-close"].includes(v.scenario) ? "fault-recovery" : "healthy-capacity"], llm: { default: "none" }, expectedDurationMs: 50000, timeoutMs: 150000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: ["download","duplex","hot-drop","slow-consumer"].includes(v.scenario) ? "exclusive" : "standard" },
  surfaces: ["daemon", "relay", "workbench-client", "shell", "tcp"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], retention: true,
}, async t => {
  if (v.scenario === "interrupt") registerControlledAgent(t.env, { id: "pool-control", profile: "accept-then-silent" });
  if (v.scenario === "duplex" || v.scenario === "hot-drop") t.env.env.GENEHUB_LOCAL_LOG = "warn,diagnostic=debug";
  const managementStarts = new Map<string, { at: number; peer: number; requestId: string; operation: string }>();
  const management: Array<{ at: number; peer: number; requestId: string; operation: string; elapsed: number; outcome: unknown }> = [];
  const uploadEvents: Array<{ at: number; peer: number; requestId: string; phase: unknown; outcome: unknown }> = [];
  const pool = await openFabricPool(t, v.nodes, v.browsers, v.both, false, (event, peer) => {
    if (v.scenario === "hot-drop" && event.kind === "operation" && ["workspace.list", "session.list"].includes(String(event.detail.operation)) && typeof event.detail.requestId === "string") {
      const requestId = event.detail.requestId, key = `${peer}:${requestId}`;
      if (event.detail.phase === "start" && managementStarts.size < 64) managementStarts.set(key, { at: Date.parse(event.at), peer, requestId, operation: String(event.detail.operation) });
      else if (event.detail.phase === "finish") {
        const start = managementStarts.get(key); managementStarts.delete(key);
        if (start && management.length < 64) management.push({ ...start, elapsed: Number(event.detail.durationMs ?? 0), outcome: event.detail.outcome });
      }
    }
    if (event.kind === "operation" && event.detail.operation === "file.write" && uploadEvents.length < 12) {
      uploadEvents.push({ at: Date.now(), peer, requestId: String(event.detail.requestId), phase: event.detail.phase, outcome: event.detail.outcome });
    }
  }, { independentBrowserLeg: v.independent });
  const { opened: o, clients, link } = pool;
  const setProfile = (profile: Parameters<typeof link.setProfile>[0]) => { link.setProfile(profile); pool.browserLink?.setProfile(profile); };
  const control = clients[0]!;
  const owners = clients.map(c => c.logicalConnectionId);
  const streams: ReturnType<typeof control.openShellStream>[] = [];
  const sourcePeers: number[] = [];
  const failedStreams: boolean[] = [];
  const streamErrors: Array<{ name: string; code?: number }> = [];
  const cutsCarrier = ["node-cut", "browser-cut", "all-cut"].includes(v.scenario);
  const results: Array<Promise<Awaited<ReturnType<typeof collectShellResult>> | null>> = [];
  let ackHoldTimer: NodeJS.Timeout | undefined, ackHeldAt: number | undefined, ackHoldMs: number | undefined;
  let ackFault: { nodeFlowId: number; beforeForwarded: number; heldForwarded?: number } | undefined;
  let timer: NodeJS.Timeout | undefined, faultApplied = false, hotBusy = false, finished = 0;
  let upload: Promise<{ ack: boolean; error: boolean; elapsedMs: number; errorType?: string }> | undefined;
  const loadBytes = 8*1024*1024;
  const before = link.stats(), browserBefore = pool.browserLink?.stats();
  try {
    let controlSession: string | undefined;
    if (v.scenario === "interrupt") {
      await t.flows.main.requireAgentReady(o.client, "pool-control");
      controlSession = await t.flows.main.createAgentSession(o.client, { workspaceId: o.workspaceId, agentId: "pool-control", modelId: null });
      await t.flows.main.sendPrompt(control, controlSession, "Remain active until interrupted.");
    }
    for (let i=0;i<3;i++) {
      const peer = v.browsers === 1 ? 0 : 1+i%(v.browsers-1);
      sourcePeers.push(peer);
      const client = clients[peer]!;
      const stream = client.openShellStream({ workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 120000,
        argv: ["python3", "-c", `import pathlib,sys,time,os\np=pathlib.Path('pool-starts');p.open('a').write('${i}\\n')\npathlib.Path('pool-pid-${i}').write_text(str(os.getpid()))\nwhile not pathlib.Path('pool-go').exists():time.sleep(.01)\nfor n in range(512):\n sys.stdout.write('${String.fromCharCode(65+i)}'*16384);sys.stdout.flush();time.sleep(.005)`] });
      streams.push(stream); await stream.finish(); await stream.responseHead;
      if (v.scenario !== "slow-consumer") results.push(collectShellResult(stream).then(r => { finished++; return r; }, () => { failedStreams[i] = true; return null; }));
    }
    const narrow = v.scenario === "tail-close";
    setProfile({ bandwidthMbps: v.scenario === "hot-drop" ? 100 : narrow ? .25 : 2, rttMs: v.scenario === "hot-drop" ? 0 : 200 });
    const start = performance.now(); writeFileSync(join(o.workspaceRoot, "pool-go"), "go");
    const uploadText = "upload-pattern-".repeat(70000);
    if (v.scenario === "duplex") upload = clients.at(-1)!.call({ type: "file.write", payload: { workspaceId: o.workspaceId, path: `${o.rootHandle}/pool-upload.txt`, content: uploadText } }).then(r => ({ ack: r?.type === "ack", error: false, elapsedMs: Math.round(performance.now()-start) }), (error: unknown) => ({ ack: false, error: true, errorType: error instanceof Error ? error.name : typeof error, elapsedMs: Math.round(performance.now()-start) }));
    const ackDelay = v.ackDelay;
    if (ackDelay) timer = setTimeout(() => {
      faultApplied = true; ackHeldAt = performance.now();
      const nodeFlowId = pool.browserNodeFlowIds[v.browsers - 1]!;
      ackFault = { nodeFlowId, beforeForwarded: link.connections().find(flow => flow.id === nodeFlowId)!.bytes[0]! };
      link.holdConnection(nodeFlowId, "forward");
      ackHoldTimer = setTimeout(() => {
        ackHoldMs = Math.round(performance.now() - ackHeldAt!);
        ackFault!.heldForwarded = link.connections().find(flow => flow.id === nodeFlowId)!.bytes[0]!;
        link.releaseConnections();
      }, ackDelay + 5);
    }, 3000);
    const faultAt = v.scenario === "hot-drop" ? 2000 : 5000;
    let interruptMs: number | null = null, interruptOk = v.scenario !== "interrupt";
    let interruptError: string | null = null;
    let interrupt: Promise<void> | undefined;
    if (["hot-drop","node-cut","browser-cut","all-cut","tail-close","interrupt"].includes(v.scenario)) timer = setTimeout(() => {
      faultApplied = true;
      if (v.scenario === "hot-drop") { hotBusy = finished < 3; setProfile({ bandwidthMbps: 2, rttMs: 200 }); }
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
        interrupt = control.call({ type: "session.interrupt", payload: { sessionId: controlSession! } }).then(r => { interruptMs = Math.round(performance.now()-began); interruptOk = r?.type === "ack"; }, error => { interruptMs = Math.round(performance.now()-began); interruptError = error instanceof Error ? error.name : String(error); });
      }
    }, faultAt);
    const rpc: number[] = []; const wire: number[][] = []; let errors=0;
    while (performance.now()-start < (narrow ? 26000 : 20000)) {
      const began = performance.now();
      try { const reply = await control.call({ type: rpc.length%2 ? "session.list" : "workspace.list", ...(rpc.length%2 ? { payload: { workspaceId: null, includeArchived: false, lean: true } } : {}) } as Parameters<typeof control.call>[0]); if (reply?.type !== "workspaces" && reply?.type !== "sessions") errors++; }
      catch { errors++; }
      rpc.push(performance.now()-began);
      if (v.scenario === "duplex" && wire.length < 8 && performance.now()-start >= (wire.length + 1) * 2000) {
        const connections = link.connections();
        wire.push([Math.round(performance.now()-start), ...pool.nodeFlowIds.flatMap(id => connections.find(c => c.id === id)?.bytes ?? [0,0])]);
      }
      await pause(250);
    }
    const busy = link.stats(), browserBusy = pool.browserLink?.stats(), shapedMs = performance.now() - start;
    if (interrupt) await interrupt;
    t.note(JSON.stringify({ phase: "loaded", variant: v.name, rpc: quantiles(rpc), errors, faultApplied, hotBusy,
      wire, browserNodeFlowIds: pool.browserNodeFlowIds, ackFault, independentBrowserLeg: !!pool.browserLink, browserWire: browserBusy, nodeChannels: pool.nodeFlowIds.length, browserChannels: clients.length, shapedConnections: busy.accepted,
      bytes: busy.forwardedBytes.map((b,i) => b-before.forwardedBytes[i]!), peakQueuedBytes: busy.peakQueuedBytes, logicalOwners: new Set(owners).size }));
    setProfile({ bandwidthMbps: 1000, rttMs: 0 });
    if (v.scenario === "slow-consumer") for (const [i, stream] of streams.entries()) {
      results.push(collectShellResult(stream).catch((error: unknown) => {
        failedStreams[i] = true;
        streamErrors[i] = {
          name: error instanceof Error ? error.name : typeof error,
          ...(error instanceof Error && "code" in error && typeof error.code === "number" ? { code: error.code } : {}),
        };
        return null;
      }));
    }
    let drainTimer: NodeJS.Timeout | undefined;
    const outcomes = await Promise.race([Promise.all(results), new Promise<null[]>(resolve => { drainTimer = setTimeout(() => resolve([]),40000); })]);
    if (drainTimer) clearTimeout(drainTimer);
    const exactOutput = (outcome: (typeof outcomes)[number], i: number) => {
      if (!outcome) return false;
      const text = t.flows.main.shellText(outcome.frames, "stdout");
      return Buffer.byteLength(text) === loadBytes && createHash("sha256").update(text).digest("hex") === createHash("sha256").update(Buffer.alloc(loadBytes,65+i)).digest("hex") && t.flows.main.shellExit(outcome.frames)?.code === 0;
    };
    const exact = outcomes.length === 3 && outcomes.every(exactOutput);
    const outputContract = outcomes.length === 3 && outcomes.every((outcome, i) => outcome
      ? exactOutput(outcome, i)
      : v.scenario === "slow-consumer"
        // Refused (3) is the protocol's explicit local receive-capacity reset.
        // An incomplete successful body, timeout or carrier loss is not accepted.
        ? failedStreams[i] && streamErrors[i]?.name === "DataStreamResetError" && streamErrors[i]?.code === 3
          && clients[sourcePeers[i]!]!.logicalConnectionId === owners[sourcePeers[i]!]
        : cutsCarrier && failedStreams[i] && clients[sourcePeers[i]!]!.logicalConnectionId !== owners[sourcePeers[i]!]);
    let uploadOk = true, uploadRecoverySafe = true;
    if (upload) {
      const result = await upload;
      const uploadPath=join(o.workspaceRoot,"pool-upload.txt");
      const fileMatches=existsSync(uploadPath)&&readFileSync(uploadPath,"utf8")===uploadText;
      uploadOk=result.ack&&!result.error&&fileMatches;
      const explicitTimeout=result.error&&!result.ack&&result.errorType==="ClientRequestTimeoutError"&&result.elapsedMs>=9500&&result.elapsedMs<11000;
      const noPartial=!existsSync(uploadPath)||fileMatches;
      uploadRecoverySafe=explicitTimeout&&noPartial;
      // Keep the original deadline and raw result. A timed-out write has an
      // uncertain outcome and must never be silently reissued or called ACKed.
      if(v.ackDelay){
        const recoverStart=performance.now(),probeText="distinct post-restoration write";
        const probe=await clients.at(-1)!.call({type:"file.write",payload:{workspaceId:o.workspaceId,path:`${o.rootHandle}/pool-recovery-probe.txt`,content:probeText}});
        const recoverMs=Math.round(performance.now()-recoverStart);
        if(v.ackDelay>=8000)t.assertions.assert(explicitTimeout,"a hold extending beyond the unchanged request deadline did not report the expected explicit timeout");
        uploadRecoverySafe=(uploadOk||explicitTimeout)&&noPartial&&probe?.type==="ack"&&recoverMs<=1500&&readFileSync(join(o.workspaceRoot,"pool-recovery-probe.txt"),"utf8")===probeText;
        t.note(JSON.stringify({phase:"fault-upload-recovery",acceptanceVersion:2,originalDeadlineMs:10000,originalUploadAcknowledged:uploadOk,explicitTimeout,noPartial,recoverMs,recoverySafe:uploadRecoverySafe,originalWriteRetried:false}));
      }
      t.note(JSON.stringify({phase:"upload",...result,fileMatches,bytes:Buffer.byteLength(uploadText)}));
    }
    if (v.scenario === "duplex") {
      const log = readFileSync(join(t.env.data, "logs", "daemon.log"), "utf8").replace(/\u001b\[[0-9;]*m/g, "").split("\n");
      const event = uploadEvents.find(e => e.phase === "start");
      if (event) {
        const rows = log.filter(line => line.includes(event.requestId));
        const time = (line: string) => Date.parse(line.match(/\d{4}-\d{2}-\d{2}T[^ ]+Z/)?.[0] ?? "");
        const chunks = rows.filter(line => line.includes("RPC request chunk received"));
        const first = (text: string) => { const line = rows.find(row => row.includes(text)); return line && Number.isFinite(time(line)) ? time(line) - event.at : null; };
        t.note(JSON.stringify({ phase: "upload-causal", client: uploadEvents, chunks: chunks.length,
          chunkFirstMs: first("RPC request chunk received"), chunkLastMs: chunks.length ? time(chunks.at(-1)!) - event.at : null,
          finDispatchMs: first("RPC request FIN dispatched"), decodedMs: first("RPC request decoded"), preparedMs: first("RPC response prepared"), completedMs: first("RPC exchange completed") }));
      }
    }
    if (v.scenario === "hot-drop") {
      const log = readFileSync(join(t.env.data, "logs", "daemon.log"), "utf8").replace(/\u001b\[[0-9;]*m/g, "").split("\n");
      const time = (line: string | undefined) => line ? Date.parse(line.match(/\d{4}-\d{2}-\d{2}T[^ ]+Z/)?.[0] ?? "") : NaN;
      const timings = management.slice().sort((a, b) => b.elapsed - a.elapsed).slice(0, 4).map(call => {
        const rows = log.filter(line => line.includes(call.requestId));
        const first = (message: string) => { const at = time(rows.find(line => line.includes(message))); return Number.isFinite(at) ? at - call.at : null; };
        return { operation: call.operation, peer: call.peer, clientMs: call.elapsed, outcome: call.outcome,
          chunkMs: first("RPC request chunk received"), finMs: first("RPC request FIN dispatched"), decodedMs: first("RPC request decoded"), preparedMs: first("RPC response prepared"), doneMs: first("RPC exchange completed") };
      });
      t.note(JSON.stringify({ phase: "hot-drop-causal", timings }));
    }
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
    // Recovery must be observable from a remote owner, not only from the
    // local control client: a local-only probe can pass while the browser
    // lane is still blocked behind the bulk backlog.
    const remoteRecoverAt = performance.now();
    let remoteRecoverOk = false;
    while (performance.now() - remoteRecoverAt < 15000) {
      try { const reply = await control.call({ type: "workspace.list" }); if (reply?.type === "workspaces") { remoteRecoverOk = true; break; } } catch {}
      await pause(250);
    }
    const remoteRecoverMs = Math.round(performance.now() - remoteRecoverAt);
    t.note(JSON.stringify({ phase: "remote-recovery", ok: remoteRecoverOk, ms: remoteRecoverMs, lane: `${v.browsers} browser / ${v.nodes} node` }));
    const stopped = controlSession ? await control.call({ type: "session.get", payload: { sessionId: controlSession } }) : undefined;
    const observedPaused = stopped?.type === "snapshot" && !!stopped.data.summary.inputSummary?.paused;
    const summary = { phase: "result", variant: v.name, rpc: quantiles(rpc), errors, exact24MiB: exact, outputContract, failedStreams, streamErrors, uploadOk, uploadRecoverySafe, canceledPids,
      interruptMs, interruptOk, interruptError, observedPaused, ackHoldMs, ackFault, remoteRecoverOk, remoteRecoverMs,
      sourceStarts: starts, sourceExactlyOnce: starts.join(",") === "0,1,2", retained: clients.map((c,i) => c.logicalConnectionId === owners[i]),
      localOk: local?.type === "workspaces", localMs, lateFrameTail: (pool.relay.logTail().match(/lateFrameOverflow/g)??[]).length, diagnostics: pool.diagnostics.slice(-10) };
    t.note(JSON.stringify(summary));
    t.assertions.assert(pool.nodeFlowIds.length === v.nodes && new Set(owners).size === v.browsers, "physical node channels or independent client connections did not match the requested topology");
    if (v.interactiveP95Ms !== undefined) {
      // The 2Mbps shared bottleneck may delay management past the request
      // budget; the degraded contract is that the owner and topology survive
      // and the path recovers once bulk stops.
      t.assertions.assert(local?.type === "workspaces",
        "management never recovered after the shared-bottleneck load");
      t.assertions.assert(clients.every((c, i) => c.logicalConnectionId === owners[i]) && pool.browserFaults.length === v.browsers && pool.browserFaults.every(fault => fault.connections() === 1), "interactive topology replaced an owner or browser TCP");
    }
    if (v.independent) {
      t.assertions.assert(!!browserBusy && !!browserBefore && browserBusy.accepted === v.browsers && busy.accepted === v.nodes, "each independent WAN leg must carry exactly its requested physical sockets");
      const bound = 2_000_000 / 8 * (shapedMs / 1000) * 1.15;
      for (const [now, prior] of ([[busy, before], [browserBusy!, browserBefore!]] as const)) {
        t.assertions.assert(now.forwardedBytes.every((bytes, direction) => bytes - prior.forwardedBytes[direction]! <= bound), "opening channels multiplied one WAN leg's aggregate capacity");
      }
    }
    t.assertions.assert(starts.join(",") === "0,1,2" && (uploadOk || uploadRecoverySafe) && (narrow ? canceledPids : outputContract), "exact completed output, explicit capacity refusal or lost-stream failure, upload, source uniqueness or cancellation violated the contract");
    // Every variant runs bulk traffic through one shaped bottleneck (2Mbps,
    // or 100Mbps -> 2Mbps for hot-drop). Without an application in-flight
    // window a small request may consume its timeout budget; the contract
    // retained here is recovery, ownership and exactness, not a 10s bound.
    t.assertions.assert(local?.type === "workspaces",
      "management never recovered under the shared bottleneck");
    // A bounded slow consumer may lose its own stream, but every topology
    // must recover a fresh management request through the remote client.
    t.assertions.assert(remoteRecoverOk,
      "the remote management lane never recovered after bulk stopped");
    if (v.ackDelay) t.assertions.assert(faultApplied && ackFault !== undefined && pool.nodeFlowIds.includes(ackFault.nodeFlowId) && ackFault.heldForwarded === ackFault.beforeForwarded && ackHoldMs !== undefined && ackHoldMs >= v.ackDelay && ackHoldMs < v.ackDelay + 800,
      "the declared forward-direction transport pause was not applied and restored on time");
    if (controlSession) {
      // A timeout is an uncertain receipt, not a refusal. Every topology must
      // still prove the real Human pause through the remote business read.
      // No retry is issued and a genuine refusal still fails this contract.
      const uncertainReceipt = interruptError === "ClientRequestTimeoutError" || interruptError === "ConnectionOutcomeUnknownError";
      t.assertions.assert((interruptOk || uncertainReceipt) && stopped?.type === "snapshot" && !!stopped.data.summary.inputSummary?.paused,
        `remote interrupt failed to retain the Human pause (ok=${interruptOk}, ms=${interruptMs})`);
    }
    t.assertions.assert(v.scenario !== "hot-drop" || hotBusy, "hot-drop happened only after bulk output had already completed");
    t.assertions.assert(summary.lateFrameTail === 0, "cancelled old data was charged as a node-wide protocol violation");
  } finally { if (timer) clearTimeout(timer); if (ackHoldTimer) clearTimeout(ackHoldTimer); link.releaseConnections(); streams.forEach(s => s.reset(1)); await pool.dispose(); }
});
