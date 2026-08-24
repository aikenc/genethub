import { existsSync } from "node:fs";
import path from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type EventLog = Array<{ type?: string; raw: unknown }>;

function terminalCount(events: EventLog): number {
  return events.filter((event) =>
    event.type === "turnCompleted" || event.type === "turnFailed" || event.type === "turnCanceled").length;
}

function lastTerminal(events: EventLog): string | undefined {
  return events.filter((event) =>
    event.type === "turnCompleted" || event.type === "turnFailed" || event.type === "turnCanceled").at(-1)?.type;
}

function lifecycleCase(
  id: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, opened: Opened) => Promise<void>,
  expectedDurationMs = 35_000,
  extraTags: string[] = [],
): void {
  defineSpecialty(
    {
      id,
      title,
      oracle,
      catches,
      tags: ["core", "agent", "session", "agent-lifecycle-depth", ...extraTags],
      llm: { default: "mock" },
      expectedDurationMs,
      timeoutMs: 150_000,
      resources: { environments: 1, cpu: 2, memoryMb: 768, io: 2, browser: 0, pool: "standard" },
      surfaces: ["daemon", "agent", "workbench-client"],
      productInterfaces: ["@genehub/workbench/client"],
    },
    async (t) => {
      const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      try {
        await t.flows.main.configureMockProvider(opened.client, opened.mock);
        await run(t, opened);
      } finally {
        opened.client.close();
        opened.daemon.stop();
        await opened.mock.stop();
      }
    },
  );
}

lifecycleCase(
  "specialty.agent.lifecycle.twelve-sequential-turns",
  "One Agent session completes twelve sequential turns",
  "the subscription records twelve distinct starts and twelve completions without failure",
  ["per-session state leaks between turns", "event cursor drops later turns", "session wedges after repeated reuse"],
  async (t, opened) => {
    const count = 12;
    opened.mock.script(...Array.from({ length: count }, (_, index) => ({ text: `reply-${index}` })));
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    for (let index = 0; index < count; index += 1) {
      await t.flows.main.sendPrompt(opened.client, sessionId, `Sequential prompt ${index}`);
      await t.tools.waitUntil(() => terminalCount(events) === index + 1, 45_000);
      t.assertions.assert(events.filter((event) => event.type === "turnFailed").length === 0, `turn ${index} failed`);
    }
    t.assertions.assert(events.filter((event) => event.type === "turnStarted").length === count, "start count drifted");
    t.assertions.assert(events.filter((event) => event.type === "turnCompleted").length === count, "completion count drifted");
  },
  60_000,
);

lifecycleCase(
  "specialty.agent.lifecycle.same-session-recovers-provider-failure",
  "A session can continue after its provider request fails",
  "the first turn fails and a second prompt on the same session completes",
  ["turn failure poisons session", "failed child is reused", "later completion attributed to failed turn"],
  async (t, opened) => {
    opened.mock.script({ status: 500 }, { text: "same session recovered" });
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    await t.flows.main.sendPrompt(opened.client, sessionId, "Fail this turn.");
    await t.tools.waitUntil(() => terminalCount(events) === 1, 45_000);
    t.assertions.assert(events.some((event) => event.type === "turnFailed"), "first turn did not fail");
    await t.flows.main.sendPrompt(opened.client, sessionId, "Recover in this session.");
    await t.tools.waitUntil(() => terminalCount(events) === 2, 45_000);
    t.assertions.assert(events.filter((event) => event.type === "turnCompleted").length === 1, "same session did not recover");
  },
);

lifecycleCase(
  "specialty.agent.lifecycle.six-subscriber-fanout",
  "Six independent subscribers observe one Agent turn",
  "every subscriber receives exactly one start and one completion for the shared session",
  ["events delivered to first subscriber only", "fanout duplicates terminal event", "subscription ids cross"],
  async (t, opened) => {
    opened.mock.script({ text: "fanout complete", delayMs: 300 });
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const clients = await Promise.all(
      Array.from({ length: 6 }, (_, index) => t.flows.main.openSecondClient(opened, `fanout-${index}`)),
    );
    try {
      const logs = await Promise.all(clients.map((client) => t.flows.main.attachEventLog(client, sessionId)));
      await t.flows.main.sendPrompt(opened.client, sessionId, "Broadcast one turn.");
      await t.tools.waitUntil(() => logs.every((events) => terminalCount(events) === 1), 45_000);
      for (const [index, events] of logs.entries()) {
        t.assertions.assert(events.filter((event) => event.type === "turnStarted").length === 1, `subscriber ${index} start count`);
        t.assertions.assert(events.filter((event) => event.type === "turnCompleted").length === 1, `subscriber ${index} completion count`);
      }
    } finally {
      clients.forEach((client) => client.close());
    }
  },
);

lifecycleCase(
  "specialty.agent.lifecycle.partial-fanout-disconnect",
  "Half of a subscriber fanout can disconnect mid-turn",
  "the remaining subscribers receive completion and the daemon remains usable",
  ["subscriber quorum owns turn", "fanout cleanup cancels producer", "disconnecting peers corrupt shared cursor"],
  async (t, opened) => {
    opened.mock.script({ text: "survived fanout disconnect", delayMs: 900 });
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const clients = await Promise.all(
      Array.from({ length: 6 }, (_, index) => t.flows.main.openSecondClient(opened, `partial-${index}`)),
    );
    try {
      const logs = await Promise.all(clients.map((client) => t.flows.main.attachEventLog(client, sessionId)));
      await t.flows.main.sendPrompt(opened.client, sessionId, "Keep running as subscribers leave.");
      await t.tools.waitUntil(() => logs.every((events) => events.some((event) => event.type === "turnStarted")), 30_000);
      clients.slice(0, 3).forEach((client) => client.close());
      await t.tools.waitUntil(() => logs.slice(3).every((events) => events.some((event) => event.type === "turnCompleted")), 45_000);
      const listed = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", "daemon failed after fanout cleanup");
    } finally {
      clients.forEach((client) => client.close());
    }
  },
);

lifecycleCase(
  "specialty.agent.lifecycle.active-session-list-consistent",
  "Session listing remains consistent while ten Agent turns run",
  "session.list contains all ten exact ids during activity and after all complete",
  ["active session omitted", "list observes partial registry insert", "completion removes live session"],
  async (t, opened) => {
    const count = 10;
    opened.mock.script(...Array.from({ length: count }, (_, index) => ({ text: `active-${index}`, delayMs: 800 })));
    const sessions = await Promise.all(
      Array.from({ length: count }, () => t.flows.main.createBuiltinSession(opened.client, opened.workspaceId)),
    );
    const logs = await Promise.all(sessions.map((session) => t.flows.main.attachEventLog(opened.client, session)));
    await Promise.all(sessions.map((session, index) => t.flows.main.sendPrompt(opened.client, session, `Active ${index}`)));
    await t.tools.waitUntil(() => logs.every((events) => events.some((event) => event.type === "turnStarted")), 30_000);
    const during = await opened.client.call({
      type: "session.list",
      payload: { workspaceId: opened.workspaceId, includeArchived: true },
    });
    t.assertions.assert(during?.type === "sessions", "session.list failed during activity");
    const duringIds = new Set(during?.type === "sessions" ? during.data.map((session) => session.id) : []);
    t.assertions.assert(sessions.every((session) => duringIds.has(session)), "active list omitted a session");
    await t.tools.waitUntil(() => logs.every((events) => events.some((event) => event.type === "turnCompleted")), 60_000);
    const after = await opened.client.call({
      type: "session.list",
      payload: { workspaceId: opened.workspaceId, includeArchived: true },
    });
    const afterIds = new Set(after?.type === "sessions" ? after.data.map((session) => session.id) : []);
    t.assertions.assert(sessions.every((session) => afterIds.has(session)), "completed list omitted a session");
  },
  50_000,
);

lifecycleCase(
  "specialty.agent.lifecycle.malformed-tool-recovers",
  "Malformed tool arguments do not poison later turns",
  "the malformed write reaches a terminal state and a later prompt on the same session completes",
  ["tool decoder crashes Agent", "turn never terminates", "session remains busy after tool error"],
  async (t, opened) => {
    opened.mock.script(
      { tool: { name: "write", arguments: { path: "missing-content.txt" } } },
      { text: "tool error handled" },
      { text: "later turn works" },
    );
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    await t.flows.main.sendPrompt(opened.client, sessionId, "Attempt malformed tool input.");
    await t.tools.waitUntil(() => terminalCount(events) === 1, 45_000);
    await t.flows.main.sendPrompt(opened.client, sessionId, "Continue after the malformed tool.");
    await t.tools.waitUntil(() => terminalCount(events) === 2, 45_000);
    t.assertions.assert(lastTerminal(events) === "turnCompleted", "later turn did not complete");
  },
);

lifecycleCase(
  "specialty.agent.lifecycle.traversal-tool-contained",
  "A model-requested traversal write stays contained",
  "no file appears above the workspace and a follow-up turn completes in the same session",
  ["Agent tool bypasses root handle", "tool error crashes child", "rejected write poisons session"],
  async (t, opened) => {
    const escaped = path.resolve(opened.workspaceRoot, "..", "agent-escaped.txt");
    opened.mock.script(
      { tool: { name: "write", arguments: { path: "../agent-escaped.txt", content: "escape" } } },
      { text: "contained" },
      { text: "follow-up complete" },
    );
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    await t.flows.main.sendPrompt(opened.client, sessionId, "Try an unsafe path.");
    await t.tools.waitUntil(() => terminalCount(events) === 1, 45_000);
    t.assertions.assert(!existsSync(escaped), "Agent tool escaped the workspace");
    await t.flows.main.sendPrompt(opened.client, sessionId, "Continue safely.");
    await t.tools.waitUntil(() => terminalCount(events) === 2, 45_000);
    t.assertions.assert(lastTerminal(events) === "turnCompleted", "session did not recover after contained traversal");
  },
  35_000,
  ["agent-unconfined"],
);

lifecycleCase(
  "specialty.agent.lifecycle.interrupt-storm-idempotent",
  "Concurrent interrupt requests leave one coherent canceled turn",
  "the active turn cancels once, all interrupt calls settle, and a later prompt completes",
  ["interrupt race duplicates terminal events", "one conflict crashes daemon", "session remains canceled forever"],
  async (t, opened) => {
    opened.mock.script({ text: "too slow", delayMs: 2_000 }, { text: "after interrupts" });
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    await t.flows.main.sendPrompt(opened.client, sessionId, "Start a cancellable turn.");
    await t.tools.waitUntil(() => events.some((event) => event.type === "turnStarted"), 30_000);
    const interrupts = await Promise.allSettled(
      Array.from({ length: 8 }, () => opened.client.call({ type: "session.interrupt", payload: { sessionId } })),
    );
    t.assertions.assert(interrupts.some((result) => result.status === "fulfilled"), "no interrupt request succeeded");
    await t.tools.waitUntil(() => terminalCount(events) === 1, 45_000);
    t.assertions.assert(events.filter((event) => event.type === "turnCanceled").length === 1, "turn was not canceled exactly once");
    await t.flows.main.sendPrompt(opened.client, sessionId, "Run after interrupts.");
    await t.tools.waitUntil(() => terminalCount(events) === 2, 45_000);
    t.assertions.assert(events.filter((event) => event.type === "turnCompleted").length === 1, "session did not recover after interrupts");
  },
);
