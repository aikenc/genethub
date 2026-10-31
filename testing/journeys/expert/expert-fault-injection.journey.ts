// What the expert's timer hook does when a background session does not simply finish. Each branch of
// `tools/team.py hook` is driven by a real session that misbehaves in one named way (the script Agent
// fixture), through the shipped daemon, template and SpaceBuilder; the front must be told exactly once,
// in words that say what happened and what to do, and what cannot be delivered must say so to the caller.
//
//   waiting  a session stops at a question for the person      -> one report naming the request
//   paused   the person interrupts a running session           -> one report that it was paused
//   failed   the Agent process dies mid-turn                   -> one report that it failed
//   stuck    a running session makes no progress               -> one report after the threshold
//   gone     the session is deleted behind the hook's back     -> one report; the record is closed
//   broken   a hook file is damaged                            -> one report naming the file
//   full     the platform and local inbox reach their limits   -> bounded storage and actionable refusal

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const isSystem = (item: Item): boolean => item.origin?.sessionId === "system";

defineJourney(
  {
    id: "journey.expert.fault-injection",
    title: "the expert's timer reports each way a background session can go wrong, once, and says what to do",
    oracle:
      "waiting/interrupted/failed/stuck/deleted sessions and damaged hooks produce one system notice; a full platform queue refuses further input while the local inbox retains up to32 complete messages without claiming a platform receipt, then refuses overflow with actionable state and no change to accepted entries",
    catches: [
      "a session waiting on the person that nobody is told about",
      "a paused or failed background session that goes unnoticed",
      "a stuck session that is never flagged, or flagged on every timer run",
      "a deleted session that leaves its pending record behind forever",
      "a damaged hook file that stops all reconciliation silently",
      "a send to a full queue that fails without saying why",
    ],
    tags: ["core", "expert", "daemon", "fault-injection"],
    llm: { default: "none" },
    expectedDurationMs: 90_000,
    timeoutMs: 360_000,
    surfaces: ["daemon", "spacebuilder", "genet-cli", "script-agent", "timer-hook"],
    productInterfaces: ["tools/team.py", "genet hook list", "session.send --system"],
  },
  async (t) => {
    hideHostAgentClis(t.env);
    seedScriptAgentRuntime(t.env);
    for (const profile of ["normal", "native-question", "accept-then-silent", "exit-without-terminal"] as const) {
      registerControlledAgent(t.env, { profile, id: `ctl-${profile}`, chunks: 2 });
    }

    const alice = path.join(t.env.data, "spaces", "alice");
    cpSync(path.join(t.openRoot, TEMPLATE), alice, { recursive: true });
    const descriptorPath = path.join(alice, "agent-space.genet.json");
    writeFileSync(descriptorPath, JSON.stringify({ ...JSON.parse(readFileSync(descriptorPath, "utf8")), name: "alice" }));
    const hookPath = path.join(alice, "skills/team-front/hooks/timer.genet.json");
    writeFileSync(hookPath, JSON.stringify({ ...JSON.parse(readFileSync(hookPath, "utf8")), every: "1s" }));
    const setEnv = (agent: string, stuckAfter = 4): void =>
      writeFileSync(path.join(alice, ".genethub", "open.env"), `EXPERT_AGENT=${agent}\nEXPERT_BOARD_PORT=0\nEXPERT_STUCK_AFTER=${stuckAfter}\nEXPERT_STOPPED_AFTER=3600\n`);
    mkdirSync(path.join(alice, ".genethub"), { recursive: true });
    setEnv("ctl-normal");
    const built = spawnSync("python3", [path.join(t.openRoot, BUILDER), "build", alice, "--format", "json"], { encoding: "utf8" });
    t.assertions.assert(built.status === 0, `SpaceBuilder build: ${built.stdout.slice(-500)}`);

    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const listed = (async () => {
        const reply = await opened.client.call({ type: "workspace.list" });
        if (reply?.type !== "workspaces") throw new Error(`workspace.list returned ${reply?.type}`);
        return reply.data as unknown as Info[];
      })();
      const spaces = await listed;
      const root = spaces.find((space) => space.name === "alice")!;
      const work = spaces.find((space) => space.name === "leader" && space.agentSpace?.parentWorkspaceId === root.id)!;
      t.assertions.assert(root && work, "alice is not registered with its work Space");

      const created = await opened.client.call({
        type: "session.create",
        payload: { workspaceId: root.id, agentId: "ctl-normal", modelId: null, modeId: null, title: "front", cwd: null },
      });
      if (created?.type !== "session") throw new Error(`session.create returned ${created?.type}`);
      const front = (created.data as unknown as { id: string }).id;

      const itemsOf = async (sessionId: string): Promise<Item[]> => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
        if (reply?.type !== "snapshot") throw new Error(`session.get returned ${reply?.type}`);
        return (reply.data as unknown as { items: Item[] }).items;
      };
      const notices = async (needle: string, kind: RegExp): Promise<Item[]> =>
        (await itemsOf(front)).filter((item) => isSystem(item) && (item.text ?? "").includes(needle) && kind.test(item.text ?? ""));

      const genet = locateGenet(t.openRoot);
      const env = { ...genetEnv(t.openRoot, { ...t.env.env, GENEHUB_LOCAL_DATA_DIR: t.env.data }), GENEHUB_CLI: genet };
      const expert = (...args: string[]) => {
        const done = spawnSync("python3", [path.join(alice, "tools", "team.py"), ...args], { cwd: path.join(alice, "front"), env, encoding: "utf8" });
        return { code: done.status ?? -1, out: done.stdout, err: done.stderr };
      };
      const spawnWith = async (agent: string, desc: string): Promise<string> => {
        setEnv(agent);
        const started = expert("spawn", "--kind", "work", "--desc", desc, `do: ${desc}`);
        t.assertions.assert(started.code === 0, `spawn (${agent}): ${started.err || started.out}`);
        const id = /(s_[0-9a-f]+)/.exec(started.out)?.[1];
        t.assertions.assert(id, `no session id in: ${started.out}`);
        return id!;
      };
      const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const exactlyOnce = async (needle: string, kind: RegExp, what: string): Promise<void> => {
        try {
          await t.tools.waitUntil(async () => (await notices(needle, kind)).length >= 1, 40_000);
        } catch {
          const texts = (await itemsOf(front)).filter((item) => isSystem(item)).map((item) => (item.text ?? "").slice(0, 160));
          t.assertions.assert(false, `${what}: no notice for ${needle} ${kind}; the front has ${JSON.stringify(texts)}; pending ${JSON.stringify(pendingIds())}`);
        }
        await settle(4_000); // several more timer runs
        const found = await notices(needle, kind);
        t.assertions.assert(found.length === 1, `${what}: ${found.length} notices for ${needle} ${kind}`);
      };
      const pendingIds = () => readdirSync(path.join(alice, ".genethub/team/pending")).map((name) => name.replace(/\.json$/, ""));

      // waiting: the session stops at a question for the person.
      const waiting = await spawnWith("ctl-native-question", "needs an answer");
      await exactlyOnce(waiting, /在等人处理/, "waiting");

      // paused: the person interrupts a running session.
      const paused = await spawnWith("ctl-accept-then-silent", "will be interrupted");
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: paused } });
        return reply?.type === "snapshot" && (reply.data as unknown as { summary: { status: string } }).summary.status === "running";
      }, 30_000);
      await opened.client.call({ type: "session.interrupt", payload: { sessionId: paused } });
      await exactlyOnce(paused, /被暂停/, "paused");

      // failed: the Agent process dies mid-turn -> reported once to front AND recorded as an anomaly note for reflect.
      const failed = await spawnWith("ctl-exit-without-terminal", "dies in the middle");
      await exactlyOnce(failed, /已失败/, "failed");
      const notesDir = path.join(alice, ".genethub/team/notes");
      const anomalyNotes = () =>
        existsSync(notesDir)
          ? readdirSync(notesDir)
              .filter((f) => f.endsWith(".json"))
              .map((f) => JSON.parse(readFileSync(path.join(notesDir, f), "utf8")) as { kind?: string; session?: string })
          : [];
      t.assertions.assert(
        anomalyNotes().some((n) => n.kind === "anomaly" && n.session === failed),
        `failed session ${failed} did not leave a kind=anomaly note: ${JSON.stringify(anomalyNotes())}`,
      );

      // quiet reflect failure: a background reflect session (quiet=true, requester=null) that dies must close its
      // pending record silently and NEVER send a report notice to the front.
      const reflectSpace = spaces.find((space) => space.name === "team-reflect" && space.agentSpace?.parentWorkspaceId === root.id)!;
      const badReflectCreated = await opened.client.call({
        type: "session.create",
        payload: { workspaceId: reflectSpace.id, agentId: "ctl-exit-without-terminal", modelId: null, modeId: null, title: "反思：测试静默失败", cwd: null },
      });
      if (badReflectCreated?.type !== "session") throw new Error(`session.create returned ${badReflectCreated?.type}`);
      const badReflectId = (badReflectCreated.data as unknown as { id: string }).id;
      writeFileSync(
        path.join(alice, ".genethub/team/pending", `${badReflectId}.json`),
        JSON.stringify({
          sessionId: badReflectId,
          requester: null,
          kind: "reflect",
          desc: "反思：测试静默失败",
          createdAtMs: Date.now(),
          baseline: null,
          notified: [],
          lock: null,
          route: "ctl-exit-without-terminal",
          quiet: true,
        }),
      );
      await t.flows.main.sendPrompt(opened.client, badReflectId, "trigger reflect failure", null, `u_bad_ref_${Date.now()}`);
      await t.tools.waitUntil(async () => !pendingIds().includes(badReflectId), 30_000);
      await settle(2_500);
      const leakedReflectNotices = await notices(badReflectId, /已失败|已停止|已不存在/);
      t.assertions.assert(
        leakedReflectNotices.length === 0,
        `quiet reflect session ${badReflectId} leaked a failure report to front: ${JSON.stringify(leakedReflectNotices)}`,
      );

      // stuck: running, silent, past the threshold (4 s in this lease).
      const stuck = await spawnWith("ctl-accept-then-silent", "makes no progress");
      await exactlyOnce(stuck, /没有进展/, "stuck");
      t.assertions.assert(
        anomalyNotes().some((n) => n.kind === "anomaly" && n.session === stuck),
        `stuck session ${stuck} did not leave a kind=anomaly note: ${JSON.stringify(anomalyNotes())}`,
      );

      // gone: deleted behind the hook's back, after it has already reported the pause.
      const gone = await spawnWith("ctl-accept-then-silent", "will be deleted");
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: gone } });
        return reply?.type === "snapshot" && (reply.data as unknown as { summary: { status: string } }).summary.status === "running";
      }, 30_000);
      await opened.client.call({ type: "session.interrupt", payload: { sessionId: gone } });
      await exactlyOnce(gone, /被暂停/, "paused before deletion");
      const deleted = await opened.client.call({ type: "session.delete", payload: { sessionId: gone } });
      t.assertions.assert(deleted?.type === "ack", `session.delete: ${JSON.stringify(deleted)}`);
      const afterDelete = spawnSync(genet, ["session", "get", gone], { env, encoding: "utf8" });
      t.assertions.assert(afterDelete.status !== 0, `session get of a deleted session exits ${afterDelete.status}: ${afterDelete.stdout.slice(0, 300)}`);
      await exactlyOnce(gone, /已不存在/, "gone");
      t.assertions.assert(!pendingIds().includes(gone), "the record of a deleted session was left in pending/");

      // broken: a hook file the daemon cannot use.
      writeFileSync(path.join(alice, ".genethub/hooks/damaged.genet.json"), "{ not json");
      await exactlyOnce("damaged", /机制出了问题/, "broken hook file");

      // Capacity is separate at the two real acceptance boundaries.
      const target = await spawnWith("ctl-accept-then-silent", "queue target");
      setEnv("ctl-accept-then-silent", 3600); // Keep watchdog timeout out of this capacity scenario.
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: target } });
        return reply?.type === "snapshot" && (reply.data as unknown as { summary: { status: string } }).summary.status === "running";
      }, 30_000);
      let platformRefused = false;
      for (let n = 0; n < 40; n += 1) {
        const filled = spawnSync(genet, ["session", "send", target, "--system", `用途: notice\n\nfiller ${n}`, "--message-id", `fill.${n}`, "--no-wait"], { env, encoding: "utf8" });
        if (filled.status !== 0) {
          t.assertions.assert(/queue.*full|队列已满/i.test(filled.stdout + filled.stderr), "platform input failed for a reason other than capacity");
          platformRefused = true;
          break;
        }
      }
      t.assertions.assert(platformRefused, "the platform accepted input beyond its bounded queue");
      for (let n = 0; n < 32; n += 1) {
        const local = expert("send", "--to", target, `local correction ${n}`);
        t.assertions.assert(local.code === 0 && local.out.includes("文件收件箱") && local.out.includes("尚未取得平台回执"), `local acceptance was not distinguished from platform acceptance: ${local.out} ${local.err}`);
      }
      const inbox = path.join(alice, ".genethub/team/inbox", `${target}.jsonl`);
      const accepted = readFileSync(inbox, "utf8");
      const entries = accepted.trim().split("\n").map(line => JSON.parse(line));
      t.assertions.assert(entries.length === 32 && entries.some(item => item.text.includes("local correction 31")), "local capacity lost an accepted correction");
      const refused = expert("send", "--to", target, "one too many");
      t.assertions.assert(
        refused.code !== 0 && refused.err.includes("收件箱已满") && refused.err.includes("现在状态") && refused.err.includes("下一步"),
        `full queue: exit ${refused.code} ${refused.err}`,
      );
      t.assertions.assert(readFileSync(inbox, "utf8") === accepted, "overflow changed or discarded accepted local inputs");

      // The timer survived all of it.
      t.assertions.assert(existsSync(path.join(alice, ".genethub/team/alive")), "no heartbeat");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
