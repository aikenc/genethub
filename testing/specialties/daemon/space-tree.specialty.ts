// A Space tree is a directory with `agent-space.genet.json` files, nothing more.
// A script (or a person) lays one down under `<data>/spaces/`, and the daemon
// has to treat it as the project it describes: the child Spaces are registered
// under their parent, a session starts where the descriptor says (`agentCwd`)
// and not at the root, and a session that another session started is marked so
// the default conversation list can leave it out. These cases drive the shipped
// daemon; only the LLM endpoint is replaced.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  defineSpecialty,
  hideHostAgentClis,
  seedScriptAgentRuntime,
  type CaseContext,
} from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

const DESCRIPTOR = "agent-space.genet.json";

function lay(dir: string, descriptor: Record<string, unknown> | string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, DESCRIPTOR), typeof descriptor === "string" ? descriptor : JSON.stringify(descriptor));
}

/** admin (agentCwd front) with think and work children, and a broken sibling. */
function layTree(data: string): { admin: string; think: string; work: string } {
  const admin = path.join(data, "spaces", "tree-fixture");
  lay(admin, { name: "admin", description: "the machine's expert", tags: ["expert"], agentCwd: "front" });
  mkdirSync(path.join(admin, "front"), { recursive: true });
  lay(path.join(admin, "spaces", "think"), { name: "think" });
  lay(path.join(admin, "spaces", "work"), { name: "work" });
  lay(path.join(data, "spaces", "broken"), "{");
  return { admin, think: path.join(admin, "spaces", "think"), work: path.join(admin, "spaces", "work") };
}

type Info = { id: string; name: string; root?: string; folders?: Array<{ path: string }>; agentSpace?: { parentWorkspaceId?: string } };

async function workspaces(opened: Opened): Promise<Info[]> {
  const reply = await opened.client.call({ type: "workspace.list" });
  if (reply?.type !== "workspaces") throw new Error(`workspace.list returned ${reply?.type}`);
  return reply.data as unknown as Info[];
}

const byPath = (list: Info[], dir: string): Info | undefined =>
  list.find((w) => (w.folders?.[0]?.path ?? w.root) === dir);

async function create(opened: Opened, workspaceId: string): Promise<{ id: string; labels?: string[] }> {
  const reply = await opened.client.call({
    type: "session.create",
    payload: { workspaceId, agentId: "genet", modelId: "deepseek/deepseek-v4-flash", modeId: null, title: null, cwd: null },
  });
  if (reply?.type !== "session") throw new Error(`session.create returned ${reply?.type}`);
  return reply.data as unknown as { id: string; labels?: string[] };
}

/** Where the session's own shell starts: the summary has no cwd, so ask the shell. */
async function startingDirectory(t: CaseContext, opened: Opened, sessionId: string, out: string): Promise<string> {
  opened.mock.script({ tool: { name: "bash", arguments: { command: `pwd -P > '${out}'` } } }, { text: "done" });
  await t.flows.main.sendPrompt(opened.client, sessionId, "where are you", null, "u_" + randomBytes(16).toString("hex"));
  await t.tools.waitUntil(async () => existsSync(out) && readFileSync(out, "utf8").trim() !== "", 30_000);
  return readFileSync(out, "utf8").trim();
}

function treeCase(
  name: string,
  title: string,
  oracle: string,
  catches: string[],
  run: (t: CaseContext, opened: Opened, tree: ReturnType<typeof layTree>) => Promise<void>,
): void {
  defineSpecialty(
    {
      id: `specialty.daemon.space-tree.${name}`,
      title,
      oracle,
      catches,
      tags: ["core", "daemon", "space-tree"],
      llm: { default: "mock" },
      expectedDurationMs: 25_000,
      timeoutMs: 120_000,
      resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
      surfaces: ["daemon", "builtin-agent", "genet-cli"],
      productInterfaces: ["workspace.list", "session.create", "genet agent run"],
    },
    async (t) => {
      hideHostAgentClis(t.env);
      seedScriptAgentRuntime(t.env);
      const tree = layTree(t.env.data);
      const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
      try {
        await t.flows.main.configureMockProvider(opened.client, opened.mock);
        await run(t, opened, tree);
      } finally {
        opened.client.close();
        opened.daemon.stop();
        await opened.mock.stop();
      }
    },
  );
}

treeCase(
  "registers-children-and-honours-agent-cwd",
  "a Space tree laid under the data directory is registered under its parent and sessions start in agentCwd",
  "after the daemon starts, workspace.list holds admin, think and work with think and work pointing at admin; a session created with no cwd starts in admin/front, in think it starts at its root; a broken descriptor creates nothing and does not stop the others",
  [
    "children registered with no parent, so they show up as primary projects",
    "a session starting at the root of a Space whose descriptor names agentCwd",
    "one unreadable descriptor hiding every other Space",
  ],
  async (t, opened, tree) => {
    const list = await workspaces(opened);
    const admin = byPath(list, tree.admin);
    const think = byPath(list, tree.think);
    const work = byPath(list, tree.work);
    t.assertions.assert(admin && think && work, `Spaces not registered: ${JSON.stringify(list.map((w) => [w.name, w.folders?.[0]?.path ?? w.root]))}`);
    t.assertions.assert(admin!.agentSpace?.parentWorkspaceId === undefined, "the root must have no parent");
    t.assertions.assert(
      think!.agentSpace?.parentWorkspaceId === admin!.id && work!.agentSpace?.parentWorkspaceId === admin!.id,
      `children must point at admin: ${JSON.stringify([think, work])}`,
    );
    t.assertions.assert(!byPath(list, path.join(path.dirname(tree.admin), "broken")), "a broken descriptor registered something");
    const inAdmin = await create(opened, admin!.id);
    const adminCwd = await startingDirectory(t, opened, inAdmin.id, path.join(t.env.root, "admin.cwd"));
    t.assertions.assert(adminCwd === realpathSync(path.join(tree.admin, "front")), `admin session cwd ${adminCwd}`);
    const inThink = await create(opened, think!.id);
    const thinkCwd = await startingDirectory(t, opened, inThink.id, path.join(t.env.root, "think.cwd"));
    t.assertions.assert(thinkCwd === realpathSync(tree.think), `think session cwd ${thinkCwd}`);
    t.assertions.assert(!inAdmin.labels?.includes("系统发起"), "a session the user started must not carry the system label");
  },
);

treeCase(
  "marks-sessions-that-a-session-started",
  "a session started by another session is labelled, one started by a person is not",
  "a built-in Agent runs `genet agent run --workspace <child>` from its own shell; the session that appears carries 系统发起 and the Agent's own session does not",
  [
    "sessions an expert starts for its work crowding the person's conversation list",
    "the person's own session being labelled as system-started",
  ],
  async (t, opened, tree) => {
    const list = await workspaces(opened);
    const admin = byPath(list, tree.admin)!;
    const think = byPath(list, tree.think)!;
    const parent = await create(opened, admin.id);
    const command = `"$GENEHUB_CLI" agent run --agent genet --workspace ${think.id} --no-wait "hello"`;
    opened.mock.script({ tool: { name: "bash", arguments: { command } } }, { text: "started" }, { text: "ok" });
    await t.flows.main.sendPrompt(opened.client, parent.id, "start a child session", null, "u_" + randomBytes(16).toString("hex"));
    const children = async () => {
      const reply = await opened.client.call({ type: "session.list", payload: { workspaceId: think.id, includeArchived: false } });
      if (reply?.type !== "sessions") throw new Error(`session.list returned ${reply?.type}`);
      return reply.data as unknown as Array<{ id: string; labels?: string[] }>;
    };
    await t.tools.waitUntil(async () => (await children()).length > 0, 30_000);
    const started = (await children())[0]!;
    t.assertions.assert(started.labels?.includes("系统发起") === true, `child labels ${JSON.stringify(started.labels)}`);
    const all = await opened.client.call({ type: "session.list", payload: { workspaceId: admin.id, includeArchived: false } });
    const mine = (all?.type === "sessions" ? (all.data as unknown as Array<{ id: string; labels?: string[] }>) : []).find((s) => s.id === parent.id);
    t.assertions.assert(mine && !mine.labels?.includes("系统发起"), "the parent session must not be labelled");
  },
);
