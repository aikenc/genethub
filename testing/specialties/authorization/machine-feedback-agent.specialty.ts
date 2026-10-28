import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.authorization.machine-feedback-agent",
  title: "An ordinary Agent reads machine feedback through its bound CLI",
  oracle: "A real Agent bash tool retrieves the submitted receipt without a workspace argument while context retains its verified SessionController identity",
  catches: ["machine feedback rejected by stale workspace equality", "identity removed to impersonate a local user", "CLI receipt differs from the submitted feedback"],
  tags: ["core", "authorization-depth", "machine-preview", "genet-cli"],
  llm: { default: "mock" },
  expectedDurationMs: 20_000, timeoutMs: 90_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "filesystem"],
  productInterfaces: ["@genehub/workbench/client", "preview.feedback", "genet preview feedback show", "genet context"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const entry = path.join(opened.workspaceRoot, "entry.txt");
    await writeFile(entry, "machine feedback source");
    const source = await opened.client.preview("", entry);
    const draft = await opened.client.call({ type: "preview.feedback", payload: {
      workspaceId: "", operation: { kind: "open", path: entry, version: source.metadata.version, draftId: null },
    } });
    if (draft?.type !== "previewFeedback" || draft.data.kind !== "draft") throw new Error("machine feedback draft absent");
    const id = draft.data.data.id;
    const submitted = await opened.client.call({ type: "preview.feedback", payload: {
      workspaceId: "", operation: { kind: "submit", id, description: "Agent machine feedback proof", annotationIds: [], bundlePaths: [] },
    } });
    t.assertions.assert(submitted?.type === "previewFeedback" && submitted.data.kind === "receipt", "feedback was not submitted");
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    opened.mock.script({ tool: { name: "bash", arguments: { command: [
      '"$GENEHUB_CLI" context > agent-context.json',
      `"$GENEHUB_CLI" preview feedback show ${id} > agent-feedback.json 2> agent-feedback.err`,
      'printf "%s" "$?" > agent-feedback.exit',
    ].join("; ") } } }, { text: "Finished." });
    await t.flows.main.sendPrompt(opened.client, sessionId, "Read the submitted preview feedback using the bound CLI.");
    const output = (name: string) => path.join(opened.workspaceRoot, name);
    await t.tools.waitUntil(() => access(output("agent-feedback.exit")).then(() => true, () => false), 45_000);
    const context = JSON.parse(await readFile(output("agent-context.json"), "utf8"));
    t.assertions.assert(context.data.authority.principalType === "sessionController" && context.data.authority.sessionId === sessionId,
      "Agent CLI did not retain its real SessionController identity");
    const exit = (await readFile(output("agent-feedback.exit"), "utf8")).trim();
    const receipt = await readFile(output("agent-feedback.json"), "utf8");
    t.assertions.assert(exit === "0", `Agent feedback CLI failed: exit=${exit}; ${receipt.slice(0, 600)}`);
    t.assertions.assert(receipt.includes(id) && receipt.includes("Agent machine feedback proof"), "Agent did not retrieve the submitted receipt");
    t.note("Real Agent bash + bound CLI retained SessionController identity and read machine feedback without workspace mapping.");
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});
