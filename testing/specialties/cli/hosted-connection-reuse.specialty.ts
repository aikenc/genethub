import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { allocatePort, defineSpecialty, parseJson, runGenetAsync, startHub, startRelay, type RelayHandle } from "../../framework/public.ts";

// The Hub's per-machine ticket allowance, lowered so that a CLI spending one
// ticket per call runs out inside this case exactly as a busy team timer does.
const ALLOWANCE = 6;

interface Failure {
  code: string;
  message: string;
  retryable: boolean;
  details?: { retryAfterMs?: unknown; reconnected?: unknown; [key: string]: unknown };
}

defineSpecialty({
  id: "specialty.cli.hosted-connection-reuse",
  title: "Repeated Hub-routed CLI calls reuse one connection instead of one ticket each",
  oracle: "With the Hub allowing six tickets per window, twelve sequential and six concurrent `--machine` calls succeed; while the relay is down a failure says how long to wait and an early retry says it did not reconnect; a relay restart is survived by dialling again; a waiting Agent run still streams its answer on its own connection; and revoking the machine stops the reused connection within seconds for good",
  catches: [
    "every --machine call spends a Hub ticket and a polling caller hits 429 within minutes",
    "concurrent calls to one machine each dial and spend their own ticket",
    "a dead pooled connection is handed out after the relay restarts",
    "a caller retrying while the target reconnects spends a ticket on every attempt",
    "a repeated failure reads like a fresh attempt, so an Agent concludes the target is still down or re-pairs it",
    "a failure that holds retries back does not say how long to wait",
    "an event-following command shares a connection and loses or steals events",
    "a reused connection keeps working after the machine was revoked",
  ],
  tags: ["core", "cli", "cloud-server", "connectivity"],
  llm: { default: "mock" },
  requiredRepos: ["cloud"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["cloud-server", "daemon", "relay", "genet-cli"],
  productInterfaces: ["hub-http", "genet-cli", "@genehub/workbench/client"],
  stages: ["pair-with-hub", "sequential", "concurrent", "relay-restart", "agent-run", "machine-revoked"],
  expectedDurationMs: 50_000,
  timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
}, async t => {
  process.env.HUB_CONNECT_PER_WINDOW = String(ALLOWANCE);
  const token = randomBytes(32).toString("hex");
  const port = await allocatePort();
  const hub = await startHub({
    databasePath: join(t.env.root, "hub.sqlite"),
    relayOrigin: `http://127.0.0.1:${port}`,
    daemonRelayOrigin: `http://127.0.0.1:${port}`,
    relayToken: token,
  });
  let relay: RelayHandle = await startRelay({ openRoot: t.openRoot, port, control: { origin: hub.origin, token } });
  t.env.env.GENEHUB_LOCAL_HUB_URL = hub.origin;
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const owner = hub.browser();
  const online = async () => {
    let id = "";
    await t.tools.waitUntil(async () => {
      const me = await owner.json<{ machines: Array<{ id: string; online: boolean }> }>("/app/me");
      id = me.machines.find(machine => machine.online)?.id ?? "";
      return id !== "";
    }, 30_000);
    return id;
  };
  const cli = (args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env);
  const failed = async (machine: string, label: string) => {
    const result = await cli(["context", "--machine", machine]);
    const failure = parseJson(result.stdout).error as Failure | undefined;
    t.assertions.assert(result.code !== 0 && failure !== undefined, `${label} succeeded: exit=${result.code}`);
    return failure!;
  };
  const reached = async (machine: string, label: string) => {
    const result = await cli(["context", "--machine", machine]);
    const reply = parseJson(result.stdout) as { type?: string; error?: { code?: string; message?: string; details?: unknown } };
    t.assertions.assert(result.code === 0 && reply.type === "context",
      `${label}: exit=${result.code} error=${JSON.stringify(reply.error)}`);
  };
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await hub.signInOwner(owner);
    const machine = await t.stage("pair-with-hub", async () => {
      const pairing = await opened.client.call({ type: "hub.pair", payload: { hubUrl: hub.origin, displayName: "reuse" } });
      if (pairing?.type !== "hubStatus" || pairing.data.state !== "pairing") throw new Error("hub.pair did not begin pairing");
      await hub.approvePairing(owner, pairing.data.userCode);
      return online();
    });

    await t.stage("sequential", async () => {
      for (let i = 0; i < ALLOWANCE * 2; i++) await reached(machine, `sequential call ${i + 1}`);
    });
    await t.stage("concurrent", async () => {
      await Promise.all(Array.from({ length: ALLOWANCE }, (_, i) => reached(machine, `concurrent call ${i + 1}`)));
    });
    await t.stage("relay-restart", async () => {
      relay.stop();
      // The first failure that cost a ticket names the wait; a retry inside it
      // must say it is that same failure again, not a fresh attempt.
      let spent: Failure | undefined;
      const early: Failure[] = [];
      await t.tools.waitUntil(async () => {
        const result = await cli(["context", "--machine", machine]);
        const failure = parseJson(result.stdout).error as Failure | undefined;
        if (!failure) return false;
        if (failure.details?.reconnected === false) early.push(failure);
        else if (typeof failure.details?.retryAfterMs === "number") spent = failure;
        return spent !== undefined;
      }, 20_000);
      t.assertions.assert(spent!.retryable && spent!.details!.retryAfterMs === 10_000,
        `a failure that holds retries back did not say how long: ${JSON.stringify(spent)}`);
      const repeat = await failed(machine, "an immediate retry while the relay is down");
      const after = repeat.details?.retryAfterMs;
      t.assertions.assert(repeat.details?.reconnected === false
        && repeat.code === spent!.code
        && repeat.message.startsWith(`not reconnected: ${machine} failed `)
        && repeat.message.includes(spent!.message)
        && typeof after === "number" && after > 0 && after < 10_000
        && repeat.message.includes(`${Math.ceil(after / 1000)}s`),
        `an immediate retry did not say it was the earlier failure again: ${JSON.stringify(repeat)}`);
      t.note(`relay down: ${early.length} early repeats before the spent failure; repeat said ${JSON.stringify(repeat.message.slice(0, 200))}`);
      await t.tools.waitUntil(async () => {
        try { relay = await startRelay({ openRoot: t.openRoot, port, control: { origin: hub.origin, token } }); return true; }
        catch { return false; }
      }, 15_000);
      // Retried as tightly as a careless poller would, before the target is
      // back at the relay: those failures must not each cost a ticket.
      const seen = new Set<string>();
      try {
        await t.tools.waitUntil(async () => {
          const result = await cli(["context", "--machine", machine]);
          const error = parseJson(result.stdout).error as { code?: string; message?: string } | undefined;
          if (error) seen.add(`${error.code}: ${error.message?.slice(0, 160)}`);
          return result.code === 0;
        }, 40_000);
      } catch (error) {
        throw new Error(`no hosted call succeeded after the relay restart: ${[...seen].join(" | ")} ${String(error)}`);
      }
      for (let i = 0; i < ALLOWANCE; i++) await reached(machine, `call ${i + 1} after relay restart`);
    });
    await t.stage("agent-run", async () => {
      opened.mock.script({ text: "answered over its own connection" });
      const run = await cli(["agent", "run", "--agent", "genet", "--model", "deepseek/deepseek-v4-flash",
        "--workspace", opened.workspaceId, "--machine", machine, "Answer once"]);
      t.assertions.assert(run.code === 0 && run.stdout.includes("answered over its own connection"),
        `a waiting run lost its event stream: exit=${run.code} ${run.stdout.slice(-400)} ${run.stderr.slice(-400)}`);
      await reached(machine, "call after a waiting run");
    });
    await t.stage("machine-revoked", async () => {
      // The connection is warm and would be reused for minutes; revoking must
      // end it, not wait for it to age out.
      await reached(machine, "call just before the revocation");
      const revoked = await owner.fetch(`/app/machines/${encodeURIComponent(machine)}/revoke`, { method: "POST" });
      t.assertions.assert(revoked.ok, `revoking the machine failed: ${revoked.status}`);
      const at = Date.now();
      let first: Failure | undefined;
      await t.tools.waitUntil(async () => {
        const result = await cli(["context", "--machine", machine]);
        if (result.code === 0) return false;
        first = parseJson(result.stdout).error as Failure;
        return true;
      }, 5_000);
      const stoppedMs = Date.now() - at;
      let last: Failure | undefined;
      for (let i = 0; i < 3; i++) {
        const result = await cli(["context", "--machine", machine]);
        t.assertions.assert(result.code !== 0, `call ${i + 1} after the revocation reached the machine again`);
        last = parseJson(result.stdout).error as Failure | undefined;
      }
      t.note(`revoked connection stopped after ${stoppedMs}ms: ${first?.code}: ${first?.message.slice(0, 160)}; `
        + `then ${last?.code} retryable=${last?.retryable}: ${last?.message.slice(0, 160)}`);
    });
    t.note(`allowance=${ALLOWANCE}; ${ALLOWANCE * 3 + 3} hosted calls, one relay restart and one waiting run fit inside it`);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
    relay.stop();
    await hub.stop();
    delete process.env.HUB_CONNECT_PER_WINDOW;
  }
});
