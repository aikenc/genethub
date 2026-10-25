import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.agent-space.durable-native-plan",
  title: "A script Agent's native plan releases its session and resumes without a project grant",
  oracle: "a planApproval the Agent raises stops the turn (interrupt answered) and closes its script session, Human acceptance survives as a new turn on a session started again with the same native resume value, and no project grant is required for an ordinary Agent plan",
  catches: ["native plans are rejected as missing PM challenges", "the in-flight turn is not stopped at the Human pause", "Human wait retains the Agent session", "acceptance resumes a fresh native session"],
  tags: ["core", "durable-approval", "agent", "native-plan"],
  // The three protocol waits allow up to 40 seconds in a healthy slow
  // environment (15s + 10s + 15s), so the unit timeout must exceed that
  // declared contract rather than force-cleaning a valid continuation.
  expectedDurationMs: 5_000, timeoutMs: 60_000,
  surfaces: ["daemon", "agent", "script-agent", "workbench-client"],
  productInterfaces: ["agent-serve-protocol-1", "session.interrupt", "session.close", "session.start resume", "session.respondPermission"],
}, async (t) => {
  const flow = await t.flows.branches.openControlledAgentSession({ openRoot: t.openRoot, lease: t.env, agent: { profile: "native-plan" } });
  try {
    await t.flows.main.sendPrompt(flow.client, flow.sessionId, "Please prepare your native plan.");
    let requestId = "";
    await t.tools.waitUntil(async () => {
      const snapshot = await flow.client.call({ type: "session.get", payload: { sessionId: flow.sessionId } });
      if (snapshot?.type !== "snapshot") return false;
      requestId = snapshot.data.pendingPermissions?.[0]?.id ?? "";
      return Boolean(requestId);
    }, 15_000);
    const native = flow.journal().find(e => e.event === "plan-request")?.sessionId;
    t.assertions.assert(typeof native === "string", "the script never raised its plan");
    // One serve process hosts every session, so the pause releases the
    // session, not a process.
    await t.tools.waitUntil(() => flow.journal().some(e => e.event === "session-closed" && e.sessionId === native), 10_000)
      .catch(() => { throw new Error("the Human pause kept the Agent session open"); });
    t.assertions.assert(flow.journal().some(e => e.event === "plan-cancellation" && (e.result as { outcome?: { outcome?: string } })?.outcome?.outcome === "cancelled"), "the in-flight plan turn was not interrupted");
    const result = await flow.client.call({ type: "session.respondPermission", payload: { sessionId: flow.sessionId, requestId, outcome: { outcome: "selected", optionId: "accept" } } });
    t.assertions.assert(result?.type === "ack", "native plan was refused as a PM challenge");
    await t.tools.waitUntil(() => flow.journal().some(e => e.event === "approved-continuation"), 15_000);
    const resume = flow.journal().find(e => e.event === "resumed");
    const continued = flow.journal().find(e => e.event === "approved-continuation");
    t.assertions.assert(Boolean(resume) && resume?.sessionId === native && continued?.sessionId === native, "native session identity changed");
  } finally { await flow.dispose(); }
});
