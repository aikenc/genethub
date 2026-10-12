#!/usr/bin/env python3
"""expert.py: how one expert's sessions talk to each other. Everything it knows is in files and in `genet`.

  send --to <session id | EXPERT:default> [--kind TEXT] TEXT   queue a system notice to a session
  spawn --kind topic|work --desc TEXT [--dir PATH] TASK        start a background session and watch it
  directory [--expert NAME]                                    list experts and their live sessions
  mount PATH | unmount PATH                                    claim / release a business directory
  hook                                                         run by the daemon's timer; not for Agents

Failure modes (each error says what happened, the state now, and what to do next):
  send   target missing / archived      -> error text, nothing queued           -> `directory`, or send to EXPERT:default
  send   target queue full (limit)      -> error text, nothing queued           -> wait, or send to another session
  spawn  writer lock held by a live one -> error text, no session created       -> wait for it, or pick another directory
  hook   `genet` fails or session gone  -> reported to the front once, record kept or moved to done/
  hook   unhandled exception            -> system message to the front, exit 1; the next tick retries
Every action is idempotent: message ids are derived from what is being said, so a repeat is dropped by the daemon.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time

BODY_LIMIT = 8 * 1024
STOPPED_AFTER_S = int(os.environ.get("EXPERT_STOPPED_AFTER", "60"))
STUCK_AFTER_S = int(os.environ.get("EXPERT_STUCK_AFTER", "3600"))
REFLECT_ROUNDS = int(os.environ.get("EXPERT_REFLECT_ROUNDS", "20"))
QUIET_S = int(os.environ.get("EXPERT_QUIET_SECONDS", "600"))
REPORT_AGAIN_S = 6 * 3600
SYSTEM_LABEL = "系统发起"
ROLE_LABELS = {"topic": "专项", "work": "工作", "default": "默认思考"}
SESSION_ID = re.compile(r"^s_[0-9a-f]+$")


class ExpertError(Exception):
    def __init__(self, what, state, nxt):
        super().__init__(what)
        self.what, self.state, self.next = what, state, nxt

    def text(self):
        return "出了什么: %s\n现在状态: %s\n下一步: %s" % (self.what, self.state, self.next)


# ---------------------------------------------------------------- genet and files

def genet(*args, ok_codes=(0,)):
    cli = os.environ.get("GENEHUB_CLI")
    if not cli:
        raise ExpertError("环境里没有 GENEHUB_CLI", "没有执行任何操作", "在 GeneHub 会话或 timer hook 里运行本脚本")
    done = subprocess.run([cli] + list(args), capture_output=True, text=True, timeout=120)
    lines = [line for line in done.stdout.splitlines() if line.strip()]
    try:
        envelope = json.loads(lines[-1]) if lines else {}  # the answer is the last line; earlier lines are progress
    except ValueError:
        envelope = {}
    if done.returncode not in ok_codes:
        message = (envelope.get("error") or {}).get("message") or done.stderr.strip()[-300:] or "exit %d" % done.returncode
        raise ExpertError("genet %s 失败: %s" % (" ".join(args[:2]), message), "没有产生副作用或已部分完成，见错误", "核对目标会话与参数后重试；操作是幂等的")
    return envelope.get("data") or {}


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = "%s.%d.tmp" % (path, os.getpid())
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=1)
    os.replace(temporary, path)


def descriptor(directory):
    return read_json(os.path.join(directory, "agent-space.genet.json"))


def find_root(start=None):
    here = os.path.realpath(start or os.environ.get("GENEHUB_SPACE_DIR") or os.getcwd())
    while True:
        found = descriptor(here)
        if found and "expert" in (found.get("tags") or []):
            return here
        parent = os.path.dirname(here)
        if parent == here:
            raise ExpertError("当前目录不在任何专家里", "没有执行任何操作", "在专家的目录（或它的 think、work 子目录）里运行")
        here = parent


def open_env(root):
    values = {}
    try:
        with open(os.path.join(root, ".genethub", "open.env"), encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    values[key.strip()] = value.strip().strip('"')
    except OSError:
        pass
    return values


def write_open_env(root, values):
    path = os.path.join(root, ".genethub", "open.env")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write("".join("%s=%s\n" % item for item in sorted(values.items())))
    os.replace(temporary, path)


def state_dir(root, *parts):
    return os.path.join(root, ".genethub", "expert", *parts)


def message_id(*parts):
    return "x." + hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:24]


def now_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------- experts and sessions

def workspaces():
    return genet("workspace", "list").get("workspaces", [])


def workspace_root(entry):
    folders = entry.get("folders") or []
    return os.path.realpath((folders[0].get("root") if folders else entry.get("root")) or "")


def experts():
    """Every expert on this machine: its name, root directory, and the id of each of its Spaces."""
    entries = workspaces()
    by_root = {workspace_root(entry): entry["id"] for entry in entries}
    found = {}
    for root, workspace_id in by_root.items():
        info = descriptor(root)
        if info and "expert" in (info.get("tags") or []):
            spaces = {"root": workspace_id}
            for role in ("think", "work"):
                child = by_root.get(os.path.realpath(os.path.join(root, "spaces", role)))
                if child:
                    spaces[role] = child
            found[info.get("name") or os.path.basename(root)] = {"root": root, "spaces": spaces}
    return found


def me(root):
    name = (descriptor(root) or {}).get("name") or os.path.basename(root)
    return name, experts().get(name) or {"root": root, "spaces": {}}


def sessions_of(workspace_id):
    return genet("session", "list", "--workspace", workspace_id).get("sessions", [])


def live_sessions(workspace_id):
    return [item for item in sessions_of(workspace_id) if not item.get("archived")]


def session_summary(session_id):
    return genet("session", "get", session_id).get("session", {}).get("summary", {})


def agent_for(root):
    configured = open_env(root).get("EXPERT_AGENT")
    if configured:
        return configured
    current = os.environ.get("GENEHUB_SESSION_ID")
    if current:
        agent = session_summary(current).get("agentId")
        if agent:
            return agent
    raise ExpertError("不知道用哪个 Agent 开会话", "没有创建任何会话", "在 .genethub/open.env 里写 EXPERT_AGENT=<agent id>，或从一个会话里运行")


def front_session(root, spaces):
    candidates = [item for item in live_sessions(spaces["root"]) if SYSTEM_LABEL not in (item.get("labels") or [])]
    return max(candidates, key=lambda item: item.get("updatedAtMs", 0))["id"] if candidates else None


def start(root, workspace_id, role, desc, text, model_key):
    env = open_env(root)
    args = ["agent", "run", "--agent", agent_for(root), text, "--workspace", workspace_id, "--label", ROLE_LABELS[role],
            "--label", SYSTEM_LABEL, "--description", desc[:300], "--no-wait"]
    model = env.get(model_key)
    if model:
        args += ["--model", model]
    return genet(*args).get("sessionId")


def clip(text):
    raw = text.encode("utf-8")
    if len(raw) <= BODY_LIMIT:
        return text
    return raw[:BODY_LIMIT].decode("utf-8", "ignore") + "\n…（已截断，用 session narrative 取全文）"


def notice(session_id, purpose, sender, text, *id_parts):
    """Queue a system notice. Idempotent: the id comes from what is said, so a repeat is dropped."""
    summary = session_summary(session_id)
    inputs = summary.get("inputSummary") or {}
    if len(inputs.get("pending") or []) >= inputs.get("limit", 32):
        raise ExpertError("目标 %s 的队列已满（%s 条）" % (session_id, inputs.get("limit", 32)), "没有排入任何消息", "等它处理完，或改发给别的会话")
    if summary.get("archived"):
        raise ExpertError("目标 %s 已归档" % session_id, "没有排入任何消息", "用 `directory` 找现在的会话，或发给 EXPERT:default")
    body = clip("用途: %s\n发送方: %s\n\n%s" % (purpose, sender, text))
    genet("session", "send", session_id, body, "--queue", "--message-id", message_id(session_id, purpose, *id_parts), "--no-wait")


# ---------------------------------------------------------------- commands

def cmd_send(args):
    root = find_root()
    name, mine = me(root)
    sender = os.environ.get("GENEHUB_SESSION_ID") or "%s:hook" % name
    target = args.to
    text = " ".join(args.text)
    if not SESSION_ID.match(target):
        expert_name, _, role = target.partition(":")
        if role != "default":
            raise ExpertError("目标 %r 不是会话 id，也不是 EXPERT:default" % target, "没有排入任何消息", "用 `directory` 查会话 id")
        expert = experts().get(expert_name)
        if not expert or "think" not in expert["spaces"]:
            raise ExpertError("没有专家 %r，或它没有 think 空间" % expert_name, "没有排入任何消息", "用 `directory` 查看有哪些专家")
        existing = [item for item in live_sessions(expert["spaces"]["think"]) if ROLE_LABELS["default"] in (item.get("labels") or [])]
        if not existing:
            created = start(expert["root"], expert["spaces"]["think"], "default", "%s 的默认思考会话：分诊请求、整理记忆" % expert_name,
                            clip("用途: %s\n发送方: %s\n\n%s" % (args.kind, sender, text)), "EXPERT_MODEL_THINK")
            print("已创建 %s 的默认思考会话 %s 并交给它" % (expert_name, created))
            return
        target = existing[0]["id"]
    notice(target, args.kind, sender, text, text)
    print("已排队 → %s" % target)


def writer_lock(path):
    git = subprocess.run(["git", "-C", path, "rev-parse", "--absolute-git-dir"], capture_output=True, text=True)
    base = git.stdout.strip() if git.returncode == 0 else os.path.join(path, ".genethub")
    return base


def claim(path, content, filename):
    """Create the marker exclusively; the filesystem lets exactly one caller win."""
    directory = writer_lock(path)
    os.makedirs(directory, exist_ok=True)
    marker = os.path.join(directory, filename)
    try:
        descriptor_fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return marker, False
    with os.fdopen(descriptor_fd, "w", encoding="utf-8") as handle:
        json.dump(content, handle, ensure_ascii=False, indent=1)
    return marker, True


def cmd_spawn(args):
    root = find_root()
    name, mine = me(root)
    role = "work" if args.kind == "work" else "topic"
    workspace_id = mine["spaces"].get("work" if role == "work" else "think")
    if not workspace_id:
        raise ExpertError("这个专家没有 %s 空间" % ("work" if role == "work" else "think"), "没有创建会话", "确认专家目录里有 spaces/%s/agent-space.genet.json" % ("work" if role == "work" else "think"))
    task = " ".join(args.task)
    lock = None
    if args.dir and role == "work":
        path = os.path.realpath(args.dir)
        marker, won = claim(path, {"session": None, "expert": name, "at": now_ms()}, "genet-writer.json")
        if not won:
            holder = (read_json(marker) or {}).get("session")
            alive = holder and not session_missing(holder) and session_summary(holder).get("status") in ("running", "waiting")
            if alive:
                raise ExpertError("%s 已有写会话 %s 在工作" % (path, holder), "没有创建会话", "等它完成，或换一个目录")
            os.remove(marker)
            marker, won = claim(path, {"session": None, "expert": name, "at": now_ms()}, "genet-writer.json")
            if not won:
                raise ExpertError("%s 的写者锁刚被别人拿走" % path, "没有创建会话", "稍后重试")
        lock = marker
        task += "\n\n业务目录: %s（你是这个目录唯一的写会话）" % path
    requester = os.environ.get("GENEHUB_SESSION_ID")
    session_id = start(root, workspace_id, role, args.desc, clip(task), "EXPERT_MODEL_WORK" if role == "work" else "EXPERT_MODEL_THINK")
    if lock:
        write_json(lock, {"session": session_id, "expert": name, "at": now_ms()})
    write_json(state_dir(root, "pending", session_id + ".json"), {
        "sessionId": session_id, "requester": requester, "kind": args.kind, "desc": args.desc, "createdAtMs": now_ms(),
        "baseline": None, "notified": [], "lock": lock})
    print("已开始 %s 会话 %s；完成后会有系统消息" % (args.kind, session_id))


def session_missing(session_id):
    try:
        session_summary(session_id)
        return False
    except ExpertError:
        return True


def cmd_directory(args):
    lines = []
    for name, expert in sorted(experts().items()):
        if args.expert and args.expert != name:
            continue
        info = descriptor(expert["root"]) or {}
        lines.append("== %s: %s" % (name, info.get("description", "")))
        for role, workspace_id in expert["spaces"].items():
            for item in sorted(live_sessions(workspace_id), key=lambda value: -value.get("updatedAtMs", 0)):
                labels = ",".join(item.get("labels") or [])
                lines.append("%s/%s %s [%s] %s %s" % (name, role, item["id"], item.get("status"), labels, item.get("description") or item.get("title") or ""))
    print("\n".join(lines) if lines else "没有专家")


def project_dirs(env):
    return [item for item in env.get("PROJECT_DIRS", "").split(":") if item]


def cmd_mount(args):
    root = find_root()
    name, _ = me(root)
    path = os.path.realpath(args.path)
    if not os.path.isdir(path):
        raise ExpertError("%s 不是目录" % args.path, "没有认领", "先让工作会话把它准备好（clone 或创建）")
    marker, won = claim(path, {"expert": name, "expertDir": root, "claimedAtMs": now_ms()}, "genet-owner.json")
    if not won:
        holder = read_json(marker) or {}
        stale = not os.path.isdir(holder.get("expertDir", "")) or path not in project_dirs(open_env(holder.get("expertDir", "")))
        if holder.get("expertDir") != root and not stale:
            raise ExpertError("%s 已由专家 %s 负责" % (path, holder.get("expert")), "没有改动任何东西", "让那个专家 unmount，或换一个目录")
        write_json(marker, {"expert": name, "expertDir": root, "claimedAtMs": now_ms()})
    env = open_env(root)
    dirs = project_dirs(env)
    if path not in dirs:
        env["PROJECT_DIRS"] = ":".join(dirs + [path])
        write_open_env(root, env)
    print("已认领 %s" % path)


def cmd_unmount(args):
    root = find_root()
    path = os.path.realpath(args.path)
    marker = os.path.join(writer_lock(path), "genet-owner.json")
    if (read_json(marker) or {}).get("expertDir") == root:
        os.remove(marker)
    env = open_env(root)
    env["PROJECT_DIRS"] = ":".join(item for item in project_dirs(env) if item != path)
    write_open_env(root, env)
    print("已释放 %s" % path)


# ---------------------------------------------------------------- the timer

def last_reply_text(session_id, item_id):
    page = genet("session", "narrative", session_id, "--item", item_id).get("page", {})
    for item in page.get("items", []):
        if item.get("id") == item_id and item.get("text"):
            return item["text"]
    return ""


def reconcile(root, name, mine):
    front = front_session(root, mine["spaces"])
    pending_dir = state_dir(root, "pending")
    for entry in sorted(os.listdir(pending_dir)) if os.path.isdir(pending_dir) else []:
        path = os.path.join(pending_dir, entry)
        record = read_json(path)
        if not record:
            continue
        session_id = record["sessionId"]
        to = record.get("requester") or front
        finish = lambda: move(root, path)  # noqa: E731
        try:
            summary = session_summary(session_id)
        except ExpertError:
            if front:
                notice(front, "report", "%s:hook" % name, "会话 %s（%s）已不存在，待办记录已清除。" % (session_id, record["desc"]), session_id, "gone")
            finish()
            continue
        status = summary.get("status")
        inputs = summary.get("inputSummary") or {}
        requests = (summary.get("interactionSummary") or {}).get("requests") or []
        reply = (summary.get("latestReply") or {}).get("itemId")
        age = (now_ms() - record["createdAtMs"]) / 1000
        said = record.setdefault("notified", [])
        if requests:
            key = "wait:%s" % json.dumps(requests, sort_keys=True)[:200]
            if front and key not in said:
                notice(front, "report", "%s:hook" % name, "会话 %s（%s）在等人处理：%s" % (session_id, record["desc"], json.dumps(requests, ensure_ascii=False)[:600]), session_id, key)
                said.append(key)
                write_json(path, record)
            continue
        if inputs.get("paused") or status == "failed":
            # Told once. An interrupted session's partial reply is not a result, so it is not delivered as one;
            # a paused record stays until the person resumes it, a failed one is closed.
            if "stop" not in said:
                if front:
                    notice(front, "report", "%s:hook" % name, "会话 %s（%s）%s：%s" % (session_id, record["desc"], "已失败" if status == "failed" else "被暂停", inputs.get("error") or "无附加信息"), session_id, "stop")
                said.append("stop")
                write_json(path, record)
            if status == "failed":
                finish()
            continue
        if status == "idle" and reply and reply != record.get("baseline"):
            text = last_reply_text(session_id, reply) or (summary.get("messagePreview") or {}).get("text", "")
            if to:
                notice(to, "result", "%s（%s）" % (session_id, record["desc"]), "%s\n\nref: ghref:item:%s:%s" % (text, session_id, reply), session_id, reply)
            finish()
        elif status == "idle" and age > STOPPED_AFTER_S:
            if to:
                notice(to, "report", "%s:hook" % name, "会话 %s（%s）已停止，没有给出回复。" % (session_id, record["desc"]), session_id, "stopped")
            finish()
        elif status == "running" and (now_ms() - summary.get("updatedAtMs", now_ms())) / 1000 > STUCK_AFTER_S and "stuck" not in said:
            if front:
                notice(front, "report", "%s:hook" % name, "会话 %s（%s）超过 %d 秒没有进展，可能卡住了。" % (session_id, record["desc"], STUCK_AFTER_S), session_id, "stuck")
            said.append("stuck")
            write_json(path, record)


def move(root, path):
    destination = state_dir(root, "done", os.path.basename(path))
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    os.replace(path, destination)


def health(root, name, mine):
    front = front_session(root, mine["spaces"])
    if not front:
        return
    hooks = genet("hook", "list", "--workspace", mine["spaces"]["root"]).get("hooks", [])
    problems = ["%s: %s" % (item["id"], item.get("problem") or item.get("lastError") or "连续失败 %d 次" % item.get("consecutiveFailures", 0))
                for item in hooks if not item.get("valid", True) or item.get("consecutiveFailures", 0) >= 3]
    report_path = state_dir(root, "reported.json")
    last = read_json(report_path, {})
    digest = hashlib.sha1("\n".join(problems).encode()).hexdigest()
    if problems and (last.get("digest") != digest or now_ms() - last.get("atMs", 0) > REPORT_AGAIN_S * 1000):
        notice(front, "report", "%s:hook" % name, "机制出了问题:\n%s\n修好后无需注册，下一次运行自动恢复。待办记录都还在 .genethub/expert/pending/。" % "\n".join(problems), digest, str(now_ms() // (REPORT_AGAIN_S * 1000)))
        write_json(report_path, {"digest": digest, "atMs": now_ms()})
    elif not problems and last.get("digest"):
        write_json(report_path, {})


def grow(root, name, mine):
    front = front_session(root, mine["spaces"])
    if not front:
        return
    marker = state_dir(root, "reflect")
    since = (read_json(marker, {}) or {}).get("atMs", 0)
    rounds = genet("session", "rounds", front).get("page", {}).get("rounds", [])
    fresh = [item for item in rounds if item.get("endedAtMs", 0) > since and item.get("trunkCount", 0) >= 1]
    if len(fresh) >= REFLECT_ROUNDS and now_ms() - max(item["endedAtMs"] for item in fresh) > QUIET_S * 1000:
        notice_target = "%s:default" % name
        args = argparse.Namespace(to=notice_target, kind="reflect", text=["自上次整理以来有 %d 轮实质对话，请整理 memory.md 与 soul.md，并更新各会话的描述。" % len(fresh)])
        cmd_send(args)
        write_json(marker, {"atMs": now_ms()})


def cmd_hook(_args):
    root = find_root()
    name, mine = me(root)
    write_json(state_dir(root, "alive"), {"atMs": now_ms()})
    try:
        reconcile(root, name, mine)
        health(root, name, mine)
        grow(root, name, mine)
    except ExpertError as error:
        report(root, name, mine, error.text())
        raise
    except Exception as error:  # noqa: BLE001 - turned into a system message below, never swallowed
        report(root, name, mine, "出了什么: 未处理的异常 %r\n现在状态: 待办记录都还在 .genethub/expert/pending/\n下一步: 检查 tools/expert.py；修好后下一次运行自动恢复" % error)
        raise


def report(root, name, mine, text):
    try:
        front = front_session(root, mine["spaces"])
        if front:
            notice(front, "report", "%s:hook" % name, text, hashlib.sha1(text.encode()).hexdigest(), str(now_ms() // (REPORT_AGAIN_S * 1000)))
    except Exception:  # noqa: BLE001 - the original failure is re-raised by the caller
        pass


def main(argv):
    parser = argparse.ArgumentParser(prog="expert.py")
    sub = parser.add_subparsers(dest="command", required=True)
    send = sub.add_parser("send")
    send.add_argument("--to", required=True)
    send.add_argument("--kind", default="note")
    send.add_argument("text", nargs="+")
    spawn = sub.add_parser("spawn")
    spawn.add_argument("--kind", choices=["topic", "work"], required=True)
    spawn.add_argument("--desc", required=True)
    spawn.add_argument("--dir")
    spawn.add_argument("task", nargs="+")
    directory = sub.add_parser("directory")
    directory.add_argument("--expert")
    for verb in ("mount", "unmount"):
        sub.add_parser(verb).add_argument("path")
    sub.add_parser("hook")
    args = parser.parse_args(argv)
    handlers = {"send": cmd_send, "spawn": cmd_spawn, "directory": cmd_directory, "mount": cmd_mount, "unmount": cmd_unmount, "hook": cmd_hook}
    try:
        handlers[args.command](args)
    except ExpertError as error:
        print(error.text(), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
