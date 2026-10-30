import { mkdirSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

/**
 * The load profile the retired Rust concurrency journey used: ten and twenty
 * workspaces, one in-flight turn each, every session observing only its own
 * turn. Native resource counts and the four/eight-browser fleet are not
 * reproduced here; they were measurement-only probes, not the business oracle.
 */
defineSpecialty(
  {
    id: "specialty.concurrency.parallel-workspaces",
    title: "Ten and twenty workspaces complete their own turns without mixing",
    oracle:
      "at the retired Rust profile's 10- and 20-workspace scale, every session completes exactly one turn and neither it nor 4/8 extra observer clients see another session's turnStarted; workspace.list and file.tree stay responsive",
    catches: [
      "shared session state starts one workspace's turn inside another",
      "the daemon stalls or drops sessions as workspace count grows",
      "a list or subscribe path serializes in-flight turns",
    ],
    tags: ["core", "concurrency", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 90_000,
    timeoutMs: 240_000,
    resources: { environments: 1, cpu: 4, memoryMb: 1024, io: 4, browser: 0, pool: "standard" },
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      for (const count of [10, 20]) {
        opened.mock.script(
          ...Array.from({ length: count }, (_, index) => ({
            text: `load-${count}-${index}`,
            delayMs: 200,
          })),
        );
        const workspaces: Array<{ id: string; session: string; events: Array<{ type?: string }> }> = [];
        const observerCount = count === 10 ? 4 : 8;
        const observers = await Promise.all(
          Array.from({ length: observerCount }, (_, index) =>
            t.flows.main.openSecondClient(opened, `workspace-observer-${count}-${index}`),
          ),
        );
        for (let index = 0; index < count; index += 1) {
          const root = path.join(t.env.workspace, `load-${count}-${index}`);
          mkdirSync(root, { recursive: true });
          const reply = await opened.client.call({ type: "workspace.open", payload: { root } });
          t.assertions.assert(reply?.type === "workspace", `workspace.open failed at ${index}`);
          const id = reply?.type === "workspace" ? reply.data.id : "";
          const session = await t.flows.main.createBuiltinSession(opened.client, id);
          const events = await t.flows.main.attachEventLog(opened.client, session);
          workspaces.push({ id, session, events });
        }
        const observerEvents = await Promise.all(
          observers.map((observer) =>
            Promise.all(workspaces.map((workspace) => t.flows.main.attachEventLog(observer, workspace.session))),
          ),
        );
        for (const workspace of workspaces) {
          await t.flows.main.sendPrompt(opened.client, workspace.session, "Say something.");
        }
        const probeStarted = Date.now();
        const listed = await opened.client.call({ type: "workspace.list" });
        t.assertions.assert(listed?.type === "workspaces", `workspace.list returned ${listed?.type}`);
        t.assertions.assert(
          Date.now() - probeStarted < 3_000,
          `workspace.list took ${Date.now() - probeStarted}ms with ${count} in-flight turns`,
        );
        const treeStarted = Date.now();
        const tree = await opened.client.call({
          type: "file.tree",
          payload: { workspaceId: workspaces[0]!.id, path: null, depth: 1 },
        });
        t.assertions.assert(tree?.type === "fileTree", `file.tree returned ${tree?.type}`);
        t.assertions.assert(
          Date.now() - treeStarted < 3_000,
          `file.tree took ${Date.now() - treeStarted}ms with ${count} in-flight turns`,
        );
        await t.tools.waitUntil(
          () =>
            workspaces.every((workspace) =>
              workspace.events.some((item) => item.type === "turnCompleted"),
            ),
          120_000,
        );
        for (const workspace of workspaces) {
          const started = workspace.events.filter(
            (item) => item.type === "turnStarted",
          );
          t.assertions.assert(
            started.length === 1,
            `workspace ${workspace.id} saw ${started.length} turnStarted at scale ${count}`,
          );
        }
        for (const [observer, logs] of observerEvents.entries()) {
          for (const [index, log] of logs.entries()) {
            const started = log.filter((item) => item.type === "turnStarted");
            t.assertions.assert(
              started.length === 1,
              `observer ${observer} saw ${started.length} turnStarted for ${workspaces[index]!.id} at scale ${count}`,
            );
          }
        }
        for (const observer of observers) observer.close();
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
