import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProtocolError_ } from "@genehub/workbench/client";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.cold-session-read-isolation",
  title: "Opening one cold conversation stays responsive with large unrelated metadata",
  oracle: "While twelve real sidebar queries read unrelated metadata, public session.get opens the selected cold conversation within one second; every list completes and drafts and preview annotations remain readable.",
  catches: ["cold conversation reads enumerate unrelated conversations", "a small session waits for unrelated metadata parsing", "point lookup loses native session identity"],
  tags: ["core", "performance", "session-read"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["session.create", "session.get", "session.drafts", "session.previewAnnotations.get"],
  surfaces: ["daemon", "filesystem", "workbench-client"],
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 2, browser: 0, pool: "standard" },
  expectedDurationMs: 15_000, timeoutMs: 180_000,
}, async t => {
  let opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const target = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const siblings: string[] = [];
    for (let index = 0; index < 64; index++) {
      siblings.push(await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId));
    }
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
    opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    // Another compatible writer can add metadata fields. Populate them after
    // startup so the measurement concerns opening a conversation, not recovery.
    const extension = "x".repeat(2 * 1024 * 1024);
    for (const id of siblings) {
      const file = join(t.env.workspace, ".genethub", "sessions", id, "meta.json");
      const meta = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...meta, futureExtension: extension }));
    }
    // User navigation competes with other windows and Team observers. Keep
    // those real public reads in flight rather than measuring an idle daemon.
    const background = Array.from({ length: 12 }, () => opened.client.call({
      type: "session.list", payload: { workspaceId: null, includeArchived: true, lean: true },
    }));
    await new Promise(resolve => setTimeout(resolve, 50));
    const start = performance.now();
    const reply = await opened.client.call({ type: "session.get", payload: { sessionId: target, recentRounds: 1 } });
    const elapsed = performance.now() - start;
    const lists = await Promise.all(background);
    t.note(`coldSessionGetMs=${Math.round(elapsed)} unrelatedMetadataBytes=${64 * extension.length}`);
    t.assertions.assert(lists.every(list => list?.type === "sessions" && list.data.some(session => session.id === target)), "background queries lost the native conversation");
    t.assertions.assert(reply?.type === "snapshot" && reply.data.summary.id === target, "wrong native conversation opened");
    t.assertions.assert(elapsed < 1000, `small cold conversation took ${Math.round(elapsed)}ms with unrelated metadata`);
    const [drafts, annotations] = await Promise.all([
      opened.client.call({ type: "session.drafts", payload: { sessionId: target } }),
      opened.client.call({ type: "session.previewAnnotations.get", payload: { sessionId: target } }),
    ]);
    t.assertions.assert(drafts?.type === "sessionDrafts" && annotations?.type === "previewAnnotations", "cold read lost auxiliary session data");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});

defineSpecialty({
  id: "specialty.daemon.cold-session-read-boundaries",
  title: "Cold lookup retains project identity, future-format refusal and deletion fences",
  oracle: "After a real restart, public reads select the newest copied native ID, retain another project's own conversation, and refuse a future layout, deleted leftover and path traversal.",
  catches: ["point lookup chooses a different project than the catalog", "a deleted directory resurrects", "an unsupported layout opens", "a session ID becomes a filesystem path"],
  tags: ["core", "session-read", "recovery-depth"], llm: { default: "none" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  productInterfaces: ["workspace.open", "session.create", "session.get", "session.delete", "session.list"],
  surfaces: ["daemon", "filesystem", "workbench-client"], expectedDurationMs: 10_000, timeoutMs: 120_000,
}, async t => {
  let o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    const target = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    const future = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    const deleted = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    const metaPath = (root: string, id: string) => join(root, ".genethub", "sessions", id, "meta.json");
    const removed = readFileSync(metaPath(t.env.workspace, deleted), "utf8");
    await o.client.call({ type: "session.delete", payload: { sessionId: deleted } });
    const otherRoot = join(t.env.root, "copied-project"); mkdirSync(otherRoot);
    const opened = await o.client.call({ type: "workspace.open", payload: { root: otherRoot } });
    if (opened?.type !== "workspace") throw new Error("second project missing");
    const other = await t.flows.main.createBuiltinSession(o.client, opened.data.id);
    o.client.close(); o.daemon.stop(); await o.mock.stop();
    o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    // Exercise externally written persistent state through the same disk format
    // used by real project copies and later compatible installations.
    const copy = JSON.parse(readFileSync(metaPath(t.env.workspace, target), "utf8"));
    copy.title = "newer project copy"; copy.updatedAtMs += 10_000;
    mkdirSync(join(otherRoot, ".genethub", "sessions", target), { recursive: true });
    writeFileSync(metaPath(otherRoot, target), JSON.stringify(copy));
    const newer = JSON.parse(readFileSync(metaPath(t.env.workspace, future), "utf8"));
    newer.format += 100; writeFileSync(metaPath(t.env.workspace, future), JSON.stringify(newer));
    mkdirSync(join(t.env.workspace, ".genethub", "sessions", deleted), { recursive: true });
    writeFileSync(metaPath(t.env.workspace, deleted), removed);
    const selected = await o.client.call({ type: "session.get", payload: { sessionId: target } });
    t.assertions.assert(selected?.type === "snapshot" && selected.data.summary.workspaceId === opened.data.id && selected.data.summary.title === copy.title, "cold lookup changed the newest copied conversation's project");
    const second = await o.client.call({ type: "session.get", payload: { sessionId: other } });
    t.assertions.assert(second?.type === "snapshot" && second.data.summary.workspaceId === opened.data.id, "second project's own conversation was lost");
    for (const id of [future, deleted, "../outside", "..", "\\outside"]) {
      let refused = false;
      try { await o.client.call({ type: "session.get", payload: { sessionId: id } }); }
      catch (error) { refused = error instanceof ProtocolError_; }
      t.assertions.assert(refused, "invalid, deleted or unsupported conversation did not return a public protocol refusal");
    }
    const catalog = await o.client.call({ type: "session.list", payload: { workspaceId: null, includeArchived: true, lean: true } });
    t.assertions.assert(catalog?.type === "sessions" && catalog.data.some(s => s.id === future && Boolean(s.unsupported)) && !catalog.data.some(s => s.id === deleted), "catalog lost future-format visibility or deletion fence");
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
