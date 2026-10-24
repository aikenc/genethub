import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, runGenetAsync, parseJson } from "../../framework/public.ts";

// Compatibility is a refusal, not a hidden execution path. Existing user data
// stays on disk, and ordinary Sessions remain the supported collaboration API.
defineSpecialty({
  id: "specialty.recovery.workflow-retired",
  title: "Removed Workflow cannot be discovered or executed by old clients",
  oracle: "capabilities contains no Workflow/flow command, Hello advertises no scheduler, legacy RPCs refuse, and user package bytes stay untouched",
  catches: ["retired scheduler still executes", "obsolete commands remain discoverable", "retirement deletes user files"],
  tags: ["core", "recovery", "retirement"], llm: { default: "none" },
  expectedDurationMs: 10_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 1, memoryMb: 1024, io: 1, browser: 0 },
  surfaces: ["daemon", "cli", "workbench-client"], productInterfaces: ["genet-cli", "@genehub/workbench/client"],
}, async t => {
  const file = path.join(t.env.workspace, ".genethub/workflows/old/flows/old.yaml");
  mkdirSync(path.dirname(file), { recursive: true });
  const contents = "schema: genehub.workflow.definition.v2\nid: old\n";
  writeFileSync(file, contents);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const call = (args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: t.env.workspace });
    const caps = await call(["capabilities"]);
    t.assertions.assert(caps.code === 0, `capabilities failed: ${caps.stderr}`);
    const commands = (parseJson(caps.stdout).data as { commands: { name: string }[] }).commands;
    t.assertions.assert(commands.length > 0 && !commands.some(command => command.name.startsWith("workflow.") || command.name === "session.flow"), "retired command remains advertised");
    t.assertions.assert(!opened.client.identity?.features?.includes("workflow.control.v1"), "scheduler remains advertised");
    for (const args of [["workflow", "list"], ["schema", "workflow.definition"], ["session", "flow", "missing"]]) {
      const result = await call(args);
      t.assertions.assert(result.code !== 0, `retired command accepted: ${args.join(" ")}`);
    }
    for (const request of [
      { type: "workflow.list", payload: { workspaceId: opened.workspaceId } },
      { type: "workflow.dispatch", payload: { workspaceId: opened.workspaceId, taskId: "old", prompt: "must never run" } },
      { type: "session.flow", payload: { sessionId: "missing" } },
    ] as const) {
      let refusal = "";
      try { await opened.client.call(request as Parameters<typeof opened.client.call>[0]); }
      catch (error) { refusal = String(error); }
      t.assertions.assert(refusal.includes("workflowRetired"), `legacy operation did not report retirement: ${request.type}: ${refusal}`);
    }
    t.assertions.assert(readFileSync(file, "utf8") === contents, "user Workflow file changed");
  } finally {
    opened.client.close();
    try { opened.daemon.stop(); } finally { await opened.mock.stop(); }
  }
});

defineSpecialty({
  id: "specialty.recovery.daemon-stops-active-sessions",
  title: "Authenticated daemon stop drains several active tool processes",
  oracle: "six real Session tool processes are alive before stop; stop reports not running and every observed process is gone",
  catches: ["Session teardown leaks tools", "shutdown waits forever behind running Agent output", "stop returns before daemon exit"],
  tags: ["core", "recovery", "daemon"], llm: { default: "mock" },
  expectedDurationMs: 20_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 0 },
  surfaces: ["daemon", "cli", "agent", "process"], productInterfaces: ["genet-cli", "session.send"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const markers = Array.from({ length: 6 }, (_, i) => path.join(t.env.workspace, `tool-${i}.pid`));
    opened.mock.script(...markers.map(file => ({ tool: { name: "bash", arguments: { command: `echo $$ > '${file}'; exec sleep 300` } } })));
    const ids = await Promise.all(markers.map(() => t.flows.main.createBuiltinSession(opened.client, opened.workspaceId)));
    await Promise.all(ids.map(id => t.flows.main.sendPrompt(opened.client, id, "Run the long tool until the daemon is stopped")));
    await t.tools.waitUntil(() => markers.every(file => existsSync(file)), 45_000);
    const pids = markers.map(file => Number(readFileSync(file, "utf8").trim()));
    t.assertions.assert(pids.every(pid => Number.isInteger(pid) && pid > 1 && t.flows.branches.processAlive(pid)), "owned tool PIDs were not running");
    opened.client.close();
    const stop = await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env, { cwd: t.env.workspace });
    t.assertions.assert(stop.code === 0, `stop failed: ${stop.stderr}`);
    await t.tools.waitUntil(() => pids.every(pid => !t.flows.branches.processAlive(pid)), 5_000);
    const status = await runGenetAsync(opened.daemon.genet, ["daemon", "status"], opened.daemon.env, { cwd: t.env.workspace });
    t.assertions.assert(status.code === 0 && parseJson(status.stdout).running === false, "daemon remains running after stop");
  } finally {
    opened.client.close();
    try { opened.daemon.stop(); } finally { await opened.mock.stop(); }
  }
});
