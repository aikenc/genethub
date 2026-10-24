import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { defineSpecialty, genetEnv, locateGenet, parseJson, runGenetAsync } from "../../framework/public.ts";

// OS suspension models a busy daemon without replacing its listener or proof.
// Every PID comes from this case's actual public daemon start response.
defineSpecialty({
  id: "specialty.recovery.daemon-stop-after-transient-silence",
  title: "A briefly busy daemon can prove its identity before stop",
  oracle: "the owned Host resumes after 1500ms, authenticates, and stops gracefully; no forced signal is reported",
  catches: ["a read timeout is mistaken for a foreign response", "stopping without an authenticated proof", "stop returns while the selected Host is alive"],
  tags: ["core", "daemon", "recovery", "cli-update"], llm: { default: "none" },
  expectedDurationMs: 15_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 1, memoryMb: 1024, io: 1, browser: 0 },
  surfaces: ["daemon", "genehub-host", "cli"], productInterfaces: ["genet-cli"],
}, async t => {
  const cli = locateGenet(t.openRoot), env = genetEnv(t.openRoot, t.env.env);
  const call = (args: string[]) => runGenetAsync(cli, args, env, { cwd: t.env.workspace });
  const first = await call(["daemon", "start"]);
  t.assertions.assert(first.code === 0, `start failed: ${first.stderr}`);
  const pid = Number(parseJson(first.stdout).pid);
  t.assertions.assert(Number.isInteger(pid) && pid > 1, "start did not name its owned Host");
  let resume: ReturnType<typeof setTimeout> | undefined;
  try {
    process.kill(pid, "SIGSTOP");
    resume = setTimeout(() => process.kill(pid, "SIGCONT"), 1500);
    const stopped = await call(["daemon", "stop"]);
    t.assertions.assert(stopped.code === 0, `busy stop failed: ${stopped.stderr}`);
    const result = parseJson(stopped.stdout);
    t.assertions.assert(result.stopped === true && result.running === false && result.forced === false, "stop bypassed graceful authenticated shutdown");
    const status = parseJson((await call(["daemon", "status"])).stdout);
    t.assertions.assert(status.running === false && status.pid == null, "Host remained after stop completed");
  } finally {
    if (resume) clearTimeout(resume);
    try { process.kill(pid, "SIGCONT"); } catch {}
    await call(["daemon", "stop"]);
  }
});

// A foreign socket is an external OS/protocol fault, not a replaced daemon.
// Its eventual disappearance must never turn an unproven PID into authority.
defineSpecialty({
  id: "specialty.recovery.daemon-stop-silent-listener-is-not-authority",
  title: "An unproven silent listener disappearing does not authorize stop",
  oracle: "stop refuses after the foreign socket disappears; restoring the real endpoint proves the original daemon is still running",
  catches: ["silent then closed listener is treated as a verified dead daemon", "a stale endpoint can signal an unproven PID"],
  tags: ["core", "daemon", "recovery", "authorization", "cli-update"], llm: { default: "none" },
  expectedDurationMs: 15_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 1, memoryMb: 1024, io: 1, browser: 0 },
  surfaces: ["daemon", "genehub-host", "cli"], productInterfaces: ["genet-cli"],
}, async t => {
  const cli = locateGenet(t.openRoot), env = genetEnv(t.openRoot, t.env.env);
  const call = (args: string[]) => runGenetAsync(cli, args, env, { cwd: t.env.workspace });
  const started = await call(["daemon", "start"]);
  t.assertions.assert(started.code === 0, `start failed: ${started.stderr}`);
  const pid = Number(parseJson(started.stdout).pid);
  const endpoint = path.join(t.env.data, "endpoint.json"), original = readFileSync(endpoint);
  let accepted = 0, closeTimer: ReturnType<typeof setTimeout> | undefined;
  const sockets = new Set<import("node:net").Socket>();
  const foreign = createServer(socket => {
    accepted++; sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    closeTimer = setTimeout(() => { for (const s of sockets) s.destroy(); foreign.close(); }, 1100);
  });
  await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve));
  try {
    const address = foreign.address();
    if (!address || typeof address === "string") throw new Error("foreign listener has no port");
    writeFileSync(endpoint, JSON.stringify({ ...JSON.parse(original.toString()), port: address.port }));
    const refused = await call(["daemon", "stop"]);
    t.assertions.assert(accepted > 0 && refused.code === 4 && /refusing to stop/.test(refused.stderr), "unproven listener authorized stop");
    writeFileSync(endpoint, original);
    const status = parseJson((await call(["daemon", "status"])).stdout);
    t.assertions.assert(status.running === true && status.pid === pid, "the real original daemon was signalled without its proof");
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
    for (const s of sockets) s.destroy();
    if (foreign.listening) await new Promise<void>(resolve => foreign.close(() => resolve()));
    writeFileSync(endpoint, original);
    await call(["daemon", "stop"]);
  }
});
