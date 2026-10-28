import { mkdir, writeFile, symlink, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { AssetPreviewError_, ProtocolError_ } from "@genehub/workbench/client";
import type { PreviewFeedbackOperation } from "@genehub/proto";
import { defineJourney, runGenetAsync, openWorkspacePeer } from "../../framework/public.ts";

defineJourney({
  id: "journey.workspace.machine-file-preview",
  title: "Machine file locators intersect live directory sources and caller grants",
  oracle: "Real local WASI daemon returns exact absolute-path bytes, merges project/manual roots with CAS, revokes the last source, denies prefix/symlink escapes and persists machine feedback outside projects",
  catches: ["absolute path bypasses directory policy", "removed project remains authorized", "one duplicate source revokes another", "CAS overwrites a newer policy", "symlink escapes the allowed root", "feedback still depends on workspace mapping"],
  tags: ["core", "workspace", "filesystem", "authorization", "machine-preview"],
  llm: {default: "none"}, expectedDurationMs: 45_000, timeoutMs: 150_000, requiredRepos: ["cloud"],
  surfaces: ["daemon", "workbench-client", "genet-cli"],
  productInterfaces: ["@genehub/workbench/client", "genet file-access", "preview.feedback"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
  let peer: Awaited<ReturnType<typeof openWorkspacePeer>> | undefined;
  try {
    const client = opened.client;
    const read = (file: string) => client.preview("", file);
    const denied = async (file: string) => {
      let refused = false;
      try { await read(file); } catch (error) { refused = error instanceof AssetPreviewError_ && [403, 404].includes(error.status); }
      t.assertions.assert(refused, "file outside the effective directory policy was not refused");
    };
    const directories = async () => {
      const reply = await client.call({type: "fileAccess.list"});
      if (reply?.type !== "fileAccess") throw new Error("directory list absent");
      return reply.data;
    };
    t.assertions.assert(client.identity?.features?.includes("asset.preview.machine-file.v1"), "machine-file capability absent");
    const entry = path.join(opened.workspaceRoot, "entry.txt");
    await writeFile(entry, "exact machine bytes");
    const loaded = await read(entry);
    t.assertions.assert(new TextDecoder().decode(loaded.bytes) === "exact machine bytes" && loaded.metadata.absolutePath === entry, "machine locator returned wrong bytes or identity");
    const old = await client.preview(opened.workspaceId, `${opened.rootHandle}/entry.txt`);
    t.assertions.assert(old.metadata.version === loaded.metadata.version, "v2 adapter changed file identity");

    const extra = path.join(t.env.root, "extra");
    const similar = `${extra}-private`;
    await mkdir(extra); await mkdir(similar);
    const external = path.join(extra, "outside.txt"), secret = path.join(similar, "secret.txt");
    await writeFile(external, "manual bytes"); await writeFile(secret, "not shared");
    await denied(external); await denied(secret);
    const before = await directories();
    const configured = await client.call({type: "fileAccess.configure", payload: {expectedRevision: before.revision, additionalDirectories: [extra]}});
    t.assertions.assert(configured?.type === "fileAccess", "manual directory was not configured");
    t.assertions.assert(new TextDecoder().decode((await read(external)).bytes) === "manual bytes", "manual directory did not authorize its file");
    await denied(secret);
    let conflict = false;
    try { await client.call({type: "fileAccess.configure", payload: {expectedRevision: before.revision, additionalDirectories: []}}); }
    catch (error) { conflict = error instanceof ProtocolError_ && error.detail.code === "conflict"; }
    t.assertions.assert(conflict && (await directories()).additionalDirectories.includes(extra), "stale CAS changed policy");

    // The WASI product must keep the capability boundary, not merely pass a
    // native helper test while its deployed guest opens an ambient path.
    await symlink(similar, path.join(extra, "escape"), process.platform === "win32" ? "junction" : "dir");
    await denied(path.join(extra, "escape", "secret.txt"));
    const project = await client.call({type: "workspace.open", payload: {root: extra}});
    if (project?.type !== "workspace") throw new Error("extra project not opened");
    const container = path.join(t.env.root, "container"); await mkdir(container);
    const definition = path.join(container, "shared.code-workspace");
    await writeFile(definition, JSON.stringify({folders: [{path: extra}]}));
    const second = await client.call({type: "workspace.open", payload: {root: definition}});
    if (second?.type !== "workspace") throw new Error("second registration not opened");
    const origins = (await directories()).directories.find(row => row.absolutePath === extra);
    t.assertions.assert(origins?.additional && origins.workspaceIds.length === 2, "root sources were flattened or lost");
    await client.call({type: "workspace.remove", payload: {workspaceId: project.data.id}});
    const current = await directories();
    await client.call({type: "fileAccess.configure", payload: {expectedRevision: current.revision, additionalDirectories: []}});
    t.assertions.assert(new TextDecoder().decode((await read(external)).bytes) === "manual bytes", "removing two sources revoked the remaining project source");
    await client.call({type: "workspace.remove", payload: {workspaceId: second.data.id}});
    await denied(external);

    const info = await client.call({type: "preview.feedback", payload: {workspaceId: "", operation: {kind: "source", path: entry}}});
    if (info?.type !== "previewFeedback" || info.data.kind !== "source") throw new Error("absolute feedback source absent");
    const draft = await client.call({type: "preview.feedback", payload: {workspaceId: "", operation: {kind: "open", path: entry, version: loaded.metadata.version, draftId: null}}});
    if (draft?.type !== "previewFeedback" || draft.data.kind !== "draft") throw new Error("machine feedback draft absent");
    const records = await readdir(path.join(t.env.data, "preview-feedback", "machine-files", "drafts"));
    t.assertions.assert(records.includes(draft.data.data.id), "draft was not saved in machine-owned storage");
    const persisted = JSON.parse(await readFile(path.join(t.env.data, "preview-feedback", "machine-files", "drafts", draft.data.data.id, "draft.json"), "utf8"));
    t.assertions.assert(persisted.data.source.path === entry, "machine feedback lost the absolute identity");
    const submitted = await client.call({type: "preview.feedback", payload: {workspaceId: "", operation: {kind: "submit", id: draft.data.data.id, description: "Machine feedback proof", annotationIds: [], bundlePaths: []}}});
    if (submitted?.type !== "previewFeedback" || submitted.data.kind !== "receipt") throw new Error("machine feedback receipt absent");
    const receiptFile = await read(submitted.data.data.workspacePath);
    t.assertions.assert(JSON.parse(new TextDecoder().decode(receiptFile.bytes)).id === draft.data.data.id, "ordinary preview cannot open the returned feedback link");
    await denied(path.join(path.dirname(submitted.data.data.workspacePath), "draft.json"));
    await denied(path.join(t.env.data, "config.json"));
    await symlink(secret, path.join(path.dirname(submitted.data.data.workspacePath), "unpublished.txt"));
    await denied(path.join(path.dirname(submitted.data.data.workspacePath), "unpublished.txt"));
    await unlink(path.join(path.dirname(submitted.data.data.workspacePath), "unpublished.txt"));
    t.assertions.assert(JSON.parse(await readFile(submitted.data.data.workspacePath, "utf8")).id === draft.data.data.id, "receipt points to a retired project path");
    const feedbackCli = await runGenetAsync(opened.daemon.genet, ["preview", "feedback", "show", draft.data.data.id], opened.daemon.env);
    t.assertions.assert(feedbackCli.code === 0 && feedbackCli.stdout.includes("Machine feedback proof"), "machine feedback CLI still requires a workspace locator");
    // Golden v1 on-disk Draft shape from the pre-migration product. Keep the
    // source directory intact while repeated public reads import it once.
    const legacySource = await client.call({type: "preview.feedback", payload: {workspaceId: opened.workspaceId, operation: {kind: "source", path: `${opened.rootHandle}/entry.txt`}}});
    if (legacySource?.type !== "previewFeedback" || legacySource.data.kind !== "source") throw new Error("legacy source absent");
    const oldId = `pf_${"1".repeat(32)}`;
    const oldDirectory = path.join(opened.workspaceRoot, ".genethub", "preview-feedback", "drafts", oldId);
    await mkdir(oldDirectory, {recursive: true});
    const oldRecord = JSON.stringify({data: {id: oldId, source: legacySource.data.data, review: {revision: 0, annotations: []}, bundles: [], receipt: null}, shareId: null, kind: "text", snapshot: "source.txt"});
    await writeFile(path.join(oldDirectory, "draft.json"), oldRecord);
    await writeFile(path.join(oldDirectory, "source.txt"), "exact machine bytes");
    for (let index = 0; index < 2; index++) {
      const restored = await client.call({type: "preview.feedback", payload: {workspaceId: opened.workspaceId, operation: {kind: "draft", id: oldId}}});
      t.assertions.assert(restored?.type === "previewFeedback" && restored.data.kind === "draft" && restored.data.data.id === oldId && restored.data.data.source.version === loaded.metadata.version, "legacy feedback failed idempotent import");
    }
    t.assertions.assert(await readFile(path.join(oldDirectory, "draft.json"), "utf8") === oldRecord, "migration modified the original feedback record");
    const refresh = await runGenetAsync(opened.daemon.genet, ["workspace", "open", definition], opened.daemon.env);
    t.assertions.assert(refresh.code === 0 && refresh.stdout.includes(second.data.id), "formal registration refresh lost the existing workspace ID");
    const append = await runGenetAsync(opened.daemon.genet, ["workspace", "add-root", second.data.id, opened.workspaceRoot], opened.daemon.env);
    t.assertions.assert(append.code === 0 && append.stdout.includes(second.data.id), "formal add-root failed to preserve workspace identity");
    const cli = await runGenetAsync(opened.daemon.genet, ["file-access", "list"], opened.daemon.env);
    t.assertions.assert(cli.code === 0 && cli.stdout.includes("additionalDirectories"), "public directory CLI did not return the policy");
    // A real Cloud workspace route must retain the same physical scope for
    // machine locators, record IDs and the final share resource manifest.
    await client.call({type: "workspace.open", payload: {root: extra}});
    const foreign = await read(external);
    const foreignDraft = await client.call({type: "preview.feedback", payload: {workspaceId: "", operation: {kind: "open", path: external, version: foreign.metadata.version, draftId: null}}});
    if (foreignDraft?.type !== "previewFeedback" || foreignDraft.data.kind !== "draft") throw new Error("foreign draft absent");
    const foreignId = foreignDraft.data.data.id;
    peer = await openWorkspacePeer({openRoot: t.openRoot, lease: t.env, client, workspaceId: opened.workspaceId});
    const scoped = peer.client;
    const call = async (operation: PreviewFeedbackOperation) => {
      const reply = await scoped.call({type: "preview.feedback", payload: {workspaceId: "", operation}});
      if (reply?.type !== "previewFeedback") throw new Error("scoped feedback absent");
      return reply.data;
    };
    const refuse = async (action: () => Promise<unknown>) => {
      let rejected = false; try { await action(); } catch { rejected = true; }
      t.assertions.assert(rejected, "workspace admission escaped its physical scope");
    };
    t.assertions.assert(new TextDecoder().decode((await scoped.preview("", entry)).bytes) === "exact machine bytes", "scoped absolute preview failed");
    await call({kind: "source", path: entry});
    const scopedDraft = await call({kind: "open", path: entry, version: loaded.metadata.version, draftId: null});
    if (scopedDraft.kind !== "draft") throw new Error("scoped draft absent");
    const scopeId = scopedDraft.data.id;
    const upload = await call({kind: "beginArtifact", id: scopeId, files: [{name: "note.txt", mime: "text/plain", bytes: 4}], metadata: {}});
    if (upload.kind !== "upload") throw new Error("scoped upload absent");
    await call({kind: "chunk", id: scopeId, uploadId: upload.data.uploadId, fileIndex: 0, offset: 0, dataBase64: Buffer.from("note").toString("base64")});
    const bundle = await call({kind: "finishArtifact", id: scopeId, uploadId: upload.data.uploadId});
    if (bundle.kind !== "artifact") throw new Error("scoped bundle absent");
    const scopeReceipt = await call({kind: "submit", id: scopeId, description: "Scoped preview feedback", annotationIds: [], bundlePaths: [bundle.data.workspacePath]});
    if (scopeReceipt.kind !== "receipt") throw new Error("scoped receipt absent");
    await call({kind: "read", id: scopeId});
    t.assertions.assert(new TextDecoder().decode((await scoped.preview("", `${bundle.data.workspacePath}/note.txt`)).bytes) === "note", "scoped evidence link failed");
    await scoped.preview("", scopeReceipt.data.workspacePath);
    await unlink(`${bundle.data.workspacePath}/note.txt`);
    await symlink(secret, `${bundle.data.workspacePath}/note.txt`);
    await refuse(() => scoped.preview("", `${bundle.data.workspacePath}/note.txt`));
    const share = await call({kind: "share", path: entry, ttlSeconds: 3600, resources: []});
    if (share.kind !== "share") throw new Error("scoped share absent");
    await call({kind: "revoke", shareId: share.data.shareId});
    await refuse(() => scoped.preview("", external));
    await refuse(() => call({kind: "source", path: external}));
    await refuse(() => call({kind: "draft", id: foreignId}));
    await refuse(() => call({kind: "submit", id: foreignId, description: "forbidden", annotationIds: [], bundlePaths: []}));
    await refuse(() => call({kind: "share", path: entry, ttlSeconds: 3600, resources: [external]}));
    const otherShare = await client.call({type: "preview.feedback", payload: {workspaceId: "", operation: {kind: "share", path: external, ttlSeconds: 3600, resources: []}}});
    if (otherShare?.type !== "previewFeedback" || otherShare.data.kind !== "share") throw new Error("foreign share absent");
    const otherShareId = otherShare.data.data.shareId;
    await refuse(() => call({kind: "revoke", shareId: otherShareId}));
    await client.call({type: "preview.feedback", payload: {workspaceId: "", operation: {kind: "revoke", shareId: otherShareId}}});
    await client.call({type: "workspace.remove", payload: {workspaceId: opened.workspaceId}});
    await client.call({type: "workspace.remove", payload: {workspaceId: second.data.id}});
    await denied(submitted.data.data.workspacePath);
    await refuse(() => scoped.preview("", scopeReceipt.data.workspacePath));
    t.note("Real public Client/CLI with local WASI: v2/v3 file identity, manual roots, live source union, revocation, CAS, prefix/symlink confinement and machine feedback storage.");
  } finally { await peer?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
