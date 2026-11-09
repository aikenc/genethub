import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonEndpoint, defineSpecialty, observeFileOpens } from "../../framework/public.ts";

for (const mode of ["idle-receipts", "project-descriptors"] as const) {
  defineSpecialty({
    id: `specialty.daemon.catalog-io.${mode}`,
    title: mode === "idle-receipts" ? "Idle resident history does not probe absent update receipts" : "Repeated project queries reuse unchanged descriptors",
    oracle: "An OS tracer on the real host observes a public-create beacon, then no repeated idle continuation or unchanged descriptor opens; external edit convergence is independently covered by cached-catalog.background-reconciliation",
    catches: ["250ms receipt polling scales with idle history", "workspace.list reopens every unchanged descriptor"],
    tags: ["core", "cached-catalog", "filesystem"], llm: { default: "none" },
    requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
    requirements: [{ kind: "command", env: "GENEHUB_STRACE", args: ["-V"], contains: "strace" }],
    resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
    surfaces: ["daemon", "filesystem"], productInterfaces: ["session.create", "session.get", "workspace.open", "workspace.list"],
    expectedDurationMs: 15000, timeoutMs: 90000,
  }, async t => {
    const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let observer: Awaited<ReturnType<typeof observeFileOpens>> | undefined;
    try {
      const ids: string[] = [], descriptors: string[] = [];
      if (mode === "idle-receipts") {
        // Upgraded installations have this directory even when no Session is
        // awaiting an update. Observe path checks as well as actual opens.
        mkdirSync(join(t.env.data, "updates", "sessions"), { recursive: true });
        for (let n = 0; n < 96; n++) {
          const id = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
          ids.push(id);
          const snapshot = await o.client.call({ type: "session.get", payload: { sessionId: id } });
          t.assertions.assert(snapshot?.type === "snapshot", "idle session did not become readable");
        }
      } else {
        for (let n = 0; n < 32; n++) {
          const root = join(t.env.root, `descriptor-${n}`); mkdirSync(root);
          descriptors.push(root);
          writeFileSync(join(root, "agent-space.genet.json"), JSON.stringify({ name: `Descriptor ${n}` }));
          const opened = await o.client.call({ type: "workspace.open", payload: { root } });
          t.assertions.assert(opened?.type === "workspace", "descriptor project did not open");
        }
        await o.client.call({ type: "workspace.list" });
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      observer = await observeFileOpens(process.env.GENEHUB_STRACE!, daemonEndpoint(o.daemon).localServerProof.pid, join(t.env.root, "file-opens.trace"), mode === "idle-receipts" ? "%file" : "openat");
      // A real public mutation proves the observer is attached to the correct host.
      const beacon = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
      const end = Date.now() + 5000; let reads = 0;
      while (Date.now() < end) {
        if (mode === "project-descriptors") {
          const reply = await o.client.call({ type: "workspace.list" });
          t.assertions.assert(reply?.type === "workspaces" && descriptors.every(root => reply.data.some(w => w.root === root)), "cached project query lost a registered project");
          reads++;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await observer.stop();
      const lines = observer.lines();
      t.assertions.assert(lines.some(line => line.includes(beacon)), "file-open observer did not see the public-create beacon");
      const probes = lines.filter(line => mode === "idle-receipts"
        ? line.includes("update") && ids.some(id => line.includes(id))
        : line.includes("agent-space.genet.json") && descriptors.some(root => line.includes(root)));
      t.note(JSON.stringify({ mode, idleSessions: ids.length, registeredDescriptors: descriptors.length, reads, observedOpens: lines.length, redundantOpens: probes.length, observerBeacon: true }));
      t.assertions.assert(probes.length === 0, `${mode} made ${probes.length} redundant file accesses in 5s`);
    } finally { await observer?.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
  });
}
