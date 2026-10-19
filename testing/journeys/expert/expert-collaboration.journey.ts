// An expert is a Space tree plus one script. This journey builds `alice` from the shipped template with
// the shipped SpaceBuilder, starts the shipped daemon, uses `expert.py init` to create a second expert `bob`
// on the live daemon, and then plays the front desk's part: it runs `tools/expert.py` the way an Agent's
// shell would. The daemon's timer runs the same script's `hook`, which notices when background sessions
// finish and delivers results. Sessions use the script Agent fixture, so no model is involved and the whole
// path is deterministic.
//
//   - `init` creates a new expert from the template, preserves soul.md anchors, initializes git main/platform,
//     compiles identity, and opens all four Spaces on the daemon;
//   - `spawn` starts a labelled, described work session under the expert's work Space, and the timer hook
//     reports its result to the front exactly once;
//   - two jobs spawned in one turn each reach the front exactly once, and a cross-expert job's result comes
//     back the same asynchronous way;
//   - writer lock prevents two concurrent `work` sessions on the same `--dir` while allowing `research`;
//   - `send --to <expert>:work` starts/routes cross-expert collaboration and delivers the reply back to the caller;
//   - `note` is only a file (including `--expert bob`), `directory` lists sessions, and `mount`/`unmount`
//     enforces single-expert ownership and warns on a dirty worktree.

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

const TEMPLATE = "apps/daemon/builtin-skills/genehub/references/team-template";
const BUILDER = "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py";

type Info = { id: string; name: string; agentSpace?: { parentWorkspaceId?: string } };
type Item = { type?: string; text?: string; system?: boolean; origin?: { sessionId?: string } };
const isSystem = (item: Item): boolean => item.system === true || item.origin?.sessionId === "system" || (item.text ?? "").startsWith("用途: ");

defineJourney(
  {
    id: "journey.expert.collaboration",
    title: "an expert initializes peers, delegates work asynchronously, enforces writer locks, and collaborates across experts",
    oracle:
      "init creates bob with soul.md anchors, git branches and four registered Spaces; spawn creates a labelled work session whose result reaches the front once; two jobs spawned in one turn each reach the front exactly once and leave pending/ empty; a second work session on the same --dir is refused while research is allowed; send --to bob:work starts a cross-expert session and delivers its reply back; note writes once without starting sessions; mount enforces exclusive ownership and warns on dirty git state",
    catches: [
      "expert.py init failing to register child Spaces or clobbering soul.md anchors",
      "a finished background session the front is never told about, or told twice",
      "two jobs from one turn collapsing into one delivery or being delivered twice",
      "two work sessions simultaneously writing the same business directory",
      "cross-expert send failing to start a session or failing to route the reply back",
      "two experts both owning one business directory",
    ],
    tags: ["core", "expert", "daemon", "spacebuilder"],
    llm: { default: "none" },
    expectedDurationMs: 50_000,
    timeoutMs: 240_000,
    surfaces: ["daemon", "spacebuilder", "genet-cli", "script-agent", "timer-hook"],
    productInterfaces: ["tools/expert.py", "genet hook list", "session.send --message-id"],
  },
  async (t) => {
    hideHostAgentClis(t.env);
    seedScriptAgentRuntime(t.env);
    registerControlledAgent(t.env, { profile: "normal", id: "ctl-normal", chunks: 2 });
    registerControlledAgent(t.env, { profile: "accept-then-silent", id: "ctl-silent", chunks: 2 });

    const alice = path.join(t.env.data, "spaces", "alice");
    cpSync(path.join(t.openRoot, TEMPLATE), alice, { recursive: true });
    const descriptorPath = path.join(alice, "agent-space.genet.json");
    writeFileSync(descriptorPath, JSON.stringify({ ...JSON.parse(readFileSync(descriptorPath, "utf8")), name: "alice" }));
    const hookPath = path.join(alice, "skills/expert-front/hooks/timer.genet.json");
    writeFileSync(hookPath, JSON.stringify({ ...JSON.parse(readFileSync(hookPath, "utf8")), every: "1s" }));
    mkdirSync(path.join(alice, ".genethub"), { recursive: true });
    writeFileSync(path.join(alice, ".genethub", "open.env"), "EXPERT_AGENT=ctl-normal\nEXPERT_BOARD_PORT=0\nEXPERT_WAKE_ROUNDS=100000\nEXPERT_NOTE_QUIET=100000\n");
    const built = spawnSync("python3", [path.join(t.openRoot, BUILDER), "build", alice, "--format", "json"], { encoding: "utf8" });
    t.assertions.assert(built.status === 0, `SpaceBuilder build alice: ${built.stdout.slice(-500)}`);

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const spaces = async (): Promise<Info[]> => {
        const reply = await opened.client.call({ type: "workspace.list" });
        if (reply?.type !== "workspaces") throw new Error(`workspace.list returned ${reply?.type}`);
        return reply.data as unknown as Info[];
      };
      let listed = await spaces();
      const root = listed.find((space) => space.name === "alice");
      t.assertions.assert(root, `alice is not registered: ${JSON.stringify(listed.map((s) => s.name))}`);
      const sessionsOf = async (workspaceId: string) => {
        const reply = await opened.client.call({ type: "session.list", payload: { workspaceId, includeArchived: false } });
        if (reply?.type !== "sessions") throw new Error(`session.list returned ${reply?.type}`);
        return reply.data as unknown as Array<{ id: string; title?: string; labels?: string[]; description?: string; status?: string }>;
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
      const env = {
        ...genetEnv(t.openRoot, { ...t.env.env, GENEHUB_LOCAL_DATA_DIR: t.env.data }),
        GENEHUB_CLI: genet,
        EXPERT_TEMPLATE: path.join(t.openRoot, TEMPLATE),
        EXPERT_SPACEBUILDER: path.join(t.openRoot, BUILDER),
      };
      const expert = (dir: string, ...args: string[]) => {
        const done = spawnSync("python3", [path.join(dir, "tools", "expert.py"), ...args], {
          cwd: path.join(dir, "front"),
          env: { ...env, GENEHUB_SESSION_ID: front },
          encoding: "utf8",
        });
        return { code: done.status ?? -1, out: done.stdout, err: done.stderr };
      };

      // 0. J1: `expert.py init` creates `bob` from the template, preserves soul.md anchors, initializes git, and opens its 4 Spaces.
      const inited = expert(alice, "init", "bob", "--desc", "QA与协作专家", "--soul", "负责跨专家验收与回合制回归验证");
      t.assertions.assert(inited.code === 0 && inited.out.includes("已创建并初始化专家 bob") && inited.out.includes("已打开空间"), `init bob: ${inited.out} ${inited.err}`);
      const bob = path.join(t.env.data, "spaces", "bob");
      writeFileSync(path.join(bob, ".genethub", "open.env"), "EXPERT_AGENT=ctl-normal\nEXPERT_BOARD_PORT=0\nEXPERT_WAKE_ROUNDS=100000\nEXPERT_NOTE_QUIET=100000\n");
      const bobSoul = readFileSync(path.join(bob, "soul.md"), "utf8");
      t.assertions.assert(
        bobSoul.includes("我做的一切只有一个目的：让用户满意") && bobSoul.includes("## 我是谁（bob）") && bobSoul.includes("负责跨专家验收与回合制回归验证") && bobSoul.includes("（以下由反思会话按证据维护"),
        `bob soul.md: ${bobSoul}`,
      );
      t.assertions.assert(existsSync(path.join(bob, ".git")) && existsSync(path.join(bob, "front", "AGENTS.md")), "bob git or AGENTS.md missing after init");
      listed = await spaces();
      const bobRoot = listed.find((space) => space.name === "bob");
      t.assertions.assert(bobRoot !== undefined, `bob root not registered: ${JSON.stringify(listed.map((s) => s.name))}`);
      for (const child of ["leader", "qa", "research", "team-reflect"]) {
        t.assertions.assert(
          listed.some((space) => space.name === child && space.agentSpace?.parentWorkspaceId === bobRoot!.id),
          `bob/${child} not registered after init`,
        );
      }

      // 1. Asynchronous `spawn` → result reaches the front via timer hook, once.
      const spawned = expert(alice, "spawn", "--kind", "work", "--desc", "write the quarterly report", "Write the quarterly report.");
      t.assertions.assert(spawned.code === 0, `spawn: ${spawned.err || spawned.out}`);
      const work = listed.find((space) => space.name === "leader" && space.agentSpace?.parentWorkspaceId === root!.id);
      t.assertions.assert(work, "alice's work Space is not registered");
      const started = await sessionsOf(work!.id);
      t.assertions.assert(
        started.length === 1 && started[0]!.description === "write the quarterly report" && started[0]!.title === "write the quarterly report" && started[0]!.labels?.includes("组长") && started[0]!.labels?.includes("系统发起"),
        `work session ${JSON.stringify(started)}`,
      );
      const resultsIn = async () =>
        (await itemsOf(front)).filter((item) => isSystem(item) && (item.text ?? "").includes("用途: result") && (item.text ?? "").includes("chunk-0 chunk-1"));
      t.assertions.assert(
        (await itemsOf(front)).every((item) => item.type !== "userMessage" || !isSystem(item) || (item.text ?? "").includes("用途:")),
        "an unexpected system-marked message",
      );
      await t.tools.waitUntil(async () => (await resultsIn()).length >= 1, 40_000);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      t.assertions.assert((await resultsIn()).length === 1, `the result was delivered ${(await resultsIn()).length} times`);
      const pending = path.join(alice, ".genethub/team/pending");
      const done = path.join(alice, ".genethub/team/done");
      t.assertions.assert(readdirSync(pending).length === 0 && readdirSync(done).length === 1, `pending ${readdirSync(pending)} done ${readdirSync(done)}`);
      t.assertions.assert(existsSync(path.join(alice, ".genethub/team/alive")), "the timer never reported itself alive");

      // 2. Two jobs from one turn: each result reaches the front exactly once and `pending/` ends empty.
      const resultsFor = async (sid: string) =>
        (await itemsOf(front)).filter(
          (item) => isSystem(item) && (item.text ?? "").includes("用途: result") && (item.text ?? "").includes(sid) && (item.text ?? "").includes("chunk-0 chunk-1"),
        );
      const spawnedA = expert(alice, "spawn", "--kind", "work", "--desc", "first async job", "Run job A.");
      const sidA = /(s_[0-9a-f]+)/.exec(spawnedA.out)?.[1];
      const spawnedB = expert(alice, "spawn", "--kind", "research", "--desc", "second async job", "Run job B.");
      const sidB = /(s_[0-9a-f]+)/.exec(spawnedB.out)?.[1];
      t.assertions.assert(sidA && sidB && sidA !== sidB, `two jobs: ${spawnedA.out} ${spawnedA.err} | ${spawnedB.out} ${spawnedB.err}`);
      const bothArrived = await t.tools
        .waitUntil(async () => (await resultsFor(sidA!)).length >= 1 && (await resultsFor(sidB!)).length >= 1, 60_000)
        .then(() => true)
        .catch(() => false);
      t.assertions.assert(
        bothArrived,
        `both jobs never reported back: A=${(await resultsFor(sidA!)).length} B=${(await resultsFor(sidB!)).length}; ` +
          `pending=${readdirSync(pending).join(",")}; front=${JSON.stringify((await itemsOf(front)).map((item) => (item.text ?? "").slice(0, 200)))}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      t.assertions.assert(
        (await resultsFor(sidA!)).length === 1 && (await resultsFor(sidB!)).length === 1,
        `delivered A=${(await resultsFor(sidA!)).length} B=${(await resultsFor(sidB!)).length} times`,
      );
      t.assertions.assert(readdirSync(pending).length === 0, `pending not cleared: ${readdirSync(pending)}`);

      // 3. Cross-expert collaboration (J8): `send --to bob:work` starts a session in bob and routes the reply back to alice's front.
      const crossSent = expert(alice, "send", "--to", "bob:work", "--kind", "task", "请对裂谷防线执行QA验收");
      const bobSid = /(s_[0-9a-f]+)/.exec(crossSent.out)?.[1];
      t.assertions.assert(crossSent.code === 0 && bobSid !== undefined && crossSent.out.includes("已为 bob:work 启动会话并投递"), `send to bob:work: ${crossSent.out} ${crossSent.err}`);
      const crossResults = async () => (await itemsOf(front)).filter((item) => isSystem(item) && (item.text ?? "").includes(bobSid!) && (item.text ?? "").includes("chunk-0 chunk-1"));
      const crossArrived = await t.tools
        .waitUntil(async () => (await crossResults()).length >= 1, 40_000)
        .then(() => true)
        .catch(() => false);
      t.assertions.assert(
        crossArrived,
        `the cross-expert result never reached the front: pending=${readdirSync(pending).join(",")} done=${readdirSync(done).join(",")} ` +
          `front=${JSON.stringify((await itemsOf(front)).map((item) => (item.text ?? "").slice(0, 160)))}`,
      );
      t.assertions.assert((await crossResults()).length === 1, `cross-expert result delivered ${(await crossResults()).length} times`);
      const badSend = expert(alice, "send", "--to", "nonexistent-expert", "hello");
      t.assertions.assert(badSend.code !== 0 && badSend.err.includes("既不是会话 id，也不是已知专家名") && badSend.err.includes("下一步"), `send to unknown expert: ${badSend.out} ${badSend.err}`);

      // 4. Writer lock (J5).
      const project = path.join(t.env.root, "project");
      mkdirSync(project, { recursive: true });
      spawnSync("git", ["init", "-q", project]);
      writeFileSync(path.join(alice, ".genethub", "open.env"), "EXPERT_AGENT=ctl-silent\nEXPERT_BOARD_PORT=0\nEXPERT_WAKE_ROUNDS=100000\nEXPERT_NOTE_QUIET=100000\n");
      const holderSpawn = expert(alice, "spawn", "--kind", "work", "--dir", project, "--desc", "long writer", "Hold the writer lock.");
      const holderSid = /(s_[0-9a-f]+)/.exec(holderSpawn.out)?.[1]!;
      t.assertions.assert(holderSpawn.code === 0 && holderSid, `holderSpawn: ${holderSpawn.out} ${holderSpawn.err}`);
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: holderSid } });
        return reply?.type === "snapshot" && (reply.data as unknown as { summary: { status: string } }).summary.status === "running";
      }, 20_000);
      // A second `work` session on the same directory is refused while `holderSid` is running, but `research` is allowed.
      const contestedWork = expert(alice, "spawn", "--kind", "work", "--dir", project, "--desc", "second writer", "Should be refused.");
      t.assertions.assert(contestedWork.code !== 0 && contestedWork.err.includes("已有写会话") && contestedWork.err.includes(holderSid), `contested writer lock: ${contestedWork.out} ${contestedWork.err}`);
      writeFileSync(path.join(alice, ".genethub", "open.env"), "EXPERT_AGENT=ctl-normal\nEXPERT_BOARD_PORT=0\nEXPERT_WAKE_ROUNDS=100000\nEXPERT_NOTE_QUIET=100000\n");
      const allowedResearch = expert(alice, "spawn", "--kind", "research", "--dir", project, "--desc", "parallel reader", "Read-only inspection.");
      const researchSid = /(s_[0-9a-f]+)/.exec(allowedResearch.out)?.[1]!;
      t.assertions.assert(allowedResearch.code === 0 && researchSid, `research alongside writer lock failed: ${allowedResearch.err}`);
      // The silent writer holds the lock until it is interrupted; it never replies, so the batch it shares
      // with the research session is only settled once it is stopped.
      await opened.client.call({ type: "session.interrupt", payload: { sessionId: holderSid } });

      // 5. `note` is a file. It records the session, creates no session, and a note for another expert lands there.
      const noted = expert(alice, "note", "--session", front, "--kind", "preference", "--quote", "that is not what I meant", "--context", "opened a read-only review as work");
      t.assertions.assert(noted.code === 0 && noted.out.includes("已留言"), `note: ${noted.err || noted.out}`);
      const ownNotes = readdirSync(path.join(alice, ".genethub/team/notes"));
      const ownNote = JSON.parse(readFileSync(path.join(alice, ".genethub/team/notes", ownNotes[0]!), "utf8"));
      t.assertions.assert(ownNotes.length === 1 && ownNote.session === front && ownNote.kind === "preference" && ownNote.quote === "that is not what I meant", `own note ${JSON.stringify(ownNote)}`);
      t.assertions.assert(expert(alice, "note", "--session", front, "--kind", "preference", "--quote", "that is not what I meant", "--context", "opened a read-only review as work").out.includes("记过了"), "the same note was written twice");
      const toBob = expert(alice, "note", "--session", front, "--expert", "bob", "please look at the review habit");
      t.assertions.assert(toBob.code === 0, `note --expert: ${toBob.err || toBob.out}`);
      const bobNotes = readdirSync(path.join(bob, ".genethub/team/notes"));
      const bobRead = bobNotes.map((file) => JSON.parse(readFileSync(path.join(bob, ".genethub/team/notes", file), "utf8")) as { from?: string; kind?: string; context?: string });
      const fromAlice = bobRead.filter((note) => note.from === "alice");
      t.assertions.assert(
        fromAlice.length === 1 && fromAlice[0]!.context === "please look at the review habit",
        `the note for bob did not land there exactly once: ${JSON.stringify(bobRead)}`,
      );
      const reflectSpace = listed.find((entry) => entry.name === "team-reflect" && entry.agentSpace?.parentWorkspaceId === root!.id)!;
      t.assertions.assert((await sessionsOf(reflectSpace.id)).length === 0, "a note created a reflect session");

      // 6. `directory` shows who is who.
      const directory = expert(alice, "directory");
      t.assertions.assert(
        directory.code === 0 && directory.out.includes("write the quarterly report") && directory.out.includes("alice/leader") && directory.out.includes("alice/root") && directory.out.includes("bob/leader"),
        `directory: ${directory.out}`,
      );

      // 7. One business directory, one owner, plus dirty worktree warning (J3).
      writeFileSync(path.join(project, "untracked.txt"), "dirty");
      const claimed = expert(alice, "mount", project);
      t.assertions.assert(claimed.code === 0 && claimed.out.includes("注意: 有 1 个未提交或未跟踪的文件"), `mount with dirty file: ${claimed.err || claimed.out}`);
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
