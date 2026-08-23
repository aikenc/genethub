import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  defineSpecialty,
  genetEnv,
  locateGenet,
  parseJson,
  runGenet,
  runGenetAsync,
  type CaseContext,
} from "../../framework/public.ts";

interface CliFixture {
  genet: string;
  env: NodeJS.ProcessEnv;
  run(args: string[]): ReturnType<typeof runGenet>;
  runAsync(args: string[]): ReturnType<typeof runGenetAsync>;
  json(args: string[]): Record<string, unknown>;
}

function fixture(t: CaseContext, dataDir = t.env.data): CliFixture {
  const genet = locateGenet(t.openRoot);
  const env = genetEnv(t.openRoot, { ...t.env.env, GENEHUB_LOCAL_DATA_DIR: dataDir });
  return {
    genet,
    env,
    run: (args) => runGenet(genet, args, env),
    runAsync: (args) => runGenetAsync(genet, args, env),
    json(args) {
      const result = runGenet(genet, args, env);
      if (result.code !== 0) throw new Error(`genet ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      return parseJson(result.stdout);
    },
  };
}

async function withCli(t: CaseContext, run: (cli: CliFixture) => Promise<void>): Promise<void> {
  const cli = fixture(t);
  cli.run(["daemon", "stop"]);
  try {
    await run(cli);
  } finally {
    cli.run(["daemon", "stop"]);
  }
}

function controlCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext) => Promise<void>,
  expectedDurationMs = 15_000,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "cli", "control-depth"],
      expectedDurationMs,
      timeoutMs: 90_000,
      resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" },
      surfaces: ["genet-cli", "daemon"],
      productInterfaces: ["genet-cli"],
    },
    run,
  );
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is not a number: ${value}`);
  return value;
}

controlCase(
  "specialty.cli.control.version-with-broken-data-dir",
  "Version remains available when the data directory is unusable",
  "--version exits zero, prints one version line, and leaves a file used as the data path untouched",
  ["version initializes daemon state", "version depends on writable home", "diagnostic version prints JSON noise"],
  async (t) => {
    const blockedPath = path.join(t.env.root, "data-is-a-file");
    writeFileSync(blockedPath, "sentinel");
    const cli = fixture(t, blockedPath);
    const result = cli.run(["--version"]);
    t.assertions.assert(result.code === 0, `version exit ${result.code}: ${result.stderr}`);
    t.assertions.assert(/^\d+\.\d+\.\d+(?:[-+][^\s]+)?\n?$/.test(result.stdout), `version output ${result.stdout}`);
    t.assertions.assert(result.stderr === "", `version wrote stderr: ${result.stderr}`);
    t.assertions.assert(readFileSync(blockedPath, "utf8") === "sentinel", "version mutated the data path");
  },
  1_000,
);

controlCase(
  "specialty.cli.control.invalid-command-envelope",
  "Invalid daemon arguments use the frozen machine error contract",
  "an unknown verb exits 2, emits one genet.cli/v1 error JSON value, and keeps human usage on stderr",
  ["invalid args exit zero", "JSON error goes to stderr", "usage contaminates stdout", "error code drifts"],
  async (t) => {
    await withCli(t, async (cli) => {
      const result = cli.run(["daemon", "not-a-command"]);
      t.assertions.assert(result.code === 2, `invalid command exit ${result.code}`);
      const body = parseJson(result.stdout);
      const error = body.error as Record<string, unknown> | undefined;
      t.assertions.assert(body.schema === "genet.cli/v1", `schema ${body.schema}`);
      t.assertions.assert(body.type === "error", `type ${body.type}`);
      t.assertions.assert(error?.code === "invalid_args", `error code ${error?.code}`);
      t.assertions.assert(error?.retryable === false, "invalid args marked retryable");
      t.assertions.assert(/usage:/i.test(result.stderr) && /error:/i.test(result.stderr), `stderr ${result.stderr}`);
      t.assertions.assert(result.stdout.trim().split("\n").length === 1, "stdout contained non-JSON lines");
    });
  },
  1_000,
);

controlCase(
  "specialty.cli.control.extra-argument-refused",
  "Lifecycle commands reject ignored trailing arguments",
  "daemon status with an extra token exits 2 and does not start or mutate daemon state",
  ["typo silently ignored", "status extra token starts daemon", "argument parser accepts ambiguous commands"],
  async (t) => {
    await withCli(t, async (cli) => {
      const result = cli.run(["daemon", "status", "unexpected"]);
      t.assertions.assert(result.code === 2, `extra argument exit ${result.code}`);
      const error = parseJson(result.stdout).error as Record<string, unknown> | undefined;
      t.assertions.assert(error?.code === "invalid_args", `error code ${error?.code}`);
      const status = cli.json(["daemon", "status"]);
      t.assertions.assert(status.running === false, "invalid command started the daemon");
    });
  },
  1_000,
);

controlCase(
  "specialty.cli.control.cold-status",
  "Status reports a cold isolated machine without starting it",
  "status exits zero with running=false, null process facts, the lease dataDir, and a version",
  ["status has a startup side effect", "stale global daemon leaks into lease", "machine facts omit data identity"],
  async (t) => {
    await withCli(t, async (cli) => {
      const status = cli.json(["daemon", "status"]);
      t.assertions.assert(status.running === false, `cold status running=${status.running}`);
      t.assertions.assert(status.pid == null && status.port == null, `cold process facts ${JSON.stringify(status)}`);
      t.assertions.assert(path.resolve(String(status.dataDir)) === path.resolve(t.env.data), `dataDir ${status.dataDir}`);
      t.assertions.assert(typeof status.version === "string" && status.version.length > 0, "version missing");
      t.assertions.assert(typeof status.channel === "string" && status.channel.length > 0, "channel missing");
    });
  },
  1_000,
);

controlCase(
  "specialty.cli.control.cold-endpoint",
  "Endpoint discovery fails closed when no daemon is running",
  "endpoint exits zero but returns null wsUrl, serverProof, and admission with running=false",
  ["stale bearer returned while stopped", "endpoint implicitly starts daemon", "partial admission escapes"],
  async (t) => {
    await withCli(t, async (cli) => {
      const endpoint = cli.json(["daemon", "endpoint"]);
      t.assertions.assert(endpoint.running === false, "cold endpoint claimed running");
      t.assertions.assert(endpoint.wsUrl == null, `cold wsUrl ${endpoint.wsUrl}`);
      t.assertions.assert(endpoint.serverProof == null, "cold serverProof was present");
      t.assertions.assert(endpoint.admission == null, "cold admission was present");
    });
  },
  1_000,
);

controlCase(
  "specialty.cli.control.cold-stop-idempotent",
  "Stopping an already stopped daemon is idempotent",
  "two stop commands both exit zero and report stopped=false, running=false",
  ["cold stop is an error", "second stop changes exit code", "stop invents a process"],
  async (t) => {
    const cli = fixture(t);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = cli.run(["daemon", "stop"]);
      t.assertions.assert(result.code === 0, `stop ${attempt} exit ${result.code}`);
      const body = parseJson(result.stdout);
      t.assertions.assert(body.stopped === false && body.running === false, `stop ${attempt}: ${result.stdout}`);
    }
  },
  1_000,
);

controlCase(
  "specialty.cli.control.start-status-stop",
  "Start, status, and stop agree on one real daemon process",
  "start publishes a live pid/port, status repeats them, stop ends it, and final status is cold",
  ["start returns before endpoint", "status identifies another process", "stop acknowledges before shutdown"],
  async (t) => {
    await withCli(t, async (cli) => {
      const started = cli.json(["daemon", "start"]);
      const pid = number(started.pid, "start pid");
      const port = number(started.port, "start port");
      t.assertions.assert(started.started === true && started.alreadyRunning === false, `start ${JSON.stringify(started)}`);
      const status = cli.json(["daemon", "status"]);
      t.assertions.assert(status.running === true && status.pid === pid && status.port === port, `status ${JSON.stringify(status)}`);
      const stopped = cli.json(["daemon", "stop"]);
      t.assertions.assert(stopped.stopped === true && stopped.running === false, `stop ${JSON.stringify(stopped)}`);
      const cold = cli.json(["daemon", "status"]);
      t.assertions.assert(cold.running === false && cold.pid == null, `final status ${JSON.stringify(cold)}`);
    });
  },
);

controlCase(
  "specialty.cli.control.start-idempotent",
  "Starting twice adopts the existing daemon without duplication",
  "the second start reports alreadyRunning=true and preserves the first pid and port",
  ["second daemon spawned", "idempotent start changes endpoint", "alreadyRunning flag lies"],
  async (t) => {
    await withCli(t, async (cli) => {
      const first = cli.json(["daemon", "start"]);
      const second = cli.json(["daemon", "start"]);
      t.assertions.assert(first.started === true && first.alreadyRunning === false, `first ${JSON.stringify(first)}`);
      t.assertions.assert(second.started === false && second.alreadyRunning === true, `second ${JSON.stringify(second)}`);
      t.assertions.assert(second.pid === first.pid && second.port === first.port, "second start changed process identity");
    });
  },
);

controlCase(
  "specialty.cli.control.restart-replaces-process-preserves-machine",
  "Restart replaces the process while preserving machine identity",
  "restart yields a different pid, the same machineId/fingerprint, and a working endpoint",
  ["restart is only a status call", "restart rotates durable machine identity", "old process survives"],
  async (t) => {
    await withCli(t, async (cli) => {
      cli.json(["daemon", "start"]);
      const before = cli.json(["daemon", "endpoint"]);
      const beforeAdmission = before.admission as Record<string, unknown>;
      const restarted = cli.json(["daemon", "restart"]);
      const after = cli.json(["daemon", "endpoint"]);
      const afterAdmission = after.admission as Record<string, unknown>;
      t.assertions.assert(restarted.started === true && restarted.alreadyRunning === false, `restart ${JSON.stringify(restarted)}`);
      t.assertions.assert(after.running === true, "restart endpoint is not running");
      t.assertions.assert(after.pid !== before.pid, `restart reused live pid ${after.pid}`);
      t.assertions.assert(afterAdmission.machineId === beforeAdmission.machineId, "restart changed machineId");
      t.assertions.assert(afterAdmission.fingerprint === beforeAdmission.fingerprint, "restart changed fingerprint");
    });
  },
  25_000,
);

controlCase(
  "specialty.cli.control.endpoint-admission-fresh",
  "Every endpoint request mints fresh one-use admission",
  "two answers keep pid and machine identity but change challenge, wsUrl, serverProof, and expiry proof material",
  ["reusable websocket bearer returned", "server proof replayable", "endpoint races process identity"],
  async (t) => {
    await withCli(t, async (cli) => {
      cli.json(["daemon", "start"]);
      const first = cli.json(["daemon", "endpoint"]);
      const second = cli.json(["daemon", "endpoint"]);
      const firstAdmission = first.admission as Record<string, unknown>;
      const secondAdmission = second.admission as Record<string, unknown>;
      t.assertions.assert(first.pid === second.pid, "endpoint changed pid");
      t.assertions.assert(firstAdmission.machineId === secondAdmission.machineId, "endpoint changed machineId");
      t.assertions.assert(firstAdmission.challenge !== secondAdmission.challenge, "challenge was reused");
      t.assertions.assert(first.wsUrl !== second.wsUrl, "wsUrl was reused");
      t.assertions.assert(first.serverProof !== second.serverProof, "serverProof was reused");
      const privateEndpoint = JSON.parse(readFileSync(path.join(t.env.data, "endpoint.json"), "utf8")) as { token?: string };
      const token = privateEndpoint.token;
      if (typeof token !== "string" || token.length <= 20) throw new Error("fixture bearer missing");
      t.assertions.assert(!JSON.stringify(first).includes(token), "endpoint response leaked reusable bearer");
      t.assertions.assert(!JSON.stringify(second).includes(token), "second response leaked reusable bearer");
    });
  },
);

controlCase(
  "specialty.cli.control.parallel-status-consistent",
  "Parallel status calls report one consistent process",
  "twenty-four concurrent CLI processes all exit zero and return the same running pid and port",
  ["status reads partially-written endpoint", "parallel control commands disagree", "one status blocks on another"],
  async (t) => {
    await withCli(t, async (cli) => {
      const started = cli.json(["daemon", "start"]);
      const results = await Promise.all(Array.from({ length: 24 }, () => cli.runAsync(["daemon", "status"])));
      for (const [index, result] of results.entries()) {
        t.assertions.assert(result.code === 0, `status ${index} exit ${result.code}: ${result.stderr}`);
        const body = parseJson(result.stdout);
        t.assertions.assert(body.running === true, `status ${index} not running`);
        t.assertions.assert(body.pid === started.pid && body.port === started.port, `status ${index} identity drift`);
      }
    });
  },
);

controlCase(
  "specialty.cli.control.stale-files-fail-cold",
  "Stale unlocked lifecycle files do not impersonate a daemon",
  "a live-looking pid in an unlocked daemon.lock plus malformed endpoint still yields running=false and cold stop",
  ["pid existence mistaken for ownership", "malformed endpoint trusted", "stop signals unrelated current process"],
  async (t) => {
    const cli = fixture(t);
    mkdirSync(t.env.data, { recursive: true });
    writeFileSync(path.join(t.env.data, "daemon.lock"), String(process.pid));
    writeFileSync(path.join(t.env.data, "endpoint.json"), "{not-json");
    const status = cli.json(["daemon", "status"]);
    t.assertions.assert(status.running === false, `stale files claimed running: ${JSON.stringify(status)}`);
    const stopped = cli.json(["daemon", "stop"]);
    t.assertions.assert(stopped.stopped === false && stopped.running === false, `stale stop ${JSON.stringify(stopped)}`);
    t.assertions.assert(existsSync(path.join(t.env.data, "daemon.lock")), "cold stop rewrote stale evidence");
  },
  1_000,
);

controlCase(
  "specialty.cli.control.two-data-dirs-isolated",
  "Two isolated data directories own distinct daemons",
  "both residents run simultaneously with different pid, port, machineId, endpoint files, and dataDir facts",
  ["global singleton ignores data dir", "machine state shared across homes", "one stop terminates both daemons"],
  async (t) => {
    const dataA = path.join(t.env.root, "daemon-a");
    const dataB = path.join(t.env.root, "daemon-b");
    const first = fixture(t, dataA);
    const second = fixture(t, dataB);
    try {
      first.json(["daemon", "start"]);
      second.json(["daemon", "start"]);
      const endpointA = first.json(["daemon", "endpoint"]);
      const endpointB = second.json(["daemon", "endpoint"]);
      const admissionA = endpointA.admission as Record<string, unknown>;
      const admissionB = endpointB.admission as Record<string, unknown>;
      t.assertions.assert(endpointA.pid !== endpointB.pid, "two data dirs shared pid");
      t.assertions.assert(endpointA.port !== endpointB.port, "two data dirs shared port");
      t.assertions.assert(admissionA.machineId !== admissionB.machineId, "two data dirs shared machineId");
      t.assertions.assert(path.resolve(String(endpointA.dataDir)) === path.resolve(dataA), `first dataDir ${endpointA.dataDir}`);
      t.assertions.assert(path.resolve(String(endpointB.dataDir)) === path.resolve(dataB), `second dataDir ${endpointB.dataDir}`);
      first.json(["daemon", "stop"]);
      const stillRunning = second.json(["daemon", "status"]);
      t.assertions.assert(stillRunning.running === true && stillRunning.pid === endpointB.pid, "first stop killed second daemon");
    } finally {
      first.run(["daemon", "stop"]);
      second.run(["daemon", "stop"]);
    }
  },
  25_000,
);
