import { defineSpecialty, readControlledAgentJournal } from "../../framework/public.ts";
import { openScaleFleet } from "../../framework/flows/branches/scale-fleet.ts";

defineSpecialty({
  id: "specialty.fabric-pool.session-burst-100",
  title: "100 sessions subscribe and start in one burst on a single node without detaching the peer",
  oracle: "One node hosts 100 sessions; all 100 full subscriptions open in one burst, all 100 prompts start together through a 5Mbps/200ms link, every completion arrives exactly once, each source task answers exactly once, and neither the peer ingress overflow path nor a physical carrier replacement is used",
  catches: [
    "a normal upload-sized burst trips the peer ingress overflow path",
    "the receive queue is smaller than one legitimate stream window",
    "a burst replaces the logical owner or opens another physical carrier",
    "one session's events are dropped to protect the others",
  ],
  tags: ["fabric-pool", "session-burst", "ingress", "receive-path"],
  llm: { default: "none" },
  expectedDurationMs: 120_000,
  timeoutMs: 300_000,
  resources: { environments: 1, cpu: 8, memoryMb: 12_288, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["daemon", "relay", "workbench-client", "agent-sdk", "tcp"],
  productInterfaces: ["@genehub/workbench/client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  retention: true,
}, async t => {
  const fleet = await openScaleFleet(t, 1, 100, false, {
    nodeChannels: 2,
    dataChannels: 1,
    nativeLog: "warn,diagnostic=debug",
  });
  const node = fleet.nodes[0]!;
  try {
    const owner = node.control.logicalConnectionId;
    const before = fleet.link.stats();
    const seen = new Set<string>();
    let liveCompletions = 0;
    let resyncCompletions = 0;
    let resyncs = 0;

    // One burst: every subscription opens before the link is shaped.
    await Promise.all(node.sessions.map((id, index) => node.dataClients[index % node.dataClients.length]!.subscribe(id, {
      onEvent(event) {
        if (event.event.type === "turnCompleted" && !seen.has(id)) {
          seen.add(id);
          liveCompletions++;
        }
      },
      onResync(snapshot, replayed) {
        resyncs++;
        const summary = (snapshot as { summary?: { status?: string; latestReply?: unknown } }).summary;
        if (!seen.has(id) && ((summary?.status === "idle" && summary.latestReply) || replayed.some(event => event.event.type === "turnCompleted"))) {
          seen.add(id);
          resyncCompletions++;
        }
      },
    })));

    fleet.link.setProfile({ bandwidthMbps: 5, rttMs: 200 });
    const started = performance.now();
    const prompts = await Promise.allSettled(node.sessions.map(id =>
      t.flows.main.sendPrompt(node.control, id, "Emit the deterministic 200-chunk reply.")));
    const startedMs = Math.round(performance.now() - started);
    const rejected = prompts.filter(result => result.status === "rejected").length;

    await t.tools.waitUntil(() => seen.size === node.sessions.length, 120_000).catch(() => undefined);
    const elapsedMs = Math.round(performance.now() - started);
    const after = fleet.link.stats();

    const support = await node.control.call({ type: "diagnostics.snapshot" });
    const ingress = support?.type === "diagnostics"
      ? support.data.events.filter(event => event.operation === "peer.ingress")
      : [];
    const answered = readControlledAgentJournal(node.agent).filter(entry => entry.event === "answered").length;

    t.note(JSON.stringify({
      phase: "burst-100",
      sessions: node.sessions.length,
      subscriptions: seen.size,
      liveCompletions,
      resyncCompletions,
      resyncs,
      rejectedPrompts: rejected,
      startedMs,
      elapsedMs,
      answered,
      peerIngress: ingress,
      acceptedBefore: before.accepted,
      acceptedAfter: after.accepted,
      peakQueuedBytes: after.peakQueuedBytes,
    }));

    t.assertions.assert(rejected === 0, `the burst rejected ${rejected} prompts before they reached the daemon`);
    t.assertions.assert(seen.size === node.sessions.length,
      `only ${seen.size}/${node.sessions.length} sessions surfaced their completion (live ${liveCompletions}, resync ${resyncCompletions})`);
    t.assertions.assert(answered === node.sessions.length,
      `the agent answered ${answered}/${node.sessions.length} sessions; a burst must not drop work`);
    t.assertions.assert(!ingress.some(event => event.code?.endsWith("full")),
      `the burst tripped the peer ingress overflow path: ${JSON.stringify(ingress)}`);
    t.assertions.assert(node.control.logicalConnectionId === owner,
      "the burst replaced the logical owner");
    t.assertions.assert(after.accepted === before.accepted,
      `the burst opened a new physical carrier (${before.accepted} -> ${after.accepted})`);
  } finally {
    await fleet.dispose();
  }
});
