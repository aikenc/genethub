import { existsSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

async function withAgent(t: CaseContext, run: (opened: Opened) => Promise<void>): Promise<void> {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await run(opened);
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

function agentCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext) => Promise<void>,
  timeoutMs = 90_000,
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "agent", "fault-depth"],
      llm: { default: "mock" },
      resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      expectedDurationMs: 30_000,
      timeoutMs,
      surfaces: ["daemon", "agent", "workbench-client"],
      productInterfaces: ["genet-cli", "@genehub/workbench/client"],
    },
    run,
  );
}

function terminal(events: Array<{ type?: string }>): boolean {
  return events.some((item) => item.type === "turnCompleted" || item.type === "turnFailed" || item.type === "turnCanceled");
}

function eventTrace(events: Array<{ type?: string; raw?: unknown }>): string {
  return JSON.stringify(
    events.map((entry) => {
      const envelope = entry.raw as { event?: { error?: unknown } } | undefined;
      return envelope?.event?.error === undefined
        ? { type: entry.type }
        : { type: entry.type, error: envelope.event.error };
    }),
  );
}

agentCase(
  "specialty.agent.http-500-keeps-daemon-live",
  "A provider 500 fails one turn without poisoning the daemon",
  "the turn reaches a terminal failure and another client can immediately list workspaces",
  ["agent failure crashes daemon", "failed turn never terminates", "connection pool remains poisoned"],
  async (t) => {
    await withAgent(t, async (opened) => {
      opened.mock.script({ status: 500 });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Trigger a controlled provider failure.");
      await t.tools.waitUntil(() => terminal(events), 45_000);
      t.assertions.assert(events.some((item) => item.type === "turnFailed"), `events ${events.map((item) => item.type)}`);
      const observer = await t.flows.main.openSecondClient(opened, "post-500-liveness");
      try {
        const listed = await observer.call({ type: "workspace.list" });
        t.assertions.assert(listed?.type === "workspaces", "daemon was not usable after agent failure");
      } finally {
        observer.close();
      }
    });
  },
);

agentCase(
  "specialty.agent.failure-does-not-poison-next-turn",
  "A failed provider request does not poison the next session",
  "a 500 turn fails, then a new session completes using the next scripted response",
  ["failure state shared across sessions", "mock/provider transport cannot recover", "agent child remains wedged"],
  async (t) => {
    await withAgent(t, async (opened) => {
      opened.mock.script({ status: 500 }, { text: "recovered" });
      const failedId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const failedEvents = await t.flows.main.attachEventLog(opened.client, failedId);
      await t.flows.main.sendPrompt(opened.client, failedId, "First request.");
      await t.tools.waitUntil(() => terminal(failedEvents), 45_000);
      t.assertions.assert(failedEvents.some((item) => item.type === "turnFailed"), "first request did not fail");

      const recoveredId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const recoveredEvents = await t.flows.main.attachEventLog(opened.client, recoveredId);
      await t.flows.main.sendPrompt(opened.client, recoveredId, "Second request.");
      await t.tools.waitUntil(() => terminal(recoveredEvents), 45_000);
      t.assertions.assert(
        recoveredEvents.some((item) => item.type === "turnCompleted"),
        `next turn did not recover: ${eventTrace(recoveredEvents)}`,
      );
    });
  },
);

agentCase(
  "specialty.agent.parallel-tools-preserve-arguments",
  "Parallel tool calls preserve each call's arguments",
  "two writes emitted in one model chunk create two distinct files with their own contents",
  ["parallel tool ids share arguments", "only first tool executes", "last tool overwrites earlier call"],
  async (t) => {
    await withAgent(t, async (opened) => {
      opened.mock.script(
        {
          tools: [
            { name: "write", arguments: { path: "parallel-a.txt", content: "alpha" } },
            { name: "write", arguments: { path: "parallel-b.txt", content: "bravo" } },
          ],
        },
        { text: "Both files are written." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Create two independent files.");
      await t.tools.waitUntil(
        () => existsSync(path.join(opened.workspaceRoot, "parallel-a.txt")) && existsSync(path.join(opened.workspaceRoot, "parallel-b.txt")),
        45_000,
      );
      t.assertions.fileEquals(opened.workspaceRoot, "parallel-a.txt", "alpha");
      t.assertions.fileEquals(opened.workspaceRoot, "parallel-b.txt", "bravo");
      await t.tools.waitUntil(() => terminal(events), 30_000);
      t.assertions.assert(events.some((item) => item.type === "turnCompleted"), "parallel tool turn did not complete");
    });
  },
);

agentCase(
  "specialty.agent.qwen-empty-tool-id-tail-preserves-arguments",
  "A Qwen empty tool-id tail frame cannot erase the real call",
  "the public Agent session reassembles an id frame, an argument delta, and an empty-id tail into one successful write",
  ["empty Qwen tail overwrites the call id", "tool arguments detach from their streamed call", "Qwen tool call becomes unknown"],
  async (t) => {
    await withAgent(t, async (opened) => {
      opened.mock.script(
        {
          tool: {
            name: "write",
            arguments: { path: "qwen-tail.txt", content: "arguments survived" },
          },
          qwenEmptyToolIdTail: true,
        },
        { text: "The Qwen-shaped tool call completed." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Execute the streamed Qwen-shaped write call.");
      await t.tools.waitUntil(() => existsSync(path.join(opened.workspaceRoot, "qwen-tail.txt")), 45_000);
      t.assertions.fileEquals(opened.workspaceRoot, "qwen-tail.txt", "arguments survived");
      await t.tools.waitUntil(() => terminal(events), 30_000);
      t.assertions.assert(
        events.some((item) => item.type === "turnCompleted"),
        `Qwen-shaped tool turn did not complete: ${eventTrace(events)}`,
      );
    });
  },
);

agentCase(
  "specialty.agent.genehub-tool-preserves-argv-and-stops",
  "The GeneHub control tool preserves argv and stops at the first failure",
  "a real built-in Agent rejects an invalid batch before spawn, then reports literal argv and never executes the second CLI command after the first fails",
  [
    "GeneHub commands are parsed by a shell",
    "a failed command does not stop its batch",
    "an invalid batch reaches a child process",
  ],
  async (t) => {
    await withAgent(t, async (opened) => {
      opened.mock.script(
        { tool: { name: "genehub", arguments: {} } },
        { text: "The invalid batch was rejected." },
        {
          tool: {
            name: "genehub",
            arguments: {
              commands: [
                { argv: ["--definitely-invalid", "$HOME", "a b"] },
                { argv: ["version", "unreached"] },
              ],
            },
          },
        },
        { text: "The failing command stopped the batch." },
        {
          tool: {
            name: "genehub",
            arguments: {
              commands: [
                {
                  argv: [
                    "shell",
                    "--cwd",
                    opened.workspaceRoot,
                    "--",
                    "sh",
                    "-c",
                    "printf ran > invalid-batch-ran.txt",
                  ],
                },
                { argv: [42] },
              ],
            },
          },
        },
        { text: "The malformed trailing command prevented the whole batch." },
      );

      const invalidSession = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const invalidEvents = await t.flows.main.attachEventLog(opened.client, invalidSession);
      await t.flows.main.sendPrompt(opened.client, invalidSession, "Run an invalid GeneHub batch.");
      await t.tools.waitUntil(() => terminal(invalidEvents), 45_000);

      const invalidOutput = await persistedGenehubOutput(opened, invalidSession);
      t.assertions.assert(
        invalidOutput.includes("'commands' is required"),
        `invalid batch was not rejected before spawn: ${invalidOutput}`,
      );

      const argvSession = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const argvEvents = await t.flows.main.attachEventLog(opened.client, argvSession);
      await t.flows.main.sendPrompt(opened.client, argvSession, "Run the exact argv batch.");
      await t.tools.waitUntil(() => terminal(argvEvents), 45_000);

      const output = await persistedGenehubOutput(opened, argvSession);
      t.assertions.assert(output.includes("$HOME"), `literal dollar argument was lost: ${output}`);
      t.assertions.assert(output.includes("a b"), `space-containing argument was lost: ${output}`);
      t.assertions.assert(output.includes('"failedAt":0'), `first failure was not reported: ${output}`);
      t.assertions.assert(!output.includes("unreached"), `second command ran after failure: ${output}`);

      const preflightSession = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const preflightEvents = await t.flows.main.attachEventLog(opened.client, preflightSession);
      await t.flows.main.sendPrompt(opened.client, preflightSession, "Reject the malformed trailing argv before execution.");
      await t.tools.waitUntil(() => terminal(preflightEvents), 45_000);

      const preflightOutput = await persistedGenehubOutput(opened, preflightSession);
      t.assertions.assert(
        preflightOutput.includes("commands[1].argv[0] must be a string"),
        `malformed trailing argv was not reported: ${preflightOutput}`,
      );
      t.assertions.assert(
        !existsSync(path.join(opened.workspaceRoot, "invalid-batch-ran.txt")),
        "an earlier command ran before the whole batch passed validation",
      );
    });
  },
);

async function persistedGenehubOutput(opened: Opened, sessionId: string): Promise<string> {
  const rounds = await opened.client.call({
    type: "session.rounds",
    payload: { sessionId, throughRoundId: null, cursor: null, limit: 1 },
  });
  if (rounds?.type !== "sessionRounds") {
    throw new Error(`session.rounds ${sessionId} returned ${rounds?.type}`);
  }
  const round = rounds.data.rounds.at(-1);
  if (!round) throw new Error(`session.rounds ${sessionId} returned no round`);

  const layer = await opened.client.call({
    type: "round.trunk.list",
    payload: { sessionId, roundId: round.roundId, cursor: null, limit: 32 },
  });
  if (layer?.type !== "roundLayer") {
    throw new Error(`round.trunk.list ${sessionId}/${round.roundId} returned ${layer?.type}`);
  }
  for (const summary of [...layer.data.trunks].reverse()) {
    const reply = await opened.client.call({
      type: "round.trunk.get",
      payload: { sessionId, roundId: round.roundId, trunkIndex: summary.index },
    });
    if (reply?.type !== "roundTrunk") {
      throw new Error(`round.trunk.get ${sessionId}/${round.roundId}/${summary.index} returned ${reply?.type}`);
    }
    for (const batch of [...reply.data.batches].reverse()) {
      for (const overview of [...batch.blobs].reverse()) {
        if (overview.kind !== "toolCall" || !overview.blob) continue;
        const blob = await opened.client.call({
          type: "blob.get",
          payload: { sessionId, blob: overview.blob },
        });
        if (blob?.type !== "blob") {
          throw new Error(`blob.get ${sessionId}/${overview.blob.id} returned ${blob?.type}`);
        }
        const item = blob.data.value as {
          type?: string;
          name?: string;
          status?: string;
          detail?: { kind?: string; raw?: { output?: unknown } };
        };
        const output = item.detail?.kind === "unknown" ? item.detail.raw?.output : undefined;
        if (
          item.type === "toolCall" &&
          item.name === "genehub" &&
          item.status === "error" &&
          typeof output === "string"
        ) {
          return output;
        }
      }
    }
  }
  throw new Error(`persisted GeneHub error output missing for ${sessionId}`);
}

agentCase(
  "specialty.agent.disconnected-subscriber-does-not-cancel",
  "Disconnecting the observing client does not cancel agent work",
  "a delayed tool turn writes its file after the initiating client closes and a new client can read the session",
  ["connection owns task lifetime", "subscriber drop kills agent", "completed work becomes unreachable"],
  async (t) => {
    await withAgent(t, async (opened) => {
      opened.mock.script(
        { tool: { name: "write", arguments: { path: "after-disconnect.txt", content: "survived" } }, delayMs: 800 },
        { text: "done" },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Write after I leave.");
      opened.client.close();
      await t.tools.waitUntil(() => existsSync(path.join(opened.workspaceRoot, "after-disconnect.txt")), 45_000);
      t.assertions.fileEquals(opened.workspaceRoot, "after-disconnect.txt", "survived");
      const returning = await t.flows.main.openSecondClient(opened, "returning-after-disconnect");
      try {
        const fetched = await returning.call({ type: "session.get", payload: { sessionId } });
        t.assertions.assert(
          fetched?.type === "snapshot" && fetched.data.summary.id === sessionId,
          "session vanished with its initiating client",
        );
      } finally {
        returning.close();
      }
    });
  },
);

agentCase(
  "specialty.agent.eight-sessions-complete-independently",
  "Eight concurrent Agent sessions complete without event cross-talk",
  "each subscription observes exactly one start and one terminal completion for its own session",
  ["shared event fanout", "session scheduler drops work", "one completion satisfies several subscribers"],
  async (t) => {
    await withAgent(t, async (opened) => {
      const count = 8;
      opened.mock.script(...Array.from({ length: count }, (_, index) => ({ text: `reply-${index}`, delayMs: 100 })));
      const sessions = await Promise.all(
        Array.from({ length: count }, () => t.flows.main.createBuiltinSession(opened.client, opened.workspaceId)),
      );
      const logs = await Promise.all(sessions.map((sessionId) => t.flows.main.attachEventLog(opened.client, sessionId)));
      await Promise.all(sessions.map((sessionId, index) => t.flows.main.sendPrompt(opened.client, sessionId, `Prompt ${index}`)));
      await t.tools.waitUntil(() => logs.every((events) => terminal(events)), 60_000);
      for (const [index, events] of logs.entries()) {
        t.assertions.assert(
          events.filter((item) => item.type === "turnStarted").length === 1,
          `session ${index} starts: ${events.map((item) => item.type)}`,
        );
        t.assertions.assert(
          events.filter((item) => item.type === "turnCompleted").length === 1,
          `session ${index} completions: ${eventTrace(events)}`,
        );
      }
    });
  },
  120_000,
);

agentCase(
  "specialty.agent.catalog-refresh-stable",
  "Repeated Agent refresh keeps the built-in catalog structurally stable",
  "twenty refreshes retain one ready genet entry with the same unique model and mode ids",
  ["refresh duplicates agents", "catalog races return empty", "model or mode ids accumulate duplicates"],
  async (t) => {
    await withAgent(t, async (opened) => {
      let baselineModels: string[] | undefined;
      let baselineModes: string[] | undefined;
      for (let index = 0; index < 20; index += 1) {
        const reply = await opened.client.call({ type: "agent.refresh" });
        t.assertions.assert(reply?.type === "agents", `agent.refresh returned ${reply?.type}`);
        const genet = reply?.type === "agents" ? reply.data.filter((agent) => agent.id === "genet") : [];
        t.assertions.assert(genet.length === 1, `refresh ${index} returned ${genet.length} genet entries`);
        const current = genet[0];
        t.assertions.assert(current?.probe.state === "ready", `refresh ${index} probe ${JSON.stringify(current?.probe)}`);
        const models = (current?.catalog.models ?? []).map((item) => item.id).sort();
        const modes = (current?.catalog.modes ?? []).map((item) => item.id).sort();
        t.assertions.assert(new Set(models).size === models.length, `duplicate models: ${models}`);
        t.assertions.assert(new Set(modes).size === modes.length, `duplicate modes: ${modes}`);
        baselineModels ??= models;
        baselineModes ??= modes;
        t.assertions.assert(JSON.stringify(models) === JSON.stringify(baselineModels), `model catalog drifted on refresh ${index}`);
        t.assertions.assert(JSON.stringify(modes) === JSON.stringify(baselineModes), `mode catalog drifted on refresh ${index}`);
      }
    });
  },
);

agentCase(
  "specialty.agent.mid-turn-second-send-refused-and-recovers",
  "A second prompt during an active turn is refused without corrupting the session",
  "the overlapping send fails, the original turn completes, and a later prompt completes normally",
  ["two turns overlap in one session", "refusal cancels original", "session remains permanently busy"],
  async (t) => {
    await withAgent(t, async (opened) => {
      opened.mock.script({ text: "first", delayMs: 900 }, { text: "second" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "First prompt.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnStarted"), 30_000);
      let refused = false;
      try {
        await t.flows.main.sendPrompt(opened.client, sessionId, "Overlapping prompt.");
      } catch {
        refused = true;
      }
      t.assertions.assert(refused, "overlapping prompt was accepted");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      const completionsBefore = events.filter((item) => item.type === "turnCompleted").length;
      await t.flows.main.sendPrompt(opened.client, sessionId, "Later prompt.");
      await t.tools.waitUntil(
        () => events.filter((item) => item.type === "turnCompleted").length === completionsBefore + 1,
        45_000,
      );
    });
  },
);
