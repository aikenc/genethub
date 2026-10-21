import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, parseJson, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.cli.daemon.identity-with-missing-pid",
  title: "Missing PID diagnostics retain authenticated daemon control and refuse a foreign listener",
  oracle: "with the real kernel lock held, a missing diagnostic PID does not hide the live host or start another; an unsigned foreign health response grants no endpoint and cannot be stopped; authenticated stop still shuts down the original host",
  catches: ["empty PID diagnostics strand a live daemon", "start adopts an unready instance", "foreign listener receives daemon authority"],
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
