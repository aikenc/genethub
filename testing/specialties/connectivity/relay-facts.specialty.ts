import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectProductClient, defineSpecialty, startRelay } from "../../framework/public.ts";

for (const scenario of ["two-device-preview", "restart"] as const) defineSpecialty({
  id: `specialty.connectivity.relay-${scenario}`,
  title: scenario === "restart" ? "Paired credentials work again after the real relay restarts" : "Two paired clients preview the same workspace-relative file through relay",
  oracle: scenario === "restart" ? "Remote access goes offline then recovers automatically; credentials minted before the outage still read workspace.list" : "Two independent relay clients receive exact Unicode file bytes and markdown metadata for one root handle",
  catches: ["retiring Vitest e2e drops a unique relay fact", "daemon needs manual remote reattachment", "preview depends on one browser's local filesystem"],
  tags: ["core", "contract", "connectivity", "refactor-relay-facts"],
  llm: { default: "none" }, requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 20000, timeoutMs: 120000,
  productInterfaces: ["@genehub/workbench/client", "device.remoteAttach", "preview"],
  surfaces: ["relay", "daemon", "workspace-filesystem"],
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  const clients: Awaited<ReturnType<typeof connectProductClient>>[] = [];
  try {
    relay = await startRelay({ openRoot: t.openRoot });
    const attached = await o.client.call({ type: "device.remoteAttach", payload: { relayUrl: relay.origin, joinToken: relay.joinToken } });
    if (attached?.type !== "remoteAccess" || !attached.data.rendezvousUrl) throw new Error("remoteAttach failed");
    const url = attached.data.rendezvousUrl;
    await t.tools.waitUntil(async () => { const d = await o.client.call({ type: "device.list" }); return d?.type === "devices" && d.data.remote.online; }, 20000);
    const paired = await t.flows.main.pairDevice(o.client, o.daemon, [], "portable-preview");
    paired.client.close();
    const first = await connectProductClient({ url, credential: paired.credential }); clients.push(first);
    if (scenario === "restart") {
      const port = Number(new URL(relay.origin).port), joinToken = relay.joinToken;
      const stopped = new Promise<void>(resolve => relay!.process.once("close", () => resolve()));
      relay.stop(); await stopped;
      await t.tools.waitUntil(async () => { const d = await o.client.call({ type: "device.list" }); return d?.type === "devices" && !d.data.remote.online; }, 20000);
      first.close();
      relay = await startRelay({ openRoot: t.openRoot, port, joinToken });
      await t.tools.waitUntil(async () => { const d = await o.client.call({ type: "device.list" }); return d?.type === "devices" && d.data.remote.online; }, 30000);
      const returning = await connectProductClient({ url, credential: paired.credential }); clients.push(returning);
      t.assertions.assert((await returning.call({ type: "workspace.list" }))?.type === "workspaces", "a pre-outage credential cannot use the restored relay");
    } else {
      const relative = "docs/preview.md", source = "# Portable preview\n\n来自 daemon 文件系统。🌱\n";
      mkdirSync(join(o.workspaceRoot, "docs"), { recursive: true }); writeFileSync(join(o.workspaceRoot, relative), source);
      const list = await first.call({ type: "workspace.list" });
      if (list?.type !== "workspaces") throw new Error("workspace list failed");
      const workspace = list.data.find(w => w.id === o.workspaceId);
      if (!workspace?.folders[0]) throw new Error("preview workspace root absent");
      const secondPair = await t.flows.main.pairDevice(o.client, o.daemon, [], "second-preview"); secondPair.client.close();
      const second = await connectProductClient({ url, credential: secondPair.credential }); clients.push(second);
      const locator = `${workspace.folders[0].rootHandle}/${relative}`;
      const previews = await Promise.all([first.preview(workspace.id, locator), second.preview(workspace.id, locator)]);
      for (const preview of previews) t.assertions.assert(preview.metadata.kind === "markdown" && new TextDecoder().decode(preview.bytes) === source, "relay preview changed bytes or file kind");
    }
  } finally { clients.forEach(c => c.close()); relay?.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
