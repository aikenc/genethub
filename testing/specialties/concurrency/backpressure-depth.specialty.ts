import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function pressureCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, opened: Opened) => Promise<void>,
  needsMock = false,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["network-risk-v2", "core", "daemon", "concurrency", "backpressure-depth", id],
      llm: { default: needsMock ? "mock" : "none" },
      expectedDurationMs: needsMock ? 35_000 : 20_000,
      timeoutMs: 120_000,
      resources: { environments: 1, cpu: 2, memoryMb: 768, io: 2, browser: 0, pool: "standard" },
      surfaces: ["daemon", "agent", "workbench-client"],
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

pressureCase(
  "specialty.backpressure.single-client-read-burst",
  "One connection survives a burst of 128 daemon reads",
  "all workspace.list calls return the same workspace set and a final call still succeeds",
  ["request id reuse", "response dropped under burst", "connection closes after queue drain"],
  async (t, opened) => {
    const replies = await Promise.all(
      Array.from({ length: 128 }, () => opened.client.call({ type: "workspace.list" })),
    );
    t.assertions.assert(replies.every((reply) => reply?.type === "workspaces"), "read burst lost a response");
    const identities = replies.map((reply) => JSON.stringify(reply)).filter((value, index, all) => all.indexOf(value) === index);
    t.assertions.assert(identities.length === 1, `read burst observed ${identities.length} workspace states`);
    const after = await opened.client.call({ type: "workspace.list" });
    t.assertions.assert(after?.type === "workspaces", "connection was unusable after burst");
  },
);

pressureCase(
  "specialty.backpressure.multi-client-read-fairness",
  "Six clients share a 192-read burst without starvation",
  "every client completes 32 reads and remains usable afterward",
  ["one socket monopolizes dispatcher", "per-client response routing crosses", "late client starves"],
  async (t, opened) => {
    const clients = [opened.client, ...await Promise.all(
      Array.from({ length: 5 }, (_, index) => t.flows.main.openSecondClient(opened, `burst-reader-${index}`)),
    )];
    try {
      const groups = await Promise.all(
        clients.map((client) => Promise.all(Array.from({ length: 32 }, () => client.call({ type: "workspace.list" })))),
      );
      for (const [index, replies] of groups.entries()) {
        t.assertions.assert(replies.length === 32 && replies.every((reply) => reply?.type === "workspaces"), `client ${index} starved`);
      }
      const final = await Promise.all(clients.map((client) => client.call({ type: "workspace.list" })));
      t.assertions.assert(final.every((reply) => reply?.type === "workspaces"), "a client died after shared burst");
    } finally {
      clients.forEach((client) => client.close());
    }
  },
);

pressureCase(
  "specialty.backpressure.parallel-distinct-writes",
  "Forty-eight distinct file writes complete without loss",
  "every acknowledged write is present on disk with its exact payload",
  ["write queue drops tail", "payload crosses request ids", "ack precedes durable write"],
  async (t, opened) => {
    mkdirSync(path.join(opened.workspaceRoot, "burst"), { recursive: true });
    const entries = Array.from({ length: 48 }, (_, index) => ({
      path: `burst/file-${String(index).padStart(2, "0")}.txt`,
      content: `payload-${index}-${"x".repeat(index * 7)}`,
    }));
    const replies = await Promise.all(
      entries.map((entry) => opened.client.call({
        type: "file.write",
        payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/${entry.path}`, content: entry.content },
      })),
    );
    t.assertions.assert(replies.every((reply) => reply?.type === "ack"), "parallel file.write did not fully acknowledge");
    for (const entry of entries) t.assertions.fileEquals(opened.workspaceRoot, entry.path, entry.content);
  },
);

pressureCase(
  "specialty.backpressure.same-file-never-torn",
  "Concurrent writes to one file never leave a torn payload",
  "the final bytes equal one complete submitted payload and daemon reads remain live",
  ["truncate and write interleave", "two payloads concatenate", "write race wedges file service"],
  async (t, opened) => {
    const payloads = Array.from({ length: 24 }, (_, index) =>
      `BEGIN-${index}\n${String(index).repeat(2_000 + index * 31)}\nEND-${index}\n`);
    const replies = await Promise.all(
      payloads.map((content) => opened.client.call({
        type: "file.write",
        payload: { workspaceId: opened.workspaceId, path: `${opened.rootHandle}/contended.txt`, content },
      })),
    );
    t.assertions.assert(replies.every((reply) => reply?.type === "ack"), "contended write was not acknowledged");
    const final = readFileSync(`${opened.workspaceRoot}/contended.txt`, "utf8");
    t.assertions.assert(payloads.includes(final), `final file was torn (${final.length} bytes)`);
    const listed = await opened.client.call({ type: "workspace.list" });
    t.assertions.assert(listed?.type === "workspaces", "daemon stalled after contended writes");
  },
);

pressureCase(
  "specialty.backpressure.slow-shell-does-not-block-reads",
  "A slow shell stream does not block unrelated daemon reads",
  "workspace.list returns promptly while shell.run is still sleeping, then the stream exits zero",
  ["stream owns message loop", "read waits for child exit", "slow stdout blocks RPC responses"],
  async (t, opened) => {
    const shell = t.flows.main.startShell(opened.client, {
      workspaceId: opened.workspaceId,
      argv: ["sh", "-c", "sleep 2; printf finished"],
    });
    const started = Date.now();
    const listed = await opened.client.call({ type: "workspace.list" });
    const elapsed = Date.now() - started;
    t.assertions.assert(listed?.type === "workspaces", "read failed during slow shell");
    t.assertions.assert(elapsed < 750, `read waited ${elapsed}ms for slow shell`);
    const result = await shell.result;
    t.assertions.assert(result.status === 200, `slow shell status ${result.status}`);
    t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "slow shell did not exit zero");
    t.assertions.assert(t.flows.main.shellText(result.frames, "stdout") === "finished", "slow shell output changed");
  },
);

pressureCase(
  "specialty.backpressure.large-shell-output-drains",
  "A one-megabyte shell stream drains with exact framing",
  "all stdout bytes arrive, the exit frame follows, and a subsequent daemon read succeeds",
  ["consumer backpressure truncates stream", "frame boundary loses bytes", "large stream poisons connection"],
  async (t, opened) => {
    const result = await t.flows.main.runShell(opened.client, {
      workspaceId: opened.workspaceId,
      argv: ["sh", "-c", "head -c 1048576 /dev/zero | tr '\\000' z"],
      timeoutMs: 30_000,
    });
    const stdout = t.flows.main.shellText(result.frames, "stdout");
    t.assertions.assert(result.status === 200, `large shell status ${result.status}`);
    t.assertions.assert(stdout.length === 1_048_576, `large stream delivered ${stdout.length} bytes`);
    t.assertions.assert(/^z+$/.test(stdout), "large stream contained corrupt bytes");
    t.assertions.assert(t.flows.main.shellExit(result.frames)?.code === 0, "large stream lacked successful exit");
    const listed = await opened.client.call({ type: "workspace.list" });
    t.assertions.assert(listed?.type === "workspaces", "connection died after large stream");
  },
);

pressureCase(
  "specialty.backpressure.disconnect-cancels-only-own-requests",
  "Closing a client with 96 in-flight reads spares other clients",
  "the closing client's calls settle while a survivor completes reads before and after cleanup",
  ["connection cleanup blocks dispatcher", "pending map shared across clients", "disconnect closes peer sockets"],
  async (t, opened) => {
    const doomed = await t.flows.main.openSecondClient(opened, "doomed-burst");
    const survivor = await t.flows.main.openSecondClient(opened, "surviving-burst");
    try {
      const pending = Array.from({ length: 96 }, () => doomed.call({ type: "workspace.list" }));
      const settled = Promise.allSettled(pending);
      doomed.close();
      const during = await survivor.call({ type: "workspace.list" });
      t.assertions.assert(during?.type === "workspaces", "survivor failed during peer cleanup");
      await settled;
      const after = await survivor.call({ type: "workspace.list" });
      t.assertions.assert(after?.type === "workspaces", "survivor failed after peer cleanup");
    } finally {
      doomed.close(); survivor.close();
    }
  },
);

pressureCase(
  "specialty.backpressure.agent-burst-keeps-reads-fair",
  "Twelve concurrent Agent turns do not starve daemon reads",
  "all turns complete while repeated workspace.list calls remain responsive and valid",
  ["Agent scheduler monopolizes runtime", "session queue drops completions", "ordinary reads wait for all models"],
  async (t, opened) => {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const count = 12;
    opened.mock.script(...Array.from({ length: count }, (_, index) => ({ text: `burst-${index}`, delayMs: 250 })));
    const sessions = await Promise.all(
      Array.from({ length: count }, () => t.flows.main.createBuiltinSession(opened.client, opened.workspaceId)),
    );
    const logs = await Promise.all(sessions.map((session) => t.flows.main.attachEventLog(opened.client, session)));
    await Promise.all(sessions.map((session, index) => t.flows.main.sendPrompt(opened.client, session, `Burst ${index}`)));
    const latencies: number[] = [];
    for (let index = 0; index < 24; index += 1) {
      const started = Date.now();
      const reply = await opened.client.call({ type: "workspace.list" });
      latencies.push(Date.now() - started);
      t.assertions.assert(reply?.type === "workspaces", `read ${index} failed during Agent burst`);
    }
    await t.tools.waitUntil(
      () => logs.every((events) => events.some((event) => event.type === "turnCompleted")),
      60_000,
    );
    const max = Math.max(...latencies);
    t.assertions.assert(max < 1_000, `Agent burst starved a daemon read for ${max}ms`);
  },
  true,
);

pressureCase(
  "specialty.backpressure.preview-flood-exact-bytes",
  "A burst of 128 previews preserves each response and the original connection",
  "128 distinct 256 KiB files return exact bytes; an independent peer stays usable and the original logical owner remains",
  ["preview flood closes peer", "crossed preview responses", "writer pressure loses control frames"],
  async (t, opened) => {
    const peer = await t.flows.main.openSecondClient(opened, "preview-control");
    const owner = opened.client.logicalConnectionId;
    const files = Array.from({ length: 128 }, (_, n) => {
      const bytes = Buffer.alloc(256 * 1024, n);
      const name = `flood-${n}.bin`;
      writeFileSync(path.join(t.env.workspace, name), bytes);
      return { name, bytes };
    });
    try {
      let completed = 0;
      const pending = Promise.all(files.map(async file => {
        const response = await opened.client.preview(opened.workspaceId, `${opened.rootHandle}/${file.name}`);
        t.assertions.assert(Buffer.from(response.bytes).equals(file.bytes), `preview bytes crossed or truncated: ${file.name}`);
        completed++;
      }));
      // Attach rejection handling before the independent peer probe.
      const outcome = pending.then(() => null, error => error as Error);
      for (let n = 0; n < 5; n++) {
        const started = performance.now();
        const reply = await peer.call({ type: "workspace.list" });
        t.assertions.assert(reply?.type === "workspaces" && performance.now() - started < 2000, "preview flood blocked independent peer");
      }
      const failure = await outcome;
      if (failure) throw failure;
      t.assertions.assert(completed === 128, "preview did not complete every response");
      t.assertions.assert(opened.client.logicalConnectionId === owner, "preview flood replaced original owner");
      t.assertions.assert((await opened.client.call({ type: "workspace.list" }))?.type === "workspaces", "original peer unusable after preview flood");
    } finally { peer.close(); }
  },
);
