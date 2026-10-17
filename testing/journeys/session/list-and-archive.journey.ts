import { defineJourney, localGenetCli } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.list-and-archive",
    title: "Sessions list per workspace and can be archived",
    oracle: "session.list and genet session list drop an archived session unless includeArchived / --include-archived is true",
    catches: ["global session list", "archive is a local flag", "CLI cannot list archived sessions"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client", "genet-cli"],
    productInterfaces: ["@genehub/workbench/client", "genet session list"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const first = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const listed = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(listed?.type === "sessions" && listed.data.length === 2, "expected two live sessions");
      await opened.client.call({
        type: "session.archive",
        payload: { sessionId: first, archived: true },
      });
      const live = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(live?.type === "sessions" && live.data.length === 1, "archived session still listed");
      t.assertions.assert(
        live?.type === "sessions" && !live.data.some((item) => item.id === first),
        "archived session still visible",
      );
      const all = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: true },
      });
      t.assertions.assert(all?.type === "sessions" && all.data.length === 2, "includeArchived lost a session");

      const cli = localGenetCli(t.openRoot, t.env);
      const cliLive = (cli(["session", "list", "--workspace", opened.workspaceId]).envelope?.data as { sessions: Array<{ id: string }> }).sessions;
      const cliAll = (cli(["session", "list", "--workspace", opened.workspaceId, "--include-archived"]).envelope?.data as { sessions: Array<{ id: string }> }).sessions;
      t.assertions.assert(cliLive.length === 1 && cliAll.length === 2 && cliAll.some((item) => item.id === first), "CLI --include-archived did not return the archived session");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
