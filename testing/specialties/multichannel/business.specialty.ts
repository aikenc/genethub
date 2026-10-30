import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client, type WebSocketLike } from "@genehub/workbench/client";
import { WebSocket } from "ws";
import { defineSpecialty, daemonEndpoint, startFaultLink, type CaseContext, BlockedError } from "../../framework/public.ts";

const meta = (name: string, title: string, oracle: string, duration = 20000) => ({
  id: `specialty.multichannel.${name}`, title, oracle,
  catches: [title], tags: ["network-risk-v2", "multichannel", name], llm: { default: "none" as const },
  expectedDurationMs: duration, timeoutMs: duration + 60000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" as const },
  surfaces: ["daemon", "workbench-client", "websocket"], productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
});
type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
async function withWorkspace(t: CaseContext, run: (o: Opened) => Promise<void>) {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try { await run(o); } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
}
async function connect(t: CaseContext, o: Opened, link?: Awaited<ReturnType<typeof startFaultLink>>) {
  const endpoint = daemonEndpoint(o.daemon);
  const errors: string[] = [];
  const client = new Client({ ...endpoint, ...(link ? { url: link.urlFor(endpoint.url) } : {}), rtcEnabled: false,
    connectTimeoutMs: 5000, helloTimeoutMs: 5000,
    onError(error) { errors.push(error instanceof Error ? error.message : String(error)); if (errors.length > 3) errors.shift(); },
    socketFactory: u => new WebSocket(u) as unknown as WebSocketLike,
    redial: async () => { const fresh = daemonEndpoint(o.daemon); return { ...fresh, ...(link ? { url: link.urlFor(fresh.url) } : {}) }; },
  });
  client.connect();
  try { await t.tools.waitUntil(() => client.connectionState === "ready", 8000); return client; }
  catch { const failure = (client.failure?.message ?? client.connectionState) + " " + errors.join("; "); client.close(); throw new Error(`public Client admission did not become ready within 8 seconds: ${failure}`); }
}
defineSpecialty(meta("capacity-eight-clients", "Eight ordinary business clients remain usable together",
  "Proposed minimum for eight ordinary connections on one owner; all eight public clients can list the same workspace, admission cannot silently replace an existing client"), async t => {
  await withWorkspace(t, async o => {
    const peers: Client[] = [o.client]; let admissionError = "";
    try {
      for (let n = 1; n < 8; n++) {
        try { peers.push(await connect(t, o)); } catch (e) { admissionError = String(e); break; }
      }
      const usable = await Promise.all(peers.map(async c => (await c.call({ type: "workspace.list" }))?.type === "workspaces"));
      t.note(`proposedTarget=8 admitted=${peers.length} usable=${usable.filter(Boolean).length}`);
      t.assertions.assert(usable.every(Boolean), "capacity pressure broke an already admitted client");
      t.assertions.assert(peers.length === 8, `capacity target=8 admitted=${peers.length}; ${admissionError}`);
    } finally { peers.slice(1).forEach(c => c.close()); }
  });
});
defineSpecialty(meta("closed-client-releases-capacity", "Closing tabs promptly makes room for new business clients",
  "Twelve sequential public clients complete RPC and close; later clients do not wait for the 60-second recovery expiry"), async t => {
  await withWorkspace(t, async o => {
    for (let n = 0; n < 12; n++) {
      const peer = await connect(t, o);
      try { t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", `round ${n} unusable`); }
      finally { peer.close(); }
      await new Promise(r => setTimeout(r, 150));
    }
  });
});
defineSpecialty(meta("saturated-capacity-releases-slot", "Closing a client releases a saturated admission slot",
  "Fill real admission to ResourceExhausted; all existing clients remain usable, then closing one permits a replacement within eight seconds"), async t => {
  await withWorkspace(t, async o => {
    const peers: Client[] = [];
    let refusal = "";
    try {
      // Past the daemon's 32-peer cap (logical_registry.rs MAX_CONNECTIONS), so the loop must end in a refusal.
      for (let n = 0; n < 40; n++) {
        try { peers.push(await connect(t, o)); } catch (error) { refusal = String(error); break; }
      }
      t.assertions.assert(peers.length > 0 && /ResourceExhausted/.test(refusal), `admission was not demonstrably saturated: admitted=${peers.length}; ${refusal}`);
      for (const peer of peers) t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "saturation evicted an existing client");
      peers.pop()!.close();
      const start = performance.now();
      const replacement = await connect(t, o); peers.push(replacement);
      t.assertions.assert((await replacement.call({ type: "workspace.list" }))?.type === "workspaces" && performance.now() - start < 8000, "closed capacity was retained until recovery expiry");
      t.note(`saturationObserved=true retainedClients=${peers.length + 1} replacementMs=${Math.round(performance.now() - start)}`);
    } finally { peers.forEach(peer => peer.close()); }
  });
});
defineSpecialty(meta("repeated-loss-one-operation", "Repeated physical losses end old streams without restarting a source",
  "The first real disconnect rejects the old output, every new connection serves a fresh RPC, and the disk source marker remains exactly once"), async t => {
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      const marker = join(o.workspaceRoot, "starts");
      const operation = t.flows.main.startShell(peer, { workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 25000,
        argv: ["python3", "-c", "import pathlib,time; pathlib.Path('starts').open('a').write('start\\n'); [(print(i,flush=True),time.sleep(1)) for i in range(10)]"] });
      await t.tools.waitUntil(() => existsSync(marker), 10000);
      for (let n = 0; n < 3; n++) {
        const before = link.connections(), oldId = peer.logicalConnectionId; link.cut();
        await t.tools.waitUntil(() => link.connections() > before && peer!.connectionState === "ready" && peer!.logicalConnectionId !== oldId, 10000);
        t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "new RPC failed after a new admission");
      }
      const failed = await operation.result.then(() => false, () => true);
      t.assertions.assert(failed, "an interrupted output was reported as a complete result");
      t.assertions.assert(readFileSync(marker, "utf8") === "start\n", "reconnect restarted the source");
    } finally { peer?.close(); await link.stop(); }
  });
});
defineSpecialty(meta("deadline-includes-outage", "Connection loss does not extend a command's deadline",
  "A running two-second command ends explicitly after socket loss, never performs its delayed disk mutation, and new RPCs work after reconnection"), async t => {
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      const marker = join(o.workspaceRoot, "deadline-start");
      const operation = t.flows.main.startShell(peer, { workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 2000,
        argv: ["python3", "-c", "import pathlib,time; pathlib.Path('deadline-start').write_text('start'); time.sleep(5); pathlib.Path('late-side-effect').write_text('bad')"] });
      await t.tools.waitUntil(() => existsSync(marker), 10000);
      const faultAt = Date.now(); link.block();
      t.assertions.assert(await operation.result.then(() => false, () => true), "lost output did not fail explicitly");
      await new Promise(r => setTimeout(r, 4000)); link.unblock();
      await t.tools.waitUntil(() => peer!.connectionState === "ready", 15000);
      await new Promise(r => setTimeout(r, Math.max(0, faultAt + 6000 - Date.now())));
      t.assertions.assert(!existsSync(join(o.workspaceRoot, "late-side-effect")), "lost command performed its delayed mutation");
      t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "new connection is unusable");
    } finally { peer?.close(); await link.stop(); }
  });
});
defineSpecialty(meta("recovery-expiry-terminal", "Connection loss promptly terminates the original stream and process",
  "Physical closure terminates the old stream within5s and reaps its original process; later recovery is a new connection without a60s retention lease", 20000), async t => {
  if (process.platform !== "linux") throw new BlockedError("expiry process birth oracle requires Linux");
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      const marker = join(o.workspaceRoot, "expiry-starts");
      const operation = t.flows.main.startShell(peer, { workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 120000,
        argv: ["python3", "-c", "import pathlib,time,os; pathlib.Path('expiry-pid').write_text(str(os.getpid())); pathlib.Path('expiry-starts').open('a').write('start\\n'); time.sleep(110)"] });
      await t.tools.waitUntil(() => existsSync(marker), 10000);
      const oldId = peer.logicalConnectionId;
      const pid = Number(readFileSync(join(o.workspaceRoot, "expiry-pid"), "utf8"));
      const processBirth = () => { try { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" "); return f[0] === "Z" ? "" : f[19]!; } catch { return ""; } };
      const birth = processBirth();
      t.assertions.assert(!!birth, "expiry command was not alive before loss");
      let terminalAt: number | undefined; void operation.stream.done.catch(() => { terminalAt = Date.now(); });
      const blockedAt = Date.now(); link.block();
      await t.tools.waitUntil(() => terminalAt !== undefined, 5000);
      const retainedMs = terminalAt! - blockedAt;
      t.note("originalStreamRetainedMs=" + retainedMs);
      t.assertions.assert(retainedMs >= 0 && retainedMs <= 5000, "old stream waited for a removed retention lease: " + retainedMs + "ms");
      await t.tools.waitUntil(() => processBirth() !== birth, 5000);
      t.assertions.assert(readFileSync(marker, "utf8") === "start\n", "expired operation restarted");
      link.unblock();
      await t.tools.waitUntil(() => peer!.connectionState === "ready", 20000);
      t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "could not reconnect after terminal expiry");
      t.assertions.assert(peer.logicalConnectionId !== oldId, "expired logical identity was resurrected");
    } finally { peer?.close(); await link.stop(); }
  });
});

defineSpecialty(meta("pty-retains-session", "An interactive terminal retains its shell variables after disconnect",
  "A variable set before loss remains in the same PTY after recovery; output proves command execution rather than input echo"), async t => {
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      let output = "";
      peer.onPty((_id, text) => { if (text) output = (output + text).slice(-16384); });
      const reply = await peer.call({ type: "pty.open", payload: { workspaceId: o.workspaceId, cols: 80, rows: 24 } });
      if (reply?.type !== "pty") throw new Error("PTY did not open");
      const ptyId = reply.data.ptyId;
      await peer.call({ type: "pty.write", payload: { ptyId, data: "export MC_VALUE=731; printf 'ready-%s\\n' 42\n" } });
      await t.tools.waitUntil(() => output.includes("ready-42"), 10000);
      const count = link.connections(); link.cut();
      await t.tools.waitUntil(() => link.connections() > count && peer!.connectionState === "ready", 10000);
      output = "";
      await peer.call({ type: "pty.write", payload: { ptyId, data: "printf 'kept-%s\\n' \"$MC_VALUE\"\n" } });
      await t.tools.waitUntil(() => output.includes("kept-731"), 10000);
      await peer.call({ type: "pty.close", payload: { ptyId } });
      await t.assertions.expectProtocolCode(() => peer!.call({ type: "pty.write", payload: { ptyId, data: "echo bad\n" } }), "notFound");
    } finally { peer?.close(); await link.stop(); }
  });
});

defineSpecialty(meta("pty-input-resize-isolation", "Two terminals keep distinct input and dimensions through recovery",
  "Inputs queued during real socket loss execute once in their own PTYs; independent shell stty output proves distinct resize delivery and closing one leaves the other usable"), async t => {
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    const terminals: string[] = [];
    try {
      peer = await connect(t, o, link);
      for (let n = 0; n < 2; n++) {
        const reply = await peer.call({ type: "pty.open", payload: { workspaceId: o.workspaceId, cols: 80, rows: 24 } });
        if (reply?.type !== "pty") throw new Error("PTY open failed");
        terminals.push(reply.data.ptyId);
        await peer.call({ type: "pty.write", payload: { ptyId: reply.data.ptyId, data: `cd '${o.workspaceRoot}'; printf ready > pty-ready-${n}\n` } });
      }
      await t.tools.waitUntil(() => terminals.every((_, n) => existsSync(join(o.workspaceRoot, `pty-ready-${n}`))), 10000);
      const connections = link.connections(); link.block();
      await t.tools.waitUntil(() => peer!.connectionState !== "ready", 5000);
      const operations = Promise.all(terminals.map(async (ptyId, n) => {
        await peer!.call({ type: "pty.resize", payload: { ptyId, cols: 91 + n, rows: 31 + n } });
        await peer!.call({ type: "pty.write", payload: { ptyId, data: `printf 'input-${n}\\n' >> pty-input-${n}; stty size > pty-size-${n}\n` } });
      }));
      void operations.catch(() => {});
      await new Promise(r => setTimeout(r, 500)); link.unblock();
      await operations;
      await t.tools.waitUntil(() => terminals.every((_, n) => {
        try { return /^\d+ \d+\r?\n$/.test(readFileSync(join(o.workspaceRoot, `pty-size-${n}`), "utf8")); } catch { return false; }
      }), 10000);
      t.assertions.assert(link.connections() > connections, "PTY input never crossed a replacement socket");
      for (let n = 0; n < 2; n++) {
        t.assertions.assert(readFileSync(join(o.workspaceRoot, `pty-input-${n}`), "utf8") === `input-${n}\n`, "terminal input duplicated or crossed ownership");
        t.assertions.assert(readFileSync(join(o.workspaceRoot, `pty-size-${n}`), "utf8").trim() === `${31 + n} ${91 + n}`, "resize applied to the wrong terminal: " + readFileSync(join(o.workspaceRoot, `pty-size-${n}`), "utf8"));
      }
      await peer.call({ type: "pty.close", payload: { ptyId: terminals[0]! } });
      await peer.call({ type: "pty.write", payload: { ptyId: terminals[1]!, data: "printf survivor > pty-survivor\n" } });
      await t.tools.waitUntil(() => existsSync(join(o.workspaceRoot, "pty-survivor")), 5000);
      t.assertions.assert(readFileSync(join(o.workspaceRoot, "pty-survivor"), "utf8") === "survivor", "closing one terminal damaged its peer");
    } finally {
      if (peer?.connectionState === "ready") for (const ptyId of terminals) await peer.call({ type: "pty.close", payload: { ptyId } }).catch(() => {});
      peer?.close(); await link.stop();
    }
  });
});
defineSpecialty(meta("file-write-under-loss", "An interrupted file request is not replayed and a business can explicitly save again",
  "Cut a1MiB write before its JSON is complete: the old call reports unknown, no file appears, then an explicit new save writes exact bytes"), async t => {
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      const content = "0123456789abcdef".repeat(65536), oldId = peer.logicalConnectionId;
      const request = { type: "file.write" as const, payload: { workspaceId: o.workspaceId, path: `${o.rootHandle}/network-file.txt`, content } };
      link.cutAfterClientBytes(256 * 1024);
      const error = await peer.call(request).then(() => null, e => e as Error);
      t.assertions.assert(link.injectedCuts() === 1 && error?.name === "ConnectionOutcomeUnknownError", "the partial write was replayed or not reported unknown");
      await t.tools.waitUntil(() => peer!.connectionState === "ready" && peer!.logicalConnectionId !== oldId, 15000);
      t.assertions.assert(!existsSync(join(o.workspaceRoot, "network-file.txt")), "an incomplete request was executed or automatically replayed");
      t.assertions.assert((await peer.call(request))?.type === "ack", "explicit business save failed");
      t.assertions.assert(readFileSync(join(o.workspaceRoot, "network-file.txt"), "utf8") === content, "explicit save changed the bytes");
    } finally { peer?.close(); await link.stop(); }
  });
});
defineSpecialty(meta("slow-stream-cancel-fairness", "A paused consumer does not indefinitely block unrelated RPC and can be cancelled",
  "An infinite real stdout producer with an unconsumed body coexists with five workspace RPCs below 2 seconds; RESET retires the observed process within 5 seconds"), async t => {
  if (process.platform !== "linux") throw new BlockedError("process identity and zombie oracle requires Linux procfs");
  await withWorkspace(t, async o => {
    const peer = await connect(t, o);
    const marker = join(o.workspaceRoot, "slow-start");
    const stream = peer.openShellStream({ workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 20000,
      argv: ["python3", "-c", "import pathlib,sys,time,os\npathlib.Path('slow-start').write_text(str(os.getpid()))\nn=0\nwhile True:\n sys.stdout.write('x'*16384+'\\n'); sys.stdout.flush(); n+=1; pathlib.Path('slow-progress').write_text(str(n)); time.sleep(0.001)"] });
    try {
      await stream.finish(); await stream.responseHead;
      await t.tools.waitUntil(() => existsSync(marker), 10000);
      const progress = () => { try { return Number(readFileSync(join(o.workspaceRoot, "slow-progress"), "utf8")); } catch { return 0; } };
      let last = 0, stableSince = performance.now();
      await t.tools.waitUntil(() => {
        const current = progress();
        if (current !== last || current === 0) { last = current; stableSince = performance.now(); }
        return last > 0 && performance.now() - stableSince >= 750;
      }, 12000);
      const pausedAt = last;
      // Resume consumption through the public stream until the producer moves.
      // A stalled process unrelated to backpressure cannot satisfy this control.
      const iterator = stream.body()[Symbol.asyncIterator]();
      const drainDeadline = performance.now() + 5000;
      while (progress() <= pausedAt && performance.now() < drainDeadline) {
        const chunk = await iterator.next();
        t.assertions.assert(!chunk.done, "producer terminated instead of applying backpressure");
        await new Promise(r => setTimeout(r, 1));
      }
      t.assertions.assert(progress() > pausedAt, "consumption did not release producer backpressure");
      t.note(`producerPausedAt=${pausedAt} resumedAt=${progress()}`);
      for (let n = 0; n < 5; n++) {
        const start = performance.now();
        const result = await peer.call({ type: "workspace.list" });
        t.assertions.assert(result?.type === "workspaces" && performance.now() - start < 2000, "slow stream starved an unrelated RPC");
      }
      const pid = Number(readFileSync(marker, "utf8"));
      const observed = () => {
        try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" "); return { state: stat[0], birth: stat[19] }; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
      };
      const initial = observed();
      t.assertions.assert(Number.isSafeInteger(pid) && pid > 1 && initial !== null && initial.state !== "Z", "producer was not live at cancellation");
      stream.reset(1);
      await t.tools.waitUntil(() => { const p = observed(); return p === null || p.birth !== initial!.birth; }, 5000).catch(() => {
        const p = observed();
        t.note(`cancelProcessState=${p?.state} sameProcess=${p?.birth === initial!.birth}`);
        throw new Error(p?.state === "Z" ? "cancelled producer exited but was not reaped within 5 seconds" : "cancelled producer remains a live process after 5 seconds; state=" + p?.state + " sameBirth=" + (p?.birth === initial!.birth));
      });
      t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "cancellation destroyed connection");
    } finally { stream.reset(1); peer.close(); }
  });
});

defineSpecialty(meta("connection-churn-resources", "Repeated tab churn leaves bounded daemon resources",
  "After ten warm-up clients and sixty measured public-client connect/RPC/close cycles, the same daemon has at most 64 MiB extra RSS and 8 extra file descriptors", 90000), async t => {
  if (process.platform !== "linux") throw new BlockedError("RSS and descriptor oracle requires Linux procfs");
  await withWorkspace(t, async o => {
    const pid = daemonEndpoint(o.daemon).localServerProof.pid;
    const sample = () => {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (!match) throw new BlockedError("daemon RSS is not observable");
      return { rssKiB: Number(match[1]), fds: readdirSync(`/proc/${pid}/fd`).length };
    };
    const cycle = async () => {
      const peer = await connect(t, o);
      try { t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "churn lost public RPC"); }
      finally { peer.close(); }
      await new Promise(r => setTimeout(r, 100));
    };
    for (let i = 0; i < 10; i++) await cycle();
    const before = sample();
    for (let i = 0; i < 60; i++) await cycle();
    await new Promise(r => setTimeout(r, 1500));
    const after = sample();
    t.note(`cycles=60 rssGrowthKiB=${after.rssKiB - before.rssKiB} fdGrowth=${after.fds - before.fds}`);
    t.assertions.assert(after.rssKiB - before.rssKiB <= 64 * 1024 && after.fds - before.fds <= 8, "connection churn retained excessive daemon resources");
  });
});

defineSpecialty(meta("response-loss-one-execution", "Lost output reports failure without executing a command twice",
  "Cut real downstream bytes after a source starts; incomplete output rejects, a fresh RPC works, and the disk contains exactly one source start"), async t => {
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      const marker = join(o.workspaceRoot, "response-starts"), oldId = peer.logicalConnectionId;
      const operation = t.flows.main.startShell(peer, { workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 15000,
        argv: ["python3", "-c", "import pathlib,time; pathlib.Path('response-starts').open('a').write('once\\n'); time.sleep(1); print('x'*131072,flush=True)"] });
      await t.tools.waitUntil(() => existsSync(marker), 8000);
      link.cutAfterServerBytes(8192);
      t.assertions.assert(await operation.result.then(() => false, () => true), "a truncated output was called complete");
      t.assertions.assert(link.injectedCuts() === 1 && readFileSync(marker, "utf8") === "once\n", "response fault was missed or source was repeated");
      await t.tools.waitUntil(() => peer!.connectionState === "ready" && peer!.logicalConnectionId !== oldId, 15000);
      t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "new RPC failed");
    } finally { peer?.close(); await link.stop(); }
  });
});
defineSpecialty(meta("concurrent-writes-under-loss", "Concurrent saves keep payload ownership and report unknown outcomes under loss",
  "Twenty-four writes cross a real cut; successful receipts and any persisted unknown writes have exact own bytes, lost calls are not replayed, and an independent client stays responsive"), async t => {
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      const oldId = peer.logicalConnectionId;
      const entries = Array.from({ length: 24 }, (_, n) => ({ name: "save-" + n + ".txt", text: (n + ":中文🙂\n").repeat(4096) }));
      link.blackhole("client");
      let settled = false;
      const writes = Promise.allSettled(entries.map(e => peer!.call({ type: "file.write", payload: { workspaceId: o.workspaceId, path: o.rootHandle + "/" + e.name, content: e.text } })));
      void writes.then(() => { settled = true; });
      await t.tools.waitUntil(() => link.heldBytes().client > 0, 5000);
      for (let n = 0; n < 5; n++) {
        t.assertions.assert(!settled, "independent RPC did not overlap outstanding saves");
        const start = performance.now();
        t.assertions.assert((await o.client.call({ type: "workspace.list" }))?.type === "workspaces" && performance.now() - start < 2000, "another connection was starved");
      }
      link.cutAfterClientBytes(128 * 1024); link.clearBlackhole();
      const results = await writes;
      t.assertions.assert(link.injectedCuts() === 1 && results.some(r => r.status === "rejected"), "the fault did not terminate any in-flight call");
      for (const [n, r] of results.entries()) {
        const e = entries[n]!, file = join(o.workspaceRoot, e.name);
        if (r.status === "fulfilled") t.assertions.assert(r.value?.type === "ack" && existsSync(file), "success was reported without a saved file");
        else t.assertions.assert(r.reason instanceof Error && r.reason.name === "ConnectionOutcomeUnknownError", "lost write did not report its uncertain outcome");
        if (existsSync(file)) t.assertions.assert(readFileSync(file, "utf8") === e.text, "partial or crossed payload for " + e.name);
      }
      await t.tools.waitUntil(() => peer!.connectionState === "ready" && peer!.logicalConnectionId !== oldId, 15000);
      t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "new connection was unusable");
    } finally { peer?.close(); await link.stop(); }
  });
});
defineSpecialty(meta("offline-cancel-no-side-effect", "Loss cancels its shell while an independent command remains alive",
  "A command on the lost endpoint is canceled without its delayed disk effect; an independent uncanceled command completes and the new connection works", 30000), async t => {
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      const stream = peer.openShellStream({ workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 20000,
        argv: ["python3", "-c", "import pathlib,time; pathlib.Path('cancel-start').write_text('started'); time.sleep(8); pathlib.Path('cancel-effect').write_text('bad')"] });
      void stream.done.catch(() => {});
      await stream.finish(); await stream.responseHead;
      await t.tools.waitUntil(() => existsSync(join(o.workspaceRoot, "cancel-start")), 8000);
      // A lost endpoint ends all its streams. Only an independent endpoint
      // may promise to preserve an uncancelled command.
      const control = t.flows.main.startShell(o.client, { workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 20000,
        argv: ["python3", "-c", "import pathlib,time; pathlib.Path('control-start').write_text('started'); time.sleep(8); pathlib.Path('control-effect').write_text('kept')"] });
      await t.tools.waitUntil(() => existsSync(join(o.workspaceRoot, "control-start")), 8000);
      const started = Date.now(), connections = link.connections();
      link.block(); stream.reset(1);
      await new Promise(r => setTimeout(r, 1000)); link.unblock();
      await t.tools.waitUntil(() => link.connections() > connections && peer!.connectionState === "ready", 10000);
      const controlResult = await control.result;
      t.assertions.assert(t.flows.main.shellExit(controlResult.frames)?.code === 0 && readFileSync(join(o.workspaceRoot, "control-effect"), "utf8") === "kept", "network loss or cancellation also killed the uncancelled control");
      await new Promise(r => setTimeout(r, Math.max(0, started + 9000 - Date.now())));
      t.assertions.assert(!existsSync(join(o.workspaceRoot, "cancel-effect")), "offline cancellation lost its business effect after reconnect");
      t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "offline cancellation broke subsequent use");
    } finally { peer?.close(); await link.stop(); }
  });
});

defineSpecialty(meta("subscriptions-isolated-under-loss", "Business resubscription keeps two sessions isolated",
  "Two business subscriptions recover their own ordered missed events on a new endpoint after TCP loss; unsubscribing one does not silence the other"), async t => {
  await withWorkspace(t, async o => {
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      const ids = await Promise.all([0, 1].map(() => t.flows.main.createBuiltinSession(o.client, o.workspaceId)));
      const observed: string[][] = [[], []]; let repairs = 0;
      for (let n = 0; n < 2; n++) await peer.subscribe(ids[n]!, {
        onEvent(e) { if (e.event.type === "titleChanged") observed[n]!.push(e.event.title); },
        onResync(_snapshot, replayed) {
          repairs++;
          for (const e of replayed) if (e.event.type === "titleChanged") observed[n]!.push(e.event.title);
        },
      });
      // Establish a real positive business cursor; cursor0 means an explicit
      // initial snapshot in this API, not retained event history.
      for (const id of ids) await o.client.call({type: "session.rename", payload: {sessionId: id, title: "before-outage"}});
      await t.tools.waitUntil(() => observed.every(events => events.includes("before-outage")), 5000);
      observed.forEach(events => { events.length = 0; });
      const connections = link.connections(); link.block();
      for (let n = 0; n < 6; n++) for (let s = 0; s < 2; s++) {
        await o.client.call({ type: "session.rename", payload: { sessionId: ids[s]!, title: s + ":" + n } });
      }
      t.assertions.assert(observed.every(a => a.length === 0), "events bypassed blocked path");
      link.unblock();
      await t.tools.waitUntil(() => observed.every(a => a.length >= 6), 15000);
      for (let s = 0; s < 2; s++) t.assertions.assert(JSON.stringify(observed[s]) === JSON.stringify(Array.from({ length: 6 }, (_, n) => s + ":" + n)), "subscription contents crossed, duplicated or reordered");
      t.assertions.assert(repairs > 0 && link.connections() > connections, "business did not rebuild on a new physical connection");
      await peer.unsubscribe(ids[0]!);
      await o.client.call({ type: "session.rename", payload: { sessionId: ids[0]!, title: "forbidden-after-unsubscribe" } });
      await o.client.call({ type: "session.rename", payload: { sessionId: ids[1]!, title: "survivor" } });
      await t.tools.waitUntil(() => observed[1]!.includes("survivor"), 5000);
      await new Promise(r => setTimeout(r, 1000));
      t.assertions.assert(observed[0]!.length === 6 && observed[1]!.length === 7, "unsubscribe affected another subscription or leaked events");
    } finally { peer?.close(); await link.stop(); }
  });
});

defineSpecialty(meta("distinct-replies-under-loss", "Concurrent reads preserve response ownership and business can explicitly refresh after loss",
  "Successful snapshots belong to their original requests; interrupted calls report unknown without hidden replay; explicit new reads recover all twelve distinct snapshots"), async t => {
  await withWorkspace(t, async o => {
    const ids: string[] = [];
    for (let n = 0; n < 12; n++) {
      const id = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
      await o.client.call({ type: "session.rename", payload: { sessionId: id, title: "owner-" + n } }); ids.push(id);
    }
    const link = await startFaultLink(daemonEndpoint(o.daemon).url);
    let peer: Client | undefined;
    try {
      peer = await connect(t, o, link);
      const oldId = peer.logicalConnectionId;
      link.cutAfterServerBytes(256);
      const replies = await Promise.allSettled(ids.map(id => peer!.call({ type: "session.get", payload: { sessionId: id } })));
      t.assertions.assert(link.injectedCuts() === 1 && replies.some(r => r.status === "rejected"), "reads did not encounter the armed loss");
      for (const [n, r] of replies.entries()) {
        if (r.status === "fulfilled") t.assertions.assert(r.value?.type === "snapshot" && r.value.data.summary.id === ids[n] && r.value.data.summary.title === "owner-" + n, "response crossed request ownership");
        else t.assertions.assert(r.reason instanceof Error && r.reason.name === "ConnectionOutcomeUnknownError", "interrupted read was hidden or misclassified");
      }
      await t.tools.waitUntil(() => peer!.connectionState === "ready" && peer!.logicalConnectionId !== oldId, 15000);
      for (const [n, id] of ids.entries()) {
        const r = await peer.call({ type: "session.get", payload: { sessionId: id } });
        t.assertions.assert(r?.type === "snapshot" && r.data.summary.id === id && r.data.summary.title === "owner-" + n, "explicit refresh returned another session");
      }
    } finally { peer?.close(); await link.stop(); }
  });
});

for (const direction of ["client", "server", "both"] as const) {
  defineSpecialty(meta("blackhole-" + direction, "A silent " + direction + " outage ends the old endpoint without source replay",
    "Channel liveness detects a real silent stall; incomplete output fails explicitly, any completed output is exact, source starts once, independent control stays usable and a new connection recovers", 30000), async t => {
    await withWorkspace(t, async o => {
      const link = await startFaultLink(daemonEndpoint(o.daemon).url);
      let peer: Client | undefined;
      try {
        peer = await connect(t, o, link);
        const operation = t.flows.main.startShell(peer, { workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 35000,
          argv: ["python3", "-c", "import pathlib,time; pathlib.Path('blackhole-start').open('a').write('one\\n'); [(print(i,flush=True),time.sleep(.25)) for i in range(32)]"] });
        await t.tools.waitUntil(() => existsSync(join(o.workspaceRoot, "blackhole-start")), 8000);
        const oldId = peer.logicalConnectionId;
        link.blackhole(direction);
        const read = peer.call({ type: "workspace.list" }); void read.catch(() => {});
        await t.tools.waitUntil(() => direction === "server" ? link.heldBytes().server > 0 : link.heldBytes().client > 0, 5000);
        t.assertions.assert((await o.client.call({ type: "workspace.list" }))?.type === "workspaces", "independent connection was also unavailable");
        await new Promise(r => setTimeout(r, 20000));
        t.assertions.assert(await read.then(() => false, () => true), "a request lost in the silent outage was transparently replayed");
        const result = await operation.result.then(value => ({value}), () => ({value: null}));
        if (result.value) t.assertions.assert(direction === "client" && t.flows.main.shellText(result.value.frames, "stdout") === Array.from({ length: 32 }, (_, i) => i + "\n").join("") && t.flows.main.shellExit(result.value.frames)?.code === 0, "an incomplete response was called successful");
        t.assertions.assert(readFileSync(join(o.workspaceRoot, "blackhole-start"), "utf8") === "one\n", "silent outage repeated the source");
        link.clearBlackhole();
        await t.tools.waitUntil(() => peer!.connectionState === "ready" && peer!.logicalConnectionId !== oldId, 20000);
        t.assertions.assert((await peer.call({ type: "workspace.list" }))?.type === "workspaces", "business cannot use the new connection");
      } finally { peer?.close(); await link.stop(); }
    });
  });
}

defineSpecialty(meta("cancel-process-tree", "Cancelling an active shell retires its subprocess tree without killing a control command",
  "Real shell and child PIDs are captured with procfs birth identities before RESET; both retire, their delayed disk effect stays absent and an uncancelled peer completes", 20000), async t => {
  if (process.platform !== "linux") throw new BlockedError("process birth oracle requires Linux");
  await withWorkspace(t, async o => {
    const peer = await connect(t, o);
    const births = new Map<number, string>();
    const birth = (pid: number) => {
      try { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" "); return f[0] === "Z" ? "" : f[19]!; } catch { return ""; }
    };
    const stream = peer.openShellStream({ workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 25000,
      argv: ["python3", "-c", "import os,pathlib,subprocess,time; c=subprocess.Popen(['python3','-c',\"import time,pathlib; time.sleep(8); pathlib.Path('tree-effect').write_text('bad')\"]); pathlib.Path('tree-pids').write_text(str(os.getpid())+' '+str(c.pid)); time.sleep(20)"] });
    void stream.done.catch(() => {});
    try {
      await stream.finish(); await stream.responseHead;
      await t.tools.waitUntil(() => existsSync(join(o.workspaceRoot, "tree-pids")), 8000);
      for (const pid of readFileSync(join(o.workspaceRoot, "tree-pids"), "utf8").split(" ").map(Number)) { const b = birth(pid); t.assertions.assert(!!b, "process exited before RESET"); births.set(pid, b); }
      const control = t.flows.main.startShell(peer, { workspaceId: o.workspaceId, cwd: o.workspaceRoot, timeoutMs: 15000, argv: ["python3", "-c", "import time,pathlib; time.sleep(2); pathlib.Path('tree-control').write_text('kept')"] });
      stream.reset(1);
      await t.tools.waitUntil(() => [...births].every(([pid, b]) => birth(pid) !== b), 5000);
      const result = await control.result;
      t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0 && readFileSync(join(o.workspaceRoot, "tree-control"), "utf8") === "kept", "cancel affected independent command");
      await new Promise(r => setTimeout(r, 8500));
      t.assertions.assert(!existsSync(join(o.workspaceRoot, "tree-effect")), "cancelled descendant performed a delayed mutation");
    } finally { stream.reset(1); peer.close(); }
  });
});
