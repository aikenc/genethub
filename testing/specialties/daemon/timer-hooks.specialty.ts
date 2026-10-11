// A project's timer hooks are commands the daemon runs on a schedule, found by
// reading `<project>/.genethub/hooks/`. These cases hold the shipped daemon (a
// wasm component starting processes through its host) to the contract that
// coordinating scripts depend on:
//
//   - a hook file is picked up with no registration, runs on its interval,
//     and an edit, a disable and a delete take effect without a restart;
//   - the command gets GeneHub's variables and the project's open.env, and can
//     call back into the daemon with the CLI it is handed;
//   - a broken file is listed with the reason, a failing hook keeps running
//     with its failures counted, and a hook that hangs is ended together with
//     what it started.
//
// Only the LLM endpoint is ever replaced in these cases, and none of them needs
// a model: hooks are run by the daemon, not by an Agent.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  defineSpecialty,
  localGenetCli,
  type CaseContext,
  type GenetCliResult,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Cli = ReturnType<typeof localGenetCli>;

interface HookRow {
  id: string;
  valid: boolean;
  problem?: string;
  enabled: boolean;
  running: boolean;
  runs: number;
  everySeconds?: number;
  owner?: string;
  lastExitCode?: number;
  lastTimedOut?: boolean;
  consecutiveFailures: number;
  lastError?: string;
}

function hookCase(
  name: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, opened: Opened, cli: Cli, root: string) => Promise<void>,
  durationMs = 30_000,
): void {
  defineSpecialty(
    {
      id: `specialty.daemon.timer-hooks.${name}`,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "timer-hooks", "genet-cli"],
      llm: { default: "none" },
      expectedDurationMs: durationMs,
      timeoutMs: Math.max(durationMs * 4, 90_000),
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "genet-cli"],
      productInterfaces: ["genet-cli", "@genehub/workbench/client"],
    },
    async (t) => {
      const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      try {
        await run(t, opened, localGenetCli(t.openRoot, t.env), opened.workspaceRoot);
      } finally {
        opened.client.close();
        opened.daemon.stop();
        await opened.mock.stop();
      }
    },
  );
}

const hooksDir = (root: string) => path.join(root, ".genethub", "hooks");

function writeHook(root: string, id: string, body: Record<string, unknown>): void {
  mkdirSync(hooksDir(root), { recursive: true });
  // The way a script is told to write one: a whole file, put in place at once.
  const target = path.join(hooksDir(root), `${id}.genet.json`);
  writeFileSync(`${target}.tmp`, JSON.stringify(body));
  rmSync(target, { force: true });
  writeFileSync(target, readFileSync(`${target}.tmp`));
  rmSync(`${target}.tmp`);
}

const lines = (root: string, name: string): string[] =>
  existsSync(path.join(root, name))
    ? readFileSync(path.join(root, name), "utf8").split("\n").filter(Boolean)
    : [];

function listed(t: CaseContext, result: GenetCliResult): HookRow[] {
  t.assertions.assert(result.code === 0, `genet hook list: exit ${result.code} ${result.stderr.slice(-300)} ${result.stdout.slice(-300)}`);
  const body = result.envelope;
  t.assertions.assert(body?.type === "hook.list", `envelope ${result.stdout.slice(-300)}`);
  return (body!.data as { hooks: HookRow[] }).hooks;
}

const sh = (script: string): string[] => ["sh", "-c", script];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

hookCase(
  "reads-the-directory-fresh",
  "a hook file runs on its interval, and an edit, a disable and a delete take effect without a restart",
  "a file written into .genethub/hooks/ is run by the daemon every interval with no registration; open.env values and GeneHub's variables reach the command; switching it off stops the runs, switching it back on resumes them, and deleting the file ends them; `genet hook list` reports it valid with its run count",
  [
    "a hook needing a registration step or a daemon restart to take effect",
    "a disabled or deleted hook that keeps running",
    "the project's open.env not reaching the command",
    "the command missing GeneHub's own variables",
  ],
  async (t, opened, cli, root) => {
    mkdirSync(path.join(root, ".genethub"), { recursive: true });
    writeFileSync(path.join(root, ".genethub", "open.env"), "FOO=bar\n");
    const hook = (extra: Record<string, unknown> = {}) => ({
      schema: "genet.hook.v1",
      event: "timer",
      every: "1s",
      exec: sh('echo "$GENEHUB_HOOK_ID|$GENEHUB_HOOK_EVENT|$FOO|$(test -n "$GENEHUB_SPACE_DIR" && echo dir)" >> ticks.log'),
      owner: "test:timer-hooks",
      ...extra,
    });
    writeHook(root, "tick", hook());
    await t.tools.waitUntil(() => lines(root, "ticks.log").length >= 3, 30_000);
    t.assertions.assert(
      lines(root, "ticks.log").every((line) => line === "tick|timer|bar|dir"),
      `the command did not get the expected environment: ${JSON.stringify(lines(root, "ticks.log").slice(0, 3))}`,
    );
    const row = listed(t, cli(["hook", "list", "--workspace", opened.workspaceId])).find((item) => item.id === "tick");
    t.assertions.assert(
      row?.valid === true && row.enabled && row.runs >= 1 && row.consecutiveFailures === 0 && row.owner === "test:timer-hooks" && row.everySeconds === 1,
      `hook list row: ${JSON.stringify(row)}`,
    );

    // Off: the runs stop, with no restart and no command.
    writeHook(root, "tick", hook({ enabled: false }));
    await sleep(2_500);
    const frozen = lines(root, "ticks.log").length;
    await sleep(3_000);
    t.assertions.assert(lines(root, "ticks.log").length === frozen, "a disabled hook kept running");
    t.assertions.assert(
      listed(t, cli(["hook", "list", "--workspace", opened.workspaceId])).find((item) => item.id === "tick")?.enabled === false,
      "hook list still shows the hook enabled",
    );

    // On again, and a new value in open.env is read by the very next run.
    writeFileSync(path.join(root, ".genethub", "open.env"), "FOO=baz\n");
    writeHook(root, "tick", hook());
    await t.tools.waitUntil(() => lines(root, "ticks.log").some((line) => line === "tick|timer|baz|dir"), 30_000);

    // Deleted: gone from the list and no more runs.
    rmSync(path.join(hooksDir(root), "tick.genet.json"));
    await sleep(2_500);
    const ended = lines(root, "ticks.log").length;
    await sleep(3_000);
    t.assertions.assert(lines(root, "ticks.log").length === ended, "a deleted hook kept running");
    t.assertions.assert(
      !listed(t, cli(["hook", "list", "--workspace", opened.workspaceId])).some((item) => item.id === "tick"),
      "a deleted file is still listed",
    );
  },
  60_000,
);

hookCase(
  "the-command-can-call-back-into-the-daemon",
  "a hook is handed a CLI that reaches the same daemon and the stdin envelope the daemon builds",
  "the command receives GENEHUB_CLI and runs `session list` through it against the daemon that started it; its stdin is one JSON line naming the event, the hook and the project",
  [
    "a hook with no way to reach the daemon that started it",
    "the stdin envelope missing or malformed",
  ],
  async (t, opened, _cli, root) => {
    const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    writeHook(root, "callback", {
      event: "timer",
      every: "1s",
      exec: sh('cat > stdin.txt; "$GENEHUB_CLI" session list > sessions.json 2> sessions.err; echo $? > sessions.exit'),
      payload: { expert: "demo" },
    });
    await t.tools.waitUntil(() => lines(root, "sessions.exit").length > 0, 30_000);
    t.assertions.assert(
      lines(root, "sessions.exit")[0] === "0",
      `the hook's CLI failed: exit=${lines(root, "sessions.exit")[0]} err=${readFileSync(path.join(root, "sessions.err"), "utf8").slice(-300)}`,
    );
    t.assertions.assert(readFileSync(path.join(root, "sessions.json"), "utf8").includes(session), "the hook's CLI reached a different daemon");
    const envelope = JSON.parse(lines(root, "stdin.txt")[0] ?? "null") as Record<string, unknown> | null;
    t.assertions.assert(
      envelope?.event === "timer" && envelope.hook === "callback" && (envelope.payload as { expert?: string })?.expert === "demo"
        && (envelope.space as { dir?: string })?.dir === root,
      `stdin envelope: ${JSON.stringify(envelope)}`,
    );
  },
);

hookCase(
  "broken-failing-and-hanging-hooks-are-contained",
  "a broken file is listed with its reason, a failing hook keeps running with its failures counted, and a hanging one is ended with its children",
  "an invalid hook file is listed as invalid with a problem and never runs; a hook that exits non-zero is run again and again with consecutiveFailures rising and its stderr in lastError, and is never disabled; a hook that hangs is ended at its timeout together with the process it started, and reported as timed out",
  [
    "a broken hook file silently ignored so nobody can tell why it never fires",
    "a failing hook disabled or stopped, leaving a state someone must undo",
    "a hung hook never ended, or its child left running",
    "one bad hook preventing the others from running",
  ],
  async (t, opened, cli, root) => {
    mkdirSync(hooksDir(root), { recursive: true });
    writeFileSync(path.join(hooksDir(root), "broken.genet.json"), "{");
    writeHook(root, "flaky", { event: "timer", every: "1s", exec: sh("echo boom >&2; exit 3") });
    writeHook(root, "hang", {
      event: "timer",
      every: "60s",
      timeout: 1,
      exec: sh("sleep 600 & echo $! > child.pid; wait"),
    });
    writeHook(root, "healthy", { event: "timer", every: "1s", exec: sh("echo ok >> healthy.log") });

    await t.tools.waitUntil(() => {
      const rows = listed(t, cli(["hook", "list", "--workspace", opened.workspaceId]));
      const flaky = rows.find((row) => row.id === "flaky");
      const hang = rows.find((row) => row.id === "hang");
      return (flaky?.consecutiveFailures ?? 0) >= 2 && (hang?.runs ?? 0) >= 1 && !hang?.running;
    }, 40_000);
    const rows = listed(t, cli(["hook", "list", "--workspace", opened.workspaceId]));
    const row = (id: string) => rows.find((item) => item.id === id);

    t.assertions.assert(
      row("broken")?.valid === false && /valid JSON/.test(row("broken")?.problem ?? "") && row("broken")?.runs === 0,
      `broken file: ${JSON.stringify(row("broken"))}`,
    );
    t.assertions.assert(
      row("flaky")?.enabled === true && row("flaky")?.lastExitCode === 3 && /boom/.test(row("flaky")?.lastError ?? ""),
      `failing hook: ${JSON.stringify(row("flaky"))}`,
    );
    t.assertions.assert(
      row("hang")?.lastTimedOut === true && /timed out after 1s/.test(row("hang")?.lastError ?? ""),
      `hanging hook: ${JSON.stringify(row("hang"))}`,
    );
    t.assertions.assert(lines(root, "healthy.log").length >= 2, "a bad neighbour stopped a healthy hook from running");

    // What the hung hook started is gone with it.
    const child = Number(lines(root, "child.pid")[0]);
    t.assertions.assert(Number.isInteger(child) && child > 1, `no child pid recorded: ${lines(root, "child.pid")}`);
    await t.tools.waitUntil(() => {
      try {
        process.kill(child, 0);
        return false;
      } catch {
        return true;
      }
    }, 20_000).catch(() => {
      throw new Error(`the hung hook's child ${child} outlived the hook`);
    });
  },
  45_000,
);
