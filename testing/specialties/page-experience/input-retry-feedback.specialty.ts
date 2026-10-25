import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.page-experience.input-retry-feedback",
  title: "A restored input receipt can resend a missing message without duplicating accepted work",
  oracle: "Browser retry against a real daemon resolves notFound using the original ID, clears an accepted receipt on reload, and preserves missing-attachment receipts",
  catches: ["404 blocks retry forever", "retry changes the input ID", "accepted message executes twice", "missing attachments are silently dropped"],
  tags: ["page-experience", "input-recovery"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 20_000, timeoutMs: 100_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "agent"], productInterfaces: ["@genehub/workbench", "session.narrative", "session.send"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    let calls = 0;
    opened.mock.script(...Array.from({ length: 6 }, () => ({ respond: () => { calls++; return { text: "RETRY_FEEDBACK_DELIVERED" }; } })));
    const session = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, session, { viewport: { width: 390, height: 844 } });
    const page = browser.page;
    await page.getByRole("textbox", { name: "任务描述" }).waitFor();
    const machine = daemonEndpoint(opened.daemon).localServerProof.machineId;
    // A persisted receipt is the disk fact left when a browser loses acceptance.
    // No product store, client or daemon is mocked; reload exercises restoration.
    const restore = async (messageId: string, missingAttachments = 0) => {
      await page.evaluate(({ machine, session, messageId, missingAttachments }) => {
        localStorage.setItem(`genehub.conversation.v1:input:${machine}:${session}:${messageId}`, JSON.stringify({ messageId, text: `RETRY_FEEDBACK ${messageId}`, sentAtMs: Date.now(), missingAttachments }));
      }, { machine, session, messageId, missingAttachments });
      await page.reload();
      await page.getByRole("textbox", { name: "任务描述" }).waitFor();
    };
    await restore("u_feedback_missing");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    // The reply can also become a sidebar title; require its message body.
    const delivered = page.getByTestId("markdown").getByText("RETRY_FEEDBACK_DELIVERED", { exact: true });
    await delivered.waitFor();
    const narrative = await opened.client.call({ type: "session.narrative", payload: { sessionId: session, itemId: "u_feedback_missing", throughRoundId: null, cursor: null, limit: null } });
    t.assertions.assert(narrative?.type === "sessionNarrative" && narrative.data.items.filter(item => item.id === "u_feedback_missing").length === 1, "retry did not retain the original ID");
    t.assertions.assert(calls === 1, "retry executed more than once");
    await restore("u_feedback_missing");
    await delivered.waitFor();
    t.assertions.assert(await page.getByRole("button", { name: "重试", exact: true }).count() === 0 && calls === 1, "accepted receipt re-executed or stayed pending");
    await restore("u_feedback_attachment", 1);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText(/本地附件已失效/).waitFor();
    t.assertions.assert(calls === 1, "retry silently discarded an attachment");
    t.note("Real browser: missing input retried once with original ID, accepted input reconciled, missing attachment kept pending");
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
