import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

for (const scenario of ["background", "timeout", "abort"] as const) defineSpecialty({
  id: `specialty.agent.bash-lifecycle.${scenario}`,
  title: `Real guest bash ${scenario} preserves output and process ownership`,
  oracle: scenario === "background"
    ? "A shell finishes while its child holds stdout; the live child remains attributable to the session and can be killed through process.kill"
    : "Timeout or user interrupt stops the real shell tree and preserves its earlier output on the public tool card",
  catches: ["tool waits forever for a background pipe", "normal shell exit kills the background service", "timeout/abort discards produced output", "cancellation leaves a shell descendant alive"],
  tags: ["core", "agent", "session", "processes", "bash-lifecycle"],
  llm: { default: "mock" }, expectedDurationMs: 15_000, timeoutMs: 75_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0 },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["agent", "daemon", "os-process", "workbench-client"],
  productInterfaces: ["session.send", "session.get", "session.interrupt", "round.trunk.list", "round.trunk.get", "blob.get", "process.list", "process.kill"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let sessionId = "", pid = 0;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const command = scenario === "background"
      ? "sleep 60 & echo $! > bash-child.pid; printf BG_READY"
      : "sleep 60 & echo $! > bash-child.pid; printf PARTIAL_OUTPUT; echo ready > bash-ready; wait";
    opened.mock.script({ tool: { name: "bash", arguments: { command, ...(scenario === "timeout" ? { timeout: 1 } : {}) } } }, { text: "Tool result received." });
    sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    await t.flows.main.sendPrompt(opened.client, sessionId, `Check bash ${scenario}.`);
    const pidFile = path.join(opened.workspaceRoot, "bash-child.pid");
    await t.tools.waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, 15_000);
    pid = Number(readFileSync(pidFile, "utf8").trim());
    t.assertions.assert(Number.isSafeInteger(pid) && pid > 1, "shell did not start a real child");
    if (scenario === "abort") {
      await t.tools.waitUntil(() => existsSync(path.join(opened.workspaceRoot, "bash-ready")), 5_000);
      await opened.client.call({ type: "session.interrupt", payload: { sessionId } });
    }
    await t.tools.waitUntil(() => events.some(event => event.type === (scenario === "abort" ? "turnCanceled" : "turnCompleted")), 15_000);
    const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId, recentRounds: 1 } });
    t.assertions.assert(snapshot?.type === "snapshot", "tool card snapshot missing");
    const roundId = snapshot?.type === "snapshot" ? snapshot.data.rounds?.at(-1)?.roundId : undefined;
    t.assertions.assert(Boolean(roundId), "completed round locator missing");
    const layer = await opened.client.call({ type: "round.trunk.list", payload: { sessionId, roundId: roundId!, cursor: null, limit: 20 } });
    t.assertions.assert(layer?.type === "roundLayer", "tool card round layer missing");
    const outputs: string[] = [];
    if (layer?.type === "roundLayer") for (const summary of layer.data.trunks) {
      const trunk = await opened.client.call({ type: "round.trunk.get", payload: { sessionId, roundId: roundId!, trunkIndex: summary.index } });
      t.assertions.assert(trunk?.type === "roundTrunk", "tool trunk missing");
      if (trunk?.type !== "roundTrunk") continue;
      for (const row of trunk.data.batches.flatMap(batch => batch.blobs)) if (row.kind === "toolCall" && row.blob) {
        const blob = await opened.client.call({ type: "blob.get", payload: { sessionId, blob: row.blob } });
        t.assertions.assert(blob?.type === "blob", "public tool content missing");
        const value = blob?.type === "blob" ? blob.data.value as { detail?: { output?: string } } : undefined;
        if (typeof value?.detail?.output === "string") outputs.push(value.detail.output);
      }
    }
    t.assertions.assert(outputs.some(output => output.includes(scenario === "background" ? "BG_READY" : "PARTIAL_OUTPUT")), "produced output missing from the public tool result: " + JSON.stringify(outputs));
    if (scenario === "background") {
      t.assertions.assert(t.flows.branches.processAlive(pid), "normal completion killed the background child");
      const processes = await opened.client.call({ type: "process.list" });
      t.assertions.assert(processes?.type === "processes" && processes.data.some(process => process.pid === pid && process.sessionId === sessionId), "background child escaped session attribution");
      await opened.client.call({ type: "process.kill", payload: { sessionId, pid } });
    }
    await t.tools.waitUntil(() => !t.flows.branches.processAlive(pid), 5_000);
    if (scenario === "timeout") {
      t.assertions.assert(outputs.some(output => output.includes("Command timed out")), "timeout was reported as success");
      t.assertions.assert(JSON.stringify(opened.mock.requests.slice(1)).includes("PARTIAL_OUTPUT"), "the next model call lost partial command output");
    }
  } finally {
    if (pid && sessionId && t.flows.branches.processAlive(pid)) await opened.client.call({ type: "process.kill", payload: { sessionId, pid } }).catch(() => {});
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
