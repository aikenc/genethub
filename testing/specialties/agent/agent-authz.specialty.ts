// Agent-level requests carry login links, device codes and secret prompts.
// The daemon hands them, and the verbs that act on script Agents, only to a
// client granted `settings`; the Agent list itself is `read`. These cases pair
// real devices through the production invite/claim flow and hold each one to
// what its grants allow, on both the push and the request path. The daemon,
// the SDK and the fixture script are real; no LLM is involved.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  defineSpecialty,
  hideHostAgentClis,
  installScriptAgent,
  readScriptAgentJournal,
  type CaseContext,
  type ScriptAgentHandle,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Client = Opened["client"];
type Pushes = ReturnType<CaseContext["flows"]["branches"]["recordAgentPushes"]>;

function authzCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext) => Promise<void>,
): void {
  defineSpecialty(
    {
      id: `specialty.agent.authz.${id}`,
      title,
      oracle,
      catches,
      tags: ["core", "agent", "script-agent", "authorization", "agent-authz"],
      llm: { default: "none" },
      expectedDurationMs: 20_000,
      timeoutMs: 90_000,
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "authorization", "script-agent", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agent-serve-protocol-1"],
    },
    run,
  );
}

async function withLoginAgent(
  t: CaseContext,
  run: (opened: Opened, agent: ScriptAgentHandle) => Promise<void>,
): Promise<void> {
  hideHostAgentClis(t.env);
  const agent = installScriptAgent(t.env, { id: "fixture-login", control: { profile: "login" } });
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.branches.waitForAgent(opened.client, agent.agentId,
      (info) => info.actions?.some((action) => action.id === "login" && action.primary) === true, { what: "asking for login" });
    await run(opened, agent);
  } catch (error) {
    const journal = readScriptAgentJournal(agent).slice(-15).map((entry) => `${entry.pid}:${entry.event}`);
    t.note(`journal: ${journal.join(" ")}`);
    throw error;
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

/** The protocol error code a call was refused with, or `accepted`. */
async function outcomeOf(call: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    const reply = await call;
    return { code: "accepted", message: JSON.stringify(reply).slice(0, 200) };
  } catch (error) {
    const detail = (error as { detail?: { code?: unknown; message?: unknown } }).detail;
    return {
      code: typeof detail?.code === "string" ? detail.code : `untyped:${error instanceof Error ? error.name : typeof error}`,
      message: String(detail?.message ?? (error instanceof Error ? error.message : error)),
    };
  }
}

async function waitForRequest(t: CaseContext, pushes: Pushes, agentId: string, who: string) {
  await t.tools.waitUntil(() => pushes.requests.some((item) => item.agentId === agentId), 15_000)
    .catch(() => { throw new Error(`${who} never received the agentRequest frame`); });
  return pushes.requests.find((item) => item.agentId === agentId)!;
}

async function startLogin(t: CaseContext, client: Client, agentId: string): Promise<void> {
  const ran = await t.flows.branches.agentControl(client, { type: "agent.action", payload: { agentId, actionId: "login" } });
  t.assertions.assert(ran.ok, `login action: ${ran.ok ? "" : ran.error}`);
}

const pendingIds = async (client: Client) => {
  const reply = await client.call({ type: "agent.requests" });
  if (reply?.type !== "agentRequests") throw new Error(`agent.requests returned ${reply?.type}`);
  return reply.data.map((item) => item.id);
};

authzCase(
  "read-device-sees-agents-not-requests",
  "A read-only device follows the Agent list but never sees or acts on Agent requests",
  "a device paired with only `read` receives `agents` pushes while a login job runs and closes, but no agentRequest or agentRequestClosed frame; its agent.action, agent.reset, agent.requests and agent.requestAnswer (on the open request) are each refused with code forbidden, the request stays pending after its refused answer, and the script saw exactly one action",
  [
    "login links or secret prompts pushed to a device without settings",
    "a read-only device runs install/login actions or resets an override",
    "a read-only device answers or cancels a person's pending request",
    "a missing grant reported as unauthorized, so the client treats it as a bad credential",
  ],
  async (t) => {
    await withLoginAgent(t, async (opened, agent) => {
      const reader = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"], "read-only");
      const readerPushes = t.flows.branches.recordAgentPushes(reader.client);
      const ownerPushes = t.flows.branches.recordAgentPushes(opened.client);
      try {
        const listsBefore = readerPushes.lists.length;
        await startLogin(t, opened.client, agent.agentId);
        const request = await waitForRequest(t, ownerPushes, agent.agentId, "the owner");

        const refusals: Record<string, { code: string; message: string }> = {
          "agent.action": await outcomeOf(reader.client.call({ type: "agent.action", payload: { agentId: agent.agentId, actionId: "login" } })),
          "agent.reset": await outcomeOf(reader.client.call({ type: "agent.reset", payload: { agentId: agent.agentId } })),
          "agent.requests": await outcomeOf(reader.client.call({ type: "agent.requests" })),
          "agent.requestAnswer": await outcomeOf(reader.client.call({
            type: "agent.requestAnswer",
            payload: { agentId: agent.agentId, requestId: request.id, outcome: { type: "canceled" } },
          })),
        };
        t.note(`read-only refusals: ${Object.entries(refusals).map(([verb, got]) => `${verb}=${got.code}`).join(" ")}`);
        const wrong = Object.entries(refusals).filter(([, got]) => got.code !== "forbidden");
        t.assertions.assert((await pendingIds(opened.client)).includes(request.id), "a read-only device's answer closed the request");
        t.assertions.assert(readScriptAgentJournal(agent).filter((entry) => entry.event === "action").length === 1,
          "a read-only device's action reached the script");

        await t.flows.branches.answerAgentRequest(opened.client, { agentId: agent.agentId, requestId: request.id, outcome: { type: "canceled" } });
        await t.tools.waitUntil(() => ownerPushes.closed.some((item) => item.requestId === request.id), 10_000)
          .catch(() => { throw new Error("the owner never received agentRequestClosed"); });
        await t.flows.branches.waitForAgent(opened.client, agent.agentId, (info) => info.job?.done === true, { what: "login job finished" });
        // The reader is told about the list changes that follow; by the time
        // one carrying the finished job reaches it, any request frame sent
        // before it would have too.
        await t.tools.waitUntil(() => readerPushes.lists.slice(listsBefore).some((agents) =>
          agents.some((item) => item.id === agent.agentId && item.job?.done === true)), 10_000)
          .catch(() => { throw new Error(`the read-only device got ${readerPushes.lists.length - listsBefore} agents pushes and none with the finished job`); });
        const publicList = await reader.client.call({ type: "agent.list" });
        const publicPayload = JSON.stringify([publicList, readerPushes.lists]);
        t.assertions.assert(!publicPayload.includes("fixture-private-cli-output") && !publicPayload.includes("fixture: not logged in"),
          "Read list or push carried private CLI text");
        const ownLogs = await t.flows.branches.agentLogs(opened.client, agent.agentId);
        t.assertions.assert(JSON.stringify(ownLogs).includes("fixture-private-cli-output"), "log grant positive control has no private line");
        t.assertions.assert(readerPushes.requests.length === 0 && readerPushes.closed.length === 0,
          `a read-only device received ${readerPushes.requests.length} agentRequest and ${readerPushes.closed.length} agentRequestClosed frames`);
        t.assertions.assert(wrong.length === 0,
          `refused with the wrong code: ${wrong.map(([verb, got]) => `${verb}: ${got.code} (${got.message})`).join("; ")}`);
      } finally {
        readerPushes.stop();
        ownerPushes.stop();
        reader.client.close();
      }
    });
  },
);

authzCase(
  "two-settings-devices-one-answer",
  "Two settings devices both see a request; the first answer wins and the other is told it closed",
  "devices A and B paired with read+settings both receive the same agentRequest; A's answer is delivered to the script (sha256 marker equals A's secret), B receives agentRequestClosed for it and no longer lists it, and B's late answer is rejected without reaching the script (one login-stored, marker unchanged)",
  [
    "a request shown on one device only",
    "the second device keeps showing a request already answered",
    "a late answer from another device overwrites or repeats the first",
  ],
  async (t) => {
    await withLoginAgent(t, async (opened, agent) => {
      const a = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "settings"], "settings-a");
      const b = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "settings"], "settings-b");
      const aPushes = t.flows.branches.recordAgentPushes(a.client);
      const bPushes = t.flows.branches.recordAgentPushes(b.client);
      try {
        await startLogin(t, a.client, agent.agentId);
        const seenByA = await waitForRequest(t, aPushes, agent.agentId, "device A");
        const seenByB = await waitForRequest(t, bPushes, agent.agentId, "device B");
        t.assertions.assert(seenByA.id === seenByB.id, `A and B were shown different requests: ${seenByA.id} / ${seenByB.id}`);
        t.assertions.assert((await pendingIds(b.client)).includes(seenByA.id), "B cannot list the open request");

        const secret = `fixture-secret-${randomBytes(12).toString("hex")}`;
        await t.flows.branches.answerAgentRequest(a.client, {
          agentId: agent.agentId,
          requestId: seenByA.id,
          outcome: { type: "answered", optionId: "ok", answers: [{ questionId: "token", selectedOptionIds: [], freeformText: secret }] },
        });
        await t.tools.waitUntil(() => bPushes.closed.some((item) => item.requestId === seenByA.id && item.agentId === agent.agentId), 10_000)
          .catch(() => { throw new Error("device B never received agentRequestClosed after A answered"); });
        t.assertions.assert(!(await pendingIds(b.client)).includes(seenByA.id), "B still lists the answered request");
        await t.flows.branches.waitForAgent(a.client, agent.agentId, (info) => info.probe.state === "ready", { what: "logged in" });

        const marker = path.join(agent.stateDir, "login.sha256");
        const expected = createHash("sha256").update(secret).digest("hex");
        t.assertions.assert(readFileSync(marker, "utf8").trim() === expected, "the script stored something other than A's answer");

        const late = await outcomeOf(b.client.call({
          type: "agent.requestAnswer",
          payload: {
            agentId: agent.agentId,
            requestId: seenByA.id,
            outcome: { type: "answered", optionId: "ok", answers: [{ questionId: "token", selectedOptionIds: [], freeformText: "late-answer" }] },
          },
        }));
        t.note(`late answer from B: ${late.code} (${late.message.slice(0, 120)})`);
        t.assertions.assert(late.code !== "accepted", `B's late answer was accepted: ${late.message}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        t.assertions.assert(readScriptAgentJournal(agent).filter((entry) => entry.event === "login-stored").length === 1,
          "the script stored a second answer");
        t.assertions.assert(readFileSync(marker, "utf8").trim() === expected, "B's late answer replaced A's");
      } finally {
        aPushes.stop();
        bPushes.stop();
        a.client.close();
        b.client.close();
      }
    });
  },
);

authzCase(
  "no-settings-cannot-list-requests",
  "A device that may drive sessions but not change settings cannot list Agent requests",
  "a device paired with read+session lists Agents but its agent.requests is refused with code forbidden while a request is open, and the owner still lists that request",
  [
    "session grant treated as enough to read login links or secret prompts",
    "a missing grant reported as unauthorized",
  ],
  async (t) => {
    await withLoginAgent(t, async (opened, agent) => {
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "session"], "session-only");
      const ownerPushes = t.flows.branches.recordAgentPushes(opened.client);
      try {
        await startLogin(t, opened.client, agent.agentId);
        const request = await waitForRequest(t, ownerPushes, agent.agentId, "the owner");
        const listed = await t.flows.branches.listAgents(device.client);
        t.assertions.assert(listed.some((item) => item.id === agent.agentId), "a read device cannot list Agents");
        const refused = await outcomeOf(device.client.call({ type: "agent.requests" }));
        t.assertions.assert(refused.code === "forbidden", `agent.requests from read+session: ${refused.code} (${refused.message})`);
        t.assertions.assert((await pendingIds(opened.client)).includes(request.id), "the request disappeared");
        await t.flows.branches.answerAgentRequest(opened.client, { agentId: agent.agentId, requestId: request.id, outcome: { type: "canceled" } });
      } finally {
        ownerPushes.stop();
        device.client.close();
      }
    });
  },
);
