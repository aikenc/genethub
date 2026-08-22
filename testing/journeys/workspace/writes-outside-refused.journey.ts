import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.workspace.writes-outside-refused",
    title: "Writes outside the workspace are refused",
    oracle: "file.write of escaped paths returns forbidden",
    catches: ["path traversal", "absolute path write"],
    tags: ["core", "workspace", "filesystem", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      for (const filePath of [
        `${opened.rootHandle}/../escape.txt`,
        "/etc/passwd",
        `${opened.rootHandle}/src/../../escape.txt`,
        "r_not_a_member/file.txt",
      ]) {
        await t.assertions.expectProtocolCode(
          () =>
            opened.client.call({
              type: "file.write",
              payload: { workspaceId: opened.workspaceId, path: filePath, content: "owned" },
            }),
          "forbidden",
        );
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
