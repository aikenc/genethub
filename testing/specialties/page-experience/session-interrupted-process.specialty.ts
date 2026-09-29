import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.session-interrupted-process",
  title: "A Human interruption starts a new process round under its own message",
  oracle: "After an explicit Human Stop interrupts an active turn and a durable input follows, the daemon keeps each tool in a distinct round and the browser shows one process card under each user message",
  catches: ["durable inbox continues a new request into the interrupted round", "the browser attaches both turns' tools to the first user message"],
  tags: ["page-experience", "session", "process-history"],
  runner: "playwright",
  llm: { default: "mock" },
  expectedDurationMs: 45_000,
  timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent"],
  productInterfaces: ["@genehub/workbench", "session.send", "session.rounds", "round.trunk.list"],
}, async (t) => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    opened.mock.script(
      { tool: { name: "bash", arguments: { command: "echo FIRST_PROCESS" } } },
      { hang: true },
      { tool: { name: "bash", arguments: { command: "echo SECOND_PROCESS" } } },
      { text: "SECOND_REQUEST_DONE" },
    );
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, sessionId);
    const page = browser.page;
    const send = (messageId: string, text: string) => opened.client.call({
      type: "session.send",
      payload: { sessionId, messageId, text, attachments: [], continuesRound: null },
    });
    const rounds = async () => {
      const reply = await opened.client.call({ type: "session.rounds", payload: { sessionId, throughRoundId: null, cursor: null, limit: 20 } });
      if (reply?.type !== "sessionRounds") throw new Error("missing process rounds");
      return reply.data.rounds;
    };
    const toolCount = async (roundId: string) => {
      const reply = await opened.client.call({ type: "round.trunk.list", payload: { sessionId, roundId, cursor: null, limit: 20 } });
      if (reply?.type !== "roundLayer") throw new Error(`missing process layer ${roundId}`);
      return reply.data.trunks.reduce((count, trunk) => count + trunk.blobCount, 0);
    };

    const firstId = "u_interrupted_process_first";
    const secondId = "u_interrupted_process_second";
    await send(firstId, "FIRST_REQUEST");
    await t.tools.waitUntil(async () => {
      const current = await rounds();
      return current.length === 1 && await toolCount(current[0]!.roundId) === 1 && opened.mock.requests.length >= 2;
    }, 30_000);
    await page.getByTestId("round-progress").first().waitFor();

    const stopped = await opened.client.call({ type: "session.interrupt", payload: { sessionId } });
    t.assertions.assert(stopped?.type === "ack", "explicit Stop was not accepted");
    await send(secondId, "SECOND_REQUEST");
    await t.tools.waitUntil(async () => {
      const current = await rounds();
      const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId } });
      return current.length === 2 && current[1]?.outcome === "completed" && snapshot?.type === "snapshot" && snapshot.data.summary.status === "idle";
    }, 45_000);
    const current = await rounds();
    t.assertions.assert(current[0]?.outcome === "superseded",
      `the interrupted round settled before the new input and did not exercise the dangling-round path: ${JSON.stringify(current)}`);
    t.assertions.assert(current[0]?.userItemId === firstId && current[1]?.userItemId === secondId,
      `interruption did not open a round for its own user message: ${JSON.stringify(current)}`);
    t.assertions.assert(await toolCount(current[0]!.roundId) === 1 && await toolCount(current[1]!.roundId) === 1,
      "interrupted and resumed tools crossed round boundaries");

    await t.tools.waitUntil(async () => await page.getByTestId("round-progress").count() === 2, 15_000);
    for (const request of ["FIRST_REQUEST", "SECOND_REQUEST"]) {
      const section = page.getByText(request, { exact: true }).locator("xpath=ancestor::section[1]");
      t.assertions.assert(await section.getByTestId("round-progress").count() === 1,
        `${request} does not own exactly one process card`);
    }
    t.note("Two durable Human messages, two daemon rounds, one tool in each and one process card under each browser message");
  } finally {
    await browser?.close();
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});
