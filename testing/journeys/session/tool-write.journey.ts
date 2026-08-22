import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.tool-write",
    title: "User asks the agent to write a file and sees it on disk",
    oracle: "workspace.list, mock-LLM tool write, and result.txt contents",
    catches: ["fake client", "in-process Daemon", "unwritten file", "unknown exchange method"],
    tags: ["core", "session", "filesystem", "product-journey"],
    llm: { default: "mock", realEligible: true },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 25_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["genet-cli", "@genehub/web/client", "daemon-protocol"],
  },
  async (t) => {
    const result = await t.flows.main.completeVerifiableTask({
      openRoot: t.openRoot,
      lease: t.env,
      task: t.data.tasks.writeFile("result.txt", "DONE"),
    });
    t.assertions.fileEquals(result.workspaceRoot, "result.txt", "DONE");
    result.client.close();
    result.daemon.stop();
    await result.mock.stop();
  },
);
