import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

const template = "apps/daemon/builtin-skills/genehub/references/team-template";
const builder = "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py";
// An ordinary project subclass. The oracle is its visible business behavior,
// not a replacement for any native Session, dispatcher or lease implementation.
const project = `from pathlib import Path
import json
from genet_builtin.api import TeamMode, WorkflowPolicy, ResourcePolicy, ReflectionPolicy, BoardPresenter, TeamCommands, ResourcePlan, Decision
class Workflow(WorkflowPolicy):
    def check_request(self, context, request):
        return Decision.hold('business approval required') if request.goal == 'unapproved' else Decision.allow()
    def check_completion(self, context, task):
        if task['outcome'] != 'success' or not task['evidence']: raise ValueError('completion projection missing public conclusion')
        return Decision.allow() if (Path(context.team_root)/'accepted').exists() else Decision.hold('independent QA required')
class InvalidAPI(Workflow):
    api_version = True
class Resource(ResourcePolicy):
    def plan_resource(self, context, request):
        if request.parameters.get('defer') and request.directory is None: return None
        return ResourcePlan(str(Path(context.team_root)/request.parameters.get('slot', 'slot')), {'project': 'demo'})
    def prepare_resource(self, context, binding):
        marker = Path(binding.directory)/'prepared'
        if marker.exists() and marker.read_text() != context.operation_id:
            raise ValueError('preparation identity changed')
        marker.write_text(context.operation_id)
        return {'marker': 'prepared'}
    def check_release(self, context, binding):
        if (Path(binding.directory)/'dirty').exists(): return Decision.hold('uncommitted business work')
        return Decision.allow()
class Reflect(ReflectionPolicy):
    def evaluate(self, context, snapshot):
        (Path(context.team_root)/'reflection-observed').write_text(str(snapshot['nowMs']))
        return Decision.hold('project reflection disabled for this delivery')
class Board(BoardPresenter):
    def sections(self, context, snapshot):
        if (Path(context.team_root)/"broken-board").exists(): return [None]
        return [{'title': 'Project acceptance', 'text': self.settings.get('label', 'demo')}]
class Commands(TeamCommands):
    def register(self, subparsers, services):
        subparsers.add_parser('project-info')
        start = subparsers.add_parser('project-start')
        start.add_argument('request_id'); start.add_argument('goal')
        def launch(args):
            print(json.dumps(services.start(request_id=args.request_id, role='leader', goal=args.goal, description='custom project')))
        return {'project-info': lambda args: print(json.dumps({'project': self.settings['name']})), 'project-start': launch}
class Mode(TeamMode):
    workflow_class = Workflow
    resource_class = Resource
    reflection_class = Reflect
    board_class = Board
    commands_class = Commands
`;
function write(file: string, value: string) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); }
function configure(root: string) {
  write(join(root, "tools/demo/__init__.py"), ""); write(join(root, "tools/demo/workflow.py"), project);
  const file = join(root, "agent-space.genet.json");
  const descriptor = JSON.parse(readFileSync(file, "utf8"));
  descriptor.team = { class: "demo.workflow:Mode", settings: { commands: { name: "custom-project" }, board: { label: "QA <required>" } } };
  writeFileSync(file, JSON.stringify(descriptor));
}
const common = { tags: ["core", "team-classes"], llm: { default: "none" as const }, expectedDurationMs: 5000, timeoutMs: 180000,
  requirements: [{ kind: "python" as const, env: "GENEHUB_PYTHON", minVersion: [3, 7] as [number, number], modules: [] }],
  surfaces: ["team-template", "spacebuilder", "filesystem"], productInterfaces: ["tools/run.py", "spacebuilder.py"], requiredArtifacts: [] as string[] };

defineSpecialty({ ...common, id: "specialty.daemon.team-classes.portable-and-upgrade",
  title: "Configured project subclasses survive source deletion, relocation and a compatible builtin update",
  oracle: "Portable artifact loads the configured Mode, all inherited slots and settings after deleting source; replacing only builtin code preserves project bytes and behavior; bad Classes fail explicitly.",
  catches: ["Class only changes describe metadata", "runtime depends on build host source", "framework update overwrites project code", "bad Class silently falls back"] }, async t => {
  const source = join(t.env.root, "source"), output = join(t.env.root, "artifact"), moved = join(t.env.root, "remote", "team");
  cpSync(join(t.openRoot, template), source, { recursive: true }); configure(source);
  const invoke = (root: string, args: string[]) => spawnSync(process.env.GENEHUB_PYTHON!, [join(root, "tools/run.py"), ...args], { encoding: "utf8", cwd: t.env.root });
  const sourceConfig = join(source, "agent-space.genet.json"), sourceRaw = JSON.parse(readFileSync(sourceConfig, "utf8"));
  sourceRaw.team.workflow_class = "genet_builtin.api:WorkflowPolicy"; writeFileSync(sourceConfig, JSON.stringify(sourceRaw));
  const overridden = invoke(source, ["describe"]);
  t.assertions.assert(overridden.status === 0 && JSON.parse(overridden.stdout).classes.workflow_class === "genet_builtin.api:WorkflowPolicy", "explicit slot did not override Mode default");
  sourceRaw.team.workflow_class = null; writeFileSync(sourceConfig, JSON.stringify(sourceRaw));
  const nullClass = invoke(source, ["describe"]);
  t.assertions.assert(nullClass.status !== 0 && nullClass.stderr.includes("explicit module:Class"), "explicit null policy silently inherited the default Class");
  sourceRaw.team.workflow_class = "demo.workflow:InvalidAPI"; writeFileSync(sourceConfig, JSON.stringify(sourceRaw));
  const wrongApi = invoke(source, ["describe"]);
  t.assertions.assert(wrongApi.status !== 0 && wrongApi.stderr.includes("incompatible Team API"), "boolean API version accepted as API 1");
  sourceRaw.team.workflow_class = "demo.workflow:Missing"; writeFileSync(sourceConfig, JSON.stringify(sourceRaw));
  const badClass = invoke(source, ["project-info"]);
  t.assertions.assert(badClass.status !== 0 && badClass.stderr.includes("cannot load configured Class"), "missing project Class silently fell back");
  delete sourceRaw.team.workflow_class; writeFileSync(sourceConfig, JSON.stringify(sourceRaw));
  const build = spawnSync(process.env.GENEHUB_PYTHON!, [join(t.openRoot, builder), "build", source, "--output", output, "--format", "json"], { encoding: "utf8" });
  t.assertions.assert(build.status === 0, build.stdout + build.stderr);
  mkdirSync(dirname(moved)); renameSync(output, moved); rmSync(source, { recursive: true });
  const describe = invoke(moved, ["describe"]);
  t.assertions.assert(describe.status === 0, describe.stderr);
  const effective = JSON.parse(describe.stdout);
  t.assertions.assert(effective.classes.resource_class === "demo.workflow:Resource" && effective.sources.resource_class === "mode", "configured Mode did not select inherited Class slot");
  const info = invoke(moved, ["project-info"]);
  t.assertions.assert(info.status === 0 && JSON.parse(info.stdout).project === "custom-project", info.stderr);
  const verified = spawnSync(process.env.GENEHUB_PYTHON!, [join(t.openRoot, builder), "verify", moved, "--artifacts-only", "--format", "json"], { encoding: "utf8" });
  t.assertions.assert(verified.status === 0, verified.stdout + verified.stderr);
  const custom = readFileSync(join(moved, "tools/demo/workflow.py"), "utf8");
  cpSync(join(t.openRoot, template, "tools/genet_builtin"), join(moved, "tools/genet_builtin"), { recursive: true });
  t.assertions.assert(readFileSync(join(moved, "tools/demo/workflow.py"), "utf8") === custom && invoke(moved, ["project-info"]).status === 0, "compatible builtin update rewrote or broke project subclass");
  const config = join(moved, "agent-space.genet.json"), raw = JSON.parse(readFileSync(config, "utf8"));
  raw.team.workflow_class = "demo.workflow:Missing"; writeFileSync(config, JSON.stringify(raw));
  const refused = invoke(moved, ["project-info"]);
  t.assertions.assert(refused.status !== 0 && refused.stderr.includes("artifact integrity failed"), "modified artifact silently used builtin default");
});

defineSpecialty({ ...common, id: "specialty.daemon.team-classes.real-task-resource-policy", requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"], expectedDurationMs: 30000,
  title: "Installed source-free Team uses project Class policies through actual Agent-bound task, timer and board",
  oracle: "Configured project rules reject an unapproved task and premature success, prepare one exact resource across retries, retain dirty work after result consumption, release on a later timer, and present project board data.",
  catches: ["core entry bypasses configured Class", "retry repeats preparation", "business resource released before QA", "resource obligation lost when result consumed", "timer or board uses default Class"] }, async t => {
  const r = await openTeam(t, "class-policy-team", [{ id: "ctl-cli-command", profile: "cli-command" }], { portable: true, configureSource: configure });
  try {
    mkdirSync(join(r.root, "slot"));
    write(join(r.root, ".genethub/definition-source.json"), JSON.stringify({sourcePath:r.source}));
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\nTEAM_WAKE_GAP=0\nTEAM_WAKE_ROUNDS=9999\n");
    const receivingRole = r.spaces.find(s => s.name === "leader" && s.agentSpace?.parentWorkspaceId === r.project.id)!;
    const legacyReceive = r.command(["receive", JSON.stringify({id:"legacy.custom.bypass", workspaceId:receivingRole.id, role:"leader", desc:"bypass", text:"approved", prepareOnly:true})]);
    t.assertions.assert(legacyReceive.code !== 0 && JSON.parse(legacyReceive.out).error.what.includes("自定义项目策略") && !existsSync(join(r.root, "slot/prepared")), "target-side legacy receiver bypassed custom project policy");
    const front = await r.create("ctl-cli-command");
    const idle = (id: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(id)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    const cli = async (sid: string, args: string[]) => {
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root })); await idle(sid);
      const item = (await r.snapshot(sid)).items.filter(i => i.type === "assistantMessage").at(-1);
      if (item?.type !== "assistantMessage") throw Error("caller has no actual Agent receipt");
      return JSON.parse(item.text) as { code: number; out: string; err: string };
    };
    const start = ["task", "start", "--space", "leader", "--desc", "custom project", "--request-id", "approved.A", "approved"];
    const rejected = await cli(front, [...start.slice(0, -1), "unapproved"]);
    t.assertions.assert(rejected.code !== 0 && rejected.err.includes("business approval required") && !existsSync(join(r.root, "slot/prepared")), "request bypassed project policy");
    const created = await cli(front, ["project-start", "approved.A", "approved"]);
    t.assertions.assert(created.code === 0, created.out + created.err);
    const task = JSON.parse(created.out.trim().split("\n").at(-1)!); const owner = task.owner.sessionId;
    await idle(owner);
    const retry = await cli(front, start);
    t.assertions.assert(retry.code === 0 && JSON.parse(retry.out.trim().split("\n").at(-1)!).owner.sessionId === owner, "retry created a second resource/session");
    t.assertions.assert(readFileSync(join(r.root, "slot/prepared"), "utf8").startsWith("taskop."), "business preparation did not run with stable operation identity");
    const premature = await cli(owner, ["task", "finish", task.taskId, "--outcome", "success", "ready"]);
    t.assertions.assert(premature.code !== 0 && premature.err.includes("independent QA required"), "success bypassed project acceptance");
    mkdirSync(join(r.root, "support-slot"));
    const supported = await cli(owner, ["task", "support", task.taskId, "--space", "qa", "--desc", "independent support slot", "--request-id", "support.own.parameters", "--parameters", JSON.stringify({slot:"support-slot", defer:true}), "Check the separate supporting candidate"]);
    t.assertions.assert(supported.code === 0, supported.err);
    const support = JSON.parse(supported.out.trim().split("\n").at(-1)!).collaborator;
    await idle(support);
    const bound = await cli(support, ["task", "bind-directory", task.taskId, "--directory", join(r.root, "support-slot")]);
    t.assertions.assert(bound.code === 0 && JSON.parse(bound.out.trim().split("\n").at(-1)!).directory === join(r.root, "support-slot") && existsSync(join(r.root,"support-slot/prepared")),
      "deferred support resource used the parent parameters or stole its directory: " + bound.err);
    r.ok(["tick"]);
    const update = JSON.parse(readFileSync(r.state("platform-check.json"), "utf8"));
    t.assertions.assert(update.status === "available" && update.sourcePath === r.source && update.appliedDigest !== update.availableDigest && !existsSync(join(r.root, ".git")), "deployed update check did not report the intentional timer patch from the read-only unique source: " + JSON.stringify(update));
    const catalog = await r.client.call({type:"workspace.list"});
    t.assertions.assert(catalog?.type === "workspaces" && !catalog.data.some(s => s.root === r.source), "offline definition source was registered as another running Team");
    rmSync(r.source, {recursive:true});
    write(join(r.root, "accepted"), "QA passed"); write(join(r.root, "slot/dirty"), "uncommitted work");
    const supportDone = await cli(support, ["task", "finish", task.taskId, "--outcome", "success", "Independent support accepted"]);
    t.assertions.assert(supportDone.code === 0, supportDone.err);
    r.ok(["tick"]); await idle(owner);
    const finished = await cli(owner, ["task", "finish", task.taskId, "--outcome", "success", "QA accepted"]);
    t.assertions.assert(finished.code === 0, finished.err);
    r.ok(["tick"]); await idle(front);
    const ledger = JSON.parse(readFileSync(r.state("tasks", task.taskId + ".json"), "utf8"));
    const lease = ledger.executionBinding?.lock;
    t.assertions.assert(lease && existsSync(lease) && existsSync(r.state("done", owner + ".json")), "business hold either freed the writer or prevented result settlement");
    // Consume the result through the public inbox, then let a later timer
    // release the original lease. This is the lost-obligation regression.
    await cli(front, ["task", "status", task.taskId]);
    rmSync(join(r.root, "slot/dirty")); r.ok(["tick"]);
    t.assertions.assert(!existsSync(lease), "timer forgot retained resource after pending result was consumed");
    t.assertions.assert(existsSync(join(r.root, "reflection-observed")), "timer bypassed configured ReflectionPolicy");
    r.ok(["board", "refresh"]);
    const board = JSON.parse(readFileSync(join(r.root, "datas/board/live.json"), "utf8"));
    t.assertions.assert(board.projectSections[0].text === "QA <required>", "board bypassed configured presenter/settings");
    const live = join(r.root, "datas/board/live.json"), good = readFileSync(live, "utf8");
    write(join(r.root, "broken-board"), "invalid project output");
    const invalid = r.command(["board", "refresh"]);
    t.assertions.assert(invalid.code !== 0 && invalid.err.includes("BoardPresenter.sections") && readFileSync(live, "utf8") === good,
      "invalid project section replaced the last good native board snapshot");
  } finally { await r.dispose(); }
});
