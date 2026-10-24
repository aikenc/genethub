import { mkdir, writeFile, symlink, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { AssetPreviewError_, ProtocolError_ } from "@genehub/workbench/client";
import { defineJourney, runGenetAsync } from "../../framework/public.ts";

defineJourney({
  id: "journey.workspace.machine-file-preview",
  title: "Machine file locators intersect live directory sources and caller grants",
  oracle: "Real local WASI daemon returns exact absolute-path bytes, merges project/manual roots with CAS, revokes the last source, denies prefix/symlink escapes and persists machine feedback outside projects",
  catches: ["absolute path bypasses directory policy", "removed project remains authorized", "one duplicate source revokes another", "CAS overwrites a newer policy", "symlink escapes the allowed root", "feedback still depends on workspace mapping"],
  tags: ["core", "workspace", "filesystem", "authorization", "machine-preview"],
  llm: {default: "none"}, expectedDurationMs: 30_000, timeoutMs: 90_000,
  surfaces: ["daemon", "workbench-client", "genet-cli"],
  productInterfaces: ["@genehub/workbench/client", "genet file-access", "preview.feedback"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
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
    t.note("Real public Client/CLI with local WASI: v2/v3 file identity, manual roots, live source union, revocation, CAS, prefix/symlink confinement and machine feedback storage.");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
