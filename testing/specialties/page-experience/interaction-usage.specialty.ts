import { defineSpecialty, openWorkbenchPage, daemonEndpoint } from "../../framework/public.ts";

for (const kind of ["unavailable", "reported-zero", "partial"] as const) {
  defineSpecialty({
    id: `specialty.page.interaction-usage.${kind}`,
    title: `Workbench shows provider accounting availability: ${kind}`,
    oracle: "A prompt sent by the actual Workbench composer displays unavailable statistics without claiming zero, preserves an explicitly reported zero, and labels partial counts; reload retains the same settled footer",
    catches: ["missing accounting rendered as zero", "valid zero hidden as missing", "partial subtotal shown as complete", "reload changes token availability"],
    tags: ["core", "page-experience", "durable-interaction", "interaction-usage"], llm: { default: "none" }, runner: "playwright",
    expectedDurationMs: 20_000, timeoutMs: 120_000,
    resources: { environments: 1, cpu: 1, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
    surfaces: ["daemon", "script-agent", "browser", "public-composer"], productInterfaces: ["@genehub/workbench", "session.send", "session.get"],
  }, async t => {
    const usage = kind === "unavailable" ? undefined : { tokenUsageStatus: kind === "partial" ? "partial" as const : "reported" as const,
      inputTokens: kind === "partial" ? 17 : 0, outputTokens: kind === "partial" ? 7 : 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmRounds: 1 };
    const session = await t.flows.branches.openControlledAgentSession({ openRoot: t.openRoot, lease: t.env, agent: { profile: "normal", usage } });
    const browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(session.daemon), session.workspaceId, session.sessionId, {}, { trace: false });
    try {
      await browser.page.getByRole("textbox", { name: "任务描述" }).fill("请回答这条消息");
      await browser.page.getByRole("button", { name: "发送", exact: true }).click();
      await t.tools.waitUntil(() => session.journal().some(e => e.event === "answered" && e.stopReason === "end_turn"), 20_000);
      const expected = kind === "unavailable" ? "未提供 token 统计" : kind === "reported-zero" ? "0 输出 tokens" : "7 输出 tokens（部分统计）";
      await browser.page.getByRole("button", { name: expected, exact: true }).waitFor();
      await browser.page.reload();
      await browser.page.getByRole("button", { name: expected, exact: true }).waitFor();
      t.assertions.assert(await browser.page.getByRole("button", { name: expected, exact: true }).count() === 1, "settled accounting changed or duplicated after reload");
    } finally { await browser.close(); await session.dispose(); }
  });
}
