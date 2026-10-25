import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, parseJson, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.cli.daemon.identity-with-missing-pid",
  title: "Transient stalls and missing PID diagnostics retain authenticated control without trusting foreign listeners",
  oracle: "the real owner recovers after a brief scheduling stall; with its kernel lock held missing PID diagnostics do not hide it or start another; unsigned and unanswered foreign listeners grant no authority even if their port later closes; authenticated stop retires the original host",
  catches: ["brief scheduling stall reported as daemon down", "empty PID diagnostics strand a live daemon", "start adopts an unready instance", "foreign listener receives daemon authority", "unanswered then closed listener authorizes stopping an unverified PID"],
  tags: ["core", "genet-cli", "daemon-control"], llm: { default: "none" },
  expectedDurationMs: 10_000, timeoutMs: 90_000,
  surfaces: ["genet-cli", "daemon", "OS file lock"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const endpointFile = path.join(t.env.data, "endpoint.json");
  const original = readFileSync(endpointFile, "utf8");
  const endpoint = JSON.parse(original);
  const cli = (args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env);
  let healthRequests = 0;
  const foreign = createServer((_request, response) => { healthRequests++; response.end(JSON.stringify({
    pid: endpoint.pid, machineId: endpoint.machineId, fingerprint: endpoint.fingerprint, proof: "not-the-host-proof",
  })); });
  let replaced = false;
  try {
    if (process.platform === "linux") {
      const protectedPids = new Set([process.pid, Number(process.env.GENEHUB_AGENT_PID), Number(process.env.GENEHUB_HOST_PID)]);
      for (const start of [...protectedPids]) {
        let pid = start;
        while (pid > 1) {
          protectedPids.add(pid);
          try {
            pid = Number(/^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
          } catch { break; }
        }
      }
      t.assertions.assert(Number.isInteger(endpoint.pid) && endpoint.pid > 1 && !protectedPids.has(endpoint.pid),
        "fault injection must target only this isolated daemon");
      // A genuinely busy owner can accept TCP before its guest gets CPU.
      // Use the real daemon and OS scheduling, never synthesize its proof.
      process.kill(endpoint.pid, "SIGSTOP");
      const resume = setTimeout(() => process.kill(endpoint.pid, "SIGCONT"), 1500);
      try {
        const recovered = await cli(["daemon", "endpoint"]);
        const facts = parseJson(recovered.stdout);
        t.assertions.assert(recovered.code === 0 && facts.running === true && typeof facts.wsUrl === "string" && !!facts.admission,
          "a briefly stalled authenticated daemon was reported unavailable");
      } finally {
        clearTimeout(resume);
        process.kill(endpoint.pid, "SIGCONT");
      }
    }
    // Mandatory-lock systems can already prevent the guest's diagnostic write.
    if (process.platform !== "win32") writeFileSync(path.join(t.env.data, "daemon.lock"), "");
    await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve));
    const address = foreign.address();
    if (!address || typeof address === "string") throw new Error("foreign listener has no port");
    writeFileSync(endpointFile, JSON.stringify({ ...endpoint, port: address.port })); replaced = true;
    const refused = await cli(["daemon", "endpoint"]);
    t.assertions.assert(healthRequests > 0, "the foreign health listener was not exercised");
    t.assertions.assert(refused.code === 0 && parseJson(refused.stdout).wsUrl == null, "foreign listener gained an admission URL");
    t.assertions.assert((await cli(["daemon", "stop"])).code !== 0 && foreign.listening, "unsigned listener was trusted by stop");
    t.assertions.assert((await opened.client.call({ type: "workspace.list" }))?.type === "workspaces", "refused stop killed the real daemon");
    if (process.platform === "linux") {
      // One accepted but unanswered probe followed by refusals must never
      // authorize the dead-listener fallback against the real owner's PID.
      writeFileSync(path.join(t.env.data, "daemon.lock"), String(endpoint.pid));
      const silent = createServer((_request, _response) => {});
      await new Promise<void>(resolve => silent.listen(0, "127.0.0.1", resolve));
      const silentAddress = silent.address();
      if (!silentAddress || typeof silentAddress === "string") throw new Error("silent listener has no port");
      writeFileSync(endpointFile, JSON.stringify({ ...endpoint, port: silentAddress.port }));
      const vanish = setTimeout(() => { silent.closeAllConnections(); silent.close(); }, 1100);
      try {
        t.assertions.assert((await cli(["daemon", "stop"])).code !== 0,
          "an unanswered probe followed by a closed port authorized stopping an unverified PID");
        t.assertions.assert((await opened.client.call({ type: "workspace.list" }))?.type === "workspaces",
          "an unverified listener caused the real daemon to be signaled");
      } finally {
        clearTimeout(vanish);
        silent.closeAllConnections();
        await new Promise<void>(resolve => silent.close(() => resolve()));
      }
    }
    writeFileSync(endpointFile, original); replaced = false;
    for (const diagnostic of ["", "0"]) {
      if (process.platform !== "win32") writeFileSync(path.join(t.env.data, "daemon.lock"), diagnostic);
      const adopted = await cli(["daemon", "start"]), facts = parseJson(adopted.stdout);
      t.assertions.assert(adopted.code === 0 && facts.running === true && facts.alreadyRunning === true && facts.pid === endpoint.pid && typeof facts.port === "number",
        "missing diagnostics hid the existing authenticated host");
    }
    const stopped = await cli(["daemon", "stop"]);
    t.assertions.assert(stopped.code === 0 && parseJson(stopped.stdout).running === false, "authenticated stop did not recover");
  } finally {
    if (replaced) writeFileSync(endpointFile, original);
    await new Promise<void>(resolve => foreign.close(() => resolve()));
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
