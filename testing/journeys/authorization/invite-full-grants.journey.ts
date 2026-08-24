import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.authorization.invite-full-grants",
    title: "A device granted everything still works exactly as before",
    oracle: "an invite with no named grants can list workspaces and read settings",
    catches: ["empty grant set silently narrows existing devices"],
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
      const listed = await paired.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", "full grant lost workspace.list");
      const settings = await paired.client.call({ type: "settings.get" });
      t.assertions.assert(settings?.type === "settings", `settings.get returned ${settings?.type}`);
    } finally {
      paired.client.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
