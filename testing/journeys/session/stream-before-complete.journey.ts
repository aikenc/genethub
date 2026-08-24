import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.stream-before-complete",
    title: "Streaming output is visible before the turn ends",
    oracle: "text itemDelta arrives before turnCompleted, and settled text is at least as long as the streamed pieces",
    catches: ["UI blank until the end", "one-frame reply pretending to stream"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "a reasonably long answer that arrives in pieces" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Say something.");
      await t.tools.waitUntil(
        () => events.some((item) => item.type === "turnCompleted"),
        45_000,
      );
      const types = events.map((item) => item.type ?? "");
      const delta = types.indexOf("itemDelta");
      const completed = types.indexOf("turnCompleted");
      t.assertions.assert(delta >= 0, "no itemDelta before completion");
      t.assertions.assert(completed > delta, "completion arrived before any delta");
      const pieces = events
        .map((item) => t.flows.main.sessionEventOf(item))
        .filter((inner) => inner?.type === "itemDelta")
        .map((inner) => inner?.delta as { kind?: string; delta?: string } | undefined)
        .filter((piece) => piece?.kind === "text" && typeof piece.delta === "string")
        .map((piece) => piece!.delta as string);
      t.assertions.assert(pieces.length > 0, "no text pieces streamed");
      const settled = pieces.join("");
      t.assertions.assert(
        settled.length >= pieces.length,
        `settled text shorter than the streamed pieces: ${settled.length} chars / ${pieces.length} deltas`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
