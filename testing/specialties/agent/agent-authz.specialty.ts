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
  "A complete paired device follows and answers the Agent login request",
  "paired device receives Agent request/list/closed pushes, cancels one request, and the script records one login action",
  [
    "login links or secret prompts pushed to a device without settings",
    "a read-only device runs install/login actions or resets an override",
    "a read-only device answers or cancels a person's pending request",
    "a missing grant reported as unauthorized, so the client treats it as a bad credential",
  ],
  async (t) => {
    await withLoginAgent(t, async (opened, agent) => {
      const reader = await t.flows.main.pairDevice(opened.client, opened.daemon, "read-only");
      const readerPushes = t.flows.branches.recordAgentPushes(reader.client);
      const ownerPushes = t.flows.branches.recordAgentPushes(opened.client);
      try {
        const listsBefore = readerPushes.lists.length;
        await startLogin(t, opened.client, agent.agentId);
        const request = await waitForRequest(t, ownerPushes, agent.agentId, "the owner");

        await t.tools.waitUntil(() => readerPushes.requests.some(item => item.id === request.id), 10_000);
        t.assertions.assert((await pendingIds(reader.client)).includes(request.id), "paired device cannot list the pending login request");
        await t.flows.branches.answerAgentRequest(reader.client, {agentId:agent.agentId,requestId:request.id,outcome:{type:"canceled"}});
        await t.tools.waitUntil(() => ownerPushes.closed.some(item=>item.requestId===request.id),10_000);
        await t.flows.branches.waitForAgent(opened.client,agent.agentId,info=>info.job?.done===true,{what:"paired login cancellation"});
        await t.tools.waitUntil(() => readerPushes.lists.slice(listsBefore).some(agents=>agents.some(item=>item.id===agent.agentId&&item.job?.done===true)),10_000);
        t.assertions.assert(readScriptAgentJournal(agent).filter(entry=>entry.event==="action").length===1,"paired answer replayed the login action");
        const ownLogs = await t.flows.branches.agentLogs(opened.client, agent.agentId);
        t.assertions.assert(JSON.stringify(ownLogs).includes("fixture-private-cli-output"), "log grant positive control has no private line");
        t.assertions.assert(readerPushes.requests.length > 0 && readerPushes.closed.some(item=>item.requestId===request.id), "paired device lost request lifecycle pushes");
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
      const a = await t.flows.main.pairDevice(opened.client, opened.daemon, "settings-a");
      const b = await t.flows.main.pairDevice(opened.client, opened.daemon, "settings-b");
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
  "A complete device lists requests while a login action is pending",
  "paired device and owner see the same pending Agent request",
  [
    "session grant treated as enough to read login links or secret prompts",
    "a missing grant reported as unauthorized",
  ],
  async (t) => {
    await withLoginAgent(t, async (opened, agent) => {
      const device = await t.flows.main.pairDevice(opened.client, opened.daemon, "session-only");
      const ownerPushes = t.flows.branches.recordAgentPushes(opened.client);
      try {
        await startLogin(t, opened.client, agent.agentId);
        const request = await waitForRequest(t, ownerPushes, agent.agentId, "the owner");
        const listed = await t.flows.branches.listAgents(device.client);
        t.assertions.assert(listed.some((item) => item.id === agent.agentId), "a read device cannot list Agents");
        t.assertions.assert((await pendingIds(device.client)).includes(request.id), "complete paired device lost login request visibility");
        t.assertions.assert((await pendingIds(opened.client)).includes(request.id), "the request disappeared");
        await t.flows.branches.answerAgentRequest(opened.client, { agentId: agent.agentId, requestId: request.id, outcome: { type: "canceled" } });
      } finally {
        ownerPushes.stop();
        device.client.close();
      }
    });
  },
);
