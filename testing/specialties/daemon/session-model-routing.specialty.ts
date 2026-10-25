// Which Agent and model a Session runs on has to be something a script can read, choose and change with
// the shipped `genet`, not something only the workbench can see. These cases drive the real CLI against a
// real daemon with the built-in Agent on a mock provider whose two models carry machine-global tiers and
// costs (flash: Flash, low; pro: Pro, medium; both understand images and video).
//
//   - `agent list --routes` prints one line per routable model and filters by every tier and medium;
//   - `agent run --tag` lets routing choose at creation, and creates nothing when no route matches;
//   - `session model` pins a model on a plain session, refuses to on a routed one, and moves a routed
//     session to another tier;
//   - a Session that named no model records the one its Agent started with.

import type { SessionSnapshot } from "@genehub/proto";

import {
  defineSpecialty,
  localGenetCli,
  type CaseContext,
  type GenetCliResult,
} from "../../framework/public.ts";

const SCHEMA = "genet.cli/v1";
const FLASH = "deepseek/deepseek-v4-flash";
const PRO = "deepseek/deepseek-v4-pro";

type Route = { agentId: string; modelId?: string; tags: string[]; cost: string; default: boolean };

const brief = (result: GenetCliResult): string =>
  `exit ${result.code} stdout ${result.stdout.slice(-400)} stderr ${result.stderr.slice(-300)}`;

function succeeded(t: CaseContext, result: GenetCliResult, type: string): Record<string, unknown> {
  t.assertions.assert(result.code === 0, `genet ${type}: ${brief(result)}`);
  const body = result.envelope;
  t.assertions.assert(
    body?.schema === SCHEMA && body.type === type && typeof body.data === "object",
    `genet ${type} envelope: ${result.stdout.slice(-400)}`,
  );
  return body!.data!;
}

function refused(t: CaseContext, result: GenetCliResult, code: number, errorCode: string, what: string): void {
  const body = result.envelope;
  t.assertions.assert(
    result.code === code && body?.schema === SCHEMA && body.type === "error" && body.error?.code === errorCode,
    `${what}: expected exit ${code} ${errorCode}, got ${brief(result)}`,
  );
}

function modelCase(
  name: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, ctx: { cli: ReturnType<typeof localGenetCli>; workspaceId: string; client: any; sessionIds: () => Promise<string[]>; snapshot: (id: string) => Promise<SessionSnapshot>; mock: any }) => Promise<void>,
): void {
  defineSpecialty(
    {
      id: `specialty.daemon.session-model.${name}`,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "session", "genet-cli", "tag-routing", "session-model"],
      llm: { default: "mock" },
      expectedDurationMs: 25_000,
      timeoutMs: 120_000,
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["genet-cli", "daemon", "agent"],
      productInterfaces: ["genet-cli", "settings.agentPreferences", "session.createRouted", "session.route"],
    },
    async (t) => {
      const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      try {
        await t.flows.main.configureMockProvider(opened.client, opened.mock);
        const snapshot = async (id: string): Promise<SessionSnapshot> => {
          const reply = await opened.client.call({ type: "session.get", payload: { sessionId: id } });
          if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
          return reply.data;
        };
        const sessionIds = async (): Promise<string[]> => {
          const reply = await opened.client.call({
            type: "session.list",
            payload: { workspaceId: opened.workspaceId, includeArchived: false },
          });
          if (reply?.type !== "sessions") throw new Error(`session.list returned ${reply?.type}`);
          return reply.data.map((entry) => entry.id);
        };
        await run(t, {
          cli: localGenetCli(t.openRoot, t.env),
          workspaceId: opened.workspaceId,
          client: opened.client,
          sessionIds,
          snapshot,
          mock: opened.mock,
        });
      } finally {
        opened.client.close();
        opened.daemon.stop();
        await opened.mock.stop();
      }
    },
  );
}

const routesOf = (t: CaseContext, result: GenetCliResult): Route[] =>
  (succeeded(t, result, "agent.list").routes as Route[]).filter((route) => route.agentId === "genet");

modelCase(
  "routes-are-listed-one-per-line-and-filtered-by-every-tier",
  "agent list --routes prints one line per routable model and filters by every tier and medium",
  "`genet agent list --routes` lists genet's flash (Flash, low) and pro (Pro, medium) routes each with agentId, modelId, tags, cost and default; --tag keeps only routes carrying every tier and implies route mode, --media keeps only routes that understand the medium; no match is an empty list, not an error; an unknown medium exits 2",
  [
    "the router's candidates hidden from the scripts that have to choose among them",
    "a filter that ORs tiers instead of ANDing them",
    "a medium filter that ignores what the machine configured",
    "an unknown medium silently treated as no filter",
  ],
  async (t, { cli }) => {
    const all = routesOf(t, cli(["agent", "list", "--routes"]));
    const flash = all.find((route) => route.modelId === FLASH);
    const pro = all.find((route) => route.modelId === PRO);
    t.assertions.assert(flash && pro, `both fixture routes should be listed: ${JSON.stringify(all)}`);
    t.assertions.assert(flash!.cost === "low" && flash!.tags.includes("Flash"), `flash route: ${JSON.stringify(flash)}`);
    t.assertions.assert(pro!.cost === "medium" && pro!.tags.includes("Pro"), `pro route: ${JSON.stringify(pro)}`);
    t.assertions.assert(
      all.every((route) => typeof route.default === "boolean"),
      "every line states whether it is the Agent's default model",
    );

    const onlyPro = routesOf(t, cli(["agent", "list", "--routes", "--tag", "Pro"]));
    t.assertions.assert(onlyPro.length === 1 && onlyPro[0]?.modelId === PRO, `--tag Pro: ${JSON.stringify(onlyPro)}`);
    const both = routesOf(t, cli(["agent", "list", "--routes", "--media", "image"]));
    t.assertions.assert(both.length === 2, `--media image: ${JSON.stringify(both)}`);
    const none = routesOf(t, cli(["agent", "list", "--routes", "--tag", "Max"]));
    t.assertions.assert(none.length === 0, `no route carries Max: ${JSON.stringify(none)}`);
    const and = routesOf(t, cli(["agent", "list", "--routes", "--tag", "Flash", "--tag", "Pro"]));
    t.assertions.assert(and.length === 0, `Flash + Pro must be an AND, not an OR: ${JSON.stringify(and)}`);

    const implicit = routesOf(t, cli(["agent", "list", "--tag", "Pro"]));
    t.assertions.assert(implicit.length === 1 && implicit[0]?.modelId === PRO, `implicit route mode: ${JSON.stringify(implicit)}`);
    refused(t, cli(["agent", "list", "--routes", "--media", "audio"]), 2, "invalidArgs", "an unknown medium");
  },
);

modelCase(
  "run-with-a-tier-lets-routing-choose-and-creates-nothing-when-none-matches",
  "agent run --tag creates a routed Session on the live cheapest match and refuses without side effects",
  "`agent run --tag Pro` creates a Session on the pro model with the tier recorded as its routing tag and `--media image` recorded as a media tag; `--tag Max` (no such route) fails with agentTagRouteUnavailable and creates no Session; --tag with --agent, --model or --session, and --media without --tag, exit 2 before anything is created",
  [
    "a tier request that quietly runs on whatever the Agent defaults to",
    "a failed route leaving an empty Session behind",
    "--tag combined with a concrete model, so two answers to one question",
    "a media requirement lost between the CLI and the daemon",
  ],
  async (t, { cli, workspaceId, sessionIds, snapshot }) => {
    const before = await sessionIds();
    const created = succeeded(
      t,
      cli(["agent", "run", "--tag", "Pro", "--media", "image", "--workspace", workspaceId, "--message-id", "route.1", "--no-wait", "hello"]),
      "session.result",
    );
    const id = String(created.sessionId);
    const summary = (await snapshot(id)).summary;
    t.assertions.assert(summary.agentId === "genet" && summary.modelId === PRO, `routed to ${summary.agentId}/${summary.modelId}`);
    t.assertions.assert(summary.routingTags?.includes("Pro") === true, `routing tags: ${JSON.stringify(summary.routingTags)}`);
    t.assertions.assert(summary.mediaTags?.includes("图片理解") === true, `media tags: ${JSON.stringify(summary.mediaTags)}`);

    const afterOne = await sessionIds();
    refused(
      t,
      cli(["agent", "run", "--tag", "Max", "--workspace", workspaceId, "--message-id", "route.2", "--no-wait", "hello"]),
      4,
      "agentTagRouteUnavailable",
      "--tag Max",
    );
    t.assertions.assert(
      (await sessionIds()).length === afterOne.length && afterOne.length === before.length + 1,
      "a route that does not exist created a Session",
    );

    for (const [args, what] of [
      [["--tag", "Pro", "--agent", "genet"], "--tag with --agent"],
      [["--tag", "Pro", "--model", FLASH], "--tag with --model"],
      [["--tag", "Pro", "--session", id], "--tag with --session"],
      [["--media", "image", "--agent", "genet"], "--media without --tag"],
    ] as const) {
      refused(t, cli(["agent", "run", ...args, "--workspace", workspaceId, "--no-wait", "x"]), 2, "invalidArgs", what);
    }
    t.assertions.assert((await sessionIds()).length === afterOne.length, "a refused request created a Session");
  },
);

modelCase(
  "session-model-pins-on-a-plain-session-refuses-a-routed-one-and-moves-tiers",
  "session model pins a model on a plain session, refuses on a routed one, and moves a routed session to another tier",
  "on a Session created with a concrete model, `session model --model` changes the model that `session get` reports; on a Session created with --tag, `--model` fails with sessionRouted and changes nothing, while `--tag Flash` moves it to the flash model; --effort alone and a bad combination (--tag with --model, nothing to change, --media without --tag) behave as documented",
  [
    "a pinned model that the next send silently routes away from",
    "a tier move that leaves the Session reporting its old model",
    "a model the Agent does not offer accepted and recorded",
    "an option combination with two answers accepted",
  ],
  async (t, { cli, workspaceId, snapshot, mock }) => {
    // The product refuses to switch Agent or model under a turn that is still running, so each Session
    // is let finish its one scripted turn before it is changed. A Session reads idle before its first
    // turn has even started, so idle alone proves nothing: the provider must also have answered the
    // turns started so far.
    const settled = (id: string, answered: number) =>
      t.tools.waitUntil(
        async () => mock.calls.length >= answered && (await snapshot(id)).summary.status === "idle",
        30_000,
      );
    mock.script({ text: "ok" }, { text: "ok" });
    const plain = String(
      succeeded(
        t,
        cli(["agent", "run", "--agent", "genet", "--model", FLASH, "--workspace", workspaceId, "--message-id", "plain.1", "--no-wait", "hello"]),
        "session.result",
      ).sessionId,
    );
    await settled(plain, 1);
    const pinned = succeeded(t, cli(["session", "model", plain, "--model", PRO]), "session.model");
    t.assertions.assert(pinned.modelId === PRO, `session model reply: ${JSON.stringify(pinned)}`);
    t.assertions.assert((await snapshot(plain)).summary.modelId === PRO, "session get still reports the old model");
    const bad = cli(["session", "model", plain, "--model", "no-such-model"]);
    t.assertions.assert(bad.code !== 0 && bad.envelope?.type === "error", `an unoffered model was accepted: ${brief(bad)}`);
    t.assertions.assert((await snapshot(plain)).summary.modelId === PRO, "a refused change altered the model");

    const routed = String(
      succeeded(
        t,
        cli(["agent", "run", "--tag", "Pro", "--workspace", workspaceId, "--message-id", "routed.1", "--no-wait", "hello"]),
        "session.result",
      ).sessionId,
    );
    await settled(routed, 2);
    refused(t, cli(["session", "model", routed, "--model", FLASH]), 4, "sessionRouted", "--model on a routed Session");
    t.assertions.assert((await snapshot(routed)).summary.modelId === PRO, "a refused pin altered a routed Session");
    const moved = succeeded(t, cli(["session", "model", routed, "--tag", "Flash"]), "session.model");
    t.assertions.assert(moved.modelId === FLASH, `tier move reply: ${JSON.stringify(moved)}`);
    t.assertions.assert((await snapshot(routed)).summary.modelId === FLASH, "session get does not show the moved tier");
    t.assertions.assert(
      (await snapshot(routed)).summary.routingTags?.includes("Flash") === true,
      "the Session no longer says which tier it follows",
    );

    refused(t, cli(["session", "model", plain, "--tag", "Pro", "--model", FLASH]), 2, "invalidArgs", "--tag with --model");
    refused(t, cli(["session", "model", plain]), 2, "invalidArgs", "nothing to change");
    refused(t, cli(["session", "model", plain, "--media", "image"]), 2, "invalidArgs", "--media without --tag");
  },
);

modelCase(
  "a-session-that-named-no-model-records-the-one-its-agent-started-with",
  "a Session created without a model records its Agent's default once it starts",
  "a Session created with no model has no model before it starts; after its first turn starts, `session get` reports the model the Agent's catalog names as default, and `session list` agrees",
  [
    "a background Session whose model is unknown to every reader of `session list`",
    "a recorded model that is not the one the Agent actually started with",
    "the default overwriting a model the caller did name",
  ],
  async (t, { cli, client, workspaceId, snapshot, mock }) => {
    // Explicit profiles resolve a permitted model at creation. This case instead
    // exercises an unconfigured Agent whose own catalog default is used at start.
    await client.call({ type: "settings.setAgentPreferences", payload: { preferences: {
      runtimes: {}, selectedTags: [], modelProfiles: [],
    } } });
    const catalog = (
      succeeded(t, cli(["agent", "list"]), "agent.list").agents as Array<{ id: string; catalog: { defaultModel?: string } }>
    ).find((agent) => agent.id === "genet");
    const expected = catalog?.catalog.defaultModel;
    t.assertions.assert(typeof expected === "string" && expected.length > 0, `genet reports no default model: ${JSON.stringify(catalog)}`);

    mock.script({ text: "ok" });
    const reply = await client.call({
      type: "session.create",
      payload: { workspaceId, agentId: "genet", modelId: null, modeId: null, title: null, cwd: null },
    });
    if (reply?.type !== "session") throw new Error(`session.create returned ${reply?.type}`);
    const id = (reply.data as unknown as { id: string }).id;
    t.assertions.assert((await snapshot(id)).summary.modelId == null, "the model was invented before anything started");

    await t.flows.main.sendPrompt(client, id, "hello");
    await t.tools.waitUntil(async () => (await snapshot(id)).summary.modelId != null, 20_000);
    t.assertions.assert((await snapshot(id)).summary.modelId === expected, `recorded ${(await snapshot(id)).summary.modelId}, Agent default ${expected}`);
    const listed = succeeded(t, cli(["session", "list"]), "session.list");
    const row = (listed.sessions as Array<{ id: string; modelId?: string }>).find((entry) => entry.id === id);
    t.assertions.assert(row?.modelId === expected, `session list row: ${JSON.stringify(row)}`);
  },
);
