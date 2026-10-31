import { ProtocolError_ } from "@genehub/workbench/client";
import { defineSpecialty, registerControlledAgent } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.connectivity.subscription-admission",
  title: "Concurrent subscriptions at capacity never acknowledge an uninstalled consumer",
  oracle: "At a peer's subscription boundary, each accepted subscription receives a subsequent rename event, rejected subscriptions retain a typed conflict, and freeing one slot admits a previously refused session without reconnecting",
  catches: [
    "a pre-reply capacity check races with installation after the reply",
    "subscription failure loses the daemon's typed error",
    "refused subscriptions leak capacity or require a new connection",
  ],
  tags: ["connectivity", "subscriptions", "admission"],
  llm: { default: "none" },
  expectedDurationMs: 30_000,
  timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "workbench-client"],
  productInterfaces: ["@genehub/workbench/client", "session.create", "subscribe", "session.rename"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  registerControlledAgent(t.env, { id: "admission-agent", profile: "normal", chunks: 1 });
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const client = opened.client;
  try {
    await t.flows.main.requireAgentReady(client, "admission-agent");
    const sessions: string[] = [];
    const seen = new Set<string>();
    const marker = "accepted-subscription-event";
    const subscribe = (id: string) => client.subscribe(id, {
      onEvent(event) {
        if (event.event.type === "titleChanged" && event.event.title === marker) seen.add(id);
      },
      onResync() {},
    });
    // Keep setup below the public client's pending-call bound. No Agent task
    // is started: rename events independently prove the consumer is installed.
    for (let offset = 0; offset < 527; offset += 32) {
      sessions.push(...await Promise.all(Array.from({ length: Math.min(32, 527 - offset) }, () =>
        t.flows.main.createAgentSession(client, {
          workspaceId: opened.workspaceId, agentId: "admission-agent", modelId: null,
        }))));
    }
    const owner = client.logicalConnectionId;
    const accepted = sessions.slice(0, 511);
    for (let offset = 0; offset < accepted.length; offset += 32) {
      await Promise.all(accepted.slice(offset, offset + 32).map(subscribe));
    }
    const candidates = sessions.slice(511);
    const attempts = await Promise.allSettled(candidates.map(subscribe));
    const refused: string[] = [];
    attempts.forEach((result, index) => {
      if (result.status === "fulfilled") accepted.push(candidates[index]!);
      else {
        t.assertions.assert(result.reason instanceof ProtocolError_ && result.reason.detail.code === "conflict",
          `subscription refusal lost its typed conflict: ${String(result.reason)}`);
        refused.push(candidates[index]!);
      }
    });
    t.assertions.assert(refused.length > 0, "the workload did not reach the subscription boundary");
    for (let offset = 0; offset < accepted.length; offset += 32) {
      await Promise.all(accepted.slice(offset, offset + 32).map(id =>
        client.call({ type: "session.rename", payload: { sessionId: id, title: marker } })));
    }
    await t.tools.waitUntil(() => accepted.every(id => seen.has(id)), 15_000);
    await client.unsubscribe(accepted[0]!);
    const recovered = refused[0]!;
    await subscribe(recovered);
    await client.call({ type: "session.rename", payload: { sessionId: recovered, title: marker } });
    await t.tools.waitUntil(() => seen.has(recovered), 5_000);
    t.assertions.assert(client.logicalConnectionId === owner, "capacity recovery replaced a healthy connection");
    t.note(JSON.stringify({ accepted: accepted.length, refused: refused.length, delivered: seen.size, slotReused: true }));
  } finally {
    client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});
