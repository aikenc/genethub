// When the reflect session starts is decided by the timer's script, without a model: the person started enough rounds
// since the last wake and the conversation is quiet, or there are notes and the last one is not fresh; never twice
// in a row, never while one is running. `reflect now` starts one whatever the thresholds say, or queues the request
// into the running one. These cases run the real script against a fake `genet` that answers from a state file and
// records what the script asked it to do (start a session, queue a message). No daemon and no model are involved.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

const TEMPLATE = "apps/daemon/builtin-skills/genehub/references/team-template";

const FAKE_GENET = `#!/usr/bin/env python3
import json, os, sys, time
state_path = os.environ["FAKE_STATE"]
log_path = state_path + ".calls"
state = json.load(open(state_path))
args = sys.argv[1:]
now = int(time.time() * 1000)
def out(data):
    print(json.dumps({"data": data}))
    sys.exit(0)
def log():
    open(log_path, "a").write(json.dumps(args, ensure_ascii=False) + "\\n")
def flag(name):
    return args[args.index(name) + 1] if name in args else None
if args[:2] == ["workspace", "list"]:
    out({"workspaces": [{"id": w, "folders": [{"root": r}]} for w, r in state["workspaces"].items()]})
if args[:2] == ["session", "list"]:
    out({"sessions": state["sessions"].get(flag("--workspace"), [])})
if args[:2] == ["session", "get"]:
    sid = args[2]
    out({"session": {
        "summary": state["summaries"].get(sid, {"status": "idle", "agentId": "ctl-normal", "modelId": "m1"}),
        "requests": state.get("requests", {}).get(sid, []),
        "inputs": state.get("inputs", {}).get(sid, {}),
    }})
if args[:2] == ["session", "respond"]:
    log()
    out({})
if args[:2] == ["session", "rounds"]:
    rounds = [dict(r, endedAtMs=now - int(r.get("endedAgoS", 0) * 1000)) for r in state["rounds"].get(args[2], [])]
    out({"page": {"rounds": rounds}})
if args[:2] == ["session", "narrative"]:
    item_id = flag("--item")
    text = state.get("narratives", {}).get("%s:%s" % (args[2], item_id), "reply of %s" % args[2])
    out({"page": {"items": [{"id": item_id, "text": text}]}})
if args[:3] == ["agent", "list", "--routes"]:
    out({"routes": state.get("routes", [{"agentId": "ctl-normal", "modelId": "m1", "tags": ["Flash"], "cost": "low", "default": True}])})
if args[:2] == ["space", "open"]:
    out({})  # registering a workspace is not an action these cases record
if args[:2] == ["session", "send"]:
    log()
    out({})
if args[:2] == ["agent", "run"]:
    log()
    state["created"] = state.get("created", 0) + 1
    session_id = "s_new%d" % state["created"]
    state["sessions"].setdefault(flag("--workspace"), []).append({"id": session_id, "labels": [args[i + 1] for i, x in enumerate(args) if x == "--label"], "status": "running", "updatedAtMs": now, "description": flag("--description")})
    state.setdefault("summaries", {})[session_id] = {"status": "running", "agentId": "ctl-normal", "modelId": "m1"}
    json.dump(state, open(state_path, "w"))
    out({"sessionId": session_id})
print(json.dumps({"error": {"message": "fake genet: unsupported " + " ".join(args)}}))
sys.exit(1)
`;

// One scenario per call: sets the world up, then (for "wake") asks the script whether to wake and reports what happened.
const DRIVER = `
import importlib.util, json, os, shutil, sys, time
spec = importlib.util.spec_from_file_location("expert", os.path.join(os.environ["EXPERT"], "tools", "expert.py"))
expert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(expert)
root = os.environ["EXPERT"]
state_path = os.environ["FAKE_STATE"]
log_path = state_path + ".calls"
now = int(time.time() * 1000)
mode, _, name = os.environ["SCENARIO"].partition(":")
S = {
    "below": {"rounds": [{"roundId": "r%d" % i, "userItemId": "u.%d" % i, "endedAgoS": 3000} for i in range(2)]},
    "due": {"rounds": [{"roundId": "r%d" % i, "userItemId": "u.%d" % i, "endedAgoS": 5} for i in range(3)]},
    "system-rounds": {"rounds": [{"roundId": "r0", "userItemId": "u.0", "endedAgoS": 3000}, {"roundId": "r1", "userItemId": "x.abc", "endedAgoS": 3000}, {"roundId": "r2", "userItemId": "x.def", "endedAgoS": 3000}]},
    "busy": {"rounds": [{"roundId": "r%d" % i, "userItemId": "u.%d" % i, "endedAgoS": 3000} for i in range(3)],
             "reflect_sessions": [{"id": "s_reflecting", "labels": ["反思", "系统发起"], "status": "running", "updatedAtMs": now}]},
    "busy-new-note": {"notes": [{"id": "urgent1", "ageS": 1, "kind": "unhappy", "quote": "还在犯同样的错"}],
                      "reflect_sessions": [{"id": "s_reflecting", "labels": ["反思", "系统发起"], "status": "running", "updatedAtMs": now}],
                      "reflect_state": {"atMs": now - 10000, "sessionId": "s_reflecting", "notifiedNoteIds": []}},
    "gap": {"rounds": [{"roundId": "r%d" % i, "userItemId": "u.%d" % i, "endedAgoS": 30} for i in range(3)], "reflect_state": {"atMs": now - 60000}},
    "since": {"rounds": [{"roundId": "r%d" % i, "userItemId": "u.%d" % i, "endedAgoS": 3000} for i in range(3)], "reflect_state": {"atMs": now - 100000}, "env": {"EXPERT_WAKE_GAP": "1"}},
    "notes-fresh": {"notes": [{"id": "a", "ageS": 1, "kind": "note"}]},
    "notes-old": {"notes": [{"id": "a", "ageS": 120, "kind": "note", "quote": "顺手记一条观察"}]},
    "unhappy-immediate": {"notes": [{"id": "u1", "ageS": 1, "kind": "unhappy", "quote": "不对，不是这个意思"}], "reflect_state": {"atMs": now - 60000}},
    "anomaly-gap": {"notes": [{"id": "anom1", "ageS": 120, "kind": "anomaly", "quote": "无"}], "reflect_state": {"atMs": now - 60000},
                    "work_sessions": [{"id": "s_stuck", "labels": ["工作", "系统发起"], "status": "running", "updatedAtMs": now - 900000, "lastActivityAtMs": now - 900000, "description": "卡住的任务"}]},
    "urgent-backoff": {"notes": [{"id": "up1", "ageS": 10, "kind": "upgrade", "quote": "无"}],
                       "reflect_state": {"atMs": now - 10000, "sessionId": "s_failed_ref", "notifiedSessionId": "s_failed_ref",
                                         "notifiedNotes": ["n" + __import__("hashlib").sha1(b"up1").hexdigest()[:12]]}},
    "no-front-inherit": {"no_front": True, "notes": [{"id": "up2", "ageS": 5, "kind": "upgrade", "quote": "无"}],
                         "work_sessions": [{"id": "s_worker", "labels": ["工作", "系统发起"], "status": "idle", "updatedAtMs": now}],
                         "extra_summaries": {"s_worker": {"agentId": "ctl-normal", "modelId": "m-work-inherited", "status": "idle"}},
                         "routes": [{"agentId": "ctl-normal", "modelId": "m-work-inherited", "tags": ["Pro"], "cost": "medium", "default": True}]},
    "no-reflect-space": {"rounds": [{"roundId": "r%d" % i, "userItemId": "u.%d" % i, "endedAgoS": 3000} for i in range(3)], "no_reflect": True},
    "idle": {"reflect_sessions": [{"id": "s_idle_reflect", "labels": ["反思", "系统发起"], "status": "idle", "updatedAtMs": now}]},
    "no-front": {"no_front": True},
    "batch": {},
}[name]
shutil.rmtree(expert.state_dir(root), ignore_errors=True)
if os.path.exists(log_path):
    os.remove(log_path)
workspaces = {"w_root": root, "w_research": os.path.join(root, "spaces/research"), "w_work": os.path.join(root, "spaces/leader"), "w_reflect": os.path.join(root, "spaces/team-reflect")}
if S.get("no_reflect"):
    del workspaces["w_reflect"]
summaries = {"s_front": {"agentId": "ctl-normal", "modelId": "m1", "status": "idle"}}
summaries.update(S.get("extra_summaries", {}))
state = {"workspaces": workspaces, "created": 0,
         "sessions": {"w_root": [] if S.get("no_front") else [{"id": "s_front", "labels": [], "status": "idle", "updatedAtMs": now}], "w_research": [], "w_work": S.get("work_sessions", []), "w_reflect": S.get("reflect_sessions", [])},
         "summaries": summaries,
         "routes": S.get("routes", [{"agentId": "ctl-normal", "modelId": "m1", "tags": ["Flash"], "cost": "low", "default": True}]),
         "rounds": {"s_front": S.get("rounds", [])}}
json.dump(state, open(state_path, "w"))
for note in S.get("notes", []):
    expert.add_note(root, {"kind": note.get("kind", "unhappy"), "session": "s_front", "turn": None, "ref": "ghref:item:s_front:u.9", "from": "t", "quote": note.get("quote", "q"), "context": "c", "text": "t"}, note["id"])
    path = os.path.join(expert.notes_dir(root), sorted(os.listdir(expert.notes_dir(root)))[-1])
    record = json.load(open(path))
    record["at"] = now - note["ageS"] * 1000
    json.dump(record, open(path, "w"))
if S.get("reflect_state"):
    expert.write_json(expert.state_dir(root, "reflect.json"), S["reflect_state"])
for key, value in S.get("env", {}).items():
    os.environ[key] = value
os.environ["EXPERT_WAKE_CHECK"] = "0"
def calls():
    return [json.loads(line) for line in open(log_path)] if os.path.exists(log_path) else []
if mode == "wake":
    name_, mine = expert.me(root)
    expert.wake(root, name_, mine)
    first = calls()
    expert.wake(root, name_, mine)  # straight away again: must not start a second one
    pending = expert.state_dir(root, "pending")
    records = [json.load(open(os.path.join(pending, f))) for f in os.listdir(pending)] if os.path.isdir(pending) else []
    briefings = expert.state_dir(root, "briefings")
    briefing = open(os.path.join(briefings, os.listdir(briefings)[0]), encoding="utf-8").read() if os.path.isdir(briefings) and os.listdir(briefings) else ""
    print(json.dumps({"calls": first, "callsAfterSecondWake": len(calls()), "records": records, "briefing": briefing,
                      "reflect": expert.read_json(expert.state_dir(root, "reflect.json"), {})}))
elif mode == "reconcile":
    name_, mine = expert.me(root)
    # Coordinator s_coord spawned two children s_c1 and s_c2 in the same round r1.
    expert.write_json(expert.state_dir(root, "pending", "s_coord.json"), {
        "sessionId": "s_coord", "requester": "s_front", "batch": "s_front:r0", "kind": "research", "desc": "统筹评审",
        "createdAtMs": now - 700000, "baseline": None, "notified": [], "lock": None, "route": "m1"})
    for cid, desc in (("s_c1", "架构子评审"), ("s_c2", "安全子评审")):
        expert.write_json(expert.state_dir(root, "pending", cid + ".json"), {
            "sessionId": cid, "requester": "s_coord", "batch": "s_coord:r1", "kind": "research", "desc": desc,
            "createdAtMs": now - 60000, "baseline": None, "notified": [], "lock": None, "route": "m1"})
    # Tick 1: s_coord is idle after spawning children (reply i_coord_1), s_c1 is done (i_c1), s_c2 is still running.
    state["summaries"]["s_coord"] = {"status": "idle", "latestReply": {"itemId": "i_coord_1"}}
    state["summaries"]["s_c1"] = {"status": "idle", "latestReply": {"itemId": "i_c1"}}
    state["summaries"]["s_c2"] = {"status": "running", "lastActivityAtMs": now}
    state["narratives"] = {"s_c1:i_c1": "架构结论A", "s_c2:i_c2": "安全结论B " + ("x" * 9000), "s_coord:i_coord_2": "汇总结论：共2项"}
    json.dump(state, open(state_path, "w"))
    expert.reconcile(root, name_, mine)
    tick1_calls = calls()
    # Tick 2: s_c2 finishes too -> batch s_coord:r1 delivers 1 combined result to s_coord.
    state["summaries"]["s_c2"] = {"status": "idle", "latestReply": {"itemId": "i_c2"}}
    json.dump(state, open(state_path, "w"))
    expert.reconcile(root, name_, mine)
    tick2_calls = calls()[len(tick1_calls):]
    # Tick 3: s_coord finishes its summary turn (i_coord_2) -> delivers 1 result to s_front with header ref preserved.
    state["summaries"]["s_coord"] = {"status": "idle", "latestReply": {"itemId": "i_coord_2"}}
    json.dump(state, open(state_path, "w"))
    expert.reconcile(root, name_, mine)
    tick3_calls = calls()[len(tick1_calls) + len(tick2_calls):]
    print(json.dumps({"calls": tick1_calls + tick2_calls + tick3_calls, "callsAfterSecondWake": len(tick1_calls),
                      "records": [{"tick2": tick2_calls, "tick3": tick3_calls}], "briefing": "", "reflect": {}}))
`;

const base = {
  tags: ["core", "expert"],
  llm: { default: "none" as const },
  expectedDurationMs: 6_000,
  timeoutMs: 90_000,
  requiredArtifacts: [],
  resources: { environments: 1, cpu: 1 },
  surfaces: ["tools/expert.py"],
  productInterfaces: ["tools/expert.py"],
};

type Call = string[];
type Outcome = { calls: Call[]; callsAfterSecondWake: number; records: Array<Record<string, unknown>>; briefing: string; reflect: Record<string, unknown> };

function rig(t: CaseContext, name: string) {
  const data = join(t.env.root, name);
  const expert = join(data, "spaces", "alice");
  mkdirSync(data, { recursive: true });
  cpSync(join(t.openRoot, TEMPLATE), expert, { recursive: true });
  const fake = join(data, "genet");
  writeFileSync(fake, FAKE_GENET, { mode: 0o755 });
  const state = join(data, "state.json");
  const env = { PATH: process.env.PATH ?? "", HOME: data, GENEHUB_CLI: fake, FAKE_STATE: state, EXPERT: expert, EXPERT_TEMPLATE: join(t.openRoot, TEMPLATE) };
  const scenario = (spec: string): Outcome => {
    const done = spawnSync("python3", ["-c", DRIVER], { env: { ...env, SCENARIO: spec }, encoding: "utf8" });
    t.assertions.assert(done.status === 0, `driver ${spec}: ${done.stderr}`);
    return done.stdout.trim() ? (JSON.parse(done.stdout) as Outcome) : ({} as Outcome);
  };
  const cli = (args: string[], extra: Record<string, string> = {}) => {
    const done = spawnSync("python3", ["tools/expert.py", ...args], { cwd: expert, env: { ...env, ...extra }, encoding: "utf8" });
    return { code: done.status ?? -1, out: done.stdout.trim(), err: done.stderr.trim() };
  };
  const calls = (): Call[] => (existsSync(`${state}.calls`) ? readFileSync(`${state}.calls`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call) : []);
  return { expert, scenario, cli, calls };
}

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-reflect-wake",
    title: "The timer starts one reflect session when the person has started three rounds or a note is waiting, and not otherwise",
    oracle:
      "two user rounds, three rounds of which only one is the person's, three rounds that have not gone quiet, rounds already counted by an earlier wake, a wake less than the gap ago, a reflect session still running, an expert with no reflect Space, and a note younger than a minute each start nothing; three quiet user rounds start exactly one session in the reflect Space with the reflect and system labels, a pending record that stays quiet, the wake time and the briefing file written, and an immediate second wake starts no second one; a note older than a minute starts one whose briefing names the note and its quote; a session that has finished does not block the next wake",
    catches: [
      "a reflect session started for every handful of messages, or never",
      "rounds the scripts started counted as the person's",
      "two reflect sessions editing the same files at once",
      "a wake that fires again at once because it did not remember the last one",
      "a conversation interrupted by a wake while the person is still talking",
      "a note that waits forever, or a wake on a note written a second ago, before the rest of the batch",
      "an old expert with no reflect Space breaking the timer",
    ],
  },
  async (t) => {
    const r = rig(t, "wake");
    for (const quiet of ["below", "system-rounds", "busy", "gap", "since", "no-reflect-space", "notes-fresh"]) {
      const out = r.scenario(`wake:${quiet}`);
      const started = (out.calls ?? []).filter((call) => call[0] === "agent");
      t.assertions.assert(started.length === 0, `${quiet}: a session was started: ${JSON.stringify(started)}`);
    }

    const due = r.scenario("wake:due");
    const run = due.calls.filter((call) => call[0] === "agent");
    t.assertions.assert(run.length === 1, `due: ${run.length} sessions started`);
    const args = run[0]!;
    t.assertions.assert(args[args.indexOf("--workspace") + 1] === "w_reflect", `started in ${args[args.indexOf("--workspace") + 1]}, not the reflect Space`);
    const labels = args.flatMap((value, index) => (value === "--label" ? [args[index + 1]!] : []));
    t.assertions.assert(labels.includes("反思") && labels.includes("系统发起"), `labels ${labels}`);
    const title = args[args.indexOf("--title") + 1];
    t.assertions.assert(args.includes("--title") && title !== undefined && title === args[args.indexOf("--description") + 1], `the session is titled by what it does, not by the first line of its task: ${title}`);
    t.assertions.assert(args.join(" ").includes("按 expert-reflect 办") && args.join(" ").includes("用途: reflect"), "the first message does not send the session to its Skill");
    t.assertions.assert(due.callsAfterSecondWake === 1, `an immediate second wake started another: ${due.callsAfterSecondWake} calls`);
    t.assertions.assert(due.records.length === 1 && due.records[0]!.kind === "reflect" && due.records[0]!.quiet === true && due.records[0]!.sessionId === "s_new1", `pending ${JSON.stringify(due.records)}`);
    t.assertions.assert(typeof due.reflect.atMs === "number" && due.reflect.sessionId === "s_new1", `reflect.json ${JSON.stringify(due.reflect)}`);
    t.assertions.assert(due.briefing.includes("自上次反思以来用户发起了 3 轮对话") && due.briefing.includes("未处理的留言（0）") && due.briefing.includes("## 各会话"), `briefing:\n${due.briefing}`);

    const noted = r.scenario("wake:notes-old");
    t.assertions.assert(noted.calls.filter((call) => call[0] === "agent").length === 1, "an old note started nothing");
    t.assertions.assert(noted.briefing.includes("有 1 条未处理的留言") && noted.briefing.includes("顺手记一条观察") && noted.briefing.includes("ghref:item:s_front:u.9"), `briefing:\n${noted.briefing}`);

    const unhappy = r.scenario("wake:unhappy-immediate");
    t.assertions.assert(unhappy.calls.filter((call) => call[0] === "agent").length === 1, "an unhappy note did not wake immediately or bypass WAKE_GAP_S");

    const busyNote = r.scenario("wake:busy-new-note");
    t.assertions.assert(
      busyNote.calls.length === 1 && busyNote.calls[0]![0] === "session" && busyNote.calls[0]![1] === "send" && busyNote.calls[0]![2] === "s_reflecting" && busyNote.calls[0]!.join(" ").includes("还在犯同样的错") && busyNote.callsAfterSecondWake === 1,
      `busy-new-note did not forward new note once to running reflect session: ${JSON.stringify(busyNote)}`,
    );

    const anomaly = r.scenario("wake:anomaly-gap");
    t.assertions.assert(anomaly.calls.filter((call) => call[0] === "agent").length === 1, "an anomaly note did not bypass WAKE_GAP_S");
    t.assertions.assert(anomaly.briefing.includes("含会话异常") && anomaly.briefing.includes("## 疑似异常会话（1）") && anomaly.briefing.includes("s_stuck"), `anomaly briefing:\n${anomaly.briefing}`);

    // An urgent note that was already notified to a reflect session that failed/exited within WAKE_GAP_S backs off instead of spinning.
    const backoff = r.scenario("wake:urgent-backoff");
    t.assertions.assert(backoff.calls.filter((call) => call[0] === "agent").length === 0, `already-notified urgent note spun up another session within gap: ${JSON.stringify(backoff.calls)}`);

    // A background-only expert with no root front session inherits the model from its work session when waking reflect.
    const noFrontInherit = r.scenario("wake:no-front-inherit");
    const noFrontRun = noFrontInherit.calls.filter((call) => call[0] === "agent");
    t.assertions.assert(
      noFrontRun.length === 1 && noFrontRun[0]!.includes("m-work-inherited"),
      `no-front expert did not inherit model from work session: ${JSON.stringify(noFrontRun)}`,
    );

    const finished = r.scenario("wake:idle");
    t.assertions.assert(finished.calls.length === 0, "nothing was due, yet something started");

    const batch = r.scenario("reconcile:batch");
    t.assertions.assert(batch.callsAfterSecondWake === 0, `tick1 should not send any result while s_c2 is still running and s_coord is waiting for children: ${JSON.stringify(batch.calls)}`);
    const tick2 = (batch.records[0] as { tick2: Call[]; tick3: Call[] }).tick2;
    const tick3 = (batch.records[0] as { tick2: Call[]; tick3: Call[] }).tick3;
    t.assertions.assert(tick2.length === 1 && tick2[0]![2] === "s_coord" && tick2[0]![3]!.includes("批次完成（2 项）") && tick2[0]![3]!.includes("ref: ghref:item:s_c1:i_c1, ghref:item:s_c2:i_c2"), `tick2 merged batch notice: ${JSON.stringify(tick2)}`);
    t.assertions.assert(tick3.length === 1 && tick3[0]![2] === "s_front" && tick3[0]![3]!.includes("\nref: ghref:item:s_coord:i_coord_2\n") && tick3[0]![3]!.includes("汇总结论：共2项"), `tick3 coordinator notice: ${JSON.stringify(tick3)}`);
  },
);

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-reflect-now",
    title: "`reflect now` starts a reflect session at once, or hands the request to the one that is running, and `tell-user` reaches the front",
    oracle:
      "with nothing due and no reflect session running, `reflect now TEXT` starts one in the reflect Space whose first message carries the request, with a pending record that is not quiet and names the asking session; with one running it queues the request into that session and starts none; an expert with no reflect Space gets an error with the next step; tell-user queues a message with the tell-user purpose into the front session and fails with the next step when there is no front",
    catches: [
      "an immediate reflection request that waits for the thresholds",
      "two reflect sessions when one is already running",
      "the user's words lost on the way to the reflect session",
      "a reflect result nobody delivers to the person who asked",
      "tell-user going nowhere, or crashing, when the front does not exist",
    ],
  },
  async (t) => {
    const r = rig(t, "now");
    r.scenario("setup:idle");
    const started = r.cli(["reflect", "now", "把评审分流的毛病现在就改掉"]);
    t.assertions.assert(started.code === 0 && started.out.startsWith("已开始反思会话 s_new1"), `reflect now: ${started.out} ${started.err}`);
    const run = r.calls().filter((call) => call[0] === "agent");
    t.assertions.assert(run.length === 1 && run[0]!.join(" ").includes("把评审分流的毛病现在就改掉") && run[0]!.join(" ").includes("用户要求立刻反思"), `agent run ${JSON.stringify(run)}`);
    const pending = join(r.expert, ".genethub/team/pending");
    const record = JSON.parse(readFileSync(join(pending, readdirSync(pending)[0]!), "utf8"));
    t.assertions.assert(record.quiet === false && record.requester === "s_front" && record.kind === "reflect", `record ${JSON.stringify(record)}`);

    r.scenario("setup:busy");
    const queued = r.cli(["reflect", "now", "再加一条：留言要带引用"]);
    t.assertions.assert(queued.code === 0 && queued.out.includes("s_reflecting") && queued.out.includes("排进它的队列"), `reflect now with one running: ${queued.out} ${queued.err}`);
    const calls = r.calls();
    t.assertions.assert(calls.every((call) => call[0] !== "agent") && calls.some((call) => call[0] === "session" && call[1] === "send" && call[2] === "s_reflecting" && call.join(" ").includes("再加一条：留言要带引用")), `calls ${JSON.stringify(calls)}`);

    r.scenario("setup:no-reflect-space");
    const old = r.cli(["reflect", "now", "x"]);
    t.assertions.assert(old.code === 1 && old.err.includes("没有 reflect 空间") && old.err.includes("下一步"), `reflect now on an expert without the Space: ${old.err}`);

    r.scenario("setup:idle");
    const told = r.cli(["tell-user", "平台的消息队列只有 32 条，需要用户决定要不要改"]);
    t.assertions.assert(told.code === 0, `tell-user: ${told.out} ${told.err}`);
    const sent = r.calls().find((call) => call[0] === "session" && call[1] === "send");
    t.assertions.assert(sent !== undefined && sent[2] === "s_front" && sent[3]!.includes("用途: tell-user") && sent[3]!.includes("平台的消息队列只有 32 条"), `tell-user sent ${JSON.stringify(sent)}`);

    r.scenario("setup:no-front");
    const lonely = r.cli(["tell-user", "x"]);
    t.assertions.assert(lonely.code === 1 && lonely.err.includes("下一步") && r.calls().length === 0, `tell-user without a front: ${lonely.err}`);
  },
);

const TEAM_TEMPLATE = "apps/daemon/builtin-skills/genehub/references/team-template";

const THREE_LAW_DRIVER = `
import importlib.util, json, os, shutil, subprocess, sys, time
spec = importlib.util.spec_from_file_location("expert", os.path.join(os.environ["TEAM"], "tools", "expert.py"))
expert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(expert)
root = os.environ["TEAM"]
state_path = os.environ["FAKE_STATE"]
log_path = state_path + ".calls"
now = int(time.time() * 1000)
os.environ["EXPERT_WAKE_CHECK"] = "0"
os.environ["EXPERT_BOARD_PORT"] = "0"

def reset_calls():
    if os.path.exists(log_path):
        os.remove(log_path)

def get_calls():
    return [json.loads(line) for line in open(log_path)] if os.path.exists(log_path) else []

workspaces = {
    "w_root": root,
    "w_leader": os.path.join(root, "spaces/leader"),
    "w_skill": os.path.join(root, "spaces/skill-lead"),
    "w_qa": os.path.join(root, "spaces/qa"),
    "w_research": os.path.join(root, "spaces/research"),
    "w_reflect": os.path.join(root, "spaces/team-reflect"),
}
expert.scaffold_role_space(root, "skill-lead", "技能系统负责人", None)

state = {
    "workspaces": workspaces,
    "created": 0,
    "sessions": {
        "w_root": [{"id": "s_front", "labels": [], "status": "idle", "updatedAtMs": now}],
        "w_leader": [{"id": "s_leader", "labels": ["工作", "系统发起"], "status": "idle", "updatedAtMs": now - 60000}],
        "w_skill": [],
        "w_qa": [],
        "w_research": [],
        "w_reflect": [],
    },
    "summaries": {
        "s_front": {"agentId": "ctl-normal", "modelId": "m1", "status": "idle"},
        "s_leader": {"agentId": "ctl-normal", "modelId": "m1", "status": "idle", "latestReply": {"itemId": "i_leader_0"}},
    },
    "requests": {},
    "inputs": {},
    "routes": [{"agentId": "ctl-normal", "modelId": "m1", "tags": ["Flash"], "cost": "low", "default": True}],
    "rounds": {"s_front": []},
    "narratives": {},
}
json.dump(state, open(state_path, "w"))
name_, mine = expert.me(root)

# ---------------------------------------------------------------------------
# Case 1: Multi-level Fractal Relay (Leader -> Lead -> 5 Workers + 1 Research)
# Hold-Until-Parent-Ready (Law 2): children finish while Lead is still running
# Turn 1; they must remain in pending/ so Lead's Turn 1 idle transition is NOT
# mistaken for Lead's final completion!
# ---------------------------------------------------------------------------
shutil.rmtree(expert.state_dir(root), ignore_errors=True)
reset_calls()
expert.write_json(expert.state_dir(root, "pending", "s_lead.json"), {
    "sessionId": "s_lead", "requester": "s_leader", "batch": "s_leader:r0", "kind": "work", "space": "skill-lead",
    "desc": "技能体系总控", "createdAtMs": now - 120000, "baseline": None, "notified": [], "lock": None, "route": "m1",
})
sub_ids = [("s_w1", "work", "火球术"), ("s_w2", "work", "冰霜新星"), ("s_w3", "work", "闪电链"), ("s_w4", "work", "护盾术"), ("s_w5", "work", "瞬移术"), ("s_res1", "research", "数值曲线调研")]
for cid, ckind, cdesc in sub_ids:
    expert.write_json(expert.state_dir(root, "pending", cid + ".json"), {
        "sessionId": cid, "requester": "s_lead", "batch": "s_lead:r1", "kind": ckind, "space": "skill-lead" if ckind == "work" else "research",
        "desc": cdesc, "createdAtMs": now - 90000, "baseline": None, "notified": [], "lock": None, "route": "m1",
    })
    state["summaries"][cid] = {"status": "idle", "latestReply": {"itemId": "i_" + cid}}
    state["narratives"]["%s:i_%s" % (cid, cid)] = "%s 交付完毕" % cdesc

# Tick 1: All 6 grandchildren are already idle with replies, while s_lead is STILL running Turn 1!
state["summaries"]["s_lead"] = {"status": "running", "lastActivityAtMs": now}
json.dump(state, open(state_path, "w"))
expert.reconcile(root, name_, mine)
c1_tick1_calls = get_calls()
c1_tick1_pending = sorted(os.listdir(expert.state_dir(root, "pending")))

# Tick 2: s_lead finishes Turn 1 (status="idle", latestReply="i_lead_turn1").
# Because the 6 grandchildren were held in pending/, s_lead must NOT report i_lead_turn1 to s_leader!
# Instead, s_lead's baseline advances to i_lead_turn1 and s_lead receives the 6-item batch summary.
reset_calls()
state["summaries"]["s_lead"] = {"status": "idle", "latestReply": {"itemId": "i_lead_turn1"}}
state["narratives"]["s_lead:i_lead_turn1"] = "我已经派发5个Worker和1个Research，等待它们回执。"
json.dump(state, open(state_path, "w"))
expert.reconcile(root, name_, mine)
c1_tick2_calls = get_calls()
c1_tick2_pending = sorted(os.listdir(expert.state_dir(root, "pending")))
c1_lead_rec_after_tick2 = expert.read_json(expert.state_dir(root, "pending", "s_lead.json"), {})

# Tick 3: s_lead finishes Turn 2 (status="idle", latestReply="i_lead_turn2") after integrating the 6 grandchildren.
# Now s_lead has no pending children and its reply != baseline ("i_lead_turn1"), so it delivers the final result to s_leader!
reset_calls()
state["summaries"]["s_lead"] = {"status": "idle", "latestReply": {"itemId": "i_lead_turn2"}}
state["narratives"]["s_lead:i_lead_turn2"] = "5个技能子模块与数值调研全部合入通过，commit abc1234"
json.dump(state, open(state_path, "w"))
expert.reconcile(root, name_, mine)
c1_tick3_calls = get_calls()
c1_tick3_pending = sorted(os.listdir(expert.state_dir(root, "pending")))

# ---------------------------------------------------------------------------
# Case 2: Law 1 Bounded Terminal State (normal + failed + stopped + stuck in one batch)
# + Team auto-unblock of waiting session + auto-unpause of failed parent!
# ---------------------------------------------------------------------------
shutil.rmtree(expert.state_dir(root), ignore_errors=True)
reset_calls()
os.environ["EXPERT_STOPPED_AFTER"] = "30"
os.environ["EXPERT_STUCK_AFTER"] = "60"
for cid, desc in (("s_b_ok", "正常模块"), ("s_b_fail", "崩溃模块"), ("s_b_stop", "静默停止模块"), ("s_b_stuck", "死锁超时模块")):
    expert.write_json(expert.state_dir(root, "pending", cid + ".json"), {
        "sessionId": cid, "requester": "s_leader", "batch": "s_leader:r2", "kind": "work", "space": "skill-lead",
        "desc": desc, "createdAtMs": now - 120000, "baseline": None, "notified": [], "lock": None, "route": "m1",
    })
# Also a waiting session with a permission request in the team
expert.write_json(expert.state_dir(root, "pending", "s_wait_perm.json"), {
    "sessionId": "s_wait_perm", "requester": "s_leader", "batch": "s_leader:r_other", "kind": "work", "space": "skill-lead",
    "desc": "等权限审批模块", "createdAtMs": now - 20000, "baseline": None, "notified": [], "lock": None, "route": "m1",
})
state["summaries"]["s_b_ok"] = {"status": "idle", "latestReply": {"itemId": "i_b_ok"}}
state["narratives"]["s_b_ok:i_b_ok"] = "正常模块已完成"
state["summaries"]["s_b_fail"] = {"status": "failed", "errorMessage": "Rust panic out of memory"}
state["summaries"]["s_b_stop"] = {"status": "idle", "updatedAtMs": now - 45000, "lastActivityAtMs": now - 45000}
state["summaries"]["s_b_stuck"] = {"status": "running", "updatedAtMs": now - 90000, "lastActivityAtMs": now - 90000}
state["summaries"]["s_wait_perm"] = {"status": "waiting", "labels": ["工作", "系统发起"], "updatedAtMs": now - 5000, "interactionSummary": {"requests": [{"id": "req_perm_99", "kind": "question"}]}}
# Parent s_leader itself had failed earlier -> should be woken with 【人类唤醒】 prefix!
state["summaries"]["s_leader"] = {"status": "failed", "latestReply": {"itemId": "i_leader_prev"}}
json.dump(state, open(state_path, "w"))
expert.reconcile(root, name_, mine)
c2_calls = get_calls()
c2_pending = sorted(os.listdir(expert.state_dir(root, "pending")))

# ---------------------------------------------------------------------------
# Case 3: Non-hijacking send & question does not prematurely close pending
# ---------------------------------------------------------------------------
shutil.rmtree(expert.state_dir(root), ignore_errors=True)
reset_calls()
sid_leader_hex = "s_111122223333"
sid_worker_hex = "s_444455556666"
sid_qa_hex = "s_777788889999"
expert.write_json(expert.state_dir(root, "pending", sid_worker_hex + ".json"), {
    "sessionId": sid_worker_hex, "requester": sid_leader_hex, "batch": sid_leader_hex + ":r3", "kind": "work", "space": "skill-lead",
    "desc": "核心战斗模块", "createdAtMs": now - 30000, "baseline": None, "notified": [], "lock": None, "route": "m1",
})
state["summaries"][sid_worker_hex] = {"status": "running", "lastActivityAtMs": now}
state["summaries"][sid_leader_hex] = {"status": "idle", "latestReply": {"itemId": "i_leader_3"}}
json.dump(state, open(state_path, "w"))
# Peer s_qa sends a question to sid_worker_hex -> must NOT overwrite requester=sid_leader_hex
import contextlib, io
os.environ["GENEHUB_SESSION_ID"] = sid_qa_hex
with contextlib.redirect_stdout(io.StringIO()):
    expert.cmd_send(type("A", (), {"to": sid_worker_hex, "kind": "question", "text": ["请问伤害公式字段名是什么？"]})())
rec_after_peer_send = expert.read_json(expert.state_dir(root, "pending", sid_worker_hex + ".json"), {})
# Now sid_worker_hex sends a question back to sid_leader_hex -> must NOT close sid_worker_hex's pending record!
os.environ["GENEHUB_SESSION_ID"] = sid_worker_hex
with contextlib.redirect_stdout(io.StringIO()):
    expert.cmd_send(type("A", (), {"to": sid_leader_hex, "kind": "question", "text": ["暴击上限是200%还是300%？"]})())
c3_pending_after_question = sorted(os.listdir(expert.state_dir(root, "pending")))

# ---------------------------------------------------------------------------
# Case 4: Law 3 Leader Watchdog self-healing + progress reset + 3-strike circuit breaker
# ---------------------------------------------------------------------------
shutil.rmtree(expert.state_dir(root), ignore_errors=True)
reset_calls()
os.environ["EXPERT_WATCHDOG_AFTER"] = "10"
os.environ["EXPERT_WATCHDOG_MAX_WAKES"] = "3"
os.makedirs(os.path.join(root, ".pm", "trunk"), exist_ok=True)
open(os.path.join(root, ".pm", "trunk", "MILESTONE_PLAN.md"), "w").write("# 里程碑计划\\n- [x] v1.0 基础战斗\\n- [ ] v1.1 技能树与精英词缀\\n")
state["summaries"]["s_leader"] = {"status": "failed", "updatedAtMs": now - 25000, "lastActivityAtMs": now - 25000, "latestReply": {"itemId": "i_ld_w0"}}
state["sessions"]["w_leader"] = [{"id": "s_leader", "labels": ["工作", "系统发起"], "status": "failed", "updatedAtMs": now - 25000}]
json.dump(state, open(state_path, "w"))

# Watchdog Wake #1 (recovers failed leader with --unpause)
expert.leader_watchdog(root, name_, mine)
wd_after_1 = expert.read_json(expert.state_dir(root, "watchdog.json"), {})

# Simulate progress: v1.0 release index.html created -> next watchdog wake resets consecutiveWakes to 0 then increments to 1
os.makedirs(os.path.join(root, "datas", "releases", "v1.0"), exist_ok=True)
open(os.path.join(root, "datas", "releases", "v1.0", "index.html"), "w").write("<html>v1.0</html>")
wd_state = expert.read_json(expert.state_dir(root, "watchdog.json"), {})
wd_state["lastWakeAtMs"] = now - 25000
expert.write_json(expert.state_dir(root, "watchdog.json"), wd_state)
expert.leader_watchdog(root, name_, mine)
wd_after_progress = expert.read_json(expert.state_dir(root, "watchdog.json"), {})

# Now 2 more wakes without any progress -> reaches 3 wakes
for _ in range(2):
    wd_state = expert.read_json(expert.state_dir(root, "watchdog.json"), {})
    wd_state["lastWakeAtMs"] = now - 25000
    expert.write_json(expert.state_dir(root, "watchdog.json"), wd_state)
    expert.leader_watchdog(root, name_, mine)
wd_at_3 = expert.read_json(expert.state_dir(root, "watchdog.json"), {})

# 4th attempt with no progress -> trips circuit breaker, writes anomaly note, notifies s_front, does NOT wake s_leader!
reset_calls()
wd_state = expert.read_json(expert.state_dir(root, "watchdog.json"), {})
wd_state["lastWakeAtMs"] = now - 25000
expert.write_json(expert.state_dir(root, "watchdog.json"), wd_state)
expert.leader_watchdog(root, name_, mine)
wd_tripped = expert.read_json(expert.state_dir(root, "watchdog.json"), {})
wd_breaker_calls = get_calls()
wd_notes = [json.load(open(os.path.join(expert.notes_dir(root), f))) for f in os.listdir(expert.notes_dir(root))] if os.path.isdir(expert.notes_dir(root)) else []

# ---------------------------------------------------------------------------
# Case 5: Dynamic sub-worktree isolation (--worktree auto & lock contention auto-cut)
# ---------------------------------------------------------------------------
shutil.rmtree(expert.state_dir(root), ignore_errors=True)
reset_calls()
repo_dir = os.path.join(root, "datas", "arpg-repo")
os.makedirs(repo_dir, exist_ok=True)
subprocess.run(["git", "init", "-q", "-b", "main", repo_dir], check=True)
open(os.path.join(repo_dir, "game.js"), "w").write("console.log('v0');\\n")
subprocess.run(["git", "-C", repo_dir, "add", "-A"], check=True)
subprocess.run(["git", "-C", repo_dir, "-c", "user.name=t", "-c", "user.email=t@local", "commit", "-q", "-m", "init"], check=True)
with contextlib.redirect_stdout(io.StringIO()):
    expert.cmd_worktree(type("A", (), {"worktree_command": "create", "slot": "skill-lead", "repo": repo_dir, "branch": "wt/skill-lead", "base": "main", "space": "skill-lead"})())

os.environ["GENEHUB_SESSION_ID"] = "s_lead_session"
# Spawn 3 concurrent workers into skill-lead: first takes or cuts auto worktree, next ones auto-cut isolated sub-worktrees without lock collision!
spawned_records = []
for idx in range(3):
    with contextlib.redirect_stdout(io.StringIO()):
        expert.cmd_spawn(type("A", (), {
            "expert": None, "space": "skill-lead", "kind": "work",
            "worktree": "auto" if idx == 0 else None,
            "desc": "并发技能子任务%d" % idx, "dir": None, "agent": "ctl-normal", "model": "m1", "tier": None, "media": None, "effort": None,
            "task": ["实现技能子模块 %d" % idx],
        })())
for fname in sorted(os.listdir(expert.state_dir(root, "pending"))):
    spawned_records.append(expert.read_json(expert.state_dir(root, "pending", fname), {}))

print(json.dumps({
    "c1": {
        "tick1Calls": c1_tick1_calls,
        "tick1Pending": c1_tick1_pending,
        "tick2Calls": c1_tick2_calls,
        "tick2Pending": c1_tick2_pending,
        "leadBaselineAfterTick2": c1_lead_rec_after_tick2.get("baseline"),
        "tick3Calls": c1_tick3_calls,
        "tick3Pending": c1_tick3_pending,
    },
    "c2": {
        "calls": c2_calls,
        "pending": c2_pending,
    },
    "c3": {
        "requesterAfterPeerSend": rec_after_peer_send.get("requester"),
        "watchersAfterPeerSend": rec_after_peer_send.get("watchers"),
        "pendingAfterQuestion": c3_pending_after_question,
    },
    "c4": {
        "after1": wd_after_1,
        "afterProgress": wd_after_progress,
        "at3": wd_at_3,
        "tripped": wd_tripped,
        "breakerCalls": wd_breaker_calls,
        "notes": wd_notes,
    },
    "c5": {
        "records": spawned_records,
    },
}))
`;

defineSpecialty(
  {
    ...base,
    id: "specialty.daemon.expert-three-law-team-relay",
    title: "Multi-level team relay obeys the Three Laws: hold-until-parent-ready, bounded terminal states on partial failure, and leader watchdog with 3-strike circuit breaker, plus dynamic sub-worktrees",
    oracle:
      "in a 3-tier team (Leader -> Lead -> 5 Workers + 1 Research), grandchildren finishing while Lead is still running Turn 1 are held in pending/ so Lead's Turn 1 completion is never mistaken for its final answer to Leader, and instead wakes Lead for Turn 2 with its baseline advanced; a multi-item batch containing normal, failed, stopped and stuck children converts anomalies to bounded done states and delivers one merged batch summary to the parent (with --unpause when the parent had failed) while auto-approving waiting permission requests in team spaces; peer questions do not hijack pending requester or close pending records; leader_watchdog wakes an idle/failed leader when MILESTONE_PLAN.md has unfinished items, resets consecutiveWakes on progress, and trips the circuit breaker after 3 consecutive wakes without progress; spawning concurrent workers into one team space automatically cuts isolated sub-worktrees without writer-lock contention",
    catches: [
      "a Lead session's Turn 1 dispatch reply prematurely delivered to Leader as the final result because its fast children were moved out of pending/ while Lead was still running",
      "one failed, stopped or stuck worker in a 5-worker batch blocking the other 4 completed workers from ever waking their parent",
      "a parent session that entered failed or paused state never waking up when its children finish",
      "a peer sending a question to a running worker overwriting its pending requester or a worker asking a question closing its own pending task",
      "a team Leader stalling forever with unfinished milestones, or a watchdog looping infinitely without a circuit breaker",
      "a sub-team Lead failing with writer-lock contention when spawning multiple concurrent workers in the same role space",
    ],
  },
  async (t) => {
    const data = join(t.env.root, "three-law");
    const team = join(data, "spaces", "arpg-team");
    mkdirSync(data, { recursive: true });
    cpSync(join(t.openRoot, TEAM_TEMPLATE), team, { recursive: true });
    const fake = join(data, "genet");
    writeFileSync(fake, FAKE_GENET, { mode: 0o755 });
    const state = join(data, "state.json");
    const builder = join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py");
    const done = spawnSync("python3", ["-c", THREE_LAW_DRIVER], {
      env: { PATH: process.env.PATH ?? "", HOME: data, GENEHUB_CLI: fake, FAKE_STATE: state, TEAM: team, EXPERT_SPACEBUILDER: builder },
      encoding: "utf8",
    });
    t.assertions.assert(done.status === 0, `three-law driver failed: ${done.stderr}`);
    const out = JSON.parse(done.stdout) as {
      c1: {
        tick1Calls: Call[];
        tick1Pending: string[];
        tick2Calls: Call[];
        tick2Pending: string[];
        leadBaselineAfterTick2: string;
        tick3Calls: Call[];
        tick3Pending: string[];
      };
      c2: { calls: Call[]; pending: string[] };
      c3: { requesterAfterPeerSend: string; watchersAfterPeerSend: string[]; pendingAfterQuestion: string[] };
      c4: {
        after1: { consecutiveWakes: number; circuitBroken: boolean };
        afterProgress: { consecutiveWakes: number; circuitBroken: boolean };
        at3: { consecutiveWakes: number; circuitBroken: boolean };
        tripped: { consecutiveWakes: number; circuitBroken: boolean };
        breakerCalls: Call[];
        notes: Array<{ kind: string; context: string; text: string }>;
      };
      c5: { records: Array<{ sessionId: string; worktree?: string; branch?: string; dir?: string; lock?: string }> };
    };

    // Case 1 assertions: Multi-level Fractal Relay (Leader -> Lead -> 5 Workers + 1 Research)
    t.assertions.assert(
      out.c1.tick1Calls.length === 0 && out.c1.tick1Pending.length === 7,
      `Tick 1 while Lead is running must hold all 6 children in pending and send nothing: calls=${JSON.stringify(out.c1.tick1Calls)} pending=${JSON.stringify(out.c1.tick1Pending)}`,
    );
    t.assertions.assert(
      out.c1.tick2Calls.length === 1 &&
        out.c1.tick2Calls[0]![2] === "s_lead" &&
        out.c1.tick2Calls[0]![3]!.includes("批次完成（6 项）") &&
        out.c1.leadBaselineAfterTick2 === "i_lead_turn1" &&
        out.c1.tick2Pending.join(",") === "s_lead.json",
      `Tick 2 when Lead finishes Turn 1 must wake Lead (NOT Leader!) with 6-item batch and advance Lead baseline: ${JSON.stringify(out.c1)}`,
    );
    t.assertions.assert(
      out.c1.tick3Calls.length === 1 &&
        out.c1.tick3Calls[0]![2] === "s_leader" &&
        out.c1.tick3Calls[0]![3]!.includes("5个技能子模块与数值调研全部合入通过") &&
        out.c1.tick3Pending.length === 0,
      `Tick 3 when Lead finishes Turn 2 must deliver final result to Leader and clear pending: ${JSON.stringify(out.c1)}`,
    );

    // Case 2 assertions: Law 1 Bounded Terminal States + Team Auto-Unblock + Failed Parent Auto-Unpause
    const unblockCall = out.c2.calls.find((c) => c.slice(0, 2).join(" ") === "session respond");
    t.assertions.assert(
      unblockCall !== undefined && unblockCall[2] === "s_wait_perm" && unblockCall.includes("req_perm_99") && unblockCall.includes("--choose"),
      `Team waiting session was not auto-unblocked: ${JSON.stringify(out.c2.calls)}`,
    );
    const batchResultCall = out.c2.calls.find((c) => c[0] === "session" && c[1] === "send" && c[2] === "s_leader" && c[3]!.includes("批次完成（4 项）"));
    t.assertions.assert(
      batchResultCall !== undefined &&
        batchResultCall[3]!.startsWith("【人类唤醒】\n用途: result") &&
        batchResultCall[3]!.includes("正常模块已完成") &&
        batchResultCall[3]!.includes("会话已失败") &&
        batchResultCall[3]!.includes("会话已停止，没有给出回复") &&
        batchResultCall[3]!.includes("超过 60 秒没有进展（已熔断"),
      `Partial failure/stopped/stuck batch did not deliver bounded 4-item summary with 【人类唤醒】 unpause prefix to failed s_leader: ${JSON.stringify(out.c2.calls)}`,
    );
    t.assertions.assert(
      out.c2.pending.join(",") === "s_wait_perm.json",
      `All 4 batch children should be moved to done/ leaving only s_wait_perm: ${JSON.stringify(out.c2.pending)}`,
    );

    // Case 3 assertions: Non-hijacking send & question does not close pending
    t.assertions.assert(
      out.c3.requesterAfterPeerSend === "s_111122223333" && out.c3.watchersAfterPeerSend.includes("s_777788889999"),
      `Peer send hijacked requester: ${JSON.stringify(out.c3)}`,
    );
    t.assertions.assert(
      out.c3.pendingAfterQuestion.includes("s_444455556666.json"),
      `Worker sending a question prematurely closed its pending record: ${JSON.stringify(out.c3)}`,
    );

    // Case 4 assertions: Law 3 Leader Watchdog + Progress Reset + 3-Strike Circuit Breaker
    t.assertions.assert(out.c4.after1.consecutiveWakes === 1 && !out.c4.after1.circuitBroken, `Watchdog wake #1: ${JSON.stringify(out.c4.after1)}`);
    t.assertions.assert(out.c4.afterProgress.consecutiveWakes === 1 && !out.c4.afterProgress.circuitBroken, `Watchdog after progress did not reset before counting: ${JSON.stringify(out.c4.afterProgress)}`);
    t.assertions.assert(out.c4.at3.consecutiveWakes === 3 && !out.c4.at3.circuitBroken, `Watchdog at 3 wakes: ${JSON.stringify(out.c4.at3)}`);
    t.assertions.assert(
      out.c4.tripped.circuitBroken === true &&
        !out.c4.breakerCalls.some((c) => c[2] === "s_leader") &&
        out.c4.breakerCalls.some((c) => c[2] === "s_front" && c[3]!.includes("已触发看门狗熔断")) &&
        out.c4.notes.some((n) => n.kind === "anomaly" && n.context.includes("连续 3 次看门狗唤醒")),
      `Watchdog 3-strike circuit breaker did not trip cleanly: ${JSON.stringify(out.c4)}`,
    );

    // Case 5 assertions: Dynamic Sub-Worktree Isolation for concurrent workers in the same role space
    const locks = new Set(out.c5.records.map((r) => r.lock).filter(Boolean));
    const subWtRecords = out.c5.records.filter((r) => r.worktree && r.branch?.startsWith("worker/"));
    const subWtDirs = new Set(subWtRecords.map((r) => r.worktree));
    t.assertions.assert(
      out.c5.records.length === 3 && locks.size === 3 && subWtRecords.length === 2 && subWtDirs.size === 2,
      `3 concurrent workers in skill-lead did not get 3 isolated worktrees/locks (1 primary + 2 sub-worktrees): ${JSON.stringify(out.c5.records)}`,
    );
  },
);

