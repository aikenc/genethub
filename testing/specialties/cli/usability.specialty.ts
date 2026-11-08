import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
    const before = (await json(opened, ["session", "list", "--workspace", opened.workspaceId])).data.sessions.length;
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
    t.assertions.assert((await json(opened, ["session", "list", "--workspace", opened.workspaceId])).data.sessions.length === before, "discovery created a session");
  }));

check("bounded-session-queries", "Whole-machine history commands fail explicitly while scoped history and current work remain usable",
  "Bare, lean and label/source-filtered global history commands fail with actionable errors and no empty success; a project still returns its idle history and complete activity preserves an archived obligation",
  ["lean hides another full history walk", "labels bypass the query scope", "refused read becomes empty work", "restriction breaks project history or archived obligations"],
  async t => workspace(t, async opened => {
    const idle = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const active = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await opened.client.call({type: "session.archive", payload: {sessionId: active, archived: true}});
    const home = path.join(opened.workspaceRoot, ".genethub");
    const {writeFileSync} = await import("node:fs");
    writeFileSync(path.join(home, "coordination-source.json"), JSON.stringify({version: 1, source: "bounded-query"}));
    writeFileSync(path.join(home, "session-coordination.json"), JSON.stringify({version: 1, source: "bounded-query", revision: 1,
      receivedAtMs: Date.now(), updatedAtMs: Date.now(), sessions: {[active]: {source: "bounded-query", active: true, pending: 1, ready: 0, unknown: 0, updatedAtMs: Date.now()}}}));
    await t.tools.waitUntil(async () => {
      const r = await opened.client.call({type: "session.page", payload: {requests: [{workspaceId: null, cursor: null, limit: 100, activeOnly: true}], includeArchived: true}});
      return r?.type === "sessionPages" && r.data[0]?.sessions.some(s => s.id === active) === true;
    }, 10000);
    for (const flags of [[], ["--lean"], ["--label", "old-script"], ["--source-kind", "human"], ["--lean", "--include-archived"]]) {
      const result = await command(opened, ["session", "list", ...flags]);
      const last = records(result.stdout).at(-1);
      t.assertions.assert(result.code !== 0 && last?.error?.code === "unboundedQueryDisabled" && !records(result.stdout).some(r => r.type === "session.list"), "unbounded read bypassed scope or became a successful empty result");
      t.assertions.assert(result.stdout.includes("--workspace") && result.stdout.includes("--active"), "refusal provides no supported replacement");
    }
    const history = (await json(opened, ["session", "list", "--workspace", opened.workspaceId, "--lean", "--include-archived"])).data.sessions;
    t.assertions.assert(history.length === 2 && history.some((s: {id: string}) => s.id === idle), "scope restriction hid project history");
    const current = (await json(opened, ["session", "list", "--active", "--include-archived"])).data.sessions;
    t.assertions.assert(current.length === 1 && current[0].id === active && current[0].archived, "complete current work lost an archived obligation or included idle history");
    t.note("Five global history spellings rejected; scoped idle history and complete archived current work remain usable.");
  }));

check("paged-history-summary", "An Agent can browse one history page and check a task without decoding its chat",
  "25 real sessions are reachable through explicit bounded CLI pages; incomplete pages carry a machine-bound nextCursor; cold metadata remains readable when chat cannot be decoded; archived and deleted state is respected",
  ["CLI secretly drains all pages", "cursor jumps to another source or scope", "a status check opens chat history", "a summary error becomes idle or missing success"],
  async t => workspace(t, async opened => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId));
    const first = (await json(opened, ["session", "list", "--limit", "7"])).data;
    t.assertions.assert(first.sessions.length === 7 && first.complete === false && typeof first.nextCursor === "string", "one page expanded history or claimed completeness");
    const found = first.sessions.map((s: {id: string}) => s.id);
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const page = (await json(opened, ["session", "list", "--limit", "7", "--cursor", cursor])).data;
      t.assertions.assert(page.sessions.length <= 7 && page.complete === (page.nextCursor === null), "continuation violates bounded/completeness contract");
      found.push(...page.sessions.map((s: {id: string}) => s.id)); cursor = page.nextCursor;
    }
    t.assertions.assert(found.length === 25 && new Set(found).size === 25 && ids.every(id => found.includes(id)), "paged history lost or duplicated a session");
    const foreign = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()); foreign.machine_id = "different-machine";
    const wrong = Buffer.from(JSON.stringify(foreign)).toString("base64url");
    for (const flags of [["--limit", "0"], ["--limit", "101"], ["--cursor", first.nextCursor], ["--limit", "7", "--cursor", wrong], ["--limit", "7", "--label", "tag"]]) {
      t.assertions.assert((await command(opened, ["session", "list", ...flags])).code !== 0, "invalid/foreign page silently returned data");
    }
    const scope = await command(opened, ["session", "list", "--workspace", opened.workspaceId, "--limit", "7", "--cursor", first.nextCursor]);
    t.assertions.assert(scope.code !== 0, "global cursor silently switched query scope");
    await opened.client.call({type: "session.archive", payload: {sessionId: ids[0]!, archived: true}});
    const archived = (await json(opened, ["session", "get", ids[0]!, "--summary"])).data;
    t.assertions.assert(archived.summary.archived === true && !Object.hasOwn(archived, "session"), "summary expanded a snapshot or hid archive state");
    const home = path.join(opened.workspaceRoot, ".genethub", "sessions");
    const model = JSON.parse(readFileSync(path.join(home, ids[0]!, "meta.json"), "utf8"));
    const cold = "s_cli_metadata_only"; mkdirSync(path.join(home, cold));
    writeFileSync(path.join(home, cold, "meta.json"), JSON.stringify({...model, id: cold, title: "Cold status only", archived: false}));
    // A real filesystem fault proves this read path must not deserialize chat.
    mkdirSync(path.join(home, cold, "chat.jsonl"));
    t.assertions.assert((await command(opened, ["session", "get", cold])).code !== 0, "fixture failed to make history unreadable");
    const summary = (await json(opened, ["session", "get", cold, "--summary"])).data.summary;
    t.assertions.assert(summary.id === cold && summary.title === "Cold status only", "status-only read required history");
    const absent = records((await command(opened, ["session", "get", "s_missing_summary", "--summary"])).stdout).at(-1);
    t.assertions.assert(absent?.error?.code === "targetNotFound", "missing status lost typed error");
    await opened.client.call({type: "session.delete", payload: {sessionId: ids[1]!}});
    t.assertions.assert((await command(opened, ["session", "get", ids[1]!, "--summary"])).code !== 0, "deleted task reappeared as a summary");
    t.note("Four CLI pages returned all 25 IDs; scope/source guards, archive and deletion checked; cold unreadable chat did not block metadata status.");
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
    const missing=await command(opened,["session","list","--active","--machine=m_other"]);
    const failure=parseJson(missing.stdout) as {error?:{code:string;retryable:boolean;details?:{stage:string;machineId:string}}};
    t.assertions.assert(missing.code===4&&failure.error?.code==="internal"&&!failure.error.retryable&&failure.error.details?.stage==="hubTicket"&&failure.error.details.machineId==="m_other","missing account route silently used local data or hid upstream failure");
    const cwd=await command(opened,["workspace","list","--cwd","/srv/app"]);
    t.assertions.assert(cwd.code===2&&String((parseJson(cwd.stdout).error as {message:string}).message).includes("--cwd"),"ignored working directory was accepted");
  }));
