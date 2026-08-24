import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.authorization.revoke-stops-acting",
    title: "A device revoked while connected stops being able to act",
    oracle: "workspace.list after device.revoke is forbidden or the link closes",
    catches: ["revoke is advisory"],
    tags: ["core", "authorization", "parity"],
    expectedDurationMs: 30_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, []);
    try {
      const before = await paired.client.call({ type: "workspace.list" });
      t.assertions.assert(before?.type === "workspaces", "device could not act before revoke");
      await opened.client.call({ type: "device.revoke", payload: { deviceId: paired.deviceId } });
      try {
        await paired.client.call({ type: "workspace.list" });
        t.assertions.assert(false, "a revoked device could still list workspaces");
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        t.assertions.assert(
          /forbidden|closed|unauthorized|revok|waited too long|connection|timeout/i.test(text),
          `a revoked device failed unclearly: ${text}`,
        );
      }
    } finally {
      paired.client.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
