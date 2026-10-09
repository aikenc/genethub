// `genet agent …` is how a person's shell and an Agent inside a session
// repair a script Agent: read its state and logs, run its own tests, reload
// an edited directory, and (people only) run actions and reset an override.
// These cases run the shipped `genet` binary against the case daemon and hold
// it to the machine contract it publishes: one `genet.cli/v1` value on
// stdout, exit 2 for bad arguments, 4 for a business failure, and the same
// verbs in `genet schema` / `genet capabilities` that the parser accepts.
// The daemon, the SDK and the fixture script are real; only the LLM endpoint
// of the session case is the mock.

import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BlockedError,
  defineSpecialty,
  HOST_AGENT_CLIS,
  hideHostAgentClis,
  installScriptAgent,
  localGenetCli,
  pathWithout,
  readScriptAgentJournal,
  seedScriptAgentRuntime,
  type CaseContext,
  type GenetCliResult,
  type ScriptAgentHandle,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type AgentInfo = Awaited<ReturnType<CaseContext["flows"]["branches"]["listAgents"]>>[number];
type Cli = ReturnType<typeof localGenetCli>;

const SCHEMA = "genet.cli/v1";
/** Every `genet agent` verb the parser accepts, with whether it changes the
 * machine (what an Agent reads to decide a retry is safe). `test` runs the
 * Agent's own offline checks and changes nothing a retry would repeat. */
const AGENT_VERBS: Record<string, boolean> = {
  list: false,
  show: false,
  logs: false,
  test: false,
  run: true,
  action: true,
  reload: true,
  reset: true,
};

function cliCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext) => Promise<void>,
  options: { durationMs?: number; llm?: "none" | "mock" } = {},
): void {
  const durationMs = options.durationMs ?? 20_000;
  defineSpecialty(
    {
      id: `specialty.agent.cli.${id}`,
      title,
      oracle,
      catches,
      tags: ["core", "agent", "script-agent", "genet-cli", "agent-cli"],
      llm: { default: options.llm ?? "none" },
      expectedDurationMs: durationMs,
      timeoutMs: Math.max(durationMs * 4, 60_000),
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["genet-cli", "daemon", "script-agent"],
      productInterfaces: ["genet-cli", "@genehub/workbench/client", "agent-serve-protocol-1"],
    },
    run,
  );
}

/** The built-in codex/cursor scripts look beyond PATH; "not installed" must
 * hold for the override and fallback facts below to mean anything. */
function withoutHostAgentClis(t: CaseContext): void {
  hideHostAgentClis(t.env);
  t.env.env.PATH = pathWithout(HOST_AGENT_CLIS, t.env.env.PATH);
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin"]) {
    if (existsSync(path.join(dir, "codex"))) {
      throw new BlockedError(`${dir}/codex is installed; the built-in codex script finds it outside PATH`);
    }
  }
}

async function withDaemon(
  t: CaseContext,
  watched: ScriptAgentHandle[],
  run: (opened: Opened, cli: Cli) => Promise<void>,
): Promise<void> {
  withoutHostAgentClis(t);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cli = localGenetCli(t.openRoot, t.env);
  try {
    await run(opened, cli);
  } catch (error) {
    for (const agent of watched) {
      const logs = await t.flows.branches.agentLogs(opened.client, agent.agentId, 12).catch((e: unknown) => [`agent.logs failed: ${String(e)}`]);
      const journal = readScriptAgentJournal(agent).slice(-12).map((entry) => `${entry.pid}:${entry.event}`);
      t.note(`${agent.agentId} logs: ${logs.join(" | ")}\n${agent.agentId} journal: ${journal.join(" ")}`);
    }
    throw error;
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

/** A daemon with no fixture Agent, for verbs that only describe the CLI. */
async function withBareDaemon(t: CaseContext, run: () => Promise<void> | void): Promise<void> {
  withoutHostAgentClis(t);
  seedScriptAgentRuntime(t.env);
  const opened = await t.flows.main.startLocalEnvironment({ openRoot: t.openRoot, lease: t.env });
  try {
    await run();
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

function brief(result: GenetCliResult): string {
  return `exit ${result.code} stdout ${result.stdout.slice(-400)} stderr ${result.stderr.slice(-300)}`;
}

/** Exit 0 and one success envelope of `type`. */
function succeeded(t: CaseContext, result: GenetCliResult, type: string): Record<string, unknown> {
  t.assertions.assert(result.code === 0, `genet ${type}: ${brief(result)}`);
  const body = result.envelope;
  t.assertions.assert(body?.schema === SCHEMA && body.type === type && typeof body.data === "object",
    `genet ${type} envelope: ${result.stdout.slice(-400)}`);
  t.assertions.assert(result.stdout.trim().split("\n").length === 1, `genet ${type} printed more than one stdout line`);
  return body!.data!;
}

/** Exit `exit` and one error envelope carrying `code`. */
function refused(t: CaseContext, result: GenetCliResult, exit: number, code: string, what: string): void {
  const body = result.envelope;
  t.assertions.assert(
    result.code === exit && body?.schema === SCHEMA && body.type === "error" && body.error?.code === code,
    `${what}: expected exit ${exit} ${code}, got ${brief(result)}`,
  );
}

const starts = (agent: ScriptAgentHandle, argv0?: string) =>
  readScriptAgentJournal(agent).filter((entry) =>
    entry.event === "start" && (argv0 === undefined || (Array.isArray(entry.argv) && entry.argv[0] === argv0)));
const journalOf = (agent: ScriptAgentHandle, event: string) =>
  readScriptAgentJournal(agent).filter((entry) => entry.event === event);
const primary = (agent: AgentInfo) => agent.actions?.find((action) => action.primary)?.id;
/** JSON with object keys sorted: the CLI and the client serialize the same
 * value with different key orders. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item);

cliCase(
  "read-verbs",
  "agent list / show / logs print the daemon's view without icons, and logs honours its line bounds",
  "`genet agent list` and `show <id>` exit 0 with one genet.cli/v1 envelope whose Agents match agent.list from the product client field for field except that no `icon` survives (one is present on the client side); `logs <id> --lines 1` is the last line of `--lines 500`, no request returns more than 500 lines, and `--lines` without a whole number exits 2 invalidArgs",
  [
    "the CLI prints base64 icons into a terminal",
    "show/list drift from what the daemon reports",
    "--lines ignored or not a tail",
    "logs returns more than its documented maximum",
    "a malformed --lines reaches the daemon instead of exiting 2",
  ],
  async (t) => {
    const agent = installScriptAgent(t.env, { id: "fixture-cli", control: { profile: "login" } });
    await withDaemon(t, [agent], async (opened, cli) => {
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, (info) => primary(info) === "login", { what: "asking for login" });
      // Something for the log to hold: the login job writes two job lines
      // before it asks, and a person cancels.
      const pushes = t.flows.branches.recordAgentPushes(opened.client);
      try {
        const ran = await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: agent.agentId, actionId: "login" } });
        t.assertions.assert(ran.ok, `login action: ${ran.ok ? "" : ran.error}`);
        await t.tools.waitUntil(() => pushes.requests.some((item) => item.agentId === agent.agentId), 15_000);
        const request = pushes.requests.find((item) => item.agentId === agent.agentId)!;
        await t.flows.branches.answerAgentRequest(opened.client, { agentId: agent.agentId, requestId: request.id, outcome: { type: "canceled" } });
        await t.flows.branches.waitForAgent(opened.client, agent.agentId, (info) => info.job?.done === true, { what: "job finished" });
      } finally {
        pushes.stop();
      }

      const fromClient = await t.flows.branches.listAgents(opened.client);
      t.assertions.assert(fromClient.some((item) => typeof item.icon === "string" && item.icon.length > 0),
        "no Agent carries an icon on the client side, so its absence below proves nothing");
      const listed = succeeded(t, cli(["agent", "list"]), "agent.list");
      const agents = listed.agents as Array<Record<string, unknown>>;
      t.assertions.assert(Array.isArray(agents), `agent.list data ${JSON.stringify(listed).slice(0, 300)}`);
      t.assertions.assert(agents.every((item) => !("icon" in item) || item.icon === null),
        `icons printed for ${agents.filter((item) => item.icon).map((item) => item.id).join(",")}`);
      t.assertions.assert(
        JSON.stringify(agents.map((item) => item.id).sort()) === JSON.stringify(fromClient.map((item) => item.id).sort()),
        `CLI ids ${agents.map((item) => item.id).join(",")} vs client ${fromClient.map((item) => item.id).join(",")}`,
      );
      const clientFixture = fromClient.find((item) => item.id === agent.agentId)!;
      const shown = succeeded(t, cli(["agent", "show", agent.agentId]), "agent.show").agent as Record<string, unknown>;
      t.assertions.assert(shown && !("icon" in shown && shown.icon !== null), `show printed an icon: ${Object.keys(shown ?? {}).join(",")}`);
      for (const field of ["id", "label", "source", "version", "message", "probe", "actions", "builtin"] as const) {
        t.assertions.assert(canonical(shown[field]) === canonical(clientFixture[field]),
          `show.${field} ${JSON.stringify(shown[field])} vs client ${JSON.stringify(clientFixture[field])}`);
      }
      t.assertions.assert(shown.source === "user" && shown.label === "Fixture Agent", `show ${JSON.stringify(shown).slice(0, 300)}`);

      const lines = (args: string[]) => succeeded(t, cli(["agent", "logs", agent.agentId, ...args]), "agent.logs").lines as string[];
      const all = lines(["--lines", "500"]);
      t.assertions.assert(all.length >= 2 && all.length <= 500, `--lines 500 gave ${all.length} lines`);
      t.assertions.assert(all.some((line) => line.includes("fixture-login: step 2 of 2")), `the job's lines are not in the log: ${all.slice(-6).join(" | ")}`);
      const one = lines(["--lines", "1"]);
      t.assertions.assert(one.length === 1 && one[0] === all.at(-1), `--lines 1 gave ${JSON.stringify(one)}; tail is ${JSON.stringify(all.at(-1))}`);
      const fallback = lines([]);
      t.assertions.assert(fallback.length >= 1 && fallback.length <= 500 && fallback.at(-1) === all.at(-1), `default logs ${fallback.length} lines`);
      for (const bad of [["--lines", "abc"], ["--lines"], ["--lines", "-3"], ["--lines", "2.5"]]) {
        refused(t, cli(["agent", "logs", agent.agentId, ...bad]), 2, "invalidArgs", `logs ${bad.join(" ")}`);
      }
      // Outside 1..500: the published schema says so; a CLI may refuse it
      // (exit 2) or clamp it, but never hand back more than the bound.
      const outside: string[] = [];
      for (const [value, most] of [["0", 1], ["501", 500], ["100000", 500]] as const) {
        const result = cli(["agent", "logs", agent.agentId, "--lines", value]);
        if (result.code === 2) {
          refused(t, result, 2, "invalidArgs", `logs --lines ${value}`);
          outside.push(`${value}:refused`);
          continue;
        }
        const got = succeeded(t, result, "agent.logs").lines as string[];
        t.assertions.assert(got.length <= most, `--lines ${value} returned ${got.length} lines`);
        outside.push(`${value}:${got.length}`);
      }
      t.note(`log lines ${all.length}; out-of-range --lines ${outside.join(" ")}`);
    });
  },
);

cliCase(
  "action-reload-reset",
  "agent action / reload / reset run through the daemon and report the Agent afterwards",
  "`agent action <id> noop` exits 0 with the Agent in its envelope, the script journals that action and AgentInfo.job ends done without error; `agent reload <id>` exits 0 and starts one new serve process; `agent reset` of a user-only Agent exits 4 and leaves user/<id>, while `agent reset codex` of a user override exits 0, removes user/codex and reports source builtin",
  [
    "agent action returns before the daemon accepted it, or never reaches the script",
    "reload over the CLI does not restart the process",
    "reset deletes a user Agent that has no built-in to return to",
    "reset of an override leaves the user directory",
  ],
  async (t) => {
    const agent = installScriptAgent(t.env, { id: "fixture-cli", control: { profile: "normal" } });
    const override = installScriptAgent(t.env, { id: "codex", control: { profile: "normal" } });
    await withDaemon(t, [agent, override], async (opened, cli) => {
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready" });
      await t.flows.branches.waitForAgent(opened.client, "codex", (info) => info.source === "override" && t.flows.branches.agentReady(info), { what: "the override, ready" });

      const acted = succeeded(t, cli(["agent", "action", agent.agentId, "noop"]), "agent.action");
      t.assertions.assert(acted.agentId === agent.agentId && acted.actionId === "noop" && (acted.agent as { id?: string })?.id === agent.agentId,
        `action envelope ${JSON.stringify(acted).slice(0, 300)}`);
      t.assertions.assert(!JSON.stringify(acted).includes('"icon":"'), "action printed an icon");
      await t.tools.waitUntil(() => journalOf(agent, "action").some((entry) => entry.action === "noop"), 10_000)
        .catch(() => { throw new Error("the script never received the noop action"); });
      const done = await t.flows.branches.waitForAgent(opened.client, agent.agentId,
        (info) => info.job?.action === "noop" && info.job.done === true, { what: "noop job done" });
      t.assertions.assert(!done.job?.error, `noop job failed: ${done.job?.error}`);

      const before = starts(agent, "serve").length;
      const reloaded = succeeded(t, cli(["agent", "reload", agent.agentId]), "agent.reload");
      t.assertions.assert((reloaded.agent as { source?: string })?.source === "user", `reload envelope ${JSON.stringify(reloaded).slice(0, 300)}`);
      await t.tools.waitUntil(() => starts(agent, "serve").length === before + 1, 15_000)
        .catch(() => { throw new Error(`reload started ${starts(agent, "serve").length - before} processes`); });
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready after reload" });

      refused(t, cli(["agent", "reset", agent.agentId]), 4, "invalidInput", "reset of a user-only Agent");
      t.assertions.assert(existsSync(path.join(agent.dir, "agent.toml")), "a refused reset deleted the user Agent");

      const reset = succeeded(t, cli(["agent", "reset", "codex"]), "agent.reset");
      t.assertions.assert(!existsSync(override.dir), "agent reset codex left user/codex");
      t.assertions.assert((reset.agent as { source?: string })?.source === "builtin", `reset envelope ${JSON.stringify(reset).slice(0, 300)}`);
      await t.flows.branches.waitForAgent(opened.client, "codex", (info) => info.source === "builtin" && primary(info) === "install",
        { what: "the built-in, offering install, after reset" });
    });
  },
  { durationMs: 25_000 },
);

cliCase(
  "test-verb",
  "agent test runs the user directory's own checks and its exit code follows the result",
  "`agent test <id>` on a sound fixture exits 0 with passed:true and the SDK's manifest line, and the fixture journals a `test` start from its user/ directory; on a fixture that dies on import it exits 4 with passed:false and output naming how the test process ended (`agent.py test 结束`), and the same journal proof",
  [
    "agent test passes without running anything",
    "a failing test exits 0",
    "test output dropped from the envelope",
    "the wrong directory is tested",
  ],
  async (t) => {
    const sound = installScriptAgent(t.env, { id: "fixture-pass", control: { profile: "normal" } });
    const broken = installScriptAgent(t.env, { id: "fixture-fail", control: { profile: "crash-on-start" } });
    await withDaemon(t, [sound, broken], async (opened, cli) => {
      await t.flows.branches.waitForAgent(opened.client, sound.agentId, t.flows.branches.agentReady, { what: "ready" });

      const passed = succeeded(t, cli(["agent", "test", sound.agentId]), "agent.test");
      t.assertions.assert(passed.passed === true && passed.agentId === sound.agentId, `passing test ${JSON.stringify(passed).slice(0, 400)}`);
      const output = String(passed.output ?? "");
      t.assertions.assert(output.includes("manifest: Fixture Agent") && /\bpassed\b/.test(output), `test output ${output.slice(0, 400)}`);
      const ran = starts(sound, "test");
      t.assertions.assert(ran.length === 1 && ran[0]!.agentDir === sound.dir, `test runs of ${sound.dir}: ${JSON.stringify(ran)}`);

      const before = starts(broken, "test").length;
      const failed = cli(["agent", "test", broken.agentId]);
      t.assertions.assert(failed.code === 4, `failing test exit: ${brief(failed)}`);
      const body = failed.envelope;
      t.assertions.assert(body?.schema === SCHEMA && body.type === "agent.test" && body.data?.passed === false,
        `failing test envelope ${failed.stdout.slice(-400)}`);
      // The fixture dies with os._exit before printing anything; the daemon
      // still says how the test process ended.
      const failure = String(body!.data!.output ?? "");
      t.assertions.assert(failure.trim() !== "" && failure.includes("agent.py test 结束"), `failing test output ${JSON.stringify(failure.slice(0, 300))}`);
      const failedRuns = starts(broken, "test");
      t.assertions.assert(failedRuns.length === before + 1 && failedRuns.at(-1)!.agentDir === broken.dir,
        `test runs of ${broken.dir}: ${JSON.stringify(failedRuns)}`);
    });
  },
);

cliCase(
  "test-targets-user-copy-after-fallback",
  "While a crashing override is set aside, agent test still tests the user copy being repaired",
  "with user/codex crashing until the daemon falls back to builtin/codex, `agent test codex` journals a `test` start from user/codex and exits 4 with passed:false; a pass here would be the built-in copy answering for the broken one",
  [
    "agent test runs builtin/<id> after the override was disabled, a false pass during repair",
    "agent test of a fallen-back Agent refused instead of testing the override",
  ],
  async (t) => {
    const override = installScriptAgent(t.env, { id: "codex", control: { profile: "crash-on-start" } });
    await withDaemon(t, [override], async (opened, cli) => {
      const fellBack = await t.flows.branches.waitForAgent(opened.client, "codex",
        (info) => info.source === "builtin" && primary(info) === "install", { timeoutMs: 120_000, what: "back on the built-in" });
      t.note(`fell back after ${journalOf(override, "fault").length} failed starts: ${JSON.stringify(t.flows.branches.summarizeAgent(fellBack))}`);

      const before = starts(override, "test").length;
      const result = cli(["agent", "test", "codex"]);
      const tested = starts(override, "test");
      t.assertions.assert(tested.length === before + 1 && tested.at(-1)!.agentDir === override.dir,
        `agent test did not run user/codex (exit ${result.code}, passed ${JSON.stringify(result.envelope?.data?.passed)}): ${result.stdout.slice(-300)}`);
      t.assertions.assert(result.code === 4 && result.envelope?.type === "agent.test" && result.envelope.data?.passed === false,
        `test of the crashing override: ${brief(result)}`);
    });
  },
  { durationMs: 60_000 },
);

cliCase(
  "unknown-agent-not-found",
  "Every agent verb names an unknown Agent as not found, a business failure",
  "against a running daemon, `agent show|action|reload|reset|test|logs` on an id no layer has exits 4 with one error envelope whose code is targetNotFound; none of them exits 2 (the arguments were well-formed) or 0",
  [
    "show reports an unknown Agent as a bad argument while the others report not found",
    "an unknown id is created, reloaded or tested as if it existed",
    "callers cannot tell a typo from a broken Agent",
  ],
  async (t) => {
    const agent = installScriptAgent(t.env, { id: "fixture-cli", control: { profile: "normal" } });
    await withDaemon(t, [agent], async (opened, cli) => {
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready" });
      const unknown = "no-such-agent";
      const outcomes: string[] = [];
      const failures: string[] = [];
      for (const [verb, ...rest] of [["show"], ["action", "noop"], ["reload"], ["reset"], ["test"], ["logs"]]) {
        const result = cli(["agent", verb!, unknown, ...rest]);
        const code = result.envelope?.error?.code;
        outcomes.push(`${verb}:${result.code}/${String(code)}`);
        if (!(result.code === 4 && result.envelope?.type === "error" && code === "targetNotFound")) failures.push(`${verb} ${brief(result)}`);
      }
      t.note(outcomes.join(" "));
      t.assertions.assert(failures.length === 0, `unknown Agent: ${failures.join("\n")}`);
      t.assertions.assert(!existsSync(path.join(t.env.data, "agents", "user", unknown)) && !existsSync(path.join(t.env.data, "agents", "state", unknown)),
        "a verb on an unknown id created its directories");
    });
  },
);

cliCase(
  "schema-and-capabilities",
  "genet schema and genet capabilities describe every agent verb the parser accepts",
  "for each of agent list|run|show|action|reload|reset|test|logs, `genet schema agent <verb>` and `genet schema agent.<verb>` exit 0 with that command's name, a synopsis starting `genet agent <verb>`, requiresDaemon true and the expected mutation flag; `genet schema` lists them all, and `genet capabilities` lists each with the same mutation flag",
  [
    "a shipped agent verb is unknown to genet schema, so an Agent cannot learn its input",
    "capabilities omits a verb or marks a mutating verb safe to retry",
    "schema and capabilities disagree about mutation",
  ],
  async (t) => {
    // Every verb is forwarded to the daemon (`apps/cli` FORWARDED), so the
    // descriptions are read from a running one.
    await withBareDaemon(t, () => describeAgentVerbs(t, localGenetCli(t.openRoot, t.env)));
  },
  { durationMs: 5_000 },
);

function describeAgentVerbs(t: CaseContext, cli: Cli): void {
  const problems: string[] = [];
  const listed = succeeded(t, cli(["schema"]), "schema").commands as Array<{ name?: string }>;
  const listedNames = new Set(listed.map((item) => item.name));
  const capabilities = succeeded(t, cli(["capabilities"]), "capabilities").commands as Array<{ name?: string; mutation?: unknown; requiresDaemon?: unknown }>;
  for (const [verb, mutation] of Object.entries(AGENT_VERBS)) {
    const name = `agent.${verb}`;
    for (const argv of [["schema", "agent", verb], ["schema", name]]) {
      const result = cli(argv);
      if (result.code !== 0 || result.envelope?.type !== "schema") {
        problems.push(`${argv.join(" ")}: ${brief(result)}`);
        continue;
      }
      const command = result.envelope.data?.command as Record<string, unknown> | undefined;
      if (command?.name !== name) problems.push(`${argv.join(" ")} named ${String(command?.name)}`);
      if (!String(command?.synopsis ?? "").startsWith(`genet agent ${verb}`)) problems.push(`${name} synopsis ${String(command?.synopsis)}`);
      if (command?.requiresDaemon !== true) problems.push(`${name} requiresDaemon ${String(command?.requiresDaemon)}`);
      if (command?.mutation !== mutation) problems.push(`${name} schema mutation ${String(command?.mutation)}, expected ${mutation}`);
      const input = command?.inputSchema as { required?: unknown } | undefined;
      if (verb !== "list" && !(Array.isArray(input?.required) && input!.required.includes("agentId"))) {
        problems.push(`${name} input does not require agentId: ${JSON.stringify(input?.required)}`);
      }
    }
    if (!listedNames.has(name)) problems.push(`genet schema does not list ${name}`);
    const capability = capabilities.find((item) => item.name === name);
    if (!capability) problems.push(`genet capabilities does not list ${name}`);
    else if (capability.mutation !== mutation) problems.push(`${name} capabilities mutation ${String(capability.mutation)}, expected ${mutation}`);
  }
  refused(t, cli(["schema", "agent", "no-such-verb"]), 2, "invalidArgs", "schema of an unknown agent verb");
  t.assertions.assert(problems.length === 0, problems.join("\n"));
}

/** The offline replay cases a built-in script Agent ships under tests/. */
function shippedTests(dir: string): string[] {
  const tests = path.join(dir, "tests");
  return existsSync(tests) ? readdirSync(tests).filter((name) => name.endsWith(".json")).sort() : [];
}

const literal = (text: string) => text.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
/** `testing.py` prints `ok   <file>` or `FAIL <file>: <why>` per replay. */
const okLine = (name: string) => new RegExp(`^ok\\s+${literal(name)}$`, "m");
const failLine = (name: string) => new RegExp(`^FAIL\\s+${literal(name)}:`, "m");

cliCase(
  "builtin-agent-tests",
  "agent test runs the built-in codex and cursor adapters' own replay tests and they pass",
  "with neither CLI installed, `agent test codex` and `agent test cursor` each exit 0 with passed:true and an `ok` line for every tests/*.json the daemon materialized under agents/builtin/<id>/, which is the same set as the source tree ships",
  [
    "a built-in adapter regression its own recorded transcripts would catch",
    "the shipped built-in copy lacks the tests the source has",
    "agent test reports passed without replaying anything",
  ],
  async (t) => {
    seedScriptAgentRuntime(t.env);
    await withDaemon(t, [], async (opened, cli) => {
      for (const id of ["codex", "cursor"]) {
        await t.flows.branches.waitForAgent(opened.client, id, (info) => info.source === "builtin" && primary(info) === "install", { what: "built-in, not installed" });
        const shipped = shippedTests(path.join(t.env.data, "agents", "builtin", id));
        const source = shippedTests(path.join(t.openRoot, "apps", "daemon", "builtin-agents", "agents", id));
        t.assertions.assert(shipped.length > 0 && JSON.stringify(shipped) === JSON.stringify(source),
          `${id} tests shipped ${JSON.stringify(shipped)} vs source ${JSON.stringify(source)}`);
        const data = succeeded(t, cli(["agent", "test", id]), "agent.test");
        const output = String(data.output ?? "");
        const missing = shipped.filter((name) => !okLine(name).test(output));
        t.assertions.assert(data.passed === true && missing.length === 0,
          `${id}: passed ${String(data.passed)}, no ok line for ${missing.join(",")}: ${output.slice(-600)}`);
        t.note(`${id}: ${shipped.length} replays ok`);
      }
    });
  },
);

cliCase(
  "override-broken-expectation-fails",
  "A codex override whose recorded expectation is wrong fails agent test and names the file",
  "a copy of the materialized built-in codex written to user/codex with one tests/*.json expecting an event the adapter never emits makes `agent test codex` exit 4 with passed:false, a FAIL line naming exactly that file, and ok lines for every other file",
  [
    "a broken expectation in an override passes",
    "the failing replay is not named, so a repair cannot find it",
    "agent test tests the built-in instead of the override being edited",
  ],
  async (t) => {
    seedScriptAgentRuntime(t.env);
    await withDaemon(t, [], async (opened, cli) => {
      await t.flows.branches.waitForAgent(opened.client, "codex", (info) => info.source === "builtin" && primary(info) === "install", { what: "built-in, not installed" });
      const builtin = path.join(t.env.data, "agents", "builtin", "codex");
      const override = path.join(t.env.data, "agents", "user", "codex");
      cpSync(builtin, override, { recursive: true });
      const names = shippedTests(override);
      const broken = names.find((name) => Array.isArray((JSON.parse(readFileSync(path.join(override, "tests", name), "utf8")) as { events?: unknown }).events));
      t.assertions.assert(broken !== undefined, `no codex replay with an events expectation among ${names.join(",")}`);
      const file = path.join(override, "tests", broken!);
      const replay = JSON.parse(readFileSync(file, "utf8")) as { events: unknown[] };
      replay.events = [...replay.events, { type: "fixtureNeverEmitted" }];
      writeFileSync(file, `${JSON.stringify(replay, null, 1)}\n`);

      const result = cli(["agent", "test", "codex"]);
      const output = String(result.envelope?.data?.output ?? "");
      t.assertions.assert(result.code === 4 && result.envelope?.type === "agent.test" && result.envelope.data?.passed === false,
        `test of the broken override: ${brief(result)}`);
      t.assertions.assert(failLine(broken!).test(output), `no FAIL line for ${broken}: ${output.slice(-600)}`);
      const others = names.filter((name) => name !== broken);
      const notOk = others.filter((name) => !okLine(name).test(output));
      t.assertions.assert(notOk.length === 0 && !others.some((name) => failLine(name).test(output)),
        `other replays not ok: ${notOk.join(",")}`);
    });
  },
);

const SESSION_TRIGGER = "RUN_AGENT_CLI_FROM_SESSION";

cliCase(
  "session-controller-refused",
  "From inside a session, agent action and reset are refused for lack of settings while test and logs work",
  "a built-in Genet session (mock LLM) running `$GENEHUB_CLI agent action fixture-cli noop` and `agent reset codex` gets exit 4 for both with error code unauthenticated and message `caller lacks the settings capability`, while `agent test fixture-cli` and `agent logs fixture-cli` exit 0; the action never reaches the script and user/codex is still there",
  [
    "a session Agent installs, logs in or runs actions without a person",
    "a session Agent resets an override the user wrote",
    "the refusal is indistinguishable from a broken Agent (no capability named)",
    "a session Agent cannot run the tests it needs to repair a script",
  ],
  async (t) => {
    const agent = installScriptAgent(t.env, { id: "fixture-cli", control: { profile: "normal" } });
    const override = installScriptAgent(t.env, { id: "codex", control: { profile: "normal" } });
    await withDaemon(t, [agent, override], async (opened) => {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready" });
      const root = opened.workspaceRoot;
      const step = (name: string, command: string) =>
        `"$GENEHUB_CLI" ${command} < /dev/null > ${name}.out 2> ${name}.err; echo $? > ${name}.exit`;
      const command = [
        `cd "${root}"`,
        step("action", `agent action ${agent.agentId} noop`),
        step("reset", "agent reset codex"),
        step("test", `agent test ${agent.agentId}`),
        step("logs", `agent logs ${agent.agentId} --lines 5`),
        "touch cli.done",
      ].join("; ");
      let issued = false;
      opened.mock.script(...Array.from({ length: 20 }, () => ({
        respond: (request: unknown) => {
          if (!issued && JSON.stringify(request).includes(SESSION_TRIGGER)) {
            issued = true;
            return { tool: { name: "bash", arguments: { command } } };
          }
          return { text: "Done." };
        },
      })));
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.sendPrompt(opened.client, sessionId, `${SESSION_TRIGGER}: check the script Agent.`);
      await t.tools.waitUntil(() => existsSync(path.join(root, "cli.done")), 60_000)
        .catch(() => { throw new Error(`the session never finished its commands: ${readdirSync(root).join(",")}`); });
      const read = (name: string) => {
        const file = path.join(root, name);
        return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
      };
      const outcome = (name: string) => {
        const line = read(`${name}.out`).split("\n").filter(Boolean).at(-1) ?? "";
        let body: { type?: string; error?: { code?: string; message?: string } } = {};
        try { body = JSON.parse(line) as typeof body; } catch { /* reported below */ }
        return { exit: read(`${name}.exit`), body, text: `${read(`${name}.out`).slice(-300)} ${read(`${name}.err`).slice(-200)}` };
      };
      const problems: string[] = [];
      for (const name of ["action", "reset"]) {
        const got = outcome(name);
        // The platform's wording for a session caller missing a grant
        // (router.rs): the code is `unauthenticated`, the message names it.
        if (!(got.exit === "4" && got.body.type === "error" && got.body.error?.code === "unauthenticated"
          && got.body.error.message === "caller lacks the settings capability")) {
          problems.push(`agent ${name} from a session: exit ${got.exit} ${got.text}`);
        }
      }
      for (const name of ["test", "logs"]) {
        const got = outcome(name);
        if (!(got.exit === "0" && got.body.type === `agent.${name}`)) problems.push(`agent ${name} from a session: exit ${got.exit} ${got.text}`);
      }
      t.assertions.assert(problems.length === 0, problems.join("\n"));
      t.assertions.assert(journalOf(agent, "action").length === 0, "the refused action reached the script");
      t.assertions.assert(existsSync(path.join(override.dir, "agent.toml")), "the refused reset removed user/codex");
    });
  },
  { durationMs: 30_000, llm: "mock" },
);
