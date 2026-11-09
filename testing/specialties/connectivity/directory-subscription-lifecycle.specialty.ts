import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { MachineConnections, MachineSummaryDirectory, type Target, type WebSocketLike } from "@genehub/workbench/client";
import { allocatePort, createLease, daemonEndpoint, defineSpecialty, releaseLease, type CaseContext } from "../../framework/public.ts";

type Node = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

async function openNodes(t: CaseContext, count: number, prefix: string): Promise<{ nodes: Node[]; extra: ReturnType<typeof createLease>[] }> {
  const extra = Array.from({ length: count - 1 }, () => createLease(prefix));
  const nodes: Node[] = [];
  try {
    for (const lease of [t.env, ...extra]) nodes.push(await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease }));
  } catch (error) {
    await closeNodes(nodes, extra);
    throw error;
  }
  return { nodes, extra };
}

async function closeNodes(nodes: Node[], extra: ReturnType<typeof createLease>[]): Promise<void> {
  for (const node of nodes) { node.client.close(); node.daemon.stop(); await node.mock.stop(); }
  extra.forEach(releaseLease);
}

const targetsOf = (nodes: Node[]): Target[] => nodes.map((n, i) => ({ id: String(i), deviceHandle: n.client.identity!.machineId, label: `Source ${i}`, kind: "remote", online: true }));

defineSpecialty({
  id: "specialty.connectivity.directory-subscription-outlives-idle-lease",
  title: "A visible source keeps its directory subscription after the read lease goes idle",
  oracle: "One real daemon is read once through the public directory with a 200 ms idle budget; after five idle periods a session created by an independent real client reaches the directory by push, with no second refresh, no closed directory socket and no cached or refreshing row",
  catches: ["idle expiry closes a live directory subscription", "a retired subscription is presented as refreshing"],
  tags: ["machine-connections", "connectivity", "team-summary"], llm: { default: "none" },
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  expectedDurationMs: 15000, timeoutMs: 60000,
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "workbench-client", "tcp"],
  productInterfaces: ["@genehub/workbench/client MachineConnections", "@genehub/workbench/client MachineSummaryDirectory", "catalog.sync"],
}, async t => {
  const { nodes, extra } = await openNodes(t, 1, "idle-subscription-");
  let pool: MachineConnections | undefined, directory: MachineSummaryDirectory | undefined;
  try {
    const targets = targetsOf(nodes);
    let closes = 0;
    pool = new MachineConnections({ targets: async () => targets, openTarget: async () => ({ ...daemonEndpoint(nodes[0]!.daemon), via: "loopback", label: "Source 0" }) }, {
      idleMs: 200,
      socketFactory: url => { const ws = new WebSocket(url); ws.once("close", () => closes++); return ws as unknown as WebSocketLike; },
    });
    directory = new MachineSummaryDirectory(pool);
    const first = await directory.refresh();
    t.assertions.assert(first.sources[0]?.state === "ready" && !first.sources[0].cached, "initial directory read did not confirm the source");
    await new Promise(resolve => setTimeout(resolve, 1000));
    const created = await t.flows.main.createBuiltinSession(nodes[0]!.client, nodes[0]!.workspaceId);
    let pushed = false;
    try { await t.tools.waitUntil(() => Boolean(directory!.value.sources[0]?.sessions.some(s => s.id === created)), 5000); pushed = true; } catch { pushed = false; }
    const row = directory.value.sources[0]!;
    t.note(JSON.stringify({ idleMs: 200, waitedMs: 1000, closes, pushed, cached: Boolean(row.cached), refreshing: Boolean(row.refreshing), state: row.state }));
    t.assertions.assert(closes === 0, "idle expiry closed the live directory subscription");
    t.assertions.assert(pushed && !row.cached && !row.refreshing, "a session created after the idle period did not reach the directory by push");
  } finally {
    directory?.close(); pool?.close(); await closeNodes(nodes, extra);
  }
});

defineSpecialty({
  id: "specialty.connectivity.retired-directory-page-recovery",
  title: "Opening an evicted project's page repairs its catalog owner",
  oracle: "Two real daemon sources and a one-client budget retire the first source; while retired it is shown as the last state rather than refreshing. A real project rename advances the daemon's catalog; the public workspacePage must then succeed once, within three seconds, without a separate refresh",
  catches: ["new page client has no catalog subscription", "old directory revision makes successful RPCs look unusable", "a retired subscription is presented as refreshing"],
  tags: ["machine-policy-audit", "connectivity", "team-summary"], llm: { default: "none" },
  resources: { environments: 1, cpu: 4, memoryMb: 4096, io: 1, browser: 0 },
  expectedDurationMs: 20000, timeoutMs: 90000,
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "workbench-client", "tcp"],
  productInterfaces: ["@genehub/workbench/client MachineSummaryDirectory.workspacePage", "catalog.sync", "session.page"],
}, async t => {
  const { nodes, extra } = await openNodes(t, 2, "retired-page-");
  let pool: MachineConnections | undefined, directory: MachineSummaryDirectory | undefined;
  let stopCatalog = () => {};
  try {
    for (const node of nodes) await t.flows.main.createBuiltinSession(node.client, node.workspaceId);
    const targets = targetsOf(nodes);
    let closes = 0;
    pool = new MachineConnections({ targets: async () => targets, openTarget: async id => ({ ...daemonEndpoint(nodes[Number(id)]!.daemon), via: "loopback", label: id }) }, {
      limit: 1,
      socketFactory: url => { const ws = new WebSocket(url); ws.once("close", () => closes++); return ws as unknown as WebSocketLike; },
    });
    directory = new MachineSummaryDirectory(pool);
    await directory.refresh();
    await t.tools.waitUntil(() => closes > 0, 3000);
    const before = directory.value.sources[0]!;
    t.assertions.assert(before.cached === true && before.state === "ready", "capacity retirement precondition missing");
    const retiredRefreshing = Boolean(before.refreshing);
    const oldRevision = before.catalogRevision!;
    const added = await t.flows.main.createBuiltinSession(nodes[0]!.client, nodes[0]!.workspaceId);
    await nodes[0]!.client.call({ type: "workspace.rename", payload: { workspaceId: nodes[0]!.workspaceId, name: "Renamed while directory retired" } });
    let daemonRevision = oldRevision;
    const catalog = nodes[0]!.client.followCatalog({ known: () => ({ sessions: [], workspaces: [] }), onUnavailable: () => {}, onBatch: b => { daemonRevision = b.revision; } });
    stopCatalog = catalog.stop; await catalog.ready;
    t.assertions.assert(daemonRevision > oldRevision, "real daemon catalog did not advance");
    const started = performance.now();
    let directError: string | null = null, directSuccess = false;
    try { const page = await directory.workspacePage(targets[0]!, nodes[0]!.workspaceId); directSuccess = page.sessions.some(s => s.id === added); }
    catch (error) { directError = error instanceof Error ? error.message : String(error); }
    const directMs = Math.round(performance.now() - started);
    t.note(JSON.stringify({ oldRevision, daemonRevision, closes, retiredRefreshing, directMs, directSuccess, directError }));
    t.assertions.assert(!retiredRefreshing, "a retired source was presented as refreshing although no request was in progress");
    t.assertions.assert(directSuccess && directMs < 3000, "direct project paging did not restore its directory subscription");
  } finally {
    stopCatalog(); directory?.close(); pool?.close(); await closeNodes(nodes, extra);
  }
});

defineSpecialty({
  id: "specialty.connectivity.directory-confirmation-before-history",
  title: "A source is confirmed when its catalog snapshot completes, not after every project preview",
  oracle: "One real daemon with twelve opened projects is forced to resynchronise; when the directory first republishes the source as current, fewer than twelve project-preview pages have finished; all twelve previews are still repaired afterwards",
  catches: ["source confirmation waits for sequential history previews", "decoupling confirmation drops project previews"],
  tags: ["connectivity", "team-summary"], llm: { default: "none" },
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  expectedDurationMs: 25000, timeoutMs: 90000,
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "workbench-client", "tcp"],
  productInterfaces: ["@genehub/workbench/client MachineSummaryDirectory", "catalog.sync", "session.page"],
}, async t => {
  const { nodes, extra } = await openNodes(t, 1, "confirm-history-");
  let pool: MachineConnections | undefined, directory: MachineSummaryDirectory | undefined, stop = () => {};
  try {
    const node = nodes[0]!, projects: string[] = [];
    for (let i = 0; i < 12; i++) {
      const root = join(t.env.root, "projects", `p${i}`); mkdirSync(root, { recursive: true });
      const opened = await node.client.call({ type: "workspace.open", payload: { root } });
      if (opened?.type !== "workspace") throw new Error("workspace.open failed");
      projects.push(opened.data.id);
      await t.flows.main.createBuiltinSession(node.client, opened.data.id);
    }
    const targets = targetsOf(nodes);
    let pages = 0;
    pool = new MachineConnections({ targets: async () => targets, openTarget: async () => ({ ...daemonEndpoint(node.daemon), via: "loopback", label: "Source 0" }) }, {
      onDiagnostic: e => { if (e.kind === "operation" && e.detail.operation === "session.page" && e.detail.phase === "finish") pages++; },
    });
    directory = new MachineSummaryDirectory(pool);
    await directory.refresh();
    for (const id of projects) await directory.workspacePage(targets[0]!, id);
    const baseline = pages;
    let resyncing = false, pagesAtConfirm: number | undefined;
    stop = directory.subscribe(value => {
      const row = value.sources[0];
      if (!row) return;
      if (row.cached) resyncing = true;
      else if (resyncing && pagesAtConfirm === undefined && !row.refreshing && (row.state === "ready" || row.state === "partial")) pagesAtConfirm = pages - baseline;
    });
    await directory.refresh(undefined, undefined, undefined, true);
    await t.tools.waitUntil(() => projects.every(id => directory!.value.sources[0]?.projectPages?.[id]) && pages - baseline >= projects.length, 20000);
    t.note(JSON.stringify({ projects: projects.length, resyncing, pagesAtConfirm, pagesAfter: pages - baseline }));
    t.assertions.assert(resyncing && pagesAtConfirm !== undefined, "forced resynchronisation was not observable");
    t.assertions.assert(pagesAtConfirm! < projects.length, "source confirmation waited for every project preview");
  } finally {
    stop(); directory?.close(); pool?.close(); await closeNodes(nodes, extra);
  }
});

defineSpecialty({
  id: "specialty.connectivity.background-refresh-keeps-live-subscriptions",
  title: "Periodic refresh does not rotate live subscriptions when sources exceed the budget",
  oracle: "Three real daemons share a two-client budget; after the first refresh reads every source once, two further background refreshes open no socket and close no live subscription, while the source that did not fit keeps its dated snapshot without claiming to refresh",
  catches: ["every refresh evicts a live subscription to read another source", "background rotation burns connection tickets", "a snapshot-only source claims to be refreshing"],
  tags: ["machine-connections", "connectivity", "team-summary"], llm: { default: "none" },
  resources: { environments: 1, cpu: 4, memoryMb: 4096, io: 1, browser: 0 },
  expectedDurationMs: 25000, timeoutMs: 90000,
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "workbench-client", "tcp"],
  productInterfaces: ["@genehub/workbench/client MachineConnections", "@genehub/workbench/client MachineSummaryDirectory", "catalog.sync"],
}, async t => {
  const { nodes, extra } = await openNodes(t, 3, "keep-live-");
  let pool: MachineConnections | undefined, directory: MachineSummaryDirectory | undefined;
  try {
    for (const node of nodes) await t.flows.main.createBuiltinSession(node.client, node.workspaceId);
    const targets = targetsOf(nodes);
    let opens = 0, closes = 0;
    pool = new MachineConnections({ targets: async () => targets, openTarget: async id => ({ ...daemonEndpoint(nodes[Number(id)]!.daemon), via: "loopback", label: id }) }, {
      limit: 2,
      socketFactory: url => { opens++; const ws = new WebSocket(url); ws.once("close", () => closes++); return ws as unknown as WebSocketLike; },
    });
    directory = new MachineSummaryDirectory(pool);
    const first = await directory.refresh();
    t.assertions.assert(first.sources.every(s => s.updatedAt !== null), "the first refresh did not read every source once");
    const opensAfterFirst = opens, closesAfterFirst = closes;
    await directory.refresh(); const last = await directory.refresh();
    const live = last.sources.filter(s => !s.cached), snapshot = last.sources.filter(s => s.cached);
    t.note(JSON.stringify({ opensAfterFirst, closesAfterFirst, opens, closes, sources: last.sources.map(s => ({ id: s.target.id, state: s.state, cached: Boolean(s.cached), refreshing: Boolean(s.refreshing) })) }));
    t.assertions.assert(opens === opensAfterFirst && closes === closesAfterFirst, "background refresh rotated live subscriptions");
    t.assertions.assert(live.length === 2 && snapshot.length === 1 && snapshot.every(s => !s.refreshing && s.updatedAt !== null), "over-budget source did not keep a dated, idle snapshot");
  } finally {
    directory?.close(); pool?.close(); await closeNodes(nodes, extra);
  }
});

defineSpecialty({
  id: "specialty.connectivity.preferred-source-survives-rotation",
  title: "The machine the user is looking at becomes live and stays live through background refreshes",
  oracle: "Three real daemons share a two-client budget; the source left as a snapshot is preferred, and the next background refresh makes it live. Two further background refreshes never close its socket, and a session created by an independent real client reaches it by push",
  catches: ["preferred source left as a stale snapshot", "background rotation evicts the source the user is looking at", "preferred source loses its live subscription"],
  tags: ["machine-connections", "connectivity", "team-summary"], llm: { default: "none" },
  resources: { environments: 1, cpu: 4, memoryMb: 4096, io: 1, browser: 0 },
  expectedDurationMs: 25000, timeoutMs: 90000,
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "workbench-client", "tcp"],
  productInterfaces: ["@genehub/workbench/client MachineConnections", "@genehub/workbench/client MachineSummaryDirectory", "catalog.sync"],
}, async t => {
  const { nodes, extra } = await openNodes(t, 3, "preferred-live-");
  let pool: MachineConnections | undefined, directory: MachineSummaryDirectory | undefined;
  try {
    const targets = targetsOf(nodes);
    const ports = nodes.map(n => new URL(daemonEndpoint(n.daemon).url).port);
    const closes = [0, 0, 0];
    pool = new MachineConnections({ targets: async () => targets, openTarget: async id => ({ ...daemonEndpoint(nodes[Number(id)]!.daemon), via: "loopback", label: id }) }, {
      limit: 2,
      socketFactory: url => { const ws = new WebSocket(url); const i = ports.indexOf(new URL(url).port); ws.once("close", () => { if (i >= 0) closes[i]!++; }); return ws as unknown as WebSocketLike; },
    });
    directory = new MachineSummaryDirectory(pool);
    const first = await directory.refresh();
    const chosen = first.sources.find(s => s.cached);
    t.assertions.assert(Boolean(chosen), "the budget did not leave one source as a snapshot");
    const id = chosen!.target.id, index = Number(id);
    directory.prefer([id]);
    await directory.refresh();
    const promoted = directory.value.sources.find(s => s.target.id === id)!;
    const closesAfterPromotion = closes[index]!;
    await directory.refresh(); await directory.refresh();
    const created = await t.flows.main.createBuiltinSession(nodes[index]!.client, nodes[index]!.workspaceId);
    let pushed = false;
    try { await t.tools.waitUntil(() => Boolean(directory!.value.sources.find(s => s.target.id === id)?.sessions.some(s => s.id === created)), 5000); pushed = true; } catch { pushed = false; }
    const row = directory.value.sources.find(s => s.target.id === id)!;
    t.note(JSON.stringify({ preferred: id, promoted: { state: promoted.state, cached: Boolean(promoted.cached) }, closes, closesAfterPromotion, pushed, final: { state: row.state, cached: Boolean(row.cached), refreshing: Boolean(row.refreshing) } }));
    t.assertions.assert(!promoted.cached && (promoted.state === "ready" || promoted.state === "partial"), "the preferred source stayed a snapshot after a background refresh");
    t.assertions.assert(closes[index] === closesAfterPromotion && !row.cached, "background refresh evicted the preferred source");
    t.assertions.assert(pushed, "the preferred source did not receive a pushed session");
  } finally {
    directory?.close(); pool?.close(); await closeNodes(nodes, extra);
  }
});

defineSpecialty({
  id: "specialty.connectivity.unreachable-source-backoff",
  title: "An unreachable source backs off without disturbing healthy subscriptions",
  oracle: "Two real daemons and one listed-online target whose port refuses connections; background refreshes after the first failed attempt do not dial the failing target again, never close a healthy subscription, and keep the failure state with its time; an explicit refresh retries it immediately",
  catches: ["failing source re-dialled on every refresh", "failed attempt displaces a healthy subscription", "explicit retry blocked by background backoff"],
  tags: ["machine-connections", "connectivity", "team-summary"], llm: { default: "none" },
  resources: { environments: 1, cpu: 4, memoryMb: 4096, io: 1, browser: 0 },
  expectedDurationMs: 25000, timeoutMs: 90000,
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "workbench-client", "tcp"],
  productInterfaces: ["@genehub/workbench/client MachineConnections", "@genehub/workbench/client MachineSummaryDirectory"],
}, async t => {
  const { nodes, extra } = await openNodes(t, 2, "unreachable-");
  let pool: MachineConnections | undefined, directory: MachineSummaryDirectory | undefined;
  try {
    const refused = await allocatePort();
    const targets = [...targetsOf(nodes), { id: "2", deviceHandle: "unreachable-machine", label: "Unreachable", kind: "remote", online: true } satisfies Target];
    let failingDials = 0, healthyCloses = 0;
    pool = new MachineConnections({ targets: async () => targets, openTarget: async id => {
      if (id === "2") { failingDials++; return { ...daemonEndpoint(nodes[0]!.daemon), url: `ws://127.0.0.1:${refused}/`, via: "loopback", label: id }; }
      return { ...daemonEndpoint(nodes[Number(id)]!.daemon), via: "loopback", label: id };
    } }, {
      timeoutMs: 1500,
      socketFactory: url => { const ws = new WebSocket(url); if (!url.includes(`:${refused}`)) ws.once("close", () => healthyCloses++); return ws as unknown as WebSocketLike; },
    });
    directory = new MachineSummaryDirectory(pool);
    await directory.refresh();
    const firstDials = failingDials;
    for (let i = 0; i < 2; i++) await directory.refresh();
    const failed = directory.value.sources.find(s => s.target.id === "2")!;
    const backgroundDials = failingDials;
    await directory.refresh(undefined, undefined, undefined, true);
    t.note(JSON.stringify({ firstDials, backgroundDials, afterExplicit: failingDials, healthyCloses, failedState: failed.state, failedRefreshing: Boolean(failed.refreshing), failedAt: failed.observedAt, healthy: directory.value.sources.filter(s => s.target.id !== "2").map(s => ({ state: s.state, cached: Boolean(s.cached) })) }));
    t.assertions.assert(["timeout", "unavailable"].includes(failed.state) && !failed.refreshing && failed.stateSource === "request", "unreachable source was not reported as a failure");
    t.assertions.assert(firstDials > 0 && backgroundDials === firstDials, "background refresh re-dialled an unreachable source within its backoff");
    t.assertions.assert(healthyCloses === 0 && directory.value.sources.filter(s => s.target.id !== "2").every(s => s.state === "ready" && !s.cached), "the failing source disturbed healthy subscriptions");
    t.assertions.assert(failingDials > backgroundDials, "an explicit refresh did not retry the failing source");
  } finally {
    directory?.close(); pool?.close(); await closeNodes(nodes, extra);
  }
});
