// The reflect session, end to end, with the shipped daemon, template, SpaceBuilder and timer hook. The front desk is
// an ordinary session that a person talks to; the timer (every second here) counts the person's rounds and the notes
// and starts the reflect session in its own Space when it should. Sessions use the script Agent fixture, so no model
// is involved. What is proven here is the whole path; the thresholds and edge cases are proven, with a fake CLI, by
// specialty.daemon.expert-reflect-wake.
//
//   - two rounds start nothing; the third starts exactly one reflect session, labelled and described, whose first
//     message points at a briefing file; when it finishes the front is NOT told (the reflect session speaks through
//     tell-user only when it has something to say);
//   - a note records the id of the user message of the front's newest round, and wakes the next reflect session
//     after the gap, whose briefing names the note;
//   - `reflect now` starts one at once, and its result reaches the front exactly once;
//   - the timer put the expert's own files under git, with a platform branch.

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
type Item = { id?: string; type?: string; text?: string; system?: boolean; origin?: { sessionId?: string } };
type Listed = { id: string; labels?: string[]; description?: string; status?: string };
const isSystem = (item: Item): boolean => item.origin?.sessionId === "system";

defineJourney(
  {
    id: "journey.expert.reflection",
    title: "an expert reflects on its own when the person has talked enough or a note is waiting, and only then",
    oracle:
      "two user rounds start no reflect session; the third starts exactly one in the reflect Space with the reflect and system labels, a first message naming a briefing file that exists, and no result notice reaches the front when it finishes; a note carries the id of the user message of the newest round and starts the next session after the gap, with the note in its briefing; `reflect now` starts one at once and its result reaches the front exactly once; the expert's root is a git repository with main and platform branches",
    catches: [
      "a reflect session that never starts, or starts for every message",
      "a note that cannot be traced to the round that caused it",
      "a routine reflect run that talks to the person every time",
      "a requested reflection whose result nobody delivers",
      "the reflect Space, its Skill and the timer not working together with the daemon",
    ],
    tags: ["core", "expert", "daemon", "spacebuilder"],
    llm: { default: "none" },
    expectedDurationMs: 90_000,
    timeoutMs: 600_000,
    surfaces: ["daemon", "spacebuilder", "genet-cli", "script-agent", "timer-hook"],
    productInterfaces: ["tools/expert.py", "genet session rounds", "genet hook list", "session.send --queue"],
  },
  async (t) => {
    hideHostAgentClis(t.env);
    seedScriptAgentRuntime(t.env);
    registerControlledAgent(t.env, { profile: "normal", id: "ctl-normal", chunks: 2 });

    const alice = path.join(t.env.data, "spaces", "alice");
    cpSync(path.join(t.openRoot, TEMPLATE), alice, { recursive: true });
    const descriptorPath = path.join(alice, "agent-space.genet.json");
    writeFileSync(descriptorPath, JSON.stringify({ ...JSON.parse(readFileSync(descriptorPath, "utf8")), name: "alice" }));
    const hookPath = path.join(alice, "skills/team-front/hooks/timer.genet.json");
    writeFileSync(hookPath, JSON.stringify({ ...JSON.parse(readFileSync(hookPath, "utf8")), every: "1s" }));
    mkdirSync(path.join(alice, ".genethub"), { recursive: true });
    writeFileSync(
      path.join(alice, ".genethub", "open.env"),
      "EXPERT_AGENT=ctl-normal\nEXPERT_BOARD_PORT=0\nEXPERT_WAKE_QUIET=2\nEXPERT_NOTE_QUIET=2\nEXPERT_WAKE_GAP=15\nEXPERT_WAKE_CHECK=1\n",
    );
    const built = spawnSync("python3", [path.join(t.openRoot, BUILDER), "build", alice, "--format", "json"], { encoding: "utf8" });
    t.assertions.assert(built.status === 0, `SpaceBuilder build: ${built.stdout.slice(-500)}`);

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const listed = await (async (): Promise<Info[]> => {
        const reply = await opened.client.call({ type: "workspace.list" });
        if (reply?.type !== "workspaces") throw new Error(`workspace.list returned ${reply?.type}`);
        return reply.data as unknown as Info[];
      })();
      const root = listed.find((space) => space.name === "alice");
      t.assertions.assert(root, `alice is not registered: ${JSON.stringify(listed.map((s) => s.name))}`);
      const reflectSpace = listed.find((space) => space.name === "team-reflect" && space.agentSpace?.parentWorkspaceId === root!.id);
      t.assertions.assert(reflectSpace, "alice's reflect Space is not registered");
      const sessionsOf = async (workspaceId: string): Promise<Listed[]> => {
        const reply = await opened.client.call({ type: "session.list", payload: { workspaceId, includeArchived: false } });
        if (reply?.type !== "sessions") throw new Error(`session.list returned ${reply?.type}`);
        return reply.data as unknown as Listed[];
      };
      const snapshot = async (sessionId: string): Promise<{ items: Item[]; summary: { status: string } }> => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
        if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
        return reply.data as unknown as { items: Item[]; summary: { status: string } };
      };
      const reflections = () => sessionsOf(reflectSpace!.id);
      // The timer ticks once a second and the host may be busy with other cases: waits are generous and say which one gave up.
      const until = async (label: string, condition: () => Promise<boolean>, ms = 120_000): Promise<void> => {
        try {
          await t.tools.waitUntil(condition, ms);
        } catch (error) {
          const notices = (await snapshot(front)).items.filter((item) => isSystem(item)).map((item) => (item.text ?? "").slice(0, 400));
          const hooks = spawnSync(genet, ["hook", "list", "--workspace", root!.id], { env, encoding: "utf8" }).stdout.slice(-1500);
          const state = ["reflect.json", "platform-check.json"].map((name) => path.join(alice, ".genethub/team", name)).filter(existsSync).map((file) => readFileSync(file, "utf8"));
          const conversation = (await snapshot(front)).items.map((item) => `${item.type}${isSystem(item) ? "(system)" : ""}:${(item.text ?? "").slice(0, 30)}`);
          const rounds = spawnSync(genet, ["session", "rounds", front], { env, encoding: "utf8" }).stdout.slice(-1500);
          throw new Error(`gave up waiting for ${label}: ${String(error)}\nsystem notices at the front: ${JSON.stringify(notices)}\nhooks: ${hooks}\nstate: ${state.join(" ")}\nrounds: ${rounds}\nconversation: ${JSON.stringify(conversation)}`);
        }
      };

      const created = await opened.client.call({
        type: "session.create",
        payload: { workspaceId: root!.id, agentId: "ctl-normal", modelId: null, modeId: null, title: "front", cwd: null },
      });
      if (created?.type !== "session") throw new Error(`session.create returned ${created?.type}`);
      const front = (created.data as unknown as { id: string }).id;
      const genet = locateGenet(t.openRoot);
      const env = { ...genetEnv(t.openRoot, { ...t.env.env, GENEHUB_LOCAL_DATA_DIR: t.env.data }), GENEHUB_CLI: genet };
      const expert = (...args: string[]) => {
        const done = spawnSync("python3", [path.join(alice, "tools", "expert.py"), ...args], { cwd: path.join(alice, "front"), env, encoding: "utf8" });
        return { code: done.status ?? -1, out: done.stdout.trim(), err: done.stderr.trim() };
      };
      const say = async (text: string): Promise<void> => {
        await t.flows.main.sendPrompt(opened.client, front, text, null, `u_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`);
        // The send is acknowledged before it is dispatched, so "idle" alone can be the state from before the message ran:
        // wait until the message is in the conversation, answered, and the session is idle again.
        await until("the front to answer", async () => {
          const view = await snapshot(front);
          const asked = view.items.findIndex((item) => item.type === "userMessage" && !isSystem(item) && item.text === text);
          return view.summary.status === "idle" && asked >= 0 && view.items.slice(asked).some((item) => item.type === "assistantMessage");
        });
      };
      const personsMessages = async () => (await snapshot(front)).items.filter((item) => item.type === "userMessage" && !isSystem(item));

      // 1. Two rounds are not enough.
      await say("你好，帮我看看这周的计划。");
      await say("再补充一点：周三要出差。");
      await new Promise((resolve) => setTimeout(resolve, 6_000)); // several timer runs, counting, and the quiet period
      t.assertions.assert((await reflections()).length === 0, `a reflect session started after two rounds: ${JSON.stringify(await reflections())}`);

      // 2. The third round starts exactly one reflect session, quietly.
      await say("好的，就这样安排。");
      await until("the first reflect session", async () => (await reflections()).length >= 1);
      const first = (await reflections())[0]!;
      t.assertions.assert(first.labels?.includes("反思") === true && first.labels.includes("系统发起") && (first.description ?? "").startsWith("反思：自上次反思以来用户发起了 3 轮对话"), `first reflect session ${JSON.stringify(first)}`);
      await until("the first reflect session to answer", async () => (await snapshot(first.id)).summary.status === "idle" && (await snapshot(first.id)).items.some((item) => item.type === "assistantMessage"));
      const prompt = (await snapshot(first.id)).items.find((item) => item.type === "userMessage")!.text ?? "";
      const briefingPath = /简报: (\S+\.md)/.exec(prompt)?.[1];
      t.assertions.assert(prompt.includes("用途: reflect") && prompt.includes("按 team-reflect 办") && briefingPath && existsSync(briefingPath), `first message: ${prompt.slice(0, 400)}`);
      t.assertions.assert(readFileSync(briefingPath!, "utf8").includes("自上次反思以来用户发起了 3 轮对话"), "the briefing does not say why");
      const results = async () => (await snapshot(front)).items.filter((item) => isSystem(item) && (item.text ?? "").includes("用途: result"));
      const done = path.join(alice, ".genethub/team/done");
      await until("the first reflect record to close", async () => existsSync(done) && readdirSync(done).length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      t.assertions.assert((await results()).length === 0, "a routine reflect run reported its result to the front");
      t.assertions.assert((await reflections()).length === 1, `a second reflect session started without a reason: ${(await reflections()).length}`);

      // 3. A note records the user message of the newest round, and wakes the next session after the gap.
      const last = (await personsMessages()).at(-1)!;
      const noted = expert("note", "--session", front, "--kind", "unhappy", "--quote", "不对，不是这个意思", "--context", "把只读的评审开成了 work");
      t.assertions.assert(noted.code === 0 && noted.out.startsWith("已留言"), `note: ${noted.err || noted.out}`);
      const notesDir = path.join(alice, ".genethub/team/notes");
      const noteFile = readdirSync(notesDir)[0]!;
      const note = JSON.parse(readFileSync(path.join(notesDir, noteFile), "utf8"));
      t.assertions.assert(note.turn?.userItemId === last.id && note.ref === `ghref:item:${front}:${last.id}`, `the note does not point at the newest user message ${last.id}: ${JSON.stringify(note)}`);
      await until("the note to start the second reflect session", async () => (await reflections()).length >= 2);
      const second = (await reflections()).find((session) => session.id !== first.id)!;
      t.assertions.assert((second.description ?? "").includes("1 条未处理的留言"), `second reflect session ${JSON.stringify(second)}`);
      const secondPrompt = (await snapshot(second.id)).items.find((item) => item.type === "userMessage")!.text ?? "";
      const secondBriefing = /简报: (\S+\.md)/.exec(secondPrompt)?.[1];
      const briefing = secondBriefing && existsSync(secondBriefing) ? readFileSync(secondBriefing, "utf8") : "";
      t.assertions.assert(briefing.includes(note.id) && briefing.includes("不对，不是这个意思") && briefing.includes(note.ref), `briefing:\n${briefing}`);
      t.assertions.assert(expert("notes", "done", note.id, "--result", "已改前台 Skill").out === "已处理 1 条留言", "notes done");

      // 4. `reflect now`: at once, whatever the gap says, and its result is delivered once.
      await until("the second reflect session to finish", async () => (await snapshot(second.id)).summary.status === "idle");
      const asked = expert("reflect", "now", "把前台分流的毛病现在就改掉");
      t.assertions.assert(asked.code === 0 && asked.out.startsWith("已开始反思会话"), `reflect now: ${asked.err || asked.out}`);
      await until("reflect now to start a session", async () => (await reflections()).length >= 3);
      await until("the requested reflection's result", async () => (await results()).length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const delivered = await results();
      t.assertions.assert(delivered.length === 1 && (delivered[0]!.text ?? "").includes("chunk-0 chunk-1"), `the requested reflection's result was delivered ${delivered.length} times`);

      // 5. The timer put the expert's files under git, with the platform branch next to main.
      const branches = spawnSync("git", ["-C", alice, "branch", "--format=%(refname:short)"], { encoding: "utf8" }).stdout.trim().split("\n").sort();
      t.assertions.assert(existsSync(path.join(alice, ".git")) && branches.includes("main"), `the expert root is not a repository on main: ${branches}`);
      const tracked = spawnSync("git", ["-C", alice, "ls-files"], { encoding: "utf8" }).stdout;
      t.assertions.assert(tracked.includes("skills/team-reflect/SKILL.md") && !tracked.includes(".genethub/"), "the repository tracks the wrong files");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
