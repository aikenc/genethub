import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import type { PreviewFeedbackOperation, PreviewFeedbackResponse } from "@genehub/proto";
import { defineJourney, runGenetAsync } from "../../framework/public.ts";

defineJourney({
  id: "journey.workspace.preview-file-feedback",
  title: "Preview feedback belongs to a named root and immutable file version",
  oracle: "Second-root metadata names the project, root and owning machine; notes and bounded log uploads survive reload, receipts are immutable and readable through the public CLI",
  catches: ["opaque root path in info", "feedback bound to a session", "duplicate upload after retry", "submitted feedback remains writable", "different version resumes old evidence"],
  tags: ["core", "workspace", "filesystem", "preview-feedback"],
  llm: { default: "none" }, expectedDurationMs: 20_000, timeoutMs: 60_000,
  surfaces: ["daemon", "asset-preview", "genet-cli"],
  productInterfaces: ["preview.feedback", "genet preview feedback show"],
}, async t => {
  const secondary = path.join(t.env.root, "secondary");
  await mkdir(secondary);
  await writeFile(path.join(secondary, "notes.md"), "# Original\n\nReview this line.\n");
  const config = path.join(t.env.workspace, "Friendly project.code-workspace");
  await writeFile(config, JSON.stringify({ folders: [{ name: "Primary", path: "." }, { name: "Assets", path: secondary }] }));
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const ws = await opened.client.call({ type: "workspace.open", payload: { root: config } });
    if (ws?.type !== "workspace") throw new Error("workspace.open did not return multi-root workspace");
    const workspaceId = ws.data.id;
    await opened.client.call({type: "workspace.rename", payload: {workspaceId, name: "Friendly project"}});
    const sourcePath = `${ws.data.folders[1]!.rootHandle}/notes.md`;
    const call = async (operation: PreviewFeedbackOperation): Promise<PreviewFeedbackResponse> => {
      const reply = await opened.client.call({ type: "preview.feedback", payload: { workspaceId, operation } });
      if (reply?.type !== "previewFeedback") throw new Error("missing preview feedback response");
      return reply.data;
    };
    const hadFeedbackHome = existsSync(path.join(opened.workspaceRoot, ".genethub/preview-feedback"));
    const source = await call({ kind: "source", path: sourcePath });
    t.assertions.assert(existsSync(path.join(opened.workspaceRoot, ".genethub/preview-feedback")) === hadFeedbackHome, "metadata read initialized feedback storage");
    if (source.kind !== "source") throw new Error("missing source info");
    t.assertions.assert(source.data.rootName === "Assets" && source.data.displayPath.includes("Friendly project") && !source.data.displayPath.includes("r_"), `info still exposes the root handle instead of names: ${JSON.stringify(source.data)}`);
    t.assertions.assert(Boolean(source.data.machineName) && source.data.absolutePath === path.join(secondary, "notes.md"), "info omitted machine or owning absolute path");
    const created = await call({ kind: "open", path: sourcePath, version: source.data.version, draftId: null });
    if (created.kind !== "draft") throw new Error("missing feedback draft");
    t.assertions.assert((await readFile(path.join(opened.workspaceRoot, ".genethub/.gitignore"), "utf8")).includes("*"), "feedback storage is visible to project git");
    const id = created.data.id;
    const annotation = { id: "ann-file-review", source: { root: { kind: "primary" as const }, relativePath: sourcePath, contentVersion: source.data.version }, target: { kind: "markdownLines" as const, startLine: 3, endLine: 3, excerpt: "Review this line." }, comment: "Keep the example", createdAtMs: Date.now() };
    await call({ kind: "upsert", id, annotation, expectedRevision: 0 });
    const retry = await call({ kind: "upsert", id, annotation, expectedRevision: 0 });
    t.assertions.assert(retry.kind === "draft" && retry.data.review.annotations.length === 1 && retry.data.review.revision === 1, "annotation retry duplicated evidence");
    const logs = Buffer.from('{"level":"error","message":"visitor log"}\n');
    const begun = await call({ kind: "beginArtifact", id, files: [{ name: "events.jsonl", mime: "application/x-ndjson", bytes: logs.length }], metadata: { purpose: "preview feedback" } });
    if (begun.kind !== "upload") throw new Error("missing artifact upload");
    const chunk = { kind: "chunk" as const, id, uploadId: begun.data.uploadId, fileIndex: 0, offset: 0, dataBase64: logs.toString("base64") };
    await call(chunk); await call(chunk);
    const bundle = await call({ kind: "finishArtifact", id, uploadId: begun.data.uploadId });
    if (bundle.kind !== "artifact") throw new Error("missing artifact bundle");
    await call({ kind: "finishArtifact", id, uploadId: begun.data.uploadId });
    const submit = { kind: "submit" as const, id, description: "Visitor feedback", annotationIds: [annotation.id], bundlePaths: [bundle.data.workspacePath] };
    const receipt = await call(submit);
    const repeated = await call(submit);
    t.assertions.assert(receipt.kind === "receipt" && JSON.stringify(receipt) === JSON.stringify(repeated), "submission retry changed receipt");
    const restored = await call({ kind: "open", path: sourcePath, version: source.data.version, draftId: id });
    t.assertions.assert(restored.kind === "draft" && restored.data.receipt?.id === id && restored.data.bundles.length === 1, "reload lost receipt or duplicated logs");
    for (const operation of [{ kind: "upsert" as const, id, annotation: { ...annotation, comment: "Changed" }, expectedRevision: 1 }, { ...submit, description: "Changed" }, { kind: "open" as const, path: sourcePath, version: "other-version", draftId: id }]) {
      let denied = false;
      try { await call(operation); } catch { denied = true; }
      t.assertions.assert(denied, `accepted invalid ${operation.kind} after submission`);
    }
    const cli = await runGenetAsync(opened.daemon.genet, ["preview", "feedback", "show", id, "--workspace", workspaceId], opened.daemon.env);
    t.assertions.assert(cli.code === 0 && cli.stdout.includes("Visitor feedback") && cli.stdout.includes("visitor log") === false, "public feedback CLI did not retrieve the record with evidence references");
    t.note("Real daemon: named multi-root metadata, file/version notes, chunk/finish/submit retries, persisted receipt, immutable submission and public CLI retrieval.");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
