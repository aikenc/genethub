import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

async function withWorkspace(t: CaseContext, run: (opened: Opened) => Promise<void>): Promise<void> {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await run(opened);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

function daemonCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext) => Promise<void>,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "state-depth"],
      expectedDurationMs: 20_000,
      timeoutMs: 75_000,
      surfaces: ["daemon", "workbench-client"],
      productInterfaces: ["genet-cli", "@genehub/web/client"],
    },
    run,
  );
}

daemonCase(
  "specialty.daemon.workspace-rename-visible",
  "Workspace rename is immediately visible to another client",
  "a second production client lists the renamed workspace with the same id and root",
  ["rename only mutates a caller cache", "rename changes workspace identity"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const observer = await t.flows.main.openSecondClient(opened, "rename-observer");
      try {
        const renamed = await opened.client.call({
          type: "workspace.rename",
          payload: { workspaceId: opened.workspaceId, name: "renamed-by-specialty" },
        });
        t.assertions.assert(renamed?.type === "workspace", `workspace.rename returned ${renamed?.type}`);
        const listed = await observer.call({ type: "workspace.list" });
        const found = listed?.type === "workspaces"
          ? listed.data.find((item) => item.id === opened.workspaceId)
          : undefined;
        t.assertions.assert(found?.name === "renamed-by-specialty", `observer saw ${found?.name}`);
        t.assertions.assert(
          found?.folders.some((folder) => folder.root === opened.workspaceRoot) === true,
          `rename changed roots: ${JSON.stringify(found?.folders)}`,
        );
      } finally {
        observer.close();
      }
    });
  },
);

daemonCase(
  "specialty.daemon.workspace-remove-preserves-disk",
  "Removing a workspace forgets registration without deleting user files",
  "workspace.list loses the id while an on-disk sentinel remains byte-for-byte intact",
  ["workspace removal recursively deletes the project", "removed workspace remains registered"],
  async (t) => {
    const sentinel = path.join(t.env.workspace, "keep-me.txt");
    writeFileSync(sentinel, "user data must survive\n");
    await withWorkspace(t, async (opened) => {
      await opened.client.call({
        type: "workspace.remove",
        payload: { workspaceId: opened.workspaceId },
      });
      const listed = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(
        listed?.type === "workspaces" && !listed.data.some((item) => item.id === opened.workspaceId),
        "removed workspace stayed in workspace.list",
      );
      t.assertions.assert(readFileSync(sentinel, "utf8") === "user data must survive\n", "project data changed");
    });
  },
);

daemonCase(
  "specialty.daemon.file-lifecycle-on-disk",
  "File mkdir, copy, move, and delete agree with the real filesystem",
  "each public file operation produces the corresponding disk state and preserves bytes",
  ["in-memory-only mutation", "copy truncation", "move leaves two live paths", "delete acknowledges without deleting"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const directory = `${opened.rootHandle}/nested`;
      const original = `${directory}/original.txt`;
      const copied = `${directory}/copied.txt`;
      const moved = `${directory}/moved.txt`;
      await opened.client.call({ type: "file.mkdir", payload: { workspaceId: opened.workspaceId, path: directory } });
      await opened.client.call({
        type: "file.write",
        payload: { workspaceId: opened.workspaceId, path: original, content: "exact bytes\nsecond line\n" },
      });
      await opened.client.call({
        type: "file.copy",
        payload: { workspaceId: opened.workspaceId, from: original, to: copied },
      });
      t.assertions.fileEquals(opened.workspaceRoot, "nested/copied.txt", "exact bytes\nsecond line\n");
      await opened.client.call({
        type: "file.move",
        payload: { workspaceId: opened.workspaceId, from: copied, to: moved },
      });
      t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "nested/copied.txt")), "move kept source");
      t.assertions.fileEquals(opened.workspaceRoot, "nested/moved.txt", "exact bytes\nsecond line\n");
      await opened.client.call({
        type: "file.delete",
        payload: { workspaceId: opened.workspaceId, paths: [original, moved] },
      });
      t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "nested/original.txt")), "delete kept original");
      t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "nested/moved.txt")), "delete kept moved file");
    });
  },
);

daemonCase(
  "specialty.daemon.file-traversal-refused",
  "Encoded parent traversal cannot write outside a workspace",
  "a sibling sentinel stays unchanged and no escaped file appears after hostile public file.write paths",
  ["root handle treated as a string prefix", "dot-dot normalized after authorization"],
  async (t) => {
    const outside = path.join(path.dirname(t.env.workspace), "outside-depth-canary.txt");
    writeFileSync(outside, "untouched");
    await withWorkspace(t, async (opened) => {
      const hostile = [
        `${opened.rootHandle}/../escaped.txt`,
        `${opened.rootHandle}/nested/../../escaped.txt`,
      ];
      for (const candidate of hostile) {
        try {
          await opened.client.call({
            type: "file.write",
            payload: { workspaceId: opened.workspaceId, path: candidate, content: "escaped" },
          });
        } catch {
          // Refusal may be a protocol error or a closed request; disk is the oracle.
        }
      }
      t.assertions.assert(readFileSync(outside, "utf8") === "untouched", "sibling sentinel changed");
      t.assertions.assert(!existsSync(path.join(path.dirname(t.env.workspace), "escaped.txt")), "write escaped workspace");
    });
  },
);

daemonCase(
  "specialty.daemon.session-rename-cross-client",
  "Session rename converges across connected clients",
  "session.get through another client returns the new title for the same session id",
  ["session title cached per connection", "rename creates a replacement session"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const observer = await t.flows.main.openSecondClient(opened, "session-rename-observer");
      try {
        await opened.client.call({
          type: "session.rename",
          payload: { sessionId, title: "durable title" },
        });
        const fetched = await observer.call({ type: "session.get", payload: { sessionId } });
        t.assertions.assert(fetched?.type === "snapshot", `session.get returned ${fetched?.type}`);
        t.assertions.assert(fetched?.type === "snapshot" && fetched.data.summary.id === sessionId, "session id changed");
        t.assertions.assert(
          fetched?.type === "snapshot" && fetched.data.summary.title === "durable title",
          "title did not converge",
        );
      } finally {
        observer.close();
      }
    });
  },
);

daemonCase(
  "specialty.daemon.archive-is-reversible",
  "Archiving and restoring a session is reversible",
  "the same session disappears from the live list and returns after archived=false",
  ["unarchive creates a duplicate", "archive cannot be reversed", "live-list filter is sticky"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await opened.client.call({ type: "session.archive", payload: { sessionId, archived: true } });
      const hidden = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(
        hidden?.type === "sessions" && !hidden.data.some((item) => item.id === sessionId),
        "archived session remained live",
      );
      await opened.client.call({ type: "session.archive", payload: { sessionId, archived: false } });
      const restored = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(
        restored?.type === "sessions" && restored.data.filter((item) => item.id === sessionId).length === 1,
        "restored session missing or duplicated",
      );
    });
  },
);

daemonCase(
  "specialty.daemon.deleted-session-stays-gone",
  "Deleting a session removes it for every connected client",
  "another client cannot find the deleted id in session.list or obtain a session reply",
  ["delete only removes the caller cache", "deleted sessions remain actionable"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const observer = await t.flows.main.openSecondClient(opened, "session-delete-observer");
      try {
        await opened.client.call({ type: "session.delete", payload: { sessionId } });
        const listed = await observer.call({
          type: "session.list",
          payload: { workspaceId: opened.workspaceId, includeArchived: true },
        });
        t.assertions.assert(
          listed?.type === "sessions" && !listed.data.some((item) => item.id === sessionId),
          "deleted session remained listed",
        );
        try {
          const fetched = await observer.call({ type: "session.get", payload: { sessionId } });
          t.assertions.assert(fetched?.type !== "snapshot", "deleted session was still readable");
        } catch {
          // An explicit not-found protocol error is also correct.
        }
      } finally {
        observer.close();
      }
    });
  },
);

daemonCase(
  "specialty.daemon.concurrent-writes-isolated",
  "Concurrent writes to separate paths do not cross-contaminate",
  "twelve simultaneous public writes leave twelve files with their own exact payload",
  ["shared write buffer", "request completion before flush", "last writer content copied to other paths"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      const writes = Array.from({ length: 12 }, (_, index) => ({
        relative: `parallel/file-${index}.txt`,
        content: `payload-${index}-${"x".repeat(index * 17)}`,
      }));
      mkdirSync(path.join(opened.workspaceRoot, "parallel"), { recursive: true });
      await Promise.all(
        writes.map((item) =>
          opened.client.call({
            type: "file.write",
            payload: {
              workspaceId: opened.workspaceId,
              path: `${opened.rootHandle}/${item.relative}`,
              content: item.content,
            },
          }),
        ),
      );
      for (const item of writes) t.assertions.fileEquals(opened.workspaceRoot, item.relative, item.content);
    });
  },
);

daemonCase(
  "specialty.daemon.stale-workspace-id-refused",
  "A removed workspace id cannot mutate its former directory",
  "file.write using the removed id fails and the former root receives no file",
  ["authorization trusts stale workspace handles", "removed workspace remains a mutation capability"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      await opened.client.call({ type: "workspace.remove", payload: { workspaceId: opened.workspaceId } });
      try {
        await opened.client.call({
          type: "file.write",
          payload: {
            workspaceId: opened.workspaceId,
            path: `${opened.rootHandle}/after-remove.txt`,
            content: "must not exist",
          },
        });
      } catch {
        // Public refusal shape is not the oracle; absence of mutation is.
      }
      t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "after-remove.txt")), "stale id still mutated disk");
    });
  },
);

daemonCase(
  "specialty.daemon.diagnostics-bounded-and-live",
  "Support diagnostics stay bounded and do not consume daemon liveness",
  "repeated snapshots remain JSON-bounded and workspace.list still succeeds afterwards",
  ["diagnostics grows without bound", "snapshot drains live state", "diagnostics call wedges the daemon"],
  async (t) => {
    await withWorkspace(t, async (opened) => {
      for (let index = 0; index < 8; index += 1) {
        const snapshot = await opened.client.call({ type: "diagnostics.snapshot" });
        t.assertions.assert(snapshot?.type === "diagnostics", `diagnostics.snapshot returned ${snapshot?.type}`);
        const encoded = JSON.stringify(snapshot);
        t.assertions.assert(encoded.length < 256_000, `diagnostics grew to ${encoded.length} bytes`);
        t.assertions.assert(!encoded.includes("sk-test"), "diagnostics exposed provider credentials");
      }
      const listed = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", "daemon stopped serving reads after diagnostics");
    });
  },
);
