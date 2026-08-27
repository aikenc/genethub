import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

const MODEL = "deepseek/deepseek-v4-flash";

function terminal(events: Array<{ type?: string }>): boolean {
  return events.some(
    (event) => event.type === "turnCompleted" || event.type === "turnFailed" || event.type === "turnCanceled",
  );
}

function eventTrace(events: Array<{ type?: string; raw: unknown }>): string {
  return JSON.stringify(events.map((event) => ({ type: event.type, raw: event.raw })));
}

defineSpecialty(
  {
    id: "specialty.authorization.pm-agent-work-session",
    title: "A PM Agent owns Agent Space and WorkSession mutations end to end",
    oracle:
      "a real built-in PM uses the public CLI to register a local Agent Space and start a real WorkAgent; users can observe and fork its WorkSession but cannot mutate either managed resource",
    catches: [
      "PM identity is trusted from request payload instead of the daemon child",
      "ordinary users can mutate WorkSessions or managed Agent Spaces",
      "PM-created WorkSessions are indistinguishable from ordinary conversations",
      "forking a WorkSession preserves its privileged role",
    ],
    tags: ["core", "authorization", "pm-agent-mvp"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 45_000,
    timeoutMs: 120_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  },
  async (t) => {
    execFileSync("git", ["init", "-q"], { cwd: t.env.workspace });
    const spaceRoot = path.join(t.env.workspace, "spaces", "implementation");
    mkdirSync(path.join(spaceRoot, ".pipebuilder"), { recursive: true });
    writeFileSync(path.join(spaceRoot, "pipespace.json"), '{"schema":"pipespace.v1"}\n');
    writeFileSync(path.join(spaceRoot, ".pipebuilder", "lock.json"), "{}\n");
    const workspaceFile = path.join(spaceRoot, "implementation.code-workspace");
    writeFileSync(workspaceFile, '{"folders":[{"path":"."}]}\n');

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const createdPm = await opened.client.call({
        type: "pm.session.create",
        payload: {
          workspaceId: opened.workspaceId,
          modelId: MODEL,
          modeId: null,
          title: "Project manager",
        },
      });
      t.assertions.assert(createdPm?.type === "session", `pm.session.create returned ${createdPm?.type}`);
      if (createdPm?.type !== "session") return;
      const pm = createdPm.data;
      t.assertions.assert(pm.kind === "pm", `PM kind was ${pm.kind}`);
      t.assertions.assert(pm.capabilities?.archive === false && pm.capabilities.delete === false, "PM retention capabilities drifted");

      const duplicatePm = await opened.client.call({
        type: "pm.session.create",
        payload: { workspaceId: opened.workspaceId, modelId: MODEL, modeId: null, title: null },
      });
      t.assertions.assert(
        duplicatePm?.type === "session" && duplicatePm.data.id === pm.id,
        "the same Folder project minted a second PM session",
      );

      const pmEvents = await t.flows.main.attachEventLog(opened.client, pm.id);
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: '"$GENEHUB_CLI" workspace register-agent-space spaces/implementation/implementation.code-workspace',
            },
          },
        },
        { text: "The implementation Agent Space is registered." },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "Register the implementation Agent Space.");
      try {
        await t.tools.waitUntil(() => terminal(pmEvents), 15_000);
      } catch {
        throw new Error(`PM registration turn did not terminate: ${eventTrace(pmEvents)}`);
      }
      t.assertions.assert(
        pmEvents.some((event) => event.type === "turnCompleted"),
        `PM registration turn failed: ${eventTrace(pmEvents)}`,
      );

      const listedWorkspaces = await opened.client.call({ type: "workspace.list" });
      const agentSpace =
        listedWorkspaces?.type === "workspaces"
          ? listedWorkspaces.data.find((workspace) => workspace.kind === "agentSpace")
          : undefined;
      t.assertions.assert(agentSpace !== undefined, "the PM CLI did not register an Agent Space");
      if (!agentSpace) return;
      t.assertions.assert(
        agentSpace.capabilities?.createSession === true &&
          agentSpace.capabilities.rename === false &&
          agentSpace.capabilities.remove === false,
        `unexpected Agent Space capabilities: ${JSON.stringify(agentSpace.capabilities)}`,
      );

      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "workspace.registerAgentSpace",
            payload: { source: workspaceFile },
          }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "workspace.rename",
            payload: { workspaceId: agentSpace.id, name: "user-renamed" },
          }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "workspace.remove", payload: { workspaceId: agentSpace.id } }),
        "forbidden",
      );

      const pmCompletions = pmEvents.filter((event) => event.type === "turnCompleted").length;
      const pmTerminals = pmEvents.filter((event) =>
        ["turnCompleted", "turnFailed", "turnCanceled"].includes(event.type ?? ""),
      ).length;
      opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: {
              command: `"$GENEHUB_CLI" agent run --agent genet --model ${MODEL} --workspace ${agentSpace.id} --work-package wp-gameplay --no-wait "Implement the gameplay package."`,
            },
          },
        },
        { text: "The WorkAgent is running.", delayMs: 600 },
        { text: "Gameplay implementation complete.", delayMs: 600 },
      );
      await t.flows.main.sendPrompt(opened.client, pm.id, "Start the gameplay WorkAgent.");

      let workId = "";
      let lastSessions: unknown = null;
      try {
        await t.tools.waitUntil(async () => {
          const sessions = await opened.client.call({
            type: "session.list",
            payload: { workspaceId: agentSpace.id, includeArchived: true },
          });
          lastSessions = sessions;
          const work =
            sessions?.type === "sessions" ? sessions.data.find((session) => session.kind === "work") : undefined;
          workId = work?.id ?? "";
          return workId.length > 0;
        }, 15_000);
      } catch {
        throw new Error(
          `PM did not create a WorkSession: events=${eventTrace(pmEvents)} sessions=${JSON.stringify(lastSessions)}`,
        );
      }
      const workEvents = await t.flows.main.attachEventLog(opened.client, workId);
      let completedWork = await opened.client.call({ type: "session.get", payload: { sessionId: workId } });
      await t.tools.waitUntil(async () => {
        completedWork = await opened.client.call({ type: "session.get", payload: { sessionId: workId } });
        return (
          completedWork?.type === "snapshot" &&
          completedWork.data.summary.status !== "running" &&
          completedWork.data.items.some((item) => item.type === "turnSummary")
        );
      }, 45_000);
      t.assertions.assert(
        completedWork?.type === "snapshot" && completedWork.data.summary.status === "idle",
        `WorkAgent turn failed: snapshot=${JSON.stringify(completedWork)} events=${eventTrace(workEvents)}`,
      );
      await t.tools.waitUntil(
        () =>
          pmEvents.filter((event) =>
            ["turnCompleted", "turnFailed", "turnCanceled"].includes(event.type ?? ""),
          ).length ===
          pmTerminals + 1,
        45_000,
      );
      t.assertions.assert(
        pmEvents.filter((event) => event.type === "turnCompleted").length === pmCompletions + 1,
        `PM WorkAgent launch turn failed: ${eventTrace(pmEvents)}`,
      );

      const snapshot = completedWork;
      t.assertions.assert(snapshot?.type === "snapshot", `session.get returned ${snapshot?.type}`);
      if (snapshot?.type !== "snapshot") return;
      const work = snapshot.data.summary;
      t.assertions.assert(work.kind === "work", `WorkSession kind was ${work.kind}`);
      t.assertions.assert(work.work?.workPackageId === "wp-gameplay", `work metadata ${JSON.stringify(work.work)}`);
      t.assertions.assert(work.work?.controllerSessionId === pm.id, "WorkSession controller is not the PM session");
      t.assertions.assert(
        work.capabilities?.send === false &&
          work.capabilities.interrupt === false &&
          work.capabilities.delete === false &&
          work.capabilities.fork === true,
        `unexpected WorkSession capabilities: ${JSON.stringify(work.capabilities)}`,
      );

      await t.assertions.expectProtocolCode(
        () =>
          opened.client.call({
            type: "session.send",
            payload: {
              sessionId: workId,
              text: "user tries to redirect work",
              attachments: [],
              artifactPreviewBaseUrl: null,
              continuesRound: null,
            },
          }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "session.archive", payload: { sessionId: workId, archived: true } }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "session.delete", payload: { sessionId: workId } }),
        "forbidden",
      );

      const turn = snapshot.data.items.find((item) => item.type === "turnSummary");
      t.assertions.assert(turn?.type === "turnSummary", "completed WorkSession has no forkable turn summary");
      if (turn?.type !== "turnSummary") return;
      const forked = await opened.client.call({
        type: "session.fork",
        payload: {
          sessionId: workId,
          turnId: turn.stats.turnId,
          target: { agentId: "genet", workspaceId: agentSpace.id, modelId: MODEL },
        },
      });
      t.assertions.assert(
        forked?.type === "session" && forked.data.kind === "normal" && forked.data.work === undefined,
        `fork preserved managed role: ${JSON.stringify(forked)}`,
      );

      const ordinary = await opened.client.call({
        type: "session.create",
        payload: {
          workspaceId: agentSpace.id,
          agentId: "genet",
          modelId: MODEL,
          modeId: null,
          title: "User inquiry",
          cwd: null,
        },
      });
      t.assertions.assert(
        ordinary?.type === "session" && ordinary.data.kind === "normal",
        "the user could not open an ordinary conversation in the Agent Space",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
