import type { SessionSnapshot } from "@genehub/proto";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

for (const scenario of ["pending-entry", "reply-read"] as const) {
  defineSpecialty({
    id: `specialty.page-experience.session-attention.${scenario}`,
    title: `Expert and session attention stays actionable across ${scenario}`,
    oracle: "The real Workbench opens every counted Human request, including archived sessions beyond recent history; only new assistant replies become unread, and viewing them clears both browser tabs",
    catches: ["expert hand opens an empty recent list", "viewing a question clears unresolved work", "old history or own input creates unread", "read state does not reach another tab", "session status bubbles into navigation"],
    tags: ["page-experience", "session-attention"], runner: "playwright", llm: { default: "mock" },
    expectedDurationMs: 45_000, timeoutMs: 180_000,
    resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
    surfaces: ["workbench-ui", "daemon", "agent"],
    productInterfaces: ["@genehub/workbench", "session.list", "session.send", "session.archive", "session.respondPermission"],
  }, async t => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      await opened.client.call({ type: "workspace.rename", payload: { workspaceId: opened.workspaceId, name: "提示验收专家" } });
      let calls = 0;
      const respond = () => {
        const call = calls++;
        if (scenario === "pending-entry" && call === 0) return { tool: { name: "request_user_input", arguments: { questions: [{ id: "scope", header: "范围", question: "选择验收范围", options: [{ label: "启动", description: "检查启动" }, { label: "全部", description: "检查所有关卡" }] }] } } };
        if (scenario === "reply-read" && call === 3) return { hang: true as const };
        return { text: `ATTENTION_REPLY_${call}：已处理本次要求。` };
      };
      opened.mock.script(...Array.from({ length: 12 }, () => ({ respond })));
      const create = async (title: string) => {
        const id = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
        await opened.client.call({ type: "session.rename", payload: { sessionId: id, title } });
        return id;
      };
      const target = await create("需要关注的会话");
      const snapshot = async (): Promise<SessionSnapshot> => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: target } });
        if (reply?.type !== "snapshot") throw new Error("missing target snapshot");
        return reply.data;
      };
      const send = (text: string) => t.flows.main.sendPrompt(opened.client, target, text);
      await send("请处理本次要求。");
      await t.tools.waitUntil(async () => scenario === "pending-entry"
        ? (await snapshot()).summary.interactionSummary?.count === 1
        : (await snapshot()).summary.status === "idle" && !!(await snapshot()).summary.latestReply, 30_000);
      if (scenario === "pending-entry") await opened.client.call({ type: "session.archive", payload: { sessionId: target, archived: true } });
      let landing = "";
      for (let index = 0; index < (scenario === "pending-entry" ? 12 : 1); index++) landing = await create(`普通会话 ${index}`);
      browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, landing);
      const page = browser.page;
      await page.getByRole("button", { name: "当前专家", exact: true }).waitFor();
      const nav = page.getByRole("navigation", { name: "工作台导航" });
      await nav.getByRole("button", { name: "专家", exact: true }).click();
      if (scenario === "pending-entry") {
        await page.getByRole("button", { name: "查看 提示验收专家 的 1 项待办", exact: true }).waitFor();
        t.assertions.assert(await nav.locator(".bg-danger, [aria-label='有未读新回复']").count() === 0, "pending session bubbled into navigation");
        await page.getByRole("button", { name: "查看 提示验收专家 的 1 项待办", exact: true }).click();
        const panel = page.getByRole("region", { name: "专家页面" });
        await panel.getByRole("button", { name: "待你处理", exact: true }).waitFor();
        const row = panel.locator(".conversation-row").filter({ hasText: "需要关注的会话" });
        await row.getByText(/已归档/).waitFor();
        await row.getByRole("button").first().click();
        const question = page.getByRole("group", { name: "选择验收范围", exact: true });
        await question.waitFor();
        t.assertions.assert((await snapshot()).summary.interactionSummary?.count === 1, "opening a question cleared the real pending request");
        await page.setViewportSize({ width: 390, height: 844 });
        await question.getByRole("radio", { name: "启动", exact: true }).check();
        await page.getByRole("button", { name: "提交答案", exact: true }).click();
        await t.tools.waitUntil(async () => (await snapshot()).summary.interactionSummary?.count === 0, 30_000);
        await page.setViewportSize({ width: 1280, height: 800 });
        await nav.getByRole("button", { name: "专家", exact: true }).click();
        await page.getByRole("button", { name: "提示验收专家", exact: true }).waitFor();
        await t.tools.waitUntil(async () => await page.getByRole("button", { name: /查看 提示验收专家 的 .* 项待办/ }).count() === 0, 15_000);
      } else {
        await nav.getByRole("button", { name: "会话", exact: true }).click();
        const list = page.getByRole("complementary", { name: "会话列表", exact: true });
        const row = list.locator(".conversation-row").filter({ hasText: "需要关注的会话" });
        await row.waitFor();
        t.assertions.assert(await row.getByLabel("有未读新回复").count() === 0, "first-load history was marked unread");
        const second = await browser.context.newPage();
        await second.goto(page.url());
        await second.getByRole("button", { name: "当前专家", exact: true }).waitFor();
        await second.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
        const secondRow = second.getByRole("complementary", { name: "会话列表", exact: true }).locator(".conversation-row").filter({ hasText: "需要关注的会话" });
        await secondRow.waitFor();
        await send("请给出一条新回复。");
        await row.getByLabel("有未读新回复").waitFor();
        await secondRow.getByLabel("有未读新回复").waitFor();
        await second.bringToFront();
        await secondRow.getByRole("button").first().click();
        await second.getByText("ATTENTION_REPLY_1：已处理本次要求。", { exact: true }).waitFor();
        await t.tools.waitUntil(async () => await row.getByLabel("有未读新回复").count() === 0, 15_000);
        await second.close();
        await page.bringToFront();
        await send("再给出一条新回复。");
        await row.getByLabel("有未读新回复").waitFor();
        await row.hover();
        await row.getByRole("button", { name: "需要关注的会话 的更多操作", exact: true }).click();
        await page.getByRole("menuitem", { name: "标为已读", exact: true }).click();
        await t.tools.waitUntil(async () => await row.getByLabel("有未读新回复").count() === 0, 15_000);
        const cursor = (await snapshot()).summary.latestReply;
        await send("这是一条用户输入，等待回复。");
        await t.tools.waitUntil(async () => (await snapshot()).summary.status === "running", 30_000);
        await row.getByText("Agent 处理中", { exact: true }).waitFor();
        t.assertions.assert((await snapshot()).summary.latestReply?.itemId === cursor?.itemId && await row.getByLabel("有未读新回复").count() === 0, "own input or running status produced unread content");
        await opened.client.call({ type: "session.interrupt", payload: { sessionId: target } });
      }
      t.assertions.assert(await nav.locator(".bg-danger, [aria-label='有未读新回复']").count() === 0, "session attention bubbled into the navigation");
      t.note(`${scenario}: real summary RPC and browser actions verified; no UI store or product client was replaced`);
    } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
  });
}
