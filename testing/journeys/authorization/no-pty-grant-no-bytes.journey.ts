import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.authorization.no-pty-grant-no-bytes",
    title: "A device without a terminal grant is not sent the terminal anyway",
    oracle: "owner sees pty echo; a read+session device's onPty stays empty",
    catches: ["pty fanout ignores grants"],
    tags: ["core", "authorization", "parity"],
    expectedDurationMs: 35_000,
    timeoutMs: 100_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const device = await t.flows.main.pairDevice(opened.client, opened.daemon, ["read", "session"]);
    const ownerChunks: string[] = [];
    const deviceChunks: string[] = [];
    const stopOwner = opened.client.onPty((_id, data) => {
      if (data) ownerChunks.push(data);
    });
    const stopDevice = device.client.onPty((_id, data) => {
      if (data) deviceChunks.push(data);
    });
    try {
      const pty = await opened.client.call({
        type: "pty.open",
        payload: { workspaceId: opened.workspaceId, cols: 80, rows: 24 },
      });
      t.assertions.assert(pty?.type === "pty", `pty.open returned ${pty?.type}`);
      const ptyId = pty?.type === "pty" ? pty.data.ptyId : "";
      await opened.client.call({ type: "pty.write", payload: { ptyId, data: "echo grant-marker\n" } });
      await t.tools.waitUntil(() => ownerChunks.join("").includes("grant-marker"), 20_000);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      t.assertions.assert(
        !deviceChunks.join("").includes("grant-marker"),
        `a device without the pty grant received terminal output: ${deviceChunks.join("")}`,
      );
    } finally {
      stopOwner();
      stopDevice();
      device.client.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
