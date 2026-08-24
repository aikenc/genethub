import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.continues-round-unknown",
    title: "continuesRound is accepted over the wire and ignored when unrecognized",
    oracle: "session.send with a fake continuesRound still completes the turn",
    catches: ["unknown round id is a protocol error"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "ok" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "hello", "r_does_not_exist");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
