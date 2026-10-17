// The expert with a real model: the shipped template, SpaceBuilder, daemon, timer and `tools/expert.py`, driven
// by the built-in Agent on the cheapest model the Beta channel's provider configuration offers. Nothing is
// scripted: the front reads the rules and Skills SpaceBuilder wrote under `front/`, decides for itself, and the
// background session it starts is a real model session too.
//
//   1. a trivial question is answered by the front alone, with no background session;
//   2. a task for the background is delegated with `expert.py spawn`, the work is really done, the timer
//      reports the result to the front, and the front tells the person.
//
// Cost is bounded: two tiny requests, a work task that writes one short file, and the model is the cheapest
// DeepSeek one. What the model did (calls, tokens, time) is attached to a failure message and, when
// EXPERT_REAL_METRICS_OUT names a file, written there on success.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineJourney, seedScriptAgentRuntime } from "../../framework/public.ts";

const TEMPLATE = "apps/daemon/builtin-skills/genehub/references/expert-template";
const BUILDER = "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py";
/**
 * A cheap, non-reasoning "flash" model from the Beta provider configuration. Never a Claude or GPT model: the
 * catalog's first entries are aiclick's Claude models, which an unknown id silently falls back to, so every
 * session below is checked to be on exactly this model before it is given anything to do.
 */
const MODEL = "qwen/qwen3.8-flash";

type Info = { id: string; name: string; agentSpace?: { parentWorkspaceId?: string } };
type Item = {
  type?: string;
  id?: string;
  text?: string;
  message?: string;
  system?: boolean;
  origin?: { sessionId?: string };
  name?: string;
  stats?: { usage?: { llmRounds?: number; inputTokens?: number; outputTokens?: number }; durationMs?: number };
};
const isSystem = (item: Item): boolean => item.system === true || item.origin?.sessionId === "system" || (item.text ?? "").startsWith("用途: ");

defineJourney(
  {
    id: "journey.expert.real-model",
    title: "with a real cheap model the front answers simple things itself and delegates real work, and is told when it is done",
    oracle:
      "a trivial question starts no background session; a delegated task is started with expert.py spawn under the work Space with a description, the real work session writes the file, the front's timeline gets one system result notice, and the front then answers the person with the outcome",
    catches: [
      "Skills that do not make a real model use expert.py",
      "the front doing long work itself instead of delegating",
      "a real background session whose completion never reaches the front",
      "the front ignoring the system notice instead of telling the person",
    ],
    tags: ["expert", "real-model"],
    llm: { default: "real" },
    resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "real-llm" },
    expectedDurationMs: 180_000,
    timeoutMs: 600_000,
    surfaces: ["daemon", "spacebuilder", "builtin-agent", "real-model", "timer-hook"],
    productInterfaces: ["tools/expert.py", "session.send", "session.get"],
  },
  async (t) => {
    t.flows.main.seedHostBetaProviders(t.env);
    seedScriptAgentRuntime(t.env);

    const alice = path.join(t.env.data, "spaces", "alice");
    cpSync(path.join(t.openRoot, TEMPLATE), alice, { recursive: true });
    const descriptorPath = path.join(alice, "agent-space.genet.json");
    writeFileSync(descriptorPath, JSON.stringify({ ...JSON.parse(readFileSync(descriptorPath, "utf8")), name: "alice", agents: ["codex"] }));
    for (const child of ["research", "work", "reflect"]) {
      const file = path.join(alice, "spaces", child, "agent-space.genet.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), agents: ["codex"] }));
    }
    const hookPath = path.join(alice, "skills/expert-front/hooks/timer.genet.json");
    writeFileSync(hookPath, JSON.stringify({ ...JSON.parse(readFileSync(hookPath, "utf8")), every: "2s" }));
    mkdirSync(path.join(alice, ".genethub"), { recursive: true });
    writeFileSync(
      path.join(alice, ".genethub", "open.env"),
      `EXPERT_AGENT=genet\nEXPERT_MODEL_WORK=${MODEL}\nEXPERT_MODEL_RESEARCH=${MODEL}\nEXPERT_MODEL_REFLECT=${MODEL}\nEXPERT_WAKE_ROUNDS=100000\nEXPERT_NOTE_QUIET=100000\n`,
    );
    const built = spawnSync("python3", [path.join(t.openRoot, BUILDER), "build", alice, "--format", "json"], { encoding: "utf8" });
    t.assertions.assert(built.status === 0, `SpaceBuilder build: ${built.stdout.slice(-500)}`);

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const listReply = await opened.client.call({ type: "workspace.list" });
      if (listReply?.type !== "workspaces") throw new Error(`workspace.list returned ${listReply?.type}`);
      const spaces = listReply.data as unknown as Info[];
      const root = spaces.find((space) => space.name === "alice")!;
      const work = spaces.find((space) => space.name === "work" && space.agentSpace?.parentWorkspaceId === root?.id)!;
      t.assertions.assert(root && work, "alice is not registered with its work Space");

      const sessionsOf = async (workspaceId: string) => {
        const reply = await opened.client.call({ type: "session.list", payload: { workspaceId, includeArchived: false } });
        if (reply?.type !== "sessions") throw new Error(`session.list returned ${reply?.type}`);
        return reply.data as unknown as Array<{ id: string; labels?: string[]; description?: string; status: string }>;
      };
      const snapshot = async (sessionId: string) => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
        if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
        return reply.data as unknown as { items: Item[]; summary: { status: string; modelId?: string | null } };
      };
      const usage = async (sessionId: string) => {
        const items = (await snapshot(sessionId)).items.filter((item) => item.type === "turnSummary");
        return items.reduce(
          (sum, item) => ({
            llmRounds: sum.llmRounds + (item.stats?.usage?.llmRounds ?? 0),
            inputTokens: sum.inputTokens + (item.stats?.usage?.inputTokens ?? 0),
            outputTokens: sum.outputTokens + (item.stats?.usage?.outputTokens ?? 0),
            turns: sum.turns + 1,
          }),
          { llmRounds: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
        );
      };
      const metrics: Record<string, unknown> = { model: MODEL };
      const fail = async (message: string, sessionIds: string[]): Promise<never> => {
        const dump: Record<string, unknown> = {};
        for (const id of sessionIds) {
          const items = (await snapshot(id)).items;
          dump[id] = items.map((item) => `${item.type}${isSystem(item) ? "(system)" : ""}: ${(item.text ?? item.message ?? item.name ?? "").slice(0, 400)}`);
        }
        throw new Error(`${message}\n${JSON.stringify({ metrics, dump }, null, 1).slice(0, 6000)}`);
      };

      // The front: an ordinary session in the expert's root Space, started where agentCwd says.
      const created = await opened.client.call({
        type: "session.create",
        payload: { workspaceId: root.id, agentId: "genet", modelId: MODEL, modeId: null, title: "front", cwd: null },
      });
      if (created?.type !== "session") throw new Error(`session.create returned ${created?.type}`);
      const front = (created.data as unknown as { id: string; modelId?: string }).id;
      const frontModel = (created.data as unknown as { modelId?: string | null }).modelId;
      if (frontModel !== MODEL) throw new Error(`the front is on ${String(frontModel)}, not ${MODEL}; refusing to spend on another model`);
      const say = async (text: string): Promise<void> => {
        await t.flows.main.sendPrompt(opened.client, front, text, null, `u_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`);
      };
      const idle = (sessionId: string) => async () => (await snapshot(sessionId)).summary.status === "idle";
      const replies = async (): Promise<string[]> =>
        (await snapshot(front)).items.filter((item) => item.type === "assistantMessage" && item.text).map((item) => item.text!);

      // 1. A trivial question: answered by the front alone.
      const started1 = Date.now();
      await say("三加四等于几？只回答数字。");
      try {
        await t.tools.waitUntil(async () => (await replies()).length >= 1, 120_000);
        await t.tools.waitUntil(idle(front), 60_000);
      } catch {
        await fail("the front gave no answer to a trivial question", [front]);
      }
      metrics.simple = { ms: Date.now() - started1, usage: await usage(front), reply: (await replies()).at(-1)?.slice(0, 80) };
      const afterSimple = (await sessionsOf(work.id)).length;
      if (afterSimple !== 0) await fail(`a trivial question started ${afterSimple} background session(s)`, [front]);
      // Whether a cheap model can add is the model's business; that it answered itself is the product's.

      // 2. A task for the background.
      const started2 = Date.now();
      await say("请安排后台的工作会话，在它的目录里创建文件 hello.txt，内容是 hi from the expert。做完告诉我结果。");
      let background: Array<{ id: string; labels?: string[]; description?: string; status: string }> = [];
      try {
        await t.tools.waitUntil(async () => (background = await sessionsOf(work.id)).length >= 1, 120_000);
      } catch {
        await fail("the front did not start a background session", [front]);
      }
      const worker = background[0]!;
      const workerModel = (await snapshot(worker.id)).summary as unknown as { modelId?: string | null };
      if (workerModel.modelId !== MODEL) await fail(`the background session is on ${String(workerModel.modelId)}, not ${MODEL}`, [front, worker.id]);
      metrics.delegated = { afterMs: Date.now() - started2, description: worker.description, labels: worker.labels, frontUsageBeforeResult: await usage(front) };
      if (!worker.description || !worker.labels?.includes("系统发起") || !worker.labels?.includes("工作")) {
        await fail(`the background session is not labelled and described by expert.py: ${JSON.stringify(worker)}`, [front, worker.id]);
      }

      const results = async () => (await snapshot(front)).items.filter((item) => isSystem(item) && (item.text ?? "").includes("用途: result"));
      try {
        await t.tools.waitUntil(async () => (await results()).length >= 1, 240_000);
      } catch {
        await fail("the finished background session was never reported to the front", [front, worker.id]);
      }
      const written = path.join(alice, "spaces", "work", "hello.txt");
      const wrote = existsSync(written) ? readFileSync(written, "utf8").trim() : null;
      metrics.work = { ms: Date.now() - started2, usage: await usage(worker.id), file: wrote };
      if (wrote === null) {
        const strays = spawnSync("find", [alice, "-name", "hello.txt", "-not", "-path", "*/skills/*"], { encoding: "utf8" }).stdout.trim();
        await fail(`the work session did not create hello.txt in its own directory (found: ${strays || "nowhere"})`, [front, worker.id]);
      }

      // The front must act on the notice, not just receive it.
      const before = (await replies()).length;
      try {
        await t.tools.waitUntil(async () => (await snapshot(front)).summary.status === "idle" && (await replies()).length > before, 120_000);
      } catch {
        await fail("the front did not answer the person after the result arrived", [front, worker.id]);
      }
      metrics.final = { totalMs: Date.now() - started2, front: await usage(front), reply: (await replies()).at(-1)?.slice(0, 200) };
      metrics.pendingLeft = readdirSync(path.join(alice, ".genethub/expert/pending"));
      // Where to keep what the model did, when the person running this wants it.
      if (process.env.EXPERT_REAL_METRICS_OUT) writeFileSync(process.env.EXPERT_REAL_METRICS_OUT, JSON.stringify(metrics, null, 1));
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
