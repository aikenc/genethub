import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.authorization.invite-read-only",
    title: "Restricted invitations are rejected without issuing broader access",
    oracle: "old scoped invitation is rejected; a normal paired device can configure and write with real effects",
    catches: ["invitation ignored", "self-widening invite"],
    tags: ["core", "authorization", "parity"],
    expectedDurationMs: 30_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const paired = await t.flows.main.pairDevice(opened.client, opened.daemon);
    try {
      const before = await opened.client.call({ type: "device.list" });
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "device.invite", payload: { grants: ["read"] } }), "badRequest");
      const after = await opened.client.call({ type: "device.list" });
      t.assertions.assert(before?.type === "devices" && after?.type === "devices" && before.data.devices.length === after.data.devices.length, "rejected narrowed invite changed authorizations");
      t.assertions.assert((await paired.client.call({ type: "settings.get" }))?.type === "settings", "complete paired device lost settings");
      await paired.client.call({ type: "file.write", payload: { workspaceId: opened.workspaceId, path: opened.rootHandle + "/paired.txt", content: "paired" } });
      t.assertions.fileEquals(opened.workspaceRoot, "paired.txt", "paired");
    } finally {
      paired.client.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
