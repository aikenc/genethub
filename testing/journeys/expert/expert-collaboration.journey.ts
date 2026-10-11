// An expert is a Space tree plus one script. This journey builds a real one from the shipped template with
// the shipped SpaceBuilder, starts the shipped daemon, and then plays the front desk's part: it runs
// `tools/expert.py` the way an Agent's shell would. The daemon's timer runs the same script's `hook`, which
// is the thing that notices a background session finished and tells the front. Sessions use the script
// Agent fixture, so no model is involved and the whole path is deterministic.
//
//   - `spawn` starts a labelled, described work session under the expert's work Space;
//   - the timer hook reports its result to the front exactly once, and the pending record is closed;
//   - `send EXPERT:default` creates the default thinking session once and queues into it afterwards;
//   - `directory` lists the sessions with their descriptions; `mount` claims a directory for one expert only.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  defineJourney,
  genetEnv,
  hideHostAgentClis,
  locateGenet,
  registerControlledAgent,
  seedScriptAgentRuntime,
} from "../../framework/public.ts";

const TEMPLATE = "apps/daemon/builtin-skills/genehub/references/expert-template";
const BUILDER = "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py";

type Info = { id: string; name: string; agentSpace?: { parentWorkspaceId?: string } };
type Item = { type?: string; text?: string; system?: boolean };

defineJourney(
  {
    id: "journey.expert.collaboration",
    title: "an expert's front is told, once, when a background session it started has finished",
    oracle:
      "spawn creates a labelled work session; within seconds the front's timeline holds one result notice carrying the work session's reply; the pending record moves to done; the default thinking session is created once and reused; mount refuses a directory another expert owns",
    catches: [
      "a finished background session the front is never told about",
      "the same result delivered twice after a timer re-run",
      "a second default thinking session on every send",
      "two experts both owning one business directory",
      "the template, SpaceBuilder, hook and script not working together",
    ],
    tags: ["core", "expert", "daemon", "spacebuilder"],
    llm: { default: "none" },
    expectedDurationMs: 40_000,
    timeoutMs: 240_000,
    surfaces: ["daemon", "spacebuilder", "genet-cli", "script-agent", "timer-hook"],
    productInterfaces: ["tools/expert.py", "genet hook list", "session.send --queue"],
  },
  async (t) => {
    hideHostAgentClis(t.env);
    seedScriptAgentRuntime(t.env);
    registerControlledAgent(t.env, { profile: "normal", id: "ctl-normal", chunks: 2 });

    // Two experts from the template: alice does the work, bob only exists to contest a directory.
    const build = (name: string): string => {
      const dir = path.join(t.env.data, "spaces", name);
      cpSync(path.join(t.openRoot, TEMPLATE), dir, { recursive: true });
      const descriptorPath = path.join(dir, "agent-space.genet.json");
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
      descriptor.name = name;
      writeFileSync(descriptorPath, JSON.stringify(descriptor));
      const hookPath = path.join(dir, "skills/expert-front/hooks/timer.genet.json");
      writeFileSync(hookPath, JSON.stringify({ ...JSON.parse(readFileSync(hookPath, "utf8")), every: "1s" }));
      mkdirSync(path.join(dir, ".genethub"), { recursive: true });
      writeFileSync(path.join(dir, ".genethub", "open.env"), "EXPERT_AGENT=ctl-normal\n");
      const built = spawnSync("python3", [path.join(t.openRoot, BUILDER), "build", dir, "--format", "json"], { encoding: "utf8" });
      t.assertions.assert(built.status === 0, `SpaceBuilder build ${name}: ${built.stdout.slice(-500)}`);
      return dir;
    };
    const alice = build("alice");
    const bob = build("bob");

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const spaces = async (): Promise<Info[]> => {
        const reply = await opened.client.call({ type: "workspace.list" });
        if (reply?.type !== "workspaces") throw new Error(`workspace.list returned ${reply?.type}`);
        return reply.data as unknown as Info[];
      };
      const listed = await spaces();
      const root = listed.find((space) => space.name === "alice");
      t.assertions.assert(root, `alice is not registered: ${JSON.stringify(listed.map((s) => s.name))}`);
      const sessionsOf = async (workspaceId: string) => {
        const reply = await opened.client.call({ type: "session.list", payload: { workspaceId, includeArchived: false } });
        if (reply?.type !== "sessions") throw new Error(`session.list returned ${reply?.type}`);
        return reply.data as unknown as Array<{ id: string; labels?: string[]; description?: string }>;
      };
      const itemsOf = async (sessionId: string): Promise<Item[]> => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
        if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
        return (reply.data as unknown as { items: Item[] }).items;
      };

      // The front: an ordinary session, created by the person, in the expert's root Space.
      const created = await opened.client.call({
        type: "session.create",
        payload: { workspaceId: root!.id, agentId: "ctl-normal", modelId: null, modeId: null, title: "front", cwd: null },
      });
      if (created?.type !== "session") throw new Error(`session.create returned ${created?.type}`);
      const front = (created.data as unknown as { id: string }).id;

      // What an Agent's shell has: the CLI binding, and the lease's own daemon.
      const genet = locateGenet(t.openRoot);
      const env = { ...genetEnv(t.openRoot, { ...t.env.env, GENEHUB_LOCAL_DATA_DIR: t.env.data }), GENEHUB_CLI: genet };
      const expert = (dir: string, ...args: string[]) => {
        const done = spawnSync("python3", [path.join(dir, "tools", "expert.py"), ...args], { cwd: path.join(dir, "front"), env, encoding: "utf8" });
        return { code: done.status ?? -1, out: done.stdout, err: done.stderr };
      };

      // 1. spawn → result reaches the front, once.
      const spawned = expert(alice, "spawn", "--kind", "work", "--desc", "write the quarterly report", "Write the quarterly report.");
      t.assertions.assert(spawned.code === 0, `spawn: ${spawned.err || spawned.out}`);
      const work = listed.find((space) => space.name === "work" && space.agentSpace?.parentWorkspaceId === root!.id);
      t.assertions.assert(work, "alice's work Space is not registered");
      const started = await sessionsOf(work!.id);
      t.assertions.assert(
        started.length === 1 && started[0]!.description === "write the quarterly report" && started[0]!.labels?.includes("工作") && started[0]!.labels?.includes("系统发起"),
        `work session ${JSON.stringify(started)}`,
      );
      // A notice a script queued is marked, so clients never show it as the person's own message.
      const resultsIn = async () =>
        (await itemsOf(front)).filter((item) => item.system === true && (item.text ?? "").includes("用途: result") && (item.text ?? "").includes("chunk-0 chunk-1"));
      t.assertions.assert(
        (await itemsOf(front)).every((item) => item.type !== "userMessage" || item.system !== true || (item.text ?? "").includes("用途:")),
        "an unexpected system-marked message",
      );
      await t.tools.waitUntil(async () => (await resultsIn()).length >= 1, 40_000);
      await new Promise((resolve) => setTimeout(resolve, 4_000)); // several more timer runs
      t.assertions.assert((await resultsIn()).length === 1, `the result was delivered ${(await resultsIn()).length} times`);
      const pending = path.join(alice, ".genethub/expert/pending");
      const done = path.join(alice, ".genethub/expert/done");
      t.assertions.assert(readdirSync(pending).length === 0 && readdirSync(done).length === 1, `pending ${readdirSync(pending)} done ${readdirSync(done)}`);
      t.assertions.assert(existsSync(path.join(alice, ".genethub/expert/alive")), "the timer never reported itself alive");

      // 2. the default thinking session is created once and then reused.
      const first = expert(alice, "send", "--to", "alice:default", "--kind", "question", "What did we learn this week?");
      t.assertions.assert(first.code === 0, `first send: ${first.err || first.out}`);
      const think = listed.find((space) => space.name === "think" && space.agentSpace?.parentWorkspaceId === root!.id)!;
      const second = expert(alice, "send", "--to", "alice:default", "--kind", "note", "One more thing.");
      t.assertions.assert(second.code === 0, `second send: ${second.err || second.out}`);
      const thinking = await sessionsOf(think.id);
      t.assertions.assert(
        thinking.length === 1 && thinking[0]!.labels?.includes("默认思考") === true,
        `default thinking sessions ${JSON.stringify(thinking)}`,
      );

      // 3. the directory shows who is who.
      const directory = expert(alice, "directory");
      t.assertions.assert(
        directory.code === 0 && directory.out.includes("write the quarterly report") && directory.out.includes("alice/work") && directory.out.includes("alice/think"),
        `directory: ${directory.out}`,
      );

      // 4. one business directory, one owner.
      const project = path.join(t.env.root, "project");
      mkdirSync(project, { recursive: true });
      spawnSync("git", ["init", "-q", project]);
      const claimed = expert(alice, "mount", project);
      t.assertions.assert(claimed.code === 0, `mount: ${claimed.err || claimed.out}`);
      t.assertions.assert(readFileSync(path.join(alice, ".genethub/open.env"), "utf8").includes(`PROJECT_DIRS=${realpath(project)}`), "open.env has no PROJECT_DIRS");
      const contested = expert(bob, "mount", project);
      t.assertions.assert(contested.code !== 0 && contested.err.includes("alice") && contested.err.includes("下一步"), `bob mounted alice's directory: ${contested.out} ${contested.err}`);
      t.assertions.assert(expert(alice, "unmount", project).code === 0, "unmount");
      t.assertions.assert(expert(bob, "mount", project).code === 0, "bob could not take the directory alice released");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

function realpath(dir: string): string {
  return spawnSync("realpath", [dir], { encoding: "utf8" }).stdout.trim();
}
