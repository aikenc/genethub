import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.authorization.invite-read-only",
    title: "A device gets what its invitation named and nothing else",
    oracle: "read grant lists workspaces; write/settings/process/invite are forbidden",
    catches: ["invitation ignored", "self-widening invite"],
    tags: ["core", "authorization", "parity"],
    expectedDurationMs: 30_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const paired = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read"]);
    try {
      const listed = await paired.client.call({ type: "workspace.list" });
      t.assertions.assert(listed?.type === "workspaces", "read was not granted");
      await t.assertions.expectProtocolCode(
        () =>
          paired.client.call({
            type: "file.write",
            payload: { workspaceId: opened.workspaceId, path: "owned.txt", content: "owned" },
          }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(() => paired.client.call({ type: "settings.get" }), "forbidden");
      await t.assertions.expectProtocolCode(() => paired.client.call({ type: "process.list" }), "forbidden");
      await t.assertions.expectProtocolCode(
        () => paired.client.call({ type: "process.killAll", payload: { sessionId: "s_any" } }),
        "forbidden",
      );
      await t.assertions.expectProtocolCode(
        () => paired.client.call({ type: "device.invite", payload: null }),
        "forbidden",
      );
    } finally {
      paired.client.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
