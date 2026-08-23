import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function pathCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, opened: Opened) => Promise<void>,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "filesystem", "path-depth"],
      llm: { default: "none" },
      expectedDurationMs: 20_000,
      timeoutMs: 90_000,
      resources: { environments: 1, cpu: 1, memoryMb: 512, io: 2, browser: 0, pool: "standard" },
      surfaces: ["daemon", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client"],
    },
    async (t) => {
      const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      try {
        await run(t, opened);
      } finally {
        opened.client.close();
        opened.daemon.stop();
        await opened.mock.stop();
      }
    },
  );
}

async function writeFile(opened: Opened, relative: string, content: string): Promise<void> {
  const reply = await opened.client.call({
    type: "file.write",
    payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/${relative}`, content },
  });
  if (reply?.type !== "ack") throw new Error(`file.write ${relative} returned ${reply?.type}`);
}

pathCase(
  "specialty.filesystem.unicode-roundtrip",
  "Unicode directory and file names round-trip through the public file API",
  "CJK, emoji, and combining characters retain exact names and UTF-8 contents on disk and in file.tree",
  ["path encoded as ASCII", "normalization changes identity", "tree response corrupts surrogate pairs"],
  async (t, opened) => {
    const directory = "资料-🧬-e\u0301";
    const filename = "结果-αβ-🙂.txt";
    const created = await opened.client.call({
      type: "file.mkdir",
      payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/${directory}` },
    });
    t.assertions.assert(created?.type === "ack", "Unicode directory was not created");
    await writeFile(opened, `${directory}/${filename}`, "第一行\nemoji: 🧪\ncombining: e\u0301\n");
    t.assertions.fileEquals(opened.workspaceRoot, `${directory}/${filename}`, "第一行\nemoji: 🧪\ncombining: e\u0301\n");
    const tree = await opened.client.call({ type: "file.tree", payload: { workspaceId: opened.workspaceId, path: null, depth: 3 } });
    const serialized = JSON.stringify(tree);
    t.assertions.assert(serialized.includes(directory) && serialized.includes(filename), `Unicode names absent from tree: ${serialized}`);
  },
);

pathCase(
  "specialty.filesystem.special-character-names",
  "Spaces and URL-significant characters stay literal in file names",
  "space, hash, percent, brackets, apostrophe, and ampersand names create distinct exact files",
  ["path URL-decoded twice", "hash treated as fragment", "percent sequence decoded", "names collapse"],
  async (t, opened) => {
    const names = ["two words.txt", "hash#name.txt", "percent%25.txt", "[brackets].txt", "it's.txt", "a&b.txt"];
    for (const [index, name] of names.entries()) await writeFile(opened, name, `special-${index}`);
    for (const [index, name] of names.entries()) t.assertions.fileEquals(opened.workspaceRoot, name, `special-${index}`);
    t.assertions.assert(new Set(names.map((name) => readFileSync(path.join(opened.workspaceRoot, name), "utf8"))).size === names.length, "special names aliased");
  },
);

pathCase(
  "specialty.filesystem.empty-and-megabyte-files",
  "Empty and one-megabyte text files preserve exact lengths",
  "file.write leaves a zero-byte file and an exact 1 MiB UTF-8 payload without truncation",
  ["empty write treated as delete", "large write truncated", "text framing adds newline"],
  async (t, opened) => {
    const large = "x".repeat(1_048_576);
    await writeFile(opened, "empty.txt", "");
    await writeFile(opened, "large.txt", large);
    t.assertions.fileEquals(opened.workspaceRoot, "empty.txt", "");
    t.assertions.fileEquals(opened.workspaceRoot, "large.txt", large);
    t.assertions.assert(readFileSync(path.join(opened.workspaceRoot, "empty.txt")).byteLength === 0, "empty file gained bytes");
    t.assertions.assert(readFileSync(path.join(opened.workspaceRoot, "large.txt")).byteLength === 1_048_576, "large file is not exactly 1 MiB");
  },
);

pathCase(
  "specialty.filesystem.deep-path-write",
  "A twenty-level workspace path remains addressable",
  "a public write at the deepest level preserves exact bytes and file.tree addresses that deep directory directly",
  ["path segment stack truncates", "root handle lost in deep join", "deep directory cannot be queried directly"],
  async (t, opened) => {
    const segments = Array.from({ length: 20 }, (_, index) => `level-${String(index).padStart(2, "0")}`);
    const directory = path.join(opened.workspaceRoot, ...segments);
    mkdirSync(directory, { recursive: true });
    const relative = `${segments.join("/")}/deep.txt`;
    await writeFile(opened, relative, "deep-value");
    t.assertions.fileEquals(opened.workspaceRoot, relative, "deep-value");
    const tree = await opened.client.call({
      type: "file.tree",
      payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/${segments.join("/")}`, depth: 1 },
    });
    t.assertions.assert(tree?.type === "fileTree" && JSON.stringify(tree).includes("deep.txt"), "deep file absent from tree");
  },
);

pathCase(
  "specialty.filesystem.unicode-copy-move",
  "Copy and move preserve bytes across Unicode and spaced names",
  "copy creates an exact second file and move removes only its source while retaining exact content",
  ["copy destination re-encoded", "move loses Unicode name", "copy and move share stale path"],
  async (t, opened) => {
    const source = `${opened.rootHandle}/源 文件.txt`;
    const copied = `${opened.rootHandle}/复制#1.txt`;
    const moved = `${opened.rootHandle}/完成 ✅.txt`;
    await writeFile(opened, "源 文件.txt", "copy-move-内容");
    const copy = await opened.client.call({ type: "file.copy", payload: { workspaceId: opened.workspaceId, from: source, to: copied } });
    t.assertions.assert(copy?.type === "ack", "Unicode copy failed");
    const move = await opened.client.call({ type: "file.move", payload: { workspaceId: opened.workspaceId, from: copied, to: moved } });
    t.assertions.assert(move?.type === "ack", "Unicode move failed");
    t.assertions.fileEquals(opened.workspaceRoot, "源 文件.txt", "copy-move-内容");
    t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "复制#1.txt")), "move retained Unicode source");
    t.assertions.fileEquals(opened.workspaceRoot, "完成 ✅.txt", "copy-move-内容");
  },
);

pathCase(
  "specialty.filesystem.overwrite-shrink-grow",
  "Repeated overwrites truncate and grow without stale tails",
  "large, tiny, empty, and larger payloads each replace the complete previous file",
  ["short overwrite leaves tail", "empty overwrite ignored", "later growth uses stale buffer"],
  async (t, opened) => {
    const versions = ["A".repeat(300_000), "tiny", "", "终".repeat(180_000)];
    for (const content of versions) {
      await writeFile(opened, "resize.txt", content);
      t.assertions.fileEquals(opened.workspaceRoot, "resize.txt", content);
    }
  },
);

pathCase(
  "specialty.filesystem.bulk-delete-special-names",
  "One delete request removes thirty-two specially named files",
  "all requested files disappear and an unrelated sentinel remains exact",
  ["bulk delete stops at special name", "partial success acknowledged", "neighbor deleted by prefix"],
  async (t, opened) => {
    const names = Array.from({ length: 32 }, (_, index) => `bulk ${index} #${index % 5}%.txt`);
    for (const [index, name] of names.entries()) await writeFile(opened, name, `bulk-${index}`);
    await writeFile(opened, "bulk-sentinel.txt", "keep");
    const deleted = await opened.client.call({
      type: "file.delete",
      payload: { workspaceId: opened.workspaceId, paths: names.map((name) => `${opened.rootHandle}/${name}`) },
    });
    t.assertions.assert(deleted?.type === "ack", "bulk delete did not acknowledge");
    t.assertions.assert(names.every((name) => !existsSync(path.join(opened.workspaceRoot, name))), "bulk delete left a file");
    t.assertions.fileEquals(opened.workspaceRoot, "bulk-sentinel.txt", "keep");
  },
);

pathCase(
  "specialty.filesystem.unicode-workspace-root",
  "A workspace root containing Unicode and spaces is fully usable",
  "workspace.open returns a distinct handle and public write lands in the exact non-ASCII root",
  ["workspace root coerced to ASCII", "space split as argument", "root handle resolves to default workspace"],
  async (t, opened) => {
    const root = path.join(t.env.root, "项目 root 🧬");
    mkdirSync(root, { recursive: true });
    const extra = await opened.client.call({ type: "workspace.open", payload: { root } });
    t.assertions.assert(extra?.type === "workspace", `Unicode workspace.open returned ${extra?.type}`);
    if (extra?.type !== "workspace") return;
    const handle = extra.data.folders[0]?.rootHandle;
    t.assertions.assert(Boolean(handle), "Unicode workspace had no root handle");
    const reply = await opened.client.call({
      type: "file.write",
      payload: { workspaceId: extra.data.id, path: `${handle}/hello 世界.txt`, content: "root-ok" },
    });
    t.assertions.assert(reply?.type === "ack", "write in Unicode root failed");
    t.assertions.assert(readFileSync(path.join(root, "hello 世界.txt"), "utf8") === "root-ok", "write landed in wrong root");
    t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "hello 世界.txt")), "Unicode root write leaked to default root");
  },
);
