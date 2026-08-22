import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.pty-echo",
    title: "A terminal opens, echoes, resizes, and closes",
    oracle: "pty.write of echo is visible on Client.onPty; pty.close then refuses writes",
    catches: ["pty RPC without bytes"],
    tags: ["core", "session", "parity"],
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const chunks: string[] = [];
      const stop = opened.client.onPty((_ptyId, data) => {
        if (data) chunks.push(data);
      });
      const openedPty = await opened.client.call({
        type: "pty.open",
        payload: { workspaceId: opened.workspaceId, cols: 80, rows: 24 },
      });
      t.assertions.assert(openedPty?.type === "pty", `pty.open returned ${openedPty?.type}`);
      const ptyId = openedPty?.type === "pty" ? openedPty.data.ptyId : "";
      await opened.client.call({ type: "pty.write", payload: { ptyId, data: "echo journey-marker\n" } });
      await t.tools.waitUntil(() => chunks.join("").includes("journey-marker"), 20_000);
      await opened.client.call({ type: "pty.resize", payload: { ptyId, cols: 120, rows: 40 } });
      await opened.client.call({ type: "pty.close", payload: { ptyId } });
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "pty.write", payload: { ptyId, data: "echo after-close\n" } }),
        "notFound",
      );
      stop();
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
