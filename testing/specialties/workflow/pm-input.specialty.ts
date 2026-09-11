import type { PermissionOutcome, SessionSnapshot } from "@genehub/proto";
import {
  defineSpecialty, connectProductClient, daemonEndpoint, runGenet, parseJson,
} from "../../framework/public.ts";

for (const scenario of ["busy", "restart", "manual-stop", "human", "human-continuation"] as const) {
  defineSpecialty({
    id: `specialty.pm-input.${scenario}`,
    title: `Durable PM input across ${scenario}`,
    oracle: "Accepted original messages retain stable IDs and delivery responsibility; only PM's native execution is continued, manual stops persist, and consultation cannot answer the original Human card",
    catches: ["ACK claims an answer or loses its original message", "retries create duplicate messages", "a new input overlaps the old native turn", "consultation cancels or replaces an earlier Human request", "automatic continuation overrides an explicit stop"],
    tags: ["core", "session", "pm-input", "workflow-control"],
    llm: { default: "mock" }, expectedDurationMs: 25_000, timeoutMs: 120_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
    productInterfaces: ["session.send", "session.get", "session.interrupt", "session.respondPermission", "genet schema", "genet daemon start"],
  }, async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let client = opened.client;
    let second: typeof client | undefined;
    let calls = 0;
    const cli = (args: string[]) => {
      const result = runGenet(opened.daemon.genet, args, opened.daemon.env);
      if (result.code !== 0) throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout}`);
      return parseJson(result.stdout);
    };
    try {
      await t.flows.main.configureMockProvider(client, opened.mock);
      if (scenario === "busy") {
        const command = (name: string) => (cli(["schema", name]).data as { command: {
          mutation: boolean; routable: boolean;
          inputSchema: { properties: Record<string, unknown> };
          outputSchema: { properties: { type: { const?: string } } };
        } }).command;
        const input = command("session.send");
        t.assertions.assert(Boolean(input.inputSchema.properties.messageId && input.inputSchema.properties.taskRunId),
          "CLI discovery omitted durable message identity or its task reference");
        const checker = command("workflow.check");
        const cancel = command("workflow.cancel");
        t.assertions.assert(!checker.mutation && cancel.mutation && !cancel.routable,
          "workflow discovery confused inspection, mutation or local project routing");
        t.assertions.assert(cancel.outputSchema.properties.type.const === "workflow.cancelling",
          "cancellation discovery claimed confirmed cleanup at admission");
      }
      const respond = () => {
        const call = calls++;
        if (scenario.startsWith("human") && call === 0) return { tool: { name: "request_user_input", arguments: { questions: [{ id: "color", header: "颜色", question: "选择颜色", options: [{ label: "蓝色", description: "使用蓝色" }, { label: "绿色", description: "使用绿色" }] }] } } };
        if ((scenario === "human" && call === 1) || (scenario === "human-continuation" && call === 2) || ((scenario === "busy" || scenario === "manual-stop") && call === 0)) return { hang: true as const };
        return { text: "PM_INPUT_ANSWER: 已核对当前问题和已有执行结果。" };
      };
      opened.mock.script(...Array.from({ length: 12 }, () => ({ respond })));
      const sessionId = await t.flows.main.createBuiltinSession(client, opened.workspaceId);
      const snapshot = async (): Promise<SessionSnapshot> => {
        const reply = await client.call({ type: "session.get", payload: { sessionId } });
        if (reply?.type !== "snapshot") throw new Error("session.get omitted the snapshot");
        return reply.data;
      };
      const send = (messageId: string, text: string, via = client) => via.call({ type: "session.send", payload: { sessionId, messageId, text, attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } });
      const handled = async (ids: string[]) => {
        await t.tools.waitUntil(async () => {
          const current = await snapshot();
          if (current.summary.inputSummary?.error) throw new Error(current.summary.inputSummary.error);
          return current.summary.status === "idle" && ids.every(id => !current.summary.inputSummary?.pendingMessageIds.includes(id));
        }, 60_000);
      };
      if (scenario.startsWith("human")) {
        await t.flows.main.sendPrompt(client, sessionId, "HUMAN_ORIGINAL_GOAL: 请先询问颜色。");
        let paused: SessionSnapshot | undefined;
        await t.tools.waitUntil(async () => { paused = await snapshot(); return Boolean(paused.pendingPermissions?.length); }, 30_000);
        const request = paused!.pendingPermissions![0]!;
        const ack = await send("u_consult", "这两个颜色有什么区别？先解释，保留原问题。");
        t.assertions.assert(ack?.type === "ack", "consultation was not durably accepted");
        await t.tools.waitUntil(() => calls >= 2, 30_000);
        if (scenario === "human-continuation") await t.tools.waitUntil(async () => (await snapshot()).summary.status === "waiting", 30_000);
        const consulting = await snapshot();
        t.assertions.assert(consulting.pendingPermissions?.[0]?.id === request.id, "consultation lost or replaced the original Human request");
        t.assertions.assert((scenario === "human-continuation" || consulting.summary.status === "running"), "PM consultation did not own its own active turn");
        const outcome: PermissionOutcome = request.questions?.length ? { outcome: "answered", answers: request.questions.map(question => ({ questionId: question.id, selectedOptionIds: [question.options[0]!.id] })) } : { outcome: "selected", optionId: request.options[0]!.id };
        const decided = await client.call({ type: "session.respondPermission", payload: { sessionId, requestId: request.id, outcome } });
        t.assertions.assert(decided?.type === "ack", "Human decision was lost while PM was consulting");
        if (scenario === "human-continuation") {
          await t.tools.waitUntil(() => calls >= 3, 30_000);
          await send("u_during_decision", "继续执行前请解释刚才的选择，不要重复已有操作。");
          await handled(["u_consult", "u_during_decision"]);
          t.assertions.assert(opened.mock.requests.slice(3).some(request => JSON.stringify(request).includes("Recorded Human response")), "interrupting the formal continuation lost the recorded decision");
        } else await handled(["u_consult"]);
        t.assertions.assert((await snapshot()).pendingPermissions?.length === 0, "the explicitly answered card did not resolve");
      } else if (scenario === "restart") {
        const image = { name: "pixel.png", mime: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhN8AAAAASUVORK5CYII=" };
        const ack = await client.call({ type: "session.send", payload: { sessionId, messageId: "u_recover", text: "保留这张图和这条消息。", attachments: [image], artifactPreviewBaseUrl: null, continuesRound: null } });
        t.assertions.assert(ack?.type === "ack", "message was not accepted before restart");
        const pid = Number(cli(["daemon", "status"]).pid);
        client.close();
        process.kill(pid, "SIGKILL");
        await t.tools.waitUntil(() => cli(["daemon", "status"]).running === false, 15_000);
        cli(["daemon", "start"]);
        client = await connectProductClient(daemonEndpoint(opened.daemon));
        const retry = await client.call({ type: "session.send", payload: { sessionId, messageId: "u_recover", text: "保留这张图和这条消息。", attachments: [image], artifactPreviewBaseUrl: null, continuesRound: null } });
        t.assertions.assert(retry?.type === "ack", "same-ID retry did not reconcile after restart");
        await handled(["u_recover"]);
        const originals = (await snapshot()).items.filter(item => item.type === "userMessage" && item.id === "u_recover");
        t.assertions.assert(originals.length === 1 && originals[0]?.type === "userMessage" && originals[0].attachments[0]?.dataBase64 === image.dataBase64, "restart lost or duplicated the accepted original attachment");
      } else {
        const events = await t.flows.main.attachEventLog(client, sessionId);
        await send("u_first", "PM_INPUT_ORIGINAL_GOAL: 请处理这个问题。");
        await t.tools.waitUntil(() => calls === 1, 30_000);
        if (scenario === "manual-stop") {
          await client.call({ type: "session.interrupt", payload: { sessionId } });
          await t.tools.waitUntil(async () => (await snapshot()).summary.status === "idle", 30_000);
          const stopped = await snapshot();
          t.assertions.assert(stopped.summary.inputSummary?.paused && stopped.summary.inputSummary.pendingMessageIds.includes("u_first"), "explicit stop did not retain and pause pending delivery");
          await new Promise(resolve => setTimeout(resolve, 750));
          t.assertions.assert(calls === 1, "automatic continuation overrode manual stop");
          await send("u_continue", "现在继续，并先核对原执行结果。");
          await handled(["u_first", "u_continue"]);
        } else {
          second = await connectProductClient(daemonEndpoint(opened.daemon));
          const acknowledgements = await Promise.all([send("u_second", "解释当前进展。", second), send("u_third", "再解释下一步。")]);
          t.assertions.assert(acknowledgements.every(reply => reply?.type === "ack"), "busy PM did not accept concurrent inputs");
          t.assertions.assert((await send("u_second", "解释当前进展。", second))?.type === "ack", "same-ID retry was rejected");
          let conflict = false;
          try { await send("u_second", "改变原消息内容。", second); } catch (error) { conflict = String(error).includes("messageId"); }
          t.assertions.assert(conflict, "same ID accepted a different body");
          await handled(["u_first", "u_second", "u_third"]);
          const items = (await snapshot()).items;
          for (const id of ["u_first", "u_second", "u_third"]) t.assertions.assert(items.filter(item => item.type === "userMessage" && item.id === id).length === 1, `original ${id} was lost or duplicated`);
          const turns = new Set<string>();
          for (const envelope of events) {
            const event = t.flows.main.sessionEventOf(envelope);
            if (event?.type === "turnStarted" && typeof event.turnId === "string") { turns.add(event.turnId); t.assertions.assert(turns.size === 1, "two PM turns overlapped"); }
            if (event?.type === "turnCompleted" || event?.type === "turnCanceled" || event?.type === "turnFailed") turns.delete(String(event.turnId));
          }
          t.assertions.assert(opened.mock.requests.slice(1).some(request => JSON.stringify(request).includes("PM_INPUT_ORIGINAL_GOAL")), "native continuation lost the original request");
        }
      }
      t.note(`scenario=${scenario}; model calls=${calls}; accepted originals and continuation obligations reconciled`);
    } finally {
      second?.close(); client.close(); opened.daemon.stop(); await opened.mock.stop();
    }
  });
}
