import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.connectivity.reconnect",
    title: "CLI admission can restart a daemon and list workspaces again",
    oracle: "workspace.list succeeds before and after genet daemon stop/start",
    catches: ["stale endpoint", "shared data dir"],
    tags: ["core", "connectivity"],
    llm: { default: "none" },
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["genet-cli", "@genehub/workbench/client"],
  },
  async (t) => {
    const result = await t.flows.branches.reconnectAfterStop({
      openRoot: t.openRoot,
      lease: t.env,
    });
    t.assertions.assert(result.listed, "workspace.list failed across restart");
  },
);
