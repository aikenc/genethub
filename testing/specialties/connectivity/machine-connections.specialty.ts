import { WebSocket } from "ws";
import { MachineConnections, MachineSummaryDirectory, type Target, type WebSocketLike } from "@genehub/workbench/client";
import { defineSpecialty, daemonEndpoint, createLease, releaseLease } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.connectivity.shared-machine-connections",
  title: "Active view, directory and message operations reuse one machine client",
  oracle: "Real daemon identities and socket opens prove concurrent leases share a client, summary reads do not close its active lease, route aliases deduplicate, cancellation preserves other users, and directory removal clears cached authority",
  catches: ["duplicate handshake per consumer", "reader cancellation closes the active view", "route locator confused with machine identity", "revoked source cache survives directory removal"],
  tags: ["machine-connections", "connectivity"], llm: { default: "none" },
  expectedDurationMs: 20_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 3, memoryMb: 3072, io: 1 },
  surfaces: ["daemon", "workbench-client", "tcp"],
  productInterfaces: ["@genehub/workbench/client MachineConnections", "session.page", "workspace.list"],
}, async t => {
  const otherLease = createLease("shared-machine-");
  const a = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let b: typeof a | undefined;
  let pool: MachineConnections | undefined, directory: MachineSummaryDirectory | undefined;
  try {
    b = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: otherLease });
    const sessionA = await t.flows.main.createBuiltinSession(a.client, a.workspaceId);
    const sessionB = await t.flows.main.createBuiltinSession(b.client, b.workspaceId);
    let targets: Target[] = [a, b].map((node, i) => ({ id: `route-${i}`, deviceHandle: node.client.identity!.machineId,
      fingerprint: node.client.identity!.fingerprint, label: `Machine ${i}`, kind: "remote", online: true }));
    const original = targets.slice();
    let sockets = 0, live = 0, peak = 0, fullLists = 0;
    pool = new MachineConnections({ targets: async () => targets, openTarget: async id => ({ ...daemonEndpoint(id === "route-0" || id === "alias-0" ? a.daemon : b!.daemon), via: "loopback", label: id }) }, {
      limit: 2, idleMs: 250,
      socketFactory: url => {
        sockets++; live++; peak = Math.max(peak, live);
        const socket = new WebSocket(url); socket.once("close", () => { live--; });
        return socket as unknown as WebSocketLike;
      },
      onDiagnostic: event => { if (event.kind === "operation" && event.detail.operation === "session.list") fullLists++; },
    });
    const first = await pool.acquire(targets[0]!, { foreground: true });
    const [same, alias] = await Promise.all([pool.acquire(targets[0]!), pool.acquire({ ...targets[0]!, id: "alias-0" })]);
    t.assertions.assert(first.client === same.client && same.client === alias.client && sockets === 1, "same machine leases opened duplicate clients");
    same.release(); alias.release();
    const controller = new AbortController();
    const cancelled = pool.acquire(targets[0]!, { signal: controller.signal }); controller.abort();
    let cancellation = false; try { await cancelled; } catch { cancellation = true; }
    t.assertions.assert(cancellation && first.client.connectionState === "ready", "cancellation closed another consumer's lease");
    directory = new MachineSummaryDirectory({ targets: async () => targets, openTarget: async () => ({ ...daemonEndpoint(a.daemon), via: "loopback", label: "Machine A" }) }, { connections: pool });
    const result = await directory.refresh(() => {});
    t.assertions.assert(result.complete && result.sources.length === 2 && result.sources[0]!.sessions.some(s => s.id === sessionA) && result.sources[1]!.sessions.some(s => s.id === sessionB), "shared directory omitted source facts");
    t.assertions.assert(sockets === 2 && fullLists === 0 && peak <= 2, "summary opened duplicate clients or used full session.list");
    directory.close(); directory = undefined;
    const reply = await first.client.call({ type: "workspace.list" });
    t.assertions.assert(reply?.type === "workspaces", "closing directory closed the active machine");
    const borrower = await pool.acquire(original[1]!);
    borrower.release();
    t.assertions.assert(sockets === 2, "message consumer failed to reuse directory connection");
    let invalidated = 0;
    pool.onInvalidated(() => { invalidated++; });
    targets = [original[1]!];
    await pool.targets();
    t.assertions.assert(invalidated === 1 && first.client.connectionState === "closed", "removed authority retained an active connection");
    first.release(); first.release();
    await t.tools.waitUntil(() => live === 0, 10_000);
    t.note(JSON.stringify({ sockets, peak, fullLists, sourceSafe: true, cancelledReaderPreservedActive: true, removedAuthorityClosed: invalidated }));
  } finally {
    directory?.close(); pool?.close();
    for (const opened of [a, b]) if (opened) { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
    releaseLease(otherLease);
  }
});
