import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

// Read daemon-issued values from the actual model conversation, never forge approvals.
function field(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    for (const line of value.split("\n").reverse()) {
      try { const found = field(JSON.parse(line), key); if (found !== undefined) return found; } catch { /* non-JSON text */ }
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record[key] !== undefined) return record[key];
    for (const child of Object.values(record).reverse()) {
      const found = field(child, key); if (found !== undefined) return found;
    }
  }
  return undefined;
}

defineSpecialty({
  id: "specialty.workflow.pm-exception-authority",
  title: "An unbound project PM recovers a blocked task and returns to normal permissions",
  oracle: "An approved project keeps normal binding checks; an actual blocked Run lets another PM manage and retry the same request, successful recovery removes the exception, and streamed tool argument fragments execute intact",
  catches: ["every PM always gains project control", "the original Run owner and current PM cannot recover each other's work", "temporary recovery permanently transfers the binding", "empty streaming ids discard tool arguments"],
  tags: ["core", "workflow", "authorization", "pm-exception-recovery", "pm-recovery-authority", "pm-business-assessment"],
  llm: { default: "mock" }, expectedDurationMs: 60_000, timeoutMs: 180_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["session.send", "session.respondPermission", "genet space bootstrap", "genet workflow", ".genethub/workflow"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    rmSync(path.join(opened.workspaceRoot, ".keep"));
    for (const [key, value] of [["user.name", "Journey User"], ["user.email", "journey@example.com"], ["commit.gpgsign", "false"]]) {
      const result = spawnSync("git", ["config", "--global", key!, value!], { env: opened.daemon.env, encoding: "utf8" });
      t.assertions.assert(result.status === 0, "isolated Git configuration failed");
    }
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    let bootstrapStage = 0, command: string | undefined, workerCalls = 0;
    let phase = "bootstrap", commandTaken = false;
    const assessed = new Set<string>();
    const respond = (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("<genehub_managed_session>") && body.includes("角色标签为 `reviewer`")) {
        const assessment = body.includes("`game-assessment`") ? "assessment" : "review";
        if (!assessed.has(assessment)) {
          assessed.add(assessment);
          const report = JSON.stringify({ verdict: "partial", subject: assessment, scope: "melee and ranged cultivation action game", findings: ["Existing ranged combat reusable; melee needs new collision and animation"], evidence: ["current artifact inspected"], uncertainty: ["combat feel requires prototype"], recommendation: "prototype before implementation" });
          return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow complete --evidence 'report=${report}'` } } };
        }
        return { text: "Business report submitted without implementation." };
      }
      if (body.includes("EXCEPTION_TEST_WORKER")) {
        workerCalls++;
        if (workerCalls === 1) return { text: "Unable to finish; no node result submitted." };
        if (workerCalls % 2 === 0) return { emptyToolIdDeltas: true, tool: { name: "genet", arguments: { args: ["workflow", "complete", "--evidence", "review=approved"] } } };
        return { text: "Recovered result submitted." };
      }
      if (phase === "bootstrap") {
        const stage = bootstrapStage++;
        if (stage === 0) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1' } } };
        if (stage === 1) return { tool: { name: "request_user_input", arguments: { questions: [{ id: field(request, "challengeId"), header: "接管", question: "确认接管项目", options: [{ label: "yes", description: "接管" }, { label: "no", description: "不接管" }] }] } } };
        if (stage === 2) return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" space bootstrap apply --pack game-delivery-v1 --plan-digest ${field(request, "planDigest")} --expected-revision ${field(request, "expectedRevision")} --action-id initial-takeover` } } };
      } else if (command && body.includes(phase)) {
        const value = command; command = undefined; commandTaken = true;
        return { emptyToolIdDeltas: true, tool: { name: "bash", arguments: { command: value } } };
      }
      return { text: "Request processed." };
    };
    opened.mock.script(...Array.from({ length: 100 }, () => ({ respond })));
    let owner = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const snapshot = async (sessionId: string): Promise<SessionSnapshot> => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
      if (reply?.type !== "snapshot") throw new Error("missing Session");
      return reply.data;
    };
    await t.flows.main.sendPrompt(opened.client, owner, "Bootstrap this project.");
    await t.tools.waitUntil(async () => (await snapshot(owner)).pendingPermissions.length > 0, 40_000)
      .catch(async error => { throw new Error(`bootstrap stage=${bootstrapStage}: ${error}; ${JSON.stringify(opened.mock.requests).slice(-12000)}`); });
    const permission = (await snapshot(owner)).pendingPermissions[0]!;
    await opened.client.call({ type: "session.respondPermission", payload: { sessionId: owner, requestId: permission.id, outcome: { outcome: "selected", optionId: "approve-once" } } });
    await t.tools.waitUntil(async () => bootstrapStage >= 4 && (await snapshot(owner)).summary.status === "idle", 50_000);
    const installed = await opened.client.call({ type: "workspace.list" });
    t.assertions.assert(installed?.type === "workspaces" && installed.data.find(space => space.id === opened.workspaceId)?.agentSpace?.components.some(component => component.componentId === "pm" && component.enabled), `bootstrap did not install PM: ${JSON.stringify(installed)}`);
    const source = path.join(opened.workspaceRoot, ".genethub/workflow");
    const workflowFile = path.join(source, "workflows/game-feature.yaml");
    const schema = readFileSync(workflowFile, "utf8").split("\n")[0]?.split(": ")[1];
    const roleFile = path.join(source, "roles/coder.yaml");
    const roleSchema = readFileSync(roleFile, "utf8").split("\n")[0]?.split(": ")[1];
    writeFileSync(roleFile, JSON.stringify({ schema: roleSchema, id: "coder", agentId: "genet", modelId: "deepseek/deepseek-v4-flash", evidenceOnly: true, userInteraction: "readOnly", prompt: "prompts/exception-worker.md" }));
    writeFileSync(path.join(source, "prompts/exception-worker.md"), "EXCEPTION_TEST_WORKER: complete assigned node only.");
    writeFileSync(workflowFile, JSON.stringify({ schema, id: "game-feature", version: 1, entry: "check", nodes: [
      { id: "check", uses: "agent.session", with: { role: "coder", workspace: "." }, completion: { all: [{ key: "review", verify: "value.equals", expected: "approved" }] }, on: { completed: ["publish"] } },
      { id: "publish", uses: "result.publish" },
    ] }));
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 50 } });
      if (reply?.type !== "workflowRuns") throw new Error("missing history");
      return reply.data;
    };
    const runCommand = async (pm: string, marker: string, value: string, taskRunId?: string) => {
      phase = marker; command = value; commandTaken = false;
      const start = opened.mock.requests.length;
      const reply = await opened.client.call({ type: "session.send", payload: { sessionId: pm, messageId: marker, text: marker, taskRunId, attachments: [], continuesRound: null, artifactPreviewBaseUrl: null } });
      t.assertions.assert(reply?.type === "ack", `input refused: ${JSON.stringify(reply)}`);
      await t.tools.waitUntil(async () => commandTaken && (await snapshot(pm)).summary.status === "idle", 40_000)
        .catch(async error => { throw new Error(`${marker}, commandTaken=${commandTaken}: ${error}; ${JSON.stringify((await snapshot(pm)).items).slice(-6500)}`); });
      const requests = opened.mock.requests.slice(start).filter(request => JSON.stringify(request).includes(marker));
      const latest = requests.at(-1) as { messages?: Array<{ role: string; content?: string }> } | undefined;
      return latest?.messages?.filter(message => message.role === "tool").at(-1)?.content ?? "missing tool result";
    };
    // The existing product transfers normal control when Human opens a new PM.
    // The prior PM becomes the unbound recovery candidate.
    const other = owner;
    owner = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    t.assertions.assert(other !== owner, "test did not create a second PM Session");
    const dispatch = (task: string) => `"$GENEHUB_CLI" workflow dispatch --workflow game-feature --task ${task} --message recover --no-wait`;
    const denied = await runCommand(other, "u_normal_denied", '"$GENEHUB_CLI" workflow activate --revision 0');
    t.assertions.assert(denied.includes("forbidden") && (await history()).length === 0, `normal unbound PM gained management: ${denied}`);
    const status = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId } });
    if (status?.type !== "workflowProject") throw new Error("candidate did not compile");
    const initial = await runCommand(owner, "u_owner_start", `"$GENEHUB_CLI" workflow activate --revision ${status.data.activationRevision} && ${dispatch("original")}`);
    t.assertions.assert(!initial.includes('"error"'), `owner could not start the candidate: ${initial}`);
    await t.tools.waitUntil(async () => (await history()).some(run => run.status === "blocked"), 35_000)
      .catch(async error => { throw new Error(`${error}; initial=${initial}; runs=${JSON.stringify(await history())}; workerCalls=${workerCalls}`); });
    const original = (await history())[0]!;
    const worker = original.nodes.find(node => node.sessionId)?.sessionId!;
    const stopped = await runCommand(other, "u_exception_worker", `"$GENEHUB_CLI" session interrupt ${worker}`);
    t.assertions.assert(!stopped.includes("forbidden"), "exception PM cannot control project-managed execution");
    const unrelatedRoot = path.join(t.env.root, "unrelated-project");
    mkdirSync(unrelatedRoot);
    const unrelated = await opened.client.call({ type: "workspace.open", payload: { root: unrelatedRoot } });
    if (unrelated?.type !== "workspace") throw new Error("unrelated workspace not opened");
    const foreign = await runCommand(other, "u_foreign_denied", `"$GENEHUB_CLI" space component set --workspace ${unrelated.data.id} --component pm --revision 0 --plan`);
    t.assertions.assert(foreign.includes("forbidden"), "exception authority escaped the project");
    // No Human challenge or binding transfer should be needed in an actual exception.
    const spaces = await opened.client.call({ type: "workspace.list" });
    if (spaces?.type !== "workspaces") throw new Error("missing project experts");
    const coder = spaces.data.find(space => space.name === "coder")!;
    const built = await runCommand(other, "u_exception_builder", '"$GENEHUB_CLI" space builder build --name coder --require-no-post-commands');
    t.assertions.assert(field(built, "status") === "ok", `exception PM could not repair expert projections: ${built}`);
    const moving = await runCommand(other, "u_foreign_parent_denied", `"$GENEHUB_CLI" space parent set --workspace ${coder.id} --parent ${unrelated.data.id} --revision ${coder.agentSpace!.revision} --plan`);
    t.assertions.assert(moving.includes("forbidden"), "exception moved a project expert into a foreign project");
    const component = coder.agentSpace!.components[0]!;
    const configure = `"$GENEHUB_CLI" space component set --workspace ${coder.id} --component ${component.componentId} --role ${component.role} --revision ${coder.agentSpace!.revision}`;
    const plan = await runCommand(other, "u_exception_plan", `${configure} --plan`);
    t.assertions.assert(typeof field(plan, "planDigest") === "string" && field(plan, "challengeId") === undefined, "exception PM was sent back to Human approval");
    const applied = await runCommand(other, "u_exception_manage", `${configure} --plan-digest ${field(plan, "planDigest")} --action-id exception-component`);
    t.assertions.assert(!applied.includes("caller lacks") && !applied.includes("approvalRequired") && !applied.includes("forbidden"), "outer capability gate blocked exceptional project management");
    const updatedSpaces = await opened.client.call({ type: "workspace.list" });
    t.assertions.assert(updatedSpaces?.type === "workspaces" && updatedSpaces.data.find(space => space.id === coder.id)?.agentSpace?.revision === coder.agentSpace!.revision + 1, "exception management did not change the real expert");
    const recovered = await runCommand(other, "u_exception_recover", `${dispatch("recovered")} --retry-of ${original.id}`, original.id);
    t.assertions.assert(!recovered.includes("retry target belongs to another PM"), "exception did not cross the original PM ownership boundary");
    await t.tools.waitUntil(async () => (await history()).some(run => run.taskId === "recovered" && run.status === "completed"), 40_000)
      .catch(async error => { throw new Error(`${error}; retry=${recovered}; workerCalls=${workerCalls}; runs=${JSON.stringify(await history())}`); });
    const successor = (await history()).find(run => run.taskId === "recovered")!;
    t.assertions.assert(successor.requestRunId === original.id && successor.parentSessionId === other, "recovery lost request lineage or responding PM");
    // A successful recovery withdraws management escalation, but the user's next
    // business request must remain usable in this original conversation.
    const beforeAssessment = spawnSync("git", ["status", "--porcelain=v1"], { cwd: opened.workspaceRoot, env: opened.daemon.env, encoding: "utf8" }).stdout;
    for (const kind of ["assessment", "review"]) {
      const delegated = await runCommand(other, `u_business_${kind}`, `"$GENEHUB_CLI" workflow dispatch --kind game --complexity ${kind} --task business-${kind} --message "Assess melee and ranged cultivation gameplay; report only" --no-wait`);
      t.assertions.assert(!delegated.includes("forbidden"), `old PM could not delegate business ${kind}: ${delegated}`);
      await t.tools.waitUntil(async () => (await history()).some(run => run.taskId === `business-${kind}` && run.status === "completed"), 40_000)
        .catch(async error => { throw new Error(`${error}; ${delegated}; runs=${JSON.stringify(await history())}; requests=${JSON.stringify(opened.mock.requests).slice(-8000)}`); });
      const reportRun = (await history()).find(run => run.taskId === `business-${kind}`)!;
      t.assertions.assert(reportRun.workflowId === `game-${kind}` && reportRun.parentSessionId === other, "business result did not return to the original PM");
      const assessmentNode = reportRun.nodes.find(node => node.sessionId)!;
      const expert = (await snapshot(assessmentNode.sessionId!)).summary;
      t.assertions.assert(expert.managed?.role === "reviewer", "business request was routed to workflow infrastructure");
      t.assertions.assert(JSON.stringify(reportRun).includes("partial"), "negative business conclusion was lost or treated as acceptance");
    }
    t.assertions.assert(spawnSync("git", ["status", "--porcelain=v1"], { cwd: opened.workspaceRoot, env: opened.daemon.env, encoding: "utf8" }).stdout === beforeAssessment, "assessment changed project files");
    const afterPlan = await runCommand(other, "u_settled_management_denied", `${configure} --plan`);
    t.assertions.assert(afterPlan.includes("forbidden"), "exception left unrelated expert management enabled");
    const closedControl = await runCommand(other, "u_settled_worker_denied", `"$GENEHUB_CLI" session interrupt ${worker}`);
    t.assertions.assert(closedControl.includes("forbidden"), "exception retained control of another PM's managed Session");
    const normalBuilder = await runCommand(other, "u_settled_builder_denied", '"$GENEHUB_CLI" space builder build --name coder --require-no-post-commands');
    t.assertions.assert(normalBuilder.includes("forbidden"), "normal PM gained direct Builder write permission");
    const ownerAgain = await runCommand(owner, "u_owner_unchanged", dispatch("owner-unchanged"));
    t.assertions.assert(!ownerAgain.includes("ProjectControlBinding"), "recovery transferred normal project control");
    await t.tools.waitUntil(async () => (await history()).length === 5, 20_000);
    t.note("management denial -> exception recovery -> business assessment and review in original PM -> management still denied; binding unchanged");
  } finally {
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
