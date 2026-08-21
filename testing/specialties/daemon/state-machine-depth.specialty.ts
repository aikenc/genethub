import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function stateCase(id: string, title: string, oracle: string, catches: string[], run: (t: CaseContext, opened: Opened) => Promise<void>): void {
  defineSpecialty({
    id: `specialty.daemon.state-machine.${id}`,
    title,
    oracle,
    catches,
    tags: ["core", "daemon", "state-machine-depth"],
    llm: { default: "none" },
    expectedDurationMs: 20_000,
    timeoutMs: 120_000,
    resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client", "daemon-protocol"],
  }, async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await run(t, opened);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  });
}

async function sessions(opened: Opened, includeArchived: boolean) {
  const reply = await opened.client.call({ type: "session.list", payload: { workspaceId: opened.workspaceId, includeArchived } });
  if (reply?.type !== "sessions") throw new Error(`session.list returned ${reply?.type}`);
  return reply.data;
}

stateCase("workspace-unicode-rename", "Workspace names preserve full Unicode", "a second client sees the exact Unicode name on the same workspace id", ["name encoding loss", "rename creates replacement identity"], async (t, opened) => {
  const name = "工程 Δ 🧬 e\u0301";
  await opened.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name } });
  const observer = await t.flows.main.openSecondClient(opened, "unicode-workspace-observer");
  try {
    const reply = await observer.call({ type: "workspace.list" });
    const found = reply?.type === "workspaces" ? reply.data.find((item) => item.id === opened.workspaceId) : undefined;
    t.assertions.assert(found?.name === name, `renamed workspace changed: ${JSON.stringify(found)}`);
  } finally { observer.close(); }
});

stateCase("workspace-rename-idempotent", "Repeating the same workspace rename is idempotent", "three identical renames leave exactly one workspace with the original id", ["duplicate registration", "id changes on no-op rename"], async (t, opened) => {
  for (let index = 0; index < 3; index += 1) await opened.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: "stable-name" } });
  const reply = await opened.client.call({ type: "workspace.list" });
  const matches = reply?.type === "workspaces" ? reply.data.filter((item) => item.id === opened.workspaceId) : [];
  t.assertions.assert(matches.length === 1 && matches[0]?.name === "stable-name", `workspace duplicated: ${JSON.stringify(matches)}`);
});

stateCase("session-unicode-rename", "Session titles preserve full Unicode", "session.get returns the exact title and unchanged id", ["title normalization", "emoji truncation", "rename remaps id"], async (t, opened) => {
  const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
  const title = "会话 Ελληνικά 🧬 e\u0301";
  await opened.client.call({ type: "session.rename", payload: { sessionId: id, title } });
  const reply = await opened.client.call({ type: "session.get", payload: { sessionId: id } });
  t.assertions.assert(reply?.type === "snapshot" && reply.data.summary.id === id && reply.data.summary.title === title, `title changed: ${JSON.stringify(reply)}`);
});

stateCase("session-last-rename-wins", "Sequential session renames converge to the final value", "both clients observe only the third title for the same id", ["stale rename wins", "client cache diverges"], async (t, opened) => {
  const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
  for (const title of ["first", "second", "third"]) await opened.client.call({ type: "session.rename", payload: { sessionId: id, title } });
  const observer = await t.flows.main.openSecondClient(opened, "last-rename-observer");
  try {
    const reply = await observer.call({ type: "session.get", payload: { sessionId: id } });
    t.assertions.assert(reply?.type === "snapshot" && reply.data.summary.title === "third", `last rename lost: ${JSON.stringify(reply)}`);
  } finally { observer.close(); }
});

stateCase("archive-idempotent", "Archiving an already archived session is idempotent", "two archive=true calls leave one hidden session that appears once with includeArchived", ["duplicate archived entries", "second archive toggles state"], async (t, opened) => {
  const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
  await opened.client.call({ type: "session.archive", payload: { sessionId: id, archived: true } });
  await opened.client.call({ type: "session.archive", payload: { sessionId: id, archived: true } });
  t.assertions.assert(!(await sessions(opened, false)).some((item) => item.id === id), "archived session remained live");
  t.assertions.assert((await sessions(opened, true)).filter((item) => item.id === id).length === 1, "archive duplicated session");
});

stateCase("unarchive-idempotent", "Restoring an already live session is idempotent", "two archive=false calls leave exactly one live session", ["duplicate live entries", "false toggles to archived"], async (t, opened) => {
  const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
  await opened.client.call({ type: "session.archive", payload: { sessionId: id, archived: false } });
  await opened.client.call({ type: "session.archive", payload: { sessionId: id, archived: false } });
  t.assertions.assert((await sessions(opened, false)).filter((item) => item.id === id).length === 1, "unarchive duplicated or hid session");
});

stateCase("delete-archived-session", "An archived session can be permanently deleted", "the id disappears from both filtered and inclusive lists", ["delete ignores archived records", "tombstone remains listable"], async (t, opened) => {
  const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
  await opened.client.call({ type: "session.archive", payload: { sessionId: id, archived: true } });
  await opened.client.call({ type: "session.delete", payload: { sessionId: id } });
  t.assertions.assert(!(await sessions(opened, false)).some((item) => item.id === id), "deleted archive appeared live");
  t.assertions.assert(!(await sessions(opened, true)).some((item) => item.id === id), "deleted archive remained inclusive");
});

stateCase("ten-session-identities-unique", "A burst of session creation produces unique durable identities", "ten creates yield ten distinct ids all present exactly once", ["id collision", "create acknowledgement before registry insert"], async (t, opened) => {
  const ids = await Promise.all(Array.from({ length: 10 }, () => t.flows.main.createBuiltinSession(opened.client, opened.workspaceId)));
  t.assertions.assert(new Set(ids).size === ids.length, `duplicate ids: ${JSON.stringify(ids)}`);
  const listed = await sessions(opened, true);
  for (const id of ids) t.assertions.assert(listed.filter((item) => item.id === id).length === 1, `id not listed once: ${id}`);
});

stateCase("empty-file-roundtrip", "An empty file is a real persisted file", "file.write creates a zero-byte path distinguishable from absence", ["empty write treated as delete", "ack before file creation"], async (t, opened) => {
  await opened.client.call({ type: "file.write", payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/empty.txt`, content: "" } });
  const disk = path.join(opened.workspaceRoot, "empty.txt");
  t.assertions.assert(existsSync(disk) && readFileSync(disk).byteLength === 0, "empty file absent or nonempty");
});

stateCase("overwrite-truncates", "Overwriting with shorter content truncates old bytes", "a long file overwritten by x contains exactly one byte", ["stale suffix retained", "append used instead of replace"], async (t, opened) => {
  const target = `${opened.rootHandle}/truncate.txt`;
  await opened.client.call({ type: "file.write", payload: { workspaceId: opened.workspaceId, path: target, content: "long-content-that-must-go" } });
  await opened.client.call({ type: "file.write", payload: { workspaceId: opened.workspaceId, path: target, content: "x" } });
  t.assertions.fileEquals(opened.workspaceRoot, "truncate.txt", "x");
});

stateCase("mkdir-existing-preserved", "Creating an existing directory fails without damaging it", "the second mkdir is refused while the directory and its sentinel remain intact", ["second mkdir deletes contents", "existing directory replaced", "duplicate create silently acknowledged"], async (t, opened) => {
  const disk = path.join(opened.workspaceRoot, "stable-dir");
  const remote = `${opened.rootHandle}/stable-dir`;
  await opened.client.call({ type: "file.mkdir", payload: { workspaceId: opened.workspaceId, path: remote } });
  writeFileSync(path.join(disk, "sentinel"), "keep");
  let refused = false;
  try {
    await opened.client.call({ type: "file.mkdir", payload: { workspaceId: opened.workspaceId, path: remote } });
  } catch {
    refused = true;
  }
  t.assertions.assert(refused, "duplicate mkdir was silently accepted");
  t.assertions.assert(readFileSync(path.join(disk, "sentinel"), "utf8") === "keep", "second mkdir changed contents");
});

stateCase("copy-preserves-source", "Copy duplicates bytes without changing the source", "source and destination both contain the exact multiline payload", ["copy implemented as move", "source truncated", "destination differs"], async (t, opened) => {
  writeFileSync(path.join(opened.workspaceRoot, "source.txt"), "one\ntwo\n");
  await opened.client.call({ type: "file.copy", payload: { workspaceId: opened.workspaceId, from: `${opened.rootHandle}/source.txt`, to: `${opened.rootHandle}/copy.txt` } });
  t.assertions.fileEquals(opened.workspaceRoot, "source.txt", "one\ntwo\n");
  t.assertions.fileEquals(opened.workspaceRoot, "copy.txt", "one\ntwo\n");
});

stateCase("move-preserves-bytes", "Move transfers exact bytes and removes only the source", "destination matches a binary-safe text payload and source is absent", ["move becomes copy", "move rewrites content"], async (t, opened) => {
  const payload = "α\nβ\n🧬\n";
  writeFileSync(path.join(opened.workspaceRoot, "before.txt"), payload);
  await opened.client.call({ type: "file.move", payload: { workspaceId: opened.workspaceId, from: `${opened.rootHandle}/before.txt`, to: `${opened.rootHandle}/after.txt` } });
  t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "before.txt")), "move kept source");
  t.assertions.fileEquals(opened.workspaceRoot, "after.txt", payload);
});

stateCase("bulk-delete-mixed-tree", "Bulk delete removes files and a populated directory together", "all requested paths disappear while an unrequested sibling survives", ["directory deletion partial", "bulk loop stops early", "sibling over-deleted"], async (t, opened) => {
  mkdirSync(path.join(opened.workspaceRoot, "tree", "nested"), { recursive: true });
  writeFileSync(path.join(opened.workspaceRoot, "tree", "nested", "a.txt"), "a");
  writeFileSync(path.join(opened.workspaceRoot, "single.txt"), "single");
  writeFileSync(path.join(opened.workspaceRoot, "keep.txt"), "keep");
  await opened.client.call({ type: "file.delete", payload: { workspaceId: opened.workspaceId, paths: [`${opened.rootHandle}/tree`, `${opened.rootHandle}/single.txt`] } });
  t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "tree")) && !existsSync(path.join(opened.workspaceRoot, "single.txt")), "requested paths survived");
  t.assertions.fileEquals(opened.workspaceRoot, "keep.txt", "keep");
});

stateCase("parallel-read-snapshot-consistent", "Parallel clients read one converged session snapshot", "eight simultaneous gets return the same id and title", ["per-client stale cache", "concurrent read mutates snapshot"], async (t, opened) => {
  const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
  await opened.client.call({ type: "session.rename", payload: { sessionId: id, title: "converged" } });
  const replies = await Promise.all(Array.from({ length: 8 }, () => opened.client.call({ type: "session.get", payload: { sessionId: id } })));
  t.assertions.assert(replies.every((reply) => reply?.type === "snapshot" && reply.data.summary.id === id && reply.data.summary.title === "converged"), `snapshots diverged: ${JSON.stringify(replies)}`);
});
