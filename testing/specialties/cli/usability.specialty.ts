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

// Keep the existing case ID so policy selections continue covering the repaired boundary.
check("capability-denial", "An ordinary Agent has owner capabilities and retains its session identity",
  "a real builtin Agent lists clients and reports owner capabilities tied to its durable Session",
  ["ordinary Agent is artificially limited", "controller identity is discarded"],
  async t => workspace(t, async opened => {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const commands = ['"$GENEHUB_CLI" client list > owner-clients.json',
      '"$GENEHUB_CLI" context > owner-context.json',
      'echo done > owner.done'];
    opened.mock.script({ tool: { name: "bash", arguments: { command: commands.join("; ") } } }, { text: "Capability check complete." });
    const sid = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, sid, "Check the CLI owner authority result.");
    await t.tools.waitUntil(() => existsSync(path.join(opened.workspaceRoot, "owner.done")), 30000);
    const read = (file: string) => parseJson(readFileSync(path.join(opened.workspaceRoot, file), "utf8")) as unknown as Envelope;
    t.assertions.assert(read("owner-clients.json").type === "client.debug", "ordinary Agent could not list clients");
    const authority = read("owner-context.json").data.authority;
    t.assertions.assert(authority.principalType === "sessionController" && authority.sessionId === sid && authority.providerOperations === true, "owner parity lost scope or identity");
  }), true);


check("forwarded-contracts", "Forwarded schema, capabilities and selector failures preserve the native CLI contract",
  "each schema routable flag matches its machine input; capabilities expose actual remote/isolation facts; unsupported machine/cwd and missing Hub discovery fail explicitly without local fallback",
  ["schema advertises a silently ignored selector", "capabilities claim a parsing sandbox", "remote failure falls back to local data"],
  async t => workspace(t, async opened => {
    const schema=(await json(opened,["schema"])).data.commands;
    t.assertions.assert(schema.length>0,"empty command schema");
    for(const entry of schema)t.assertions.assert(typeof entry.routable==="boolean"&&entry.routable===Object.hasOwn(entry.inputSchema.properties,"machine"),`routing schema differs for ${entry.name}`);
    const caps=(await json(opened,["capabilities"])).data;
    t.assertions.assert(caps.remoteExec===true&&caps.remote.hostedHub===true&&caps.remote.transports.includes("rendezvous")&&caps.remote.selector.flag==="--machine"&&caps.remote.selector.implicitDefault===false,"remote capabilities changed");
    t.assertions.assert(caps.isolation.arbitraryCommands===true&&caps.isolation.commandLineParsing===false&&caps.isolation.engine===null&&caps.isolation.reportedBy==="context.daemon.isolation"&&caps.workingDirectory.inferred===false,"OS capability reporting changed");
    for(const args of [["daemon","stop","--machine","m_other"],["schema","--machine","m_other"]]){
      const reply=await command(opened,args);const error=records(reply.stdout).at(-1)?.error;
      t.assertions.assert(reply.code===2&&error?.code==="commandNotRoutable","local-only selector was ignored");
    }
    const missing=await command(opened,["session","list","--machine=m_other"]);
    const failure=parseJson(missing.stdout) as {error?:{code:string;retryable:boolean;details?:{stage:string;machineId:string}}};
    t.assertions.assert(missing.code===4&&failure.error?.code==="internal"&&!failure.error.retryable&&failure.error.details?.stage==="hubTicket"&&failure.error.details.machineId==="m_other","missing account route silently used local data or hid upstream failure");
    const cwd=await command(opened,["workspace","list","--cwd","/srv/app"]);
    t.assertions.assert(cwd.code===2&&String((parseJson(cwd.stdout).error as {message:string}).message).includes("--cwd"),"ignored working directory was accepted");
  }));
