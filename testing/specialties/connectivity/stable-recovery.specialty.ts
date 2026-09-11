import { connectProductClient, daemonEndpoint, defineSpecialty, startFaultLink } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.connectivity.stable-recovery-resets-backoff",
  title: "Stable service between network cuts resets recovery backoff",
  oracle: "Three actual TCP cuts separated by 31 seconds of healthy public RPC retain the owner and each start at the initial retry budget",
  catches: ["successful resume never resets failure backoff"],
  tags: ["core", "network-risk-v2", "merge-risk", "stable-recovery"], llm: { default: "none" },
  expectedDurationMs: 105000, timeoutMs: 160000, surfaces: ["daemon", "workbench-client", "tcp"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const link = await startFaultLink(daemonEndpoint(opened.daemon).url);
  const retries: number[] = [];
  const input = () => { const fresh = daemonEndpoint(opened.daemon); return { ...fresh, url: link.urlFor(fresh.url) }; };
  const client = await connectProductClient({ ...input(), redial: async () => input(),
    onDiagnostic(e) { if (e.kind === "connection" && e.detail.phase === "retry-scheduled") retries.push(Number(e.detail.attempt)); } });
  try {
    const owner = client.logicalConnectionId;
    for (let n = 0; n < 3; n++) {
      const until = Date.now() + 31000;
      while (Date.now() < until) {
        t.assertions.assert((await client.call({ type: "workspace.list" }))?.type === "workspaces", "stable interval lost business access");
        await new Promise(r => setTimeout(r, 500));
      }
      retries.length = 0; const connections = link.connections(); const start = performance.now(); link.cut();
      await t.tools.waitUntil(() => link.connections() > connections && client.connectionState === "ready", 10000);
      t.assertions.assert(retries.length === 1 && retries[0] === 0, "healthy interval retained failure backoff: " + retries);
      t.assertions.assert(performance.now() - start < 2500, "stable peer waited an escalated recovery delay");
      t.assertions.assert(client.logicalConnectionId === owner, "recovery replaced original owner");
    }
  } finally { client.close(); await link.stop(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
