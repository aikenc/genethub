import { defineSpecialty, daemonEndpoint, openWorkbenchPage, registerControlledAgent } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.session-interrupted-process",
  title: "A Human input during a running turn on an Agent without mid-turn steering opens its own process round",
  oracle: "With an Agent that cannot take a message mid-turn, a durable Human input interrupts the active turn, the daemon keeps each turn in a distinct round with its own user message, and the browser shows one process card under each message",
  catches: [
    "durable inbox continues a new request into the interrupted round",
    "the browser attaches both turns' tools to the first user message",
    "a steer-capable path is assumed for an Agent that has none",
  ],
  tags: ["page-experience", "session", "process-history", "interrupt"],
  runner: "playwright",
  llm: { default: "none" },
  expectedDurationMs: 60_000,
  timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent"],
  productInterfaces: ["@genehub/workbench", "session.send", "session.rounds", "round.trunk.list"],
}, async (t) => {
  // The script Agent has no mid-turn steering, so a durable Human input while
  // it is running interrupts the turn and opens a new round. A normal turn is
  // paced over several chunks so the interrupt lands while it is still active.
  registerControlledAgent(t.env, { id: "interrupt-agent", profile: "normal", chunks: 40, chunkIntervalMs: 200, tool: "bash" });
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.requireAgentReady(opened.client, "interrupt-agent");
    const sessionId = await t.flows.main.createAgentSession(opened.client, {
      workspaceId: opened.workspaceId,
      agentId: "interrupt-agent",
      modelId: null,
    });
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, sessionId);
    const page = browser.page;
    const send = (messageId: string, text: string) => opened.client.call({
      type: "session.send",
      payload: { sessionId, messageId, text, attachments: [], artifactPreviewBaseUrl: null, continuesRound: null },
    });
    const rounds = async () => {
      const reply = await opened.client.call({ type: "session.rounds", payload: { sessionId, throughRoundId: null, cursor: null, limit: 20 } });
      if (reply?.type !== "sessionRounds") throw new Error("missing process rounds");
      return reply.data.rounds;
    };

    const firstId = "u_interrupted_process_first";
    const secondId = "u_interrupted_process_second";
    const firstReply = await send(firstId, "FIRST_REQUEST");
    t.note(JSON.stringify({ phase: "first-sent", reply: firstReply?.type }));
    await t.tools.waitUntil(async () => {
      const current = await rounds();
      return current.length === 1 && current[0]?.outcome === "running";
    }, 30_000).catch(async (error) => {
      const current = await rounds().catch(e => String(e));
      const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId } }).catch(e => String(e));
      t.note(JSON.stringify({ phase: "first-timeout", current, status: typeof snapshot === "string" ? snapshot : (snapshot as any)?.data?.summary?.status }));
      throw error;
    });
    await page.getByTestId("round-progress").first().waitFor();

    await send(secondId, "SECOND_REQUEST");
    await t.tools.waitUntil(async () => {
      const current = await rounds();
      const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId } });
      return current.length === 2 && current[1]?.outcome === "completed" && snapshot?.type === "snapshot" && snapshot.data.summary.status === "idle";
    }, 60_000);
    const current = await rounds();
    t.assertions.assert(current[0]?.outcome === "superseded",
      `the interrupted round settled before the new input and did not exercise the dangling-round path: ${JSON.stringify(current)}`);
    t.assertions.assert(current[0]?.userItemId === firstId && current[1]?.userItemId === secondId,
      `interruption did not open a round for its own user message: ${JSON.stringify(current)}`);

    await t.tools.waitUntil(async () => await page.getByTestId("round-progress").count() === 2, 20_000);
    for (const request of ["FIRST_REQUEST", "SECOND_REQUEST"]) {
      const section = page.getByText(request, { exact: true }).locator("xpath=ancestor::section[1]");
      t.assertions.assert(await section.getByTestId("round-progress").count() === 1,
        `${request} does not own exactly one process card`);
    }
    t.note("Two durable Human messages, two daemon rounds, one process card under each browser message");
  } finally {
    await browser?.close();
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});
