import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.git-commit",
    title: "Changes made by the agent show up in git and can be committed",
    oracle: "git.status lists result.txt then git.commit leaves a clean tree",
    catches: ["status from memory", "commit without the file"],
    tags: ["core", "session", "filesystem", "parity"],
    llm: { default: "mock", realEligible: true },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 30_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    t.data.git.init(t.env.workspace);
    const result = await t.flows.main.completeVerifiableTask({
      openRoot: t.openRoot,
      lease: t.env,
      task: t.data.tasks.writeFile("result.txt", "DONE"),
    });
    try {
      const status = await result.client.call({
        type: "git.status",
        payload: { workspaceId: result.workspaceId },
      });
      t.assertions.assert(status?.type === "gitStatus" && !status.data.clean, "git.status stayed clean");
      t.assertions.assert(
        status?.type === "gitStatus" && status.data.changes.some((change) => change.path.includes("result.txt")),
        "result.txt missing from git.status",
      );
      const commit = await result.client.call({
        type: "git.commit",
        payload: { workspaceId: result.workspaceId, message: "add result", paths: [] },
      });
      t.assertions.assert(
        commit?.type === "gitCommit" && commit.data.commit.length === 40,
        "git.commit did not return a SHA",
      );
      const after = await result.client.call({
        type: "git.status",
        payload: { workspaceId: result.workspaceId },
      });
      t.assertions.assert(after?.type === "gitStatus" && after.data.clean, "tree dirty after commit");
    } finally {
      result.client.close();
      result.daemon.stop();
      await result.mock.stop();
    }
  },
);
