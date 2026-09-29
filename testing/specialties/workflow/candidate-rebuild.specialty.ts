import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.candidate-rebuild",
  title: "An unreadable prior Candidate can be replaced from current source after Human approval",
  oracle: "PM cannot activate past an unknown recovery policy without a Candidate-bound Human answer; approval activates current source while preserving the unusable old snapshot",
  catches: ["invalid old Candidate permanently blocks source activation", "unknown recovery policy bypasses Human approval", "rebuild silently rewrites the old snapshot"],
  tags: ["core", "workflow", "workflow-recovery"],
  llm: { default: "mock" }, expectedDurationMs: 25_000, timeoutMs: 100_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.activate", "workflow.check", "workflow.inspect", "session.respondPermission"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedDirectChangePackage({ projectRoot: opened.workspaceRoot });
    const cli = (args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    const initial = await cli(["workflow", "activate", "--revision", "0"]);
    t.assertions.assert(initial.code === 0, `initial activation failed: ${initial.stderr || initial.stdout}`);
    const executor = path.join(opened.workspaceRoot, ".genethub/components/executor");
    const activationFile = path.join(executor, "packages/local/activation.json");
    const activation = () => JSON.parse(readFileSync(activationFile, "utf8")) as { revision: number; activeDigest: string };
    const before = activation();
    const oldFile = path.join(executor, "candidates", `${before.activeDigest.slice("sha256:".length)}.json`);
    const old = JSON.parse(readFileSync(oldFile, "utf8"));
    old.snapshotDigest = `sha256:${"0".repeat(64)}`;
    const invalidSnapshot = JSON.stringify(old);
    writeFileSync(oldFile, invalidSnapshot);
    const prompt = path.join(source, "prompts/direct-worker.md");
    writeFileSync(prompt, `${readFileSync(prompt, "utf8")}\nRebuilt from current source.\n`);
    const checked = await cli(["workflow", "check", "--draft"]);
    const draft = JSON.parse(checked.stdout).data.draft;
    t.assertions.assert(checked.code === 0 && draft.valid && draft.candidateDigest !== before.activeDigest,
      "current source cannot be checked independently of the invalid active snapshot");

    let first = false, retry = false;
    opened.mock.script(...Array.from({ length: 30 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      const firstAttempt = body.includes("REBUILD_FIRST") && !first;
      const retryAttempt = body.includes("REBUILD_APPROVED") && !retry;
      if (firstAttempt || retryAttempt) {
        if (firstAttempt) first = true;
        if (retryAttempt) retry = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow activate --revision 1' } } };
      }
      return { text: "Activation follows the durable Human decision." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const snapshot = async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (reply?.type !== "snapshot") throw new Error("PM snapshot unavailable");
      return reply.data;
    };
    await t.flows.main.sendPrompt(opened.client, pm, "REBUILD_FIRST");
    await t.tools.waitUntil(async () => (await snapshot()).pendingPermissions.some(card => card.id.startsWith("workflow-human-recovery-activation-")), 25_000);
    const card = (await snapshot()).pendingPermissions.find(item => item.id.startsWith("workflow-human-recovery-activation-"))!;
    t.assertions.assert(card.description?.includes(draft.candidateDigest) && card.description.includes("原候选不可读")
      && activation().revision === before.revision && activation().activeDigest === before.activeDigest,
      "unknown recovery policy changed the pointer before Human approval or approval lost its Candidate binding");
    const answered = await opened.client.call({ type: "session.respondPermission", payload: {
      sessionId: pm, requestId: card.id, outcome: { outcome: "selected", optionId: "approve" },
    } });
    t.assertions.assert(answered?.type === "ack", "Human approval was not accepted");
    await t.tools.waitUntil(async () => (await snapshot()).summary.status === "idle", 20_000);
    await t.flows.main.sendPrompt(opened.client, pm, "REBUILD_APPROVED");
    await t.tools.waitUntil(() => activation().revision === 2, 25_000);
    const inspected = await cli(["workflow", "inspect"]);
    t.assertions.assert(inspected.code === 0 && activation().activeDigest === draft.candidateDigest,
      "approved source did not become the valid active Candidate");
    t.assertions.assert(readFileSync(oldFile, "utf8") === invalidSnapshot,
      "rebuild rewrote or migrated the old snapshot instead of activating a new Candidate");
  } finally {
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
