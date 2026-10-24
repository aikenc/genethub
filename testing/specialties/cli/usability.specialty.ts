import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, parseJson, runGenetAsync, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type Envelope = { type: string; data: Record<string, any>; error?: { code: string } };
const records = (stdout: string): Envelope[] => stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const command = (opened: Opened, args: string[]) => runGenetAsync(opened.daemon.genet, args, opened.daemon.env);
async function json(opened: Opened, args: string[]): Promise<Envelope> {
  const result = await command(opened, args);
  if (result.code !== 0) throw new Error(`CLI ${args.slice(0, 2).join(" ")} failed: ${result.stderr}`);
  return parseJson(result.stdout) as unknown as Envelope;
}
async function workspace(t: CaseContext, run: (opened: Opened) => Promise<void>) {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try { await run(opened); }
  finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
}
function check(id: string, title: string, oracle: string, catches: string[], run: (t: CaseContext) => Promise<void>, mock = false) {
  defineSpecialty({
    id: "specialty.cli.usability." + id, title, oracle, catches,
    tags: ["core", "cli", "cli-usability"], llm: { default: mock ? "mock" : "none" },
    requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
    productInterfaces: ["genet-cli", "@genehub/workbench/client"],
    surfaces: ["genet-cli", "daemon"], expectedDurationMs: 15000, timeoutMs: 90000,
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" },
  }, run);
}

check("argument-boundaries", "Version and help options reach the intended child process",
  "the real Node version runs through shell; child flags are preserved; a command after double dash is not intercepted as CLI help",
  ["native version option consumes child argv", "help steals an executable after double dash", "child flags disappear"],
  async t => workspace(t, async opened => {
    const version = await command(opened, ["shell", "--workspace", opened.workspaceId, "--", process.execPath, "--version"]);
    const versionRecords = records(version.stdout);
    const stdout = versionRecords.filter(r => r.type === "shell.output" && r.data.stream === "stdout").map(r => r.data.data).join("");
    t.assertions.assert(version.code === 0 && stdout.trim() === process.version, "shell did not execute the target Node version");
    t.assertions.assert(versionRecords.some(r => r.type === "shell.exit" && r.data.exitCode === 0), "real child completion was absent");
    const args = await command(opened, ["shell", "--workspace", opened.workspaceId, "--", process.execPath, "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", "--version", "-V", "--help"]);
    const said = records(args.stdout).filter(r => r.type === "shell.output" && r.data.stream === "stdout").map(r => r.data.data).join("");
    t.assertions.assert(args.code === 0 && said === JSON.stringify(["--version", "-V", "--help"]), "child argument tail was changed");
    const literal = await command(opened, ["shell", "--cwd", opened.workspaceRoot, "--", "--help"]);
    t.assertions.assert(literal.code !== 0 && !records(literal.stdout).some(r => r.type === "help"), "a literal executable was intercepted as help");
  }));

check("discovery-contracts", "Help and schemas describe real public command behavior",
  "help creates no sessions, native status schemas describe native facts, transfer schemas accept list responses, invalid filters fail as arguments",
  ["help opens a session", "schema excludes actual response shape", "invalid option reports no target", "capabilities disagree with command schema"],
  async t => workspace(t, async opened => {
    const before = (await json(opened, ["session", "list"])).data.sessions.length;
    for (const args of [["session", "--help"], ["agent", "run", "--help"], ["file", "transfer", "--help"]]) {
      t.assertions.assert((await json(opened, args)).type === "help", "command help failed");
    }
    for (const args of [["--help"], ["daemon", "--help"], ["daemon", "status", "--help"]]) {
      t.assertions.assert((await command(opened, args)).code === 0, "native help failed");
    }
    for (const name of ["space.open", "status", "daemon.status", "client.list", "process.list", "process.kill", "process.killAll"]) {
      const schema = (await json(opened, ["schema", name])).data.command;
      t.assertions.assert(schema.name === name, "public command is undiscoverable");
      if (name.startsWith("process.")) t.assertions.assert(schema.routable && schema.inputSchema.properties.machine, "process routing is not discoverable");
      if (name === "client.list") t.assertions.assert(schema.outputSchema.properties.type.const === (await json(opened, ["client", "list"])).type, "client output schema differs from its response");
      if (name === "status" || name === "daemon.status") {
        const actual = parseJson((await command(opened, name.split("."))).stdout);
        t.assertions.assert(typeof actual.running === schema.outputSchema.properties.running.type && typeof actual.version === "string", "native status schema does not describe native facts");
      }
    }
    const transfers = await json(opened, ["file", "transfer", "status"]);
    const transferSchema = (await json(opened, ["schema", "file.transfer.status"])).data.command.outputSchema;
    t.assertions.assert(transferSchema.properties.type.enum.includes(transfers.type), "transfer list violates its published output type");
    const caps = (await json(opened, ["capabilities"])).data.commands;
    for (const cap of caps) {
      const schema = (await json(opened, ["schema", cap.name])).data.command;
      t.assertions.assert(cap.requiresDaemon === schema.requiresDaemon && cap.routable === schema.routable, "capability and schema disagree");
    }
    for (const args of [["session", "list", "--source-kind", "typo"], ["file", "transfer", "status", "--unknown"], ["file", "transfer", "status", "one", "two"], ["file", "transfer", "cancel", "--unknown"]]) {
      const refused = await command(opened, args);
      t.assertions.assert(refused.code === 2 && records(refused.stdout).at(-1)?.error?.code === "invalidArgs", "invalid input became an empty result or missing target");
    }
    t.assertions.assert((await json(opened, ["session", "list"])).data.sessions.length === before, "discovery created a session");
  }));

check("route-filters", "Agent filters select routes without a redundant mode switch",
  "implicit and explicit route filters agree and a tag-only CLI run actually selects the requested remote-independent model",
  ["filters require hidden routes flag", "schema requires Agent for tag selection", "tag request silently runs a different model"],
  async t => workspace(t, async opened => {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const implicit = (await json(opened, ["agent", "list", "--tag", "Pro", "--media", "video"])).data.routes;
    const explicit = (await json(opened, ["agent", "list", "--routes", "--tag", "Pro", "--media", "video"])).data.routes;
    t.assertions.assert(implicit.length > 0 && JSON.stringify(implicit) === JSON.stringify(explicit), "route mode is required or filters changed");
    t.assertions.assert(implicit.every((route: { tags: string[] }) => route.tags.includes("Pro")), "route filter was ignored");
    const schema = (await json(opened, ["schema", "agent.run"])).data.command.inputSchema;
    t.assertions.assert(!schema.required.includes("agentId"), "schema forbids tag-only selection");
    opened.mock.script({ text: "Route task complete." });
    const accepted = await json(opened, ["agent", "run", "--tag", "Pro", "--workspace", opened.workspaceId,
      "--message-id", "cli-usability-route", "--no-wait", "Complete this route selection check."]);
    const sid = accepted.data.sessionId;
    t.assertions.assert(typeof sid === "string", "tag request created no session");
    await t.tools.waitUntil(async () => {
      const summary = (await json(opened, ["session", "get", sid])).data.session.summary;
      return summary.status === "idle" && summary.latestReply != null;
    }, 30000);
    const summary = (await json(opened, ["session", "get", sid])).data.session.summary;
    t.assertions.assert(summary.agentId === "genet" && summary.modelId === "deepseek/deepseek-v4-pro", "tag selection did not reach its requested model");
  }), true);

check("capability-denial", "An authenticated Agent's missing capability is forbidden rather than unauthenticated",
  "a real builtin Agent calls client list through its session-bound CLI, gets forbidden, and remains a usable authenticated Session",
  ["capability denial requests a new login", "repair widens Agent grants", "CLI bypasses the originating Session"],
  async t => workspace(t, async opened => {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    opened.mock.script({ tool: { name: "bash", arguments: { command:
      '"$GENEHUB_CLI" client list < /dev/null > cli-denied.json 2> cli-denied.err; echo done > cli-denied.done' } } }, { text: "Capability check complete." });
    const sid = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, sid, "Check the CLI capability result.");
    await t.tools.waitUntil(() => existsSync(path.join(opened.workspaceRoot, "cli-denied.done")), 30000);
    const denied = parseJson(readFileSync(path.join(opened.workspaceRoot, "cli-denied.json"), "utf8")) as unknown as Envelope;
    t.assertions.assert(denied.error?.code === "forbidden", "missing capability was misclassified or granted");
    t.assertions.assert((await json(opened, ["session", "get", sid])).data.session.summary.id === sid, "authenticated Session disappeared");
  }), true);
