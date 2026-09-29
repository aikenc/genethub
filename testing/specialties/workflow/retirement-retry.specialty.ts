import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentHostProcesses, BlockedError, defineSpecialty, runGenetAsync } from "../../framework/public.ts";
import type { WorkflowRunStatus } from "@genehub/proto";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
for (const scenario of ["retry"] as const) defineSpecialty({
  id: `specialty.workflow.retirement.${scenario}`,
  title: `Accepted Worker retirement ${scenario} keeps its result and resource ownership`,
  oracle: "A real suspended Agent delays cancellation acknowledgement beyond one close attempt; accepted results stay finishing until verified cleanup, without replay, while resource ownership remains with the same Worker",
  catches: ["a retryable close turns accepted work into a failed program", "cleanup releases a write lease early", "cleanup repeats the Worker effect"],
  tags: ["core", "workflow", "structured-workflow", "retirement"],
  llm: { default: "mock" }, expectedDurationMs: 25_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
  productInterfaces: ["genet workflow", "session.send", "workflow.history", "workflow.check"],
}, async t => {
  if (process.platform !== "linux") throw new BlockedError("Agent suspension requires the Linux process fault environment");
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let pausedPid: number | undefined;
  const resume = () => { if (pausedPid !== undefined) { try { process.kill(pausedPid, "SIGCONT"); } catch {} pausedPid = undefined; } };
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(result.code === 0, result.stderr || result.stdout);
  };
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedDirectChangePackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "RETIREMENT_WORKER: report the assigned result once and retain real effects.\n");
    writeFileSync(path.join(source, "flows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [
        { id: "work", uses: "agent.session", with: { role: "worker" }, completion: { output: { type: "object", properties: { passed: { type: "boolean" } } } } },
        { id: "publish", uses: "result.publish" },
      ],
      structure: { body: { id: "delivery", type: "sequence", steps: [
        { id: "effect", type: "task", activity: "work", input: { op: "literal", value: null } },
        { id: "publish-result", type: "task", activity: "publish", input: { op: "literal", value: null } },
      ] } },
    }));
    await cli(["workflow", "check", "--draft"]);
    const effect = path.join(opened.workspaceRoot, "accepted-effect.txt");
    const release = path.join(opened.workspaceRoot, "release-report");
    const escaped = path.join(opened.workspaceRoot, "escaped-after-report.txt");
    let nextCommand: string | undefined = '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task retirement --no-wait --message "Produce the bounded artifact and publish only after retirement"';
    let workerReported = false;
    opened.mock.script(...Array.from({ length: 30 }, () => ({ respond: (request: unknown) => {
      const text = JSON.stringify(request);
      if (!text.includes("RETIREMENT_WORKER")) {
        if (!nextCommand) return { text: "Observed execution facts." };
        const command = nextCommand; nextCommand = undefined;
        return { tool: { name: "bash", arguments: { command } } };
      }
      if (workerReported) return { text: "Result was already submitted." };
      workerReported = true;
      const barrier = `for i in $(seq 1 400); do test -f ${quote(release)} && break; sleep 0.05; done; test -f ${quote(release)}`;
      return { tool: { name: "bash", arguments: { command: `printf 'completed-once\\n' >> ${quote(effect)} && ${barrier} && "$GENEHUB_CLI" workflow complete --output ${quote(JSON.stringify({ passed: true }))} && sleep 20 && printf 'escaped\\n' > ${quote(escaped)}` } } };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    let inputSeq = 0;
    const send = (text: string) => opened.client.call({ type: "session.send", payload: {
      sessionId: pm, messageId: `u_retirement_${++inputSeq}`, text,
      attachments: [], continuesRound: null,
    } });
    let run: WorkflowRunStatus | undefined;
    const current = async () => {
      const response = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (response?.type !== "workflowRuns") throw new Error("missing public Run history");
      run = response.data.find(item => item.handles.length === 0);
      return run;
    };
    await send("Run the configured delivery, preserving its original goal.");
    await t.tools.waitUntil(async () => existsSync(effect) && !!(await current())?.nodes.find(node => node.uses === "agent.session")?.sessionId, 35_000);
    const worker = run!.nodes.find(node => node.uses === "agent.session")!;
    const agents = agentHostProcesses().filter(row => row.environ.includes(t.env.data) && row.cmd.includes(worker.sessionId!));
    t.assertions.assert(agents.length === 1, `expected one lease-owned Worker Agent, got ${agents.length}`);
    pausedPid = agents[0]!.pid;
    process.kill(pausedPid, "SIGSTOP");
    writeFileSync(release, "report may complete from the already-running real CLI");
    await t.tools.waitUntil(async () => (await current())?.nodes.find(node => node.id === worker.id)?.status === "finishing", 15_000);
    const acceptedAt = run!.nodes.find(node => node.id === worker.id)!.resultAcceptedAtMs;
    // Include patrol admission, the timeline pump's bounded drain and the
    // adapter's cancellation acknowledgement, rather than racing its first try.
    await new Promise(resolve => setTimeout(resolve, 12_000));
    await current();
    t.assertions.assert(run?.status === "running" && run.nodes.find(node => node.id === worker.id)?.status === "finishing", `a delayed cleanup became terminal: ${JSON.stringify(run)}`);
    t.assertions.assert(!run!.nodes.some(node => node.uses === "result.publish"), "published before owned Worker retirement");
    resume();
    await t.tools.waitUntil(async () => ["completed", "blocked"].includes((await current())?.status ?? ""), 35_000);
    const retired = run!.nodes.find(node => node.id === worker.id)!;
    t.assertions.assert(retired.sessionId === worker.sessionId && retired.resultAcceptedAtMs === acceptedAt && (retired.output as { passed?: boolean } | undefined)?.passed === true, "cleanup changed the accepted result or Worker identity");
    t.assertions.assert(readFileSync(effect, "utf8").trim() === "completed-once" && !existsSync(escaped), "Worker effect replayed or a canceled tool escaped retirement");
    t.assertions.assert(run!.nodes.filter(node => node.uses === "agent.session").length === 1, "retirement created a replacement Worker");
    t.assertions.assert(run!.status === "completed" && run!.nodes.some(node => node.uses === "result.publish"), "cleanup retry bypassed retirement");
    t.note(`Delayed one real Agent's abort acknowledgement; ${scenario} retained the accepted result and exactly one disk effect.`);
  } finally {
    resume();
    opened.client.close();
    await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
    await opened.mock.stop();
  }
});
