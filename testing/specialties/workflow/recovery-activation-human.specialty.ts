import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.recovery-activation-human",
  title: "Recovery flow activation needs a durable Human approval",
  oracle: "PM's first custom recovery activation creates a Candidate-bound Human question without changing the active pointer; approval permits that same Candidate and reset selects built-in recovery without editing source",
  catches: ["PM silently activates recovery source changes", "Human approval is not bound to one Candidate", "reset rewrites package source", "reset fails to override new recovery Runs"],
  tags: ["core", "workflow", "workflow-recovery", "session-attention"],
  llm: { default: "mock" }, expectedDurationMs: 35_000, timeoutMs: 95_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.activate", "workflow.inspect", "workflow.recovery.reset", "session.respondPermission"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let stage = "setup";
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedDirectChangePackage({ projectRoot: opened.workspaceRoot });
    const manifest = path.join(source, "workflow.md");
    const cli = async (args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env,
      { cwd: opened.workspaceRoot });
    const initial = await cli(["workflow", "activate", "--revision", "0"]);
    t.assertions.assert(initial.code === 0, `initial activation failed: ${initial.stderr || initial.stdout}`);
    const status = async () => {
      const reply = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId } });
      if (reply?.type !== "workflowProject") throw new Error("Workflow inspection unavailable");
      return reply.data;
    };
    const before = await status();
    t.assertions.assert(before.activationRevision === 1 && !!before.activeDigest, "initial Candidate was not activated");

    writeFileSync(manifest, "---\ndescription: Human activation fixture\nrecovery: flows/recovery.yaml\n---\n");
    writeFileSync(path.join(source, "flows/recovery.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "recovery", version: 1, entry: "review",
      outcomes: { resume: { success: true }, human: { success: false } },
      nodes: [{ id: "review", uses: "agent.session", with: { role: "worker" }, on: { resume: ["publish"], human: [] } },
        { id: "publish", uses: "result.publish" }],
    }));
    let attempts = 0, firstSent = false, retrySent = false, dispatched = false;
    opened.mock.script(...Array.from({ length: 40 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("只读复查被处理的 Run")) return { hang: true as const };
      if (body.includes("START_AFTER_RESET") && !dispatched) {
        dispatched = true;
        return { tool: { name: "bash", arguments: {
          command: '"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task reset-business --message "exercise recovery reset" --no-wait',
        } } };
      }
      const first = body.includes("ACTIVATE_CUSTOM_RECOVERY first") && !firstSent;
      const retry = body.includes("ACTIVATE_CUSTOM_RECOVERY retry") && !retrySent;
      if (first || retry) {
        if (first) firstSent = true;
        if (retry) retrySent = true;
        attempts++;
        return { tool: { name: "bash", arguments: {
          command: '"$GENEHUB_CLI" workflow recovery activate --revision 1',
        } } };
      }
      return { text: "Activation awaits the Human decision." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    stage = "PM asks to activate custom recovery";
    await t.flows.main.sendPrompt(opened.client, pm, "ACTIVATE_CUSTOM_RECOVERY first");
    const pending = async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (reply?.type !== "snapshot") throw new Error("PM Session unavailable");
      return reply.data.pendingPermissions.filter(card => card.id.startsWith("workflow-human-recovery-activation-"));
    };
    await t.tools.waitUntil(async () => (await pending()).length === 1, 20_000);
    const card = (await pending())[0]!;
    t.assertions.assert(card.options?.map(option => option.id).join(",") === "approve,reject",
      "recovery activation card has the wrong Human options");
    const candidate = (await status()).candidateDigest;
    t.assertions.assert(!!candidate && card.detail?.includes(candidate)
      && (await status()).activeDigest === before.activeDigest && (await status()).activationRevision === 1,
    "unapproved recovery Candidate became active or the card omitted its identity");
    const answered = await opened.client.call({ type: "session.respondPermission", payload: {
      sessionId: pm, requestId: card.id, outcome: { outcome: "selected", optionId: "approve" },
    } });
    t.assertions.assert(answered?.type === "ack", "Human approval was not recorded");
    stage = "PM retries the approved Candidate";
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      return reply?.type === "snapshot" && reply.data.summary.status === "idle";
    }, 15_000);
    await t.flows.main.sendPrompt(opened.client, pm, "ACTIVATE_CUSTOM_RECOVERY retry");
    await t.tools.waitUntil(async () => (await status()).activationRevision === 2, 20_000);
    const active = await status();
    t.assertions.assert(attempts === 2 && active.activeDigest === candidate && !active.recoveryBuiltinOverride,
      "Human approval did not activate exactly the reviewed custom Candidate");
    stage = "reset recovery without changing package source";
    const reset = await opened.client.call({ type: "workflow.recovery.reset", payload: {
      workspaceId: opened.workspaceId, expectedRevision: active.activationRevision,
    } });
    t.assertions.assert(reset?.type === "workflowProject" && reset.data.recoveryBuiltinOverride
      && reset.data.activeDigest === candidate && reset.data.activationRevision === 3,
    "recovery reset did not persist the built-in override");
    t.assertions.assert(readFileSync(manifest, "utf8").includes("recovery: flows/recovery.yaml"),
      "recovery reset rewrote the source manifest");
    stage = "start recovery after intentional reset";
    await t.flows.main.sendPrompt(opened.client, pm, "START_AFTER_RESET");
    const recoveryRun = async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
      const business = reply.data.find(run => run.taskId === "reset-business");
      return business && reply.data.find(run => run.handles.some(handle => handle.runId === business.id));
    };
    await t.tools.waitUntil(async () => !!(await recoveryRun()), 45_000);
    const selected = (await recoveryRun())!;
    t.assertions.assert(selected.workflowId === "builtin-recovery", "reset did not select the built-in recovery graph");
    const journal = await cli(["workflow", "journal", "--run", selected.id, "--since", "0", "--limit", "100"]);
    t.assertions.assert(journal.code === 0, `recovery journal unavailable: ${journal.stderr || journal.stdout}`);
    const events = (JSON.parse(journal.stdout) as { data: { events: Array<{ eventType: string }> } }).data.events;
    t.assertions.assert(!events.some(event => event.eventType === "recovery.fallback"),
      "intentional reset was incorrectly reported as a damaged custom recovery fallback");
  } catch (error) {
    throw new Error(`${stage}: ${error}`);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});
