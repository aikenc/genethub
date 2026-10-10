import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { connectProductClient, daemonEndpoint, defineSpecialty, openWorkbenchPage, parseJson, runGenet, runGenetAsync } from "../../framework/public.ts";

// Ordinary script Agent, real Session controller CLI and public Workbench.
// The real Codex installation canary separately covers native tool invocation.
defineSpecialty({
  id: "specialty.agent.conversation-question.browser",
  title: "A real CLI question stops execution and resumes through the browser after restart",
  oracle: "An Agent calls session.ask using its own controller identity; a real Workbench displays radio choices and text only after its CLI exits. Restart and page reload retain the same question. Human submission starts a fresh execution in the same Session with the answer and unchanged mode; the old question cannot be changed or answered again",
  catches: ["Agent cannot discover a conversation entry", "question waits on caller RPC", "browser answer detached from Session", "restart loses question", "ordinary answer elevates mode", "duplicate decision"],
  tags: ["core", "agent", "durable-interaction", "conversation-question"],
  llm: { default: "none" }, runner: "playwright", expectedDurationMs: 25_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 1, memoryMb: 1536, io: 1, browser: 1, pool: "browser" },
  surfaces: ["daemon", "script-agent", "real-cli", "browser", "filesystem", "os-process"],
  productInterfaces: ["genet session ask", "genet schema", "session.get", "session.respondPermission", "@genehub/workbench"],
}, async t => {
  const nonce = "browser-answer-" + randomBytes(8).toString("hex");
  const session = await t.flows.branches.openControlledAgentSession({ openRoot: t.openRoot, lease: t.env,
    agent: { profile: "cli-question", once: true, expectedResume: nonce, processTree: true } });
  let client = session.client;
  const snapshot = async () => {
    const reply = await client.call({ type: "session.get", payload: { sessionId: session.sessionId } });
    if (reply?.type !== "snapshot") throw new Error("no snapshot");
    return reply.data;
  };
  const browser = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(session.daemon), session.workspaceId, session.sessionId, {}, { trace: false });
  try {
    const schema = runGenet(session.daemon.genet, ["schema", "session.ask"], session.daemon.env);
    t.assertions.assert(schema.code === 0 && JSON.stringify(parseJson(schema.stdout)).includes("session.ask"), "question entry missing from schema");
    const bad = runGenet(session.daemon.genet, ["session", "ask", session.sessionId, "--question", "test", "--typo"], session.daemon.env);
    t.assertions.assert(bad.code === 2, "unknown question argument accepted");
    const mode = (await snapshot()).summary.modeId;
    await browser.page.getByRole("textbox", { name: "任务描述" }).fill("请使用平台提问入口给我一个输入框和选择。");
    await browser.page.getByRole("button", { name: "发送", exact: true }).click();
    await t.tools.waitUntil(async () => (await snapshot()).pendingPermissions.length === 1, 20_000);
    const before = await snapshot();
    const request = before.pendingPermissions[0]!;
    const children = session.journal().filter(e => ["session-start", "question-cli"].includes(e.event));
    t.assertions.assert(children.length === 2 && children.every(e => !t.flows.branches.processAlive(Number(e.cliPid))), "question shown while owned CLIs were alive");
    const tree = session.journal().find(e => e.event === "tree-created");
    t.assertions.assert(!!tree && [tree.rootPid, tree.leafPid, tree.siblingPid].every(pid => {
      try { const stat = readFileSync(`/proc/${Number(pid)}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z"; }
      catch { return true; }
    }), "question card kept Session descendants alive");
    await browser.page.getByRole("radio").first().waitFor();
    t.assertions.assert(await browser.page.getByPlaceholder("其他答案或补充说明").count() === 1, "question has no text input");
    // No original RPC, Agent process, browser connection, or daemon is needed.
    client.close(); session.daemon.stop();
    const started = runGenet(session.daemon.genet, ["daemon", "start"], session.daemon.env);
    t.assertions.assert(started.code === 0, "daemon restart failed");
    client = await connectProductClient(daemonEndpoint(session.daemon));
    await browser.page.reload();
    await browser.page.getByRole("radio").first().waitFor();
    t.assertions.assert((await snapshot()).pendingPermissions[0]?.id === request.id, "question changed on restart");
    const changed = await runGenetAsync(session.daemon.genet, ["session", "ask", session.sessionId, "--request-id", request.id, "--question", "changed"], session.daemon.env);
    t.assertions.assert(changed.code === 4, "same request id changed payload");
    await browser.page.getByRole("radio").first().check();
    await browser.page.getByPlaceholder("其他答案或补充说明").fill(nonce);
    await browser.page.getByRole("button", { name: "提交答案", exact: true }).click();
    await t.tools.waitUntil(() => session.journal().some(e => e.event === "continuation-received" && e.matched === true), 20_000);
    await t.tools.waitUntil(async () => (await snapshot()).summary.status === "idle", 15_000);
    const after = await snapshot();
    t.assertions.assert(after.pendingPermissions.length === 0 && after.summary.modeId === mode, "answer retained a question or elevated mode");
    t.assertions.assert(after.items.filter(i => i.type === "userMessage" && i.text.includes(nonce) && i.text.includes("选项 A")).length === 1, "submitted choice/text missing from persistent chat");
    await browser.page.getByText(nonce, { exact: false }).waitFor();
    await browser.page.reload();
    await browser.page.getByText(nonce, { exact: false }).waitFor();
    t.assertions.assert(await browser.page.getByText(nonce, { exact: false }).count() === 1, "reload lost or duplicated the submitted answer");
    const starts = session.journal().filter(e => e.event === "session-start");
    t.assertions.assert(starts.length === 2 && Number(starts[0]!.cliPid) !== Number(starts[1]!.cliPid), "answer reused old execution");
    let rejected = false;
    try { await client.call({ type: "session.respondPermission", payload: { sessionId: session.sessionId, requestId: request.id, outcome: { outcome: "canceled" } } }); }
    catch { rejected = true; }
    t.assertions.assert(rejected, "already answered question accepted again");
    t.note(`requestId=${request.id}; stoppedChildren=${children.length}; resumedExecutions=${starts.length - 1}`);
  } catch (error) {
    t.note("question journal: " + JSON.stringify(session.journal().slice(-18)));
    const logs = await t.flows.branches.agentLogs(client, session.agent.agentId).catch(() => []);
    t.note("Agent log: " + JSON.stringify(logs).slice(-2000));
    t.note("snapshot: " + JSON.stringify(await snapshot().catch(() => null)).slice(-2000));
    throw error;
  } finally { await browser.close(); client.close(); await session.dispose(); }
});
