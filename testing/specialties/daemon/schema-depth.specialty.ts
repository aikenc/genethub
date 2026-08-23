import { existsSync } from "node:fs";
import path from "node:path";

import { ProtocolError_ } from "@genehub/workbench/client";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

interface SchemaCase {
  id: string;
  title: string;
  oracle: string;
  catches: string[];
  request(opened: Opened, sessionId: string): unknown;
  verify?(t: CaseContext, opened: Opened, sessionId: string): Promise<void>;
}

async function expectClose(opened: Opened, request: unknown): Promise<void> {
  try {
    await opened.client.call(request as never);
  } catch (error) {
    if (error instanceof ProtocolError_ && String(error.detail.code).toLowerCase() === "badrequest") {
      return;
    }
    throw new Error(`wrong malformed-request result: ${String(error)}`);
  }
  throw new Error(`malformed request accepted: ${JSON.stringify(request)}`);
}

async function assertLive(t: CaseContext, opened: Opened): Promise<void> {
  const reply = await opened.client.call({ type: "workspace.list" });
  t.assertions.assert(reply?.type === "workspaces" && reply.data.some((item) => item.id === opened.workspaceId), "daemon did not recover after protocol close");
}

const cases: SchemaCase[] = [
  { id: "workspace-rename-missing-id", title: "Workspace rename requires workspaceId", oracle: "the ingress closes and the registered workspace remains available", catches: ["rename applies to implicit workspace", "missing id reaches registry"], request: () => ({ type: "workspace.rename", payload: { name: "invalid" } }) },
  { id: "workspace-rename-name-number", title: "Workspace rename rejects numeric names", oracle: "the numeric value is not stringified and daemon redial succeeds", catches: ["numeric name coercion", "type confusion in metadata"], request: (opened) => ({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: 7 } }) },
  { id: "workspace-remove-null-id", title: "Workspace removal rejects null identity", oracle: "null cannot select a default workspace and the real registration survives", catches: ["null id defaults to active workspace", "remove decoder panic"], request: () => ({ type: "workspace.remove", payload: { workspaceId: null } }) },
  { id: "session-get-missing-id", title: "Session get requires sessionId", oracle: "the malformed lookup closes only its ingress and the real session remains readable", catches: ["missing id returns arbitrary session", "lookup parser poisons redial"], request: () => ({ type: "session.get", payload: {} }), verify: async (t, opened, id) => { const reply = await opened.client.call({ type: "session.get", payload: { sessionId: id } }); t.assertions.assert(reply?.type === "snapshot" && reply.data.summary.id === id, "real session lost"); } },
  { id: "session-rename-title-array", title: "Session rename rejects array titles", oracle: "the array is not joined or persisted and the session remains readable", catches: ["array title coercion", "metadata type confusion"], request: (_opened, id) => ({ type: "session.rename", payload: { sessionId: id, title: ["bad"] } }) },
  { id: "session-archive-string-flag", title: "Session archive requires a boolean flag", oracle: "the string false is not treated as truthy and live state remains unchanged", catches: ["string boolean coercion", "unexpected archive mutation"], request: (_opened, id) => ({ type: "session.archive", payload: { sessionId: id, archived: "false" } }), verify: async (t, opened, id) => { const reply = await opened.client.call({ type: "session.list", payload: { workspaceId: opened.workspaceId, includeArchived: false } }); t.assertions.assert(reply?.type === "sessions" && reply.data.some((item) => item.id === id), "invalid flag archived session"); } },
  { id: "session-list-array-workspace", title: "Session list rejects array workspace identities", oracle: "an array cannot broaden listing scope and redial remains healthy", catches: ["array flattened into id", "cross-workspace enumeration"], request: () => ({ type: "session.list", payload: { workspaceId: ["all"], includeArchived: true } }) },
  { id: "session-delete-number-id", title: "Session delete rejects numeric identity", oracle: "the numeric id cannot delete the real session", catches: ["number stringified as id", "delete type confusion"], request: () => ({ type: "session.delete", payload: { sessionId: 0 } }) },
  { id: "file-write-content-object", title: "File write rejects object content", oracle: "no file is created before the protocol close", catches: ["object serialized into user file", "partial write before decode"], request: (opened) => ({ type: "file.write", payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/object.txt`, content: { bad: true } } }), verify: async (t, opened) => t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "object.txt")), "invalid write created file") },
  { id: "file-mkdir-number-path", title: "File mkdir rejects numeric paths", oracle: "the number is not converted into a workspace path", catches: ["path number stringification", "root handle bypass"], request: (opened) => ({ type: "file.mkdir", payload: { workspaceId: opened.workspaceId, path: 123 } }) },
  { id: "file-delete-scalar-paths", title: "File delete requires a path list", oracle: "a scalar path cannot trigger deletion and daemon redial succeeds", catches: ["scalar treated as iterable", "unexpected single delete"], request: (opened) => ({ type: "file.delete", payload: { workspaceId: opened.workspaceId, paths: `${opened.rootHandle}/keep.txt` } }) },
  { id: "file-copy-missing-destination", title: "File copy requires a destination", oracle: "missing to cannot create an implicit copy or damage the source", catches: ["destination defaults to source", "partial copy mutation"], request: (opened) => ({ type: "file.copy", payload: { workspaceId: opened.workspaceId, from: `${opened.rootHandle}/source.txt` } }) },
  { id: "file-move-null-source", title: "File move rejects a null source", oracle: "null cannot resolve to workspace root and no destination appears", catches: ["null maps to root", "workspace tree moved"], request: (opened) => ({ type: "file.move", payload: { workspaceId: opened.workspaceId, from: null, to: `${opened.rootHandle}/moved` } }), verify: async (t, opened) => t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "moved")), "invalid move created destination") },
  { id: "file-tree-fractional-depth", title: "File tree rejects fractional depth", oracle: "1.5 cannot cross the integer boundary and a later valid tree succeeds", catches: ["float truncation", "fractional recursion ambiguity"], request: (opened) => ({ type: "file.tree", payload: { workspaceId: opened.workspaceId, path: null, depth: 1.5 } }), verify: async (t, opened) => { const reply = await opened.client.call({ type: "file.tree", payload: { workspaceId: opened.workspaceId, path: null, depth: 1 } }); t.assertions.assert(reply?.type === "fileTree", "valid tree failed after malformed depth"); } },
  { id: "workspace-open-root-array", title: "Workspace open rejects an array root", oracle: "multiple host paths cannot be smuggled through a scalar root field", catches: ["array path coercion", "unauthorized multi-root creation"], request: () => ({ type: "workspace.open", payload: { root: ["/tmp", "/"] } }) },
  { id: "workspace-open-missing-root", title: "Workspace open requires a root", oracle: "an omitted root cannot create an implicit workspace and the existing workspace survives", catches: ["implicit current-directory open", "missing root reaches registry"], request: () => ({ type: "workspace.open", payload: {} }) },
  { id: "workspace-open-number-root", title: "Workspace open rejects numeric roots", oracle: "a number cannot be stringified into a host path", catches: ["numeric path coercion", "unexpected workspace registration"], request: () => ({ type: "workspace.open", payload: { root: 42 } }) },
  { id: "workspace-remove-missing-id", title: "Workspace removal requires workspaceId", oracle: "an omitted identity cannot remove the active workspace", catches: ["implicit active-workspace removal", "missing identity mutation"], request: () => ({ type: "workspace.remove", payload: {} }) },
  { id: "workspace-remove-array-id", title: "Workspace removal rejects array identities", oracle: "an array cannot broaden removal to multiple workspaces", catches: ["array identity flattening", "bulk removal through scalar field"], request: (opened) => ({ type: "workspace.remove", payload: { workspaceId: [opened.workspaceId] } }) },
  { id: "session-create-missing-workspace", title: "Session creation requires workspaceId", oracle: "an omitted workspace cannot attach a session to implicit state", catches: ["implicit workspace selection", "orphan session creation"], request: () => ({ type: "session.create", payload: { agentId: "builtin" } }) },
  { id: "session-create-array-agent", title: "Session creation rejects array agent ids", oracle: "multiple agent identities cannot enter a scalar selector", catches: ["array agent coercion", "unexpected agent fallback"], request: (opened) => ({ type: "session.create", payload: { workspaceId: opened.workspaceId, agentId: ["builtin"] } }) },
  { id: "session-get-array-id", title: "Session get rejects array identities", oracle: "an array cannot enumerate or select a session", catches: ["array identity flattening", "cross-session lookup"], request: (_opened, id) => ({ type: "session.get", payload: { sessionId: [id] } }) },
  { id: "session-rename-missing-title", title: "Session rename requires a title", oracle: "an omitted title cannot clear or synthesize metadata", catches: ["implicit empty title", "missing title mutation"], request: (_opened, id) => ({ type: "session.rename", payload: { sessionId: id } }) },
  { id: "session-archive-null-flag", title: "Session archive rejects null flags", oracle: "null cannot be interpreted as either archive transition", catches: ["null boolean coercion", "unexpected archive mutation"], request: (_opened, id) => ({ type: "session.archive", payload: { sessionId: id, archived: null } }) },
  { id: "session-delete-array-id", title: "Session delete rejects array identities", oracle: "a scalar delete cannot be widened into bulk deletion", catches: ["array identity flattening", "bulk delete through scalar field"], request: (_opened, id) => ({ type: "session.delete", payload: { sessionId: [id] } }) },
  { id: "session-send-missing-id", title: "Session send requires sessionId", oracle: "content cannot be delivered to an implicit active session", catches: ["implicit session routing", "orphan turn creation"], request: () => ({ type: "session.send", payload: { content: "invalid" } }) },
  { id: "session-send-object-content", title: "Session send rejects object content", oracle: "structured input is not stringified into a user message", catches: ["object content serialization", "malformed turn creation"], request: (_opened, id) => ({ type: "session.send", payload: { sessionId: id, content: { text: "invalid" } } }) },
  { id: "session-interrupt-null-id", title: "Session interrupt rejects null identity", oracle: "null cannot select an active turn or session", catches: ["implicit active-session interrupt", "null identity panic"], request: () => ({ type: "session.interrupt", payload: { sessionId: null } }) },
  { id: "file-read-missing-path", title: "File read requires a path", oracle: "an omitted path cannot default to the workspace root", catches: ["implicit root read", "missing path traversal"], request: (opened) => ({ type: "file.read", payload: { workspaceId: opened.workspaceId } }) },
  { id: "file-read-array-path", title: "File read rejects array paths", oracle: "multiple paths cannot enter the scalar read boundary", catches: ["array path coercion", "bulk read through scalar field"], request: (opened) => ({ type: "file.read", payload: { workspaceId: opened.workspaceId, path: [opened.rootHandle] } }) },
  { id: "file-write-missing-content", title: "File write requires content", oracle: "omitted content cannot truncate or create a file", catches: ["missing content treated as empty", "mutation before validation"], request: (opened) => ({ type: "file.write", payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/missing-content.txt` } }), verify: async (t, opened) => t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "missing-content.txt")), "missing content created file") },
  { id: "file-mkdir-missing-path", title: "File mkdir requires a path", oracle: "omitted path cannot target the workspace root", catches: ["implicit root mkdir", "missing path mutation"], request: (opened) => ({ type: "file.mkdir", payload: { workspaceId: opened.workspaceId } }) },
  { id: "file-delete-null-paths", title: "File delete rejects null path lists", oracle: "null cannot mean all paths or workspace root", catches: ["null interpreted as wildcard", "root deletion attempt"], request: (opened) => ({ type: "file.delete", payload: { workspaceId: opened.workspaceId, paths: null } }) },
  { id: "file-copy-array-source", title: "File copy rejects array sources", oracle: "multiple sources cannot enter a scalar copy operation", catches: ["array source flattening", "unintended bulk copy"], request: (opened) => ({ type: "file.copy", payload: { workspaceId: opened.workspaceId, from: [`${opened.rootHandle}/source.txt`], to: `${opened.rootHandle}/copy-array.txt` } }) },
  { id: "file-copy-object-destination", title: "File copy rejects object destinations", oracle: "an object cannot be formatted into a destination path", catches: ["object path coercion", "copy outside requested location"], request: (opened) => ({ type: "file.copy", payload: { workspaceId: opened.workspaceId, from: `${opened.rootHandle}/source.txt`, to: { path: `${opened.rootHandle}/bad.txt` } } }) },
  { id: "file-move-missing-destination", title: "File move requires a destination", oracle: "an omitted destination cannot remove or rename the source", catches: ["destination defaults to source", "source mutation before validation"], request: (opened) => ({ type: "file.move", payload: { workspaceId: opened.workspaceId, from: `${opened.rootHandle}/keep.txt` } }) },
  { id: "file-tree-string-depth", title: "File tree rejects string depth", oracle: "numeric strings cannot silently alter recursion limits", catches: ["string integer coercion", "unbounded traversal ambiguity"], request: (opened) => ({ type: "file.tree", payload: { workspaceId: opened.workspaceId, path: null, depth: "2" } }) },
  { id: "file-tree-array-path", title: "File tree rejects array paths", oracle: "multiple roots cannot be smuggled into one traversal", catches: ["array path flattening", "multi-root enumeration"], request: (opened) => ({ type: "file.tree", payload: { workspaceId: opened.workspaceId, path: [opened.rootHandle], depth: 1 } }) },
  { id: "pty-write-number-data", title: "PTY write rejects numeric data", oracle: "numbers cannot be converted into terminal input bytes", catches: ["numeric terminal input coercion", "unexpected PTY mutation"], request: () => ({ type: "pty.write", payload: { ptyId: "missing", data: 7 } }) },
  { id: "pty-resize-string-columns", title: "PTY resize rejects string dimensions", oracle: "string dimensions cannot pass integer terminal geometry validation", catches: ["string geometry coercion", "invalid resize reaches PTY"], request: () => ({ type: "pty.resize", payload: { ptyId: "missing", cols: "80", rows: 24 } }) },
];

for (const item of cases) {
  defineSpecialty({
    id: `specialty.daemon.schema.${item.id}`,
    title: item.title,
    oracle: item.oracle,
    catches: item.catches,
    tags: ["core", "daemon", "daemon-schema-depth"],
    llm: { default: "none" },
    expectedDurationMs: 20_000,
    timeoutMs: 120_000,
    resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client", "daemon-protocol"],
  }, async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await expectClose(opened, item.request(opened, sessionId));
      await assertLive(t, opened);
      await item.verify?.(t, opened, sessionId);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  });
}
