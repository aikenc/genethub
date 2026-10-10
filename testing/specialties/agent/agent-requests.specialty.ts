// What the daemon does with the Agent-level requests a script opens when the
// script misbehaves: dies holding one, sends one over the size bounds, or
// keeps more open than the kernel holds. A person must never be left with a
// card nobody can answer, nor be shown one the kernel refused. The daemon,
// SDK and fixture script are real (`requests` profile); no LLM is involved.

import { writeFileSync } from "node:fs";
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
type Pushes = ReturnType<CaseContext["flows"]["branches"]["recordAgentPushes"]>;

function requestsCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, opened: Opened, agent: ScriptAgentHandle, pushes: Pushes) => Promise<void>,
): void {
  defineSpecialty(
    {
      id: `specialty.agent.requests.${id}`,
      title,
      oracle,
      catches,
      tags: ["core", "agent", "script-agent", "agent-requests"],
      llm: { default: "none" },
      expectedDurationMs: 15_000,
      timeoutMs: 90_000,
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "script-agent", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client", "daemon-protocol", "agent-serve-protocol-1"],
    },
    async (t) => {
      hideHostAgentClis(t.env);
      const agent = installScriptAgent(t.env, { id: "fixture-req", control: { profile: "requests" } });
      const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      const pushes = t.flows.branches.recordAgentPushes(opened.client);
      try {
        await t.flows.branches.waitForAgent(opened.client, agent.agentId, t.flows.branches.agentReady, { what: "ready" });
        await run(t, opened, agent, pushes);
      } catch (error) {
        const logs = await t.flows.branches.agentLogs(opened.client, agent.agentId, 12).catch((e: unknown) => [`agent.logs failed: ${String(e)}`]);
        t.note(`logs: ${logs.join(" | ")}\njournal: ${readScriptAgentJournal(agent).slice(-15).map((entry) => `${entry.pid}:${entry.event}`).join(" ")}`);
        throw error;
      } finally {
        pushes.stop();
        opened.client.close();
        opened.daemon.stop();
        await opened.mock.stop();
      }
    },
  );
}

async function act(t: CaseContext, opened: Opened, agent: ScriptAgentHandle, actionId: string): Promise<void> {
  const ran = await t.flows.branches.agentControl(opened.client, { type: "agent.action", payload: { agentId: agent.agentId, actionId } });
  t.assertions.assert(ran.ok, `${actionId}: ${ran.ok ? "" : ran.error}`);
}

/** Request ids and titles the script says it opened, in order. */
const journaled = (agent: ScriptAgentHandle) =>
  readScriptAgentJournal(agent)
    .filter((entry) => entry.event === "request-opened")
    .map((entry) => ({ id: String(entry.requestId), title: String(entry.title), oversize: entry.oversize as string | undefined }));

const shownIds = (pushes: Pushes, agent: ScriptAgentHandle) =>
  pushes.requests.filter((item) => item.agentId === agent.agentId).map((item) => item.id);

async function listedIds(client: Opened["client"], agent: ScriptAgentHandle): Promise<string[]> {
  const reply = await client.call({ type: "agent.requests" });
  if (reply?.type !== "agentRequests") throw new Error(`agent.requests returned ${reply?.type}`);
  return reply.data.filter((item) => item.agentId === agent.agentId).map((item) => item.id);
}

requestsCase(
  "crash-closes-open-request",
  "A script that dies holding a request takes the request with it",
  "after the fixture's request reached the client as agentRequest, the script process exits; the client receives agentRequestClosed for that id, agent.requests and pendingRequests no longer hold it, and the restarted script is ready",
  [
    "a dead script leaves a request card nobody can answer",
    "agent.requests keeps listing a request whose script is gone",
    "the request is closed without telling connected clients",
  ],
  async (t, daemon, agent, pushes) => {
    await act(t, daemon, agent, "crash-holding-request");
    await t.tools.waitUntil(() => journaled(agent).length === 1 && shownIds(pushes, agent).includes(journaled(agent)[0]!.id), 15_000)
      .catch(() => { throw new Error(`the held request never reached the client: journal ${JSON.stringify(journaled(agent))}`); });
    const held = journaled(agent)[0]!.id;
    t.assertions.assert((await listedIds(daemon.client, agent)).includes(held), "agent.requests does not list the open request");
    const crashedPid = Number(readScriptAgentJournal(agent).find((entry) => entry.event === "request-opened")!.pid);

    writeFileSync(path.join(agent.stateDir, "crash-now"), "");
    await t.tools.waitUntil(() => readScriptAgentJournal(agent).some((entry) => entry.event === "exit" && entry.pid === crashedPid), 10_000)
      .catch(() => { throw new Error("the fixture never crashed"); });
    await t.tools.waitUntil(() => pushes.closed.some((item) => item.agentId === agent.agentId && item.requestId === held), 15_000)
      .catch(() => { throw new Error("no agentRequestClosed after the script died holding the request"); });
    t.assertions.assert(!(await listedIds(daemon.client, agent)).includes(held), "agent.requests still lists the dead script's request");
    const after = await t.flows.branches.waitForAgent(daemon.client, agent.agentId,
      (info) => info.probe.state === "ready" && (info.pendingRequests ?? []).length === 0, { what: "ready again with nothing pending" });
    t.assertions.assert(!(after.pendingRequests ?? []).some((item) => item.id === held), "pendingRequests still holds the request");
  },
);

requestsCase(
  "oversize-request-never-shown",
  "Requests over the kernel's size bounds are never shown; a later valid one is",
  "the fixture opens three requests, each over one bound (detail > 2048, title > 200, QR link > 1024), then a valid sentinel; clients receive only the sentinel, agent.requests and pendingRequests hold only the sentinel, and agent.logs carries one `[daemon] 用户请求不合规，已忽略` line per refused request naming its reason",
  [
    "an oversized login card or QR payload reaches every client",
    "a refused request listed as pending forever",
    "the refusal is silent, so the script author cannot find it",
  ],
  async (t, daemon, agent, pushes) => {
    await act(t, daemon, agent, "oversize-requests");
    await t.tools.waitUntil(() => pushes.requests.some((item) => item.agentId === agent.agentId && item.title === "fixture: sentinel"), 15_000)
      .catch(() => { throw new Error(`the sentinel never arrived; shown ${JSON.stringify(pushes.requests.map((item) => item.title.slice(0, 40)))}`); });
    const all = journaled(agent);
    const sentinel = all.find((item) => item.title === "fixture: sentinel")!;
    const oversized = all.filter((item) => item.oversize);
    t.assertions.assert(oversized.length === 3, `the fixture opened ${oversized.length} oversized requests`);
    const shown = shownIds(pushes, agent);
    t.assertions.assert(JSON.stringify(shown) === JSON.stringify([sentinel.id]),
      `clients were shown ${shown.length} requests: ${oversized.filter((item) => shown.includes(item.id)).map((item) => item.oversize).join(",")} oversized`);
    t.assertions.assert(JSON.stringify(await listedIds(daemon.client, agent)) === JSON.stringify([sentinel.id]), "agent.requests lists more than the sentinel");
    const info = await t.flows.branches.waitForAgent(daemon.client, agent.agentId,
      (item) => (item.pendingRequests ?? []).some((pending) => pending.id === sentinel.id), { what: "pending the sentinel" });
    t.assertions.assert(info.pendingRequests!.length === 1, `pendingRequests ${JSON.stringify(info.pendingRequests)}`);
    const refusals = (await t.flows.branches.agentLogs(daemon.client, agent.agentId)).filter((line) => line.startsWith("[daemon] 用户请求不合规，已忽略"));
    t.note(`refusals: ${refusals.join(" | ")}`);
    for (const reason of ["说明过长", "id 或标题过长", "展示内容过长"]) {
      t.assertions.assert(refusals.filter((line) => line.endsWith(reason)).length === 1, `no single refusal line for ${reason}: ${refusals.join(" | ")}`);
    }
    await t.flows.branches.answerAgentRequest(daemon.client, { agentId: agent.agentId, requestId: sentinel.id, outcome: { type: "canceled" } });
    await t.flows.branches.waitForAgent(daemon.client, agent.agentId,
      (item) => item.job?.action === "oversize-requests" && item.job.done === true, { what: "the action finished" });
  },
);

requestsCase(
  "ninth-open-request-refused",
  "A script holding eight open requests cannot open a ninth",
  "the fixture opens nine requests at once; the first eight reach the client in order and are listed by agent.requests, the ninth is never shown or listed, and agent.logs says `未答复的用户请求过多` once",
  [
    "a script floods every client with request cards",
    "the limit drops an earlier request instead of the new one",
    "the refusal is silent",
  ],
  async (t, daemon, agent, pushes) => {
    await act(t, daemon, agent, "nine-requests");
    await t.tools.waitUntil(() => journaled(agent).length === 9 && shownIds(pushes, agent).length >= 8, 15_000)
      .catch(() => { throw new Error(`opened ${journaled(agent).length}, shown ${shownIds(pushes, agent).length}`); });
    const ids = journaled(agent).map((item) => item.id);
    await t.tools.waitUntil(async () => (await t.flows.branches.agentLogs(daemon.client, agent.agentId))
      .some((line) => line.includes("未答复的用户请求过多")), 10_000)
      .catch(() => { throw new Error("no daemon note about the refused ninth request"); });
    const shown = shownIds(pushes, agent);
    t.assertions.assert(JSON.stringify(shown) === JSON.stringify(ids.slice(0, 8)), `shown ${shown.length}; ninth shown ${shown.includes(ids[8]!)}`);
    const listed = await listedIds(daemon.client, agent);
    t.assertions.assert(listed.length === 8 && !listed.includes(ids[8]!) && ids.slice(0, 8).every((id) => listed.includes(id)),
      `agent.requests lists ${listed.length}; ninth listed ${listed.includes(ids[8]!)}`);
    const notes = (await t.flows.branches.agentLogs(daemon.client, agent.agentId)).filter((line) => line.includes("未答复的用户请求过多"));
    t.assertions.assert(notes.length === 1, `limit noted ${notes.length} times`);
  },
);
