import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.session-process-history",
  title: "Returning to a warm session shows its completed process history",
  oracle: "The browser shows both tool calls stored by the daemon after the session completes in the background",
  catches: ["a warm tab keeps an early trunk summary", "a refreshed summary keeps an old expanded trunk"],
  tags: ["page-experience", "session", "process-history"],
  runner: "playwright",
  llm: { default: "mock" },
  expectedDurationMs: 40_000,
  timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent"],
  productInterfaces: ["@genehub/workbench", "round.trunk.list"],
}, async (t) => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    opened.mock.script(
      { tool: { name: "bash", arguments: { command: "echo FIRST_PROCESS_CALL" } } },
      { tool: { name: "bash", arguments: { command: "echo SECOND_PROCESS_CALL" } }, delayMs: 8_000 },
      { text: "PROCESS_HISTORY_DONE" },
    );
    const target = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const other = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await opened.client.call({ type: "session.rename", payload: { sessionId: target, title: "过程记录目标" } });
    await opened.client.call({ type: "session.rename", payload: { sessionId: other, title: "旁观会话" } });
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, target);
    const page = browser.page;
    await page.getByRole("heading", { name: "过程记录目标", exact: true }).waitFor();

    await t.flows.main.sendPrompt(opened.client, target, "Run both commands.");
    await page.getByTestId("round-batch").first().waitFor({ timeout: 15_000 });
    const nav = page.getByRole("navigation", { name: "工作台导航" });
    await nav.getByRole("button", { name: "会话", exact: true }).click();
    const list = page.getByRole("complementary", { name: "会话列表", exact: true });
    await list.locator(".conversation-row").filter({ hasText: "旁观会话" }).getByRole("button").first().click();
    await page.getByRole("heading", { name: "旁观会话", exact: true }).waitFor();

    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: target } });
      return reply?.type === "snapshot" && reply.data.summary.status === "idle";
    }, 45_000);
    const rounds = await opened.client.call({ type: "session.rounds", payload: { sessionId: target, limit: 20, throughRoundId: null, cursor: null } });
    if (rounds?.type !== "sessionRounds") throw new Error("missing completed round");
    const roundId = rounds.data.rounds.at(-1)?.roundId;
    if (!roundId) throw new Error("missing completed round id");
    const layer = await opened.client.call({ type: "round.trunk.list", payload: { sessionId: target, roundId, limit: 20, cursor: null } });
    if (layer?.type !== "roundLayer") throw new Error("missing completed process layer");
    const storedTools = layer.data.trunks.reduce((count, trunk) => count + trunk.blobCount, 0);
    t.assertions.assert(storedTools === 2, `daemon stored ${storedTools} process rows instead of two: ${JSON.stringify({ rounds: rounds.data.rounds.map((round) => ({ id: round.roundId, outcome: round.outcome })), trunks: layer.data.trunks.map((trunk) => ({ index: trunk.index, blobCount: trunk.blobCount })), mockRequests: opened.mock.requests.length })}`);

    await list.locator(".conversation-row").filter({ hasText: "过程记录目标" }).getByRole("button").first().click();
    await page.getByRole("heading", { name: "过程记录目标", exact: true }).waitFor();
    const trunk = page.getByTestId("round-trunk").last();
    await t.tools.waitUntil(async () => {
      const header = trunk.getByRole("button").first();
      if (await header.getAttribute("aria-expanded") === "false") await header.click();
      for (const batch of await trunk.getByTestId("round-batch").all()) {
        const button = batch.getByRole("button").first();
        if (await button.getAttribute("aria-expanded") === "false") await button.click();
      }
      return await trunk.getByTestId("blob-row").count() === 2;
    }, 15_000);
    t.assertions.assert(await trunk.getByText("echo SECOND_PROCESS_CALL", { exact: false }).count() > 0,
      "browser kept the early expanded trunk after switching back");
    t.note("Public daemon layer contains two tools and the returned browser tab renders both");
  } finally {
    await browser?.close();
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});
