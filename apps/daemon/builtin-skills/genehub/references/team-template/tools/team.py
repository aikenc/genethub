#!/usr/bin/env python3
"""team.py: how one expert's sessions talk to each other. Everything it knows is in files and in `genet`.

  send --to <session id> [--kind TEXT] TEXT                    queue a system notice to a session
  spawn --kind research|work --desc TEXT [--dir PATH] [--tier T | --model ID] [--media image|video] TASK
                                                               start a background session and watch it
  note [--kind K] [--quote TEXT] [--context TEXT] [--expert NAME] [TEXT]
                                                               leave a note for the reflect session: session, turn and ref are filled in
  notes [ls [--all]] | notes done ID... [--result TEXT]        read / close the notes
  tell-user TEXT                                               ask the front to pass a message to the person, as it is
  reflect now [--tier T | --model ID] TEXT                     start a reflect session now, whatever the thresholds say
  snapshot [-m TEXT]                                           commit what changed in the expert's own files (git at the root)
  drift                                                        what differs from the platform's template (git diff against `platform`)
  directory [--expert NAME]                                    list experts, what they keep, and their live sessions
  mount PATH | unmount PATH                                    claim / release a business directory
  path datas|temp|root [GROUP/NAME | --from GIT_URL] [--create]   absolute path under the expert's datas/ or temp/, or the root itself
  datas ls                                                     what is kept under datas/ (and who is writing it)
  temp new SLUG --purpose TEXT | ls | rm TARGET | clean        scratch space: temp/YYMMDD/hhmm_slug_hash4
  reset [--expert NAME] [--with-memory] [--apply]              ONLY when the user asks: restore the template (soul.md included); plan first
  sync-identity                                                recompile soul.md into the Agents' own instruction files
  hook                                                         run by the daemon's timer; not for Agents

Failure modes (each error says what happened, the state now, and what to do next):
  send   target missing / archived      -> error text, nothing queued           -> `directory`; to ask another expert use `note --expert`
  send   target queue full (limit)      -> error text, nothing queued           -> wait, or send to another session
  spawn  writer lock held by a live one -> error text, no session created       -> wait for it, or pick another directory
  note   field missing                  -> the note is kept, a hint says what to add -> add it next time; the reflect session can still follow session/turn/ref
  note   no genet / no session          -> the note is kept without session/turn  -> run it inside a session
  reflect now, no reflect Space         -> error text, nothing created            -> the expert predates reflect; `reset` (only if the user asks)
  reflect now, one already running      -> the request is queued into it          -> wait for its result
  git    `git` not installed            -> reported to the front once, files untouched -> install git; the next tick initialises the repository
  hook   `genet` fails or session gone  -> reported to the front once, record kept or moved to done/
  temp   slug invalid / target outside temp/ -> error text, nothing created or removed -> follow the rule in the error
  reset  without --apply                -> prints the plan, changes nothing        -> let the reflect session upgrade; reset only if the user asks, then show the plan
  reset  target not found / ambiguous   -> error text, nothing changed             -> `directory`, use the exact name or directory name
  reset  rebuild fails                  -> files are already reset, backup named   -> fix the error, run spacebuilder.py build <dir>
  hook   temp older than the keep time  -> removed once an hour, never what changed in the last 24 hours
  hook   soul.md changed, rebuild fails -> reported to the front, retried after 60s -> fix the cause named in the report
  hook   unhandled exception            -> system message to the front, exit 1; the next tick retries
  spawn  no route has the medium / tier -> error text, no session created       -> `genet agent list --routes`, pick a --tier or --model
Every action is idempotent: message ids are derived from what is being said, so a repeat is dropped by the daemon.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
BODY_LIMIT = 8 * 1024
STOPPED_AFTER_S = int(os.environ.get("EXPERT_STOPPED_AFTER", "60"))
GIVEUP_AFTER_S = int(os.environ.get("EXPERT_GIVEUP_AFTER", "1800"))
STUCK_AFTER_S = int(os.environ.get("EXPERT_STUCK_AFTER", "300"))
# The daemon's own wording for a turn that died (`apps/daemon/src/session/inbox.rs:808`); it pauses the session
# with this message, which is the only way to tell a dead turn from a pause the person asked for.
TURN_FAILED_ERROR = "本轮失败，已接收消息保留"
# Patience for one member of a batch whose siblings are already finished: a leader driving 5-10 workers must
# not wait the single-task threshold for a member that has gone quiet, or every finished result waits with it.
# This never shortens a member that is still doing something; only its own silence ends the wait.
BATCH_STUCK_AFTER_S = int(os.environ.get("EXPERT_BATCH_STUCK_AFTER", "90"))
WATCHDOG_AFTER_S = int(os.environ.get("EXPERT_WATCHDOG_AFTER", "15"))
WATCHDOG_MAX_WAKES = int(os.environ.get("EXPERT_WATCHDOG_MAX_WAKES", "3"))
# When the timer wakes the reflect session. Each can be overridden by the environment or `.genethub/open.env`.
WAKE_ROUNDS = 3          # user-initiated rounds since the last wake
WAKE_GAP_S = 600         # least time between two wakes (`reflect now` and urgent notes ignore it)
NOTE_QUIET_S = 60        # ordinary notes wait this long so one start handles a batch; urgent notes wake immediately
WAKE_CHECK_S = 60        # how often the rounds are counted (counting asks the daemon)
PLATFORM_CHECK_S = 60    # how often the template is compared with the platform branch
REPORT_AGAIN_S = 6 * 3600
HEALTH_CHECK_S = 60      # how often the timer asks the daemon whether its hooks are broken (one `hook list` is ~2s)
TEMP_KEEP_DAYS = float(os.environ.get("EXPERT_TEMP_KEEP_DAYS", "7"))
TEMP_ACTIVE_S = 24 * 3600
TEMP_CLEAN_EVERY_S = 3600
SLUG_RULE = "slug 只能用小写字母、数字和连字符（如 fix-login、review-pr-42），1 到 30 个字符，要能看出用途；用途是中文就写成英文 slug，中文放进 --purpose"
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DATE_DIR = re.compile(r"^\d{6}$")
SYSTEM_LABEL = "系统发起"
ROLE_LABELS = {"research": "研究", "work": "工作", "reflect": "反思", "team-reflect": "反思", "leader": "组长", "qa": "验收"}
SESSION_ID = re.compile(r"^s_[0-9a-f]+$")


class ExpertError(Exception):
    def __init__(self, what, state, nxt):
        super().__init__(what)
        self.what, self.state, self.next = what, state, nxt

    def text(self):
        return "出了什么: %s\n现在状态: %s\n下一步: %s" % (self.what, self.state, self.next)


# ---------------------------------------------------------------- genet and files

def _resolve_genet_env():
    env = dict(os.environ)
    cli = env.get("GENEHUB_CLI")
    script_abs = os.path.realpath(__file__)
    parts = script_abs.split(os.sep)
    if "spaces" in parts:
        idx = len(parts) - 1 - parts[::-1].index("spaces")
        daemon_dir = os.sep.join(parts[:idx]) or os.sep
        slot_cli = os.path.realpath(os.path.join(daemon_dir, "..", "..", "install", "bin", "genet-dev"))
        if os.path.isfile(os.path.join(daemon_dir, "config.json")) and os.path.isfile(slot_cli):
            real_daemon = os.path.realpath(daemon_dir)
            cur_data_dir = os.path.realpath(env["GENEHUB_DEV_DATA_DIR"]) if env.get("GENEHUB_DEV_DATA_DIR") else None
            if cur_data_dir != real_daemon:
                env.pop("GENEHUB_CONTROLLER_TOKEN", None)
                env.pop("GENEHUB_EXECUTION_LEASE", None)
            env["GENEHUB_DEV_DATA_DIR"] = real_daemon
            if not cli or os.path.realpath(cli) != slot_cli:
                cli = slot_cli
                env["GENEHUB_CLI"] = slot_cli
                env.pop("GENEHUB_CONTROLLER_TOKEN", None)
                env.pop("GENEHUB_EXECUTION_LEASE", None)
    return cli, env


def genet(*args, ok_codes=(0,)):
    cli, env = _resolve_genet_env()
    if not cli:
        raise ExpertError("环境里没有 GENEHUB_CLI", "没有执行任何操作", "在 GeneHub 会话或 timer hook 里运行本脚本")
    done = subprocess.run([cli] + list(args), capture_output=True, text=True, env=env, timeout=120)
    if done.returncode not in ok_codes and "401 Unauthorized" in (done.stdout + done.stderr):
        if env.get("GENEHUB_CONTROLLER_TOKEN") or env.get("GENEHUB_EXECUTION_LEASE"):
            retry_env = dict(env)
            retry_env.pop("GENEHUB_CONTROLLER_TOKEN", None)
            retry_env.pop("GENEHUB_EXECUTION_LEASE", None)
            done = subprocess.run([cli] + list(args), capture_output=True, text=True, env=retry_env, timeout=120)
    lines = [line for line in done.stdout.splitlines() if line.strip()]
    try:
        envelope = json.loads(lines[-1]) if lines else {}  # the answer is the last line; earlier lines are progress
    except ValueError:
        envelope = {}
    if done.returncode not in ok_codes:
        message = (envelope.get("error") or {}).get("message") or done.stderr.strip()[-300:] or "exit %d" % done.returncode
        raise ExpertError("genet %s 失败: %s" % (" ".join(args[:2]), message), "没有产生副作用或已部分完成，见错误", "核对目标会话与参数后重试；操作是幂等的")
    if len(args) >= 2 and args[0] == "space" and args[1] == "open":
        _WORKSPACES_CACHE["items"] = None
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


def _walk_expert_root(path):
    if not path:
        return None
    here = os.path.realpath(path)
    while True:
        found = descriptor(here)
        if found and "expert" in (found.get("tags") or []):
            return here
        parent = os.path.dirname(here)
        if parent == here:
            return None
        here = parent


def find_root(start=None):
    if start:
        root = _walk_expert_root(start)
        if root:
            return root
    script_root = _walk_expert_root(os.path.dirname(os.path.abspath(__file__)))
    cwd_root = _walk_expert_root(os.getcwd())
    env_root = _walk_expert_root(os.environ.get("GENEHUB_SPACE_DIR")) if os.environ.get("GENEHUB_SPACE_DIR") else None
    if script_root and not script_root.replace(os.sep, "/").endswith(
        "/builtin-skills/genehub/references/team-template"
    ):
        if cwd_root and cwd_root != env_root:
            return cwd_root
        return script_root
    if cwd_root:
        return cwd_root
    if env_root:
        return env_root
    if script_root:
        return script_root
    raise ExpertError("当前目录不在任何专家里", "没有执行任何操作", "在专家的目录（或它的 research、work、reflect 子目录）里运行")


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


def setting(root, key, default):
    """A number the environment or the machine's `.genethub/open.env` may override."""
    value = os.environ.get(key) or open_env(root).get(key)
    try:
        return float(value) if value not in (None, "") else default
    except ValueError:
        return default


def state_dir(root, *parts):
    return os.path.join(root, ".genethub", "expert", *parts)


def message_id(*parts):
    return "x." + hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:24]


def now_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------- experts and sessions

_WORKSPACES_CACHE = {"at": 0.0, "items": None}
WORKSPACES_TTL = 10.0


def workspaces():
    now = time.time()
    if _WORKSPACES_CACHE["items"] is None or now - _WORKSPACES_CACHE["at"] > WORKSPACES_TTL:
        _WORKSPACES_CACHE["items"] = genet("workspace", "list").get("workspaces", [])
        _WORKSPACES_CACHE["at"] = time.time()
    return _WORKSPACES_CACHE["items"]


def workspace_root(entry):
    folders = entry.get("folders") or []
    return os.path.realpath((folders[0].get("root") if folders else entry.get("root")) or "")


def child_role_names(root):
    spaces_dir = os.path.join(root, "spaces")
    if not os.path.isdir(spaces_dir):
        return []
    out = []
    try:
        entries = sorted(os.listdir(spaces_dir))
    except OSError:
        return []
    for item in entries:
        if not item.startswith(".") and os.path.isfile(os.path.join(spaces_dir, item, ROOT_DESCRIPTOR)):
            out.append(item)
    return out


def experts():
    """Every expert on this machine: its name, root directory, and the id of each of its Spaces."""
    entries = workspaces()
    by_root = {workspace_root(entry): entry["id"] for entry in entries}
    by_root_name = {workspace_root(entry): entry.get("name") for entry in entries}
    spaces_dirs = {os.path.dirname(root) for root in by_root if os.path.basename(os.path.dirname(root)) == "spaces"}
    reopened = False
    for spaces_dir in list(spaces_dirs):
        try:
            candidates = [os.path.join(spaces_dir, item) for item in os.listdir(spaces_dir)]
        except OSError:
            continue
        for candidate in candidates:
            if not os.path.isdir(candidate):
                continue
            info = descriptor(candidate)
            if not (info and "expert" in (info.get("tags") or [])):
                continue
            real = os.path.realpath(candidate)
            expected_name = info.get("name") or os.path.basename(real)
            roles = child_role_names(real) or ["research", "work", "reflect"]
            missing_role = any(
                os.path.isdir(os.path.join(real, "spaces", role))
                and os.path.realpath(os.path.join(real, "spaces", role)) not in by_root
                for role in roles
            )
            if real not in by_root or missing_role or by_root_name.get(real) != expected_name:
                try:
                    genet("space", "open", real)
                    reopened = True
                except ExpertError:
                    pass
    if reopened:
        entries = workspaces()
        by_root = {workspace_root(entry): entry["id"] for entry in entries}
    found = {}
    for root, workspace_id in by_root.items():
        info = descriptor(root)
        if info and "expert" in (info.get("tags") or []):
            spaces = {"root": workspace_id}
            for role in child_role_names(root):
                child = by_root.get(os.path.realpath(os.path.join(root, "spaces", role)))
                if child:
                    spaces[role] = child
            found[info.get("name") or os.path.basename(root)] = {"root": root, "spaces": spaces}
    return found


def me(root):
    real = os.path.realpath(root)
    name = (descriptor(real) or {}).get("name") or os.path.basename(real)
    entries = workspaces()
    by_root = {workspace_root(entry): entry["id"] for entry in entries}
    roles = child_role_names(real)
    spaces = {}
    if real in by_root:
        spaces["root"] = by_root[real]
    for role in roles:
        child = by_root.get(os.path.realpath(os.path.join(real, "spaces", role)))
        if child:
            spaces[role] = child
    expected_count = 1 + len(roles)
    if len(spaces) < expected_count:
        try:
            genet("space", "open", real)
            entries = workspaces()
            by_root = {workspace_root(entry): entry["id"] for entry in entries}
            spaces = {}
            if real in by_root:
                spaces["root"] = by_root[real]
            for role in roles:
                child = by_root.get(os.path.realpath(os.path.join(real, "spaces", role)))
                if child:
                    spaces[role] = child
        except ExpertError:
            pass
    return name, {"root": real, "spaces": spaces}


_WORKSPACE_SESSIONS_CACHE = {}

# 默认 CLI 单次调用直接查实时会话列表；定时钩子将 SESSIONS_TTL 设为 HOOK_SESSIONS_TTL 以在一轮内复用快照。
SESSIONS_TTL = 0.0
HOOK_SESSIONS_TTL = 20.0


def clear_sessions_cache():
    _WORKSPACE_SESSIONS_CACHE.clear()


def auto_describe_session(session_id, text):
    """Best-effort update of a resident session's one-line description so sidebar titles never go stale."""
    if not session_id or not SESSION_ID.match(str(session_id)) or not text:
        return
    clean = " ".join(str(text).splitlines()).strip()
    if not clean:
        return
    while len(clean.encode("utf-8")) > 160:
        clean = clean[:-2].rstrip() + "…"
    try:
        genet("session", "describe", session_id, clean)
    except Exception:
        pass


def sessions_of(workspace_id, max_age=None):
    if not workspace_id:
        return []
    now = time.time()
    age = SESSIONS_TTL if max_age is None else max_age
    cached = _WORKSPACE_SESSIONS_CACHE.get(workspace_id)
    if age <= 0 or cached is None or now - cached[0] > age:
        items = genet("session", "list", "--workspace", workspace_id).get("sessions", [])
        _WORKSPACE_SESSIONS_CACHE[workspace_id] = (time.time(), items)
        return items
    return cached[1]


def live_sessions(workspace_id):
    return [item for item in sessions_of(workspace_id) if not item.get("archived")]


def session_summary(session_id):
    return genet("session", "get", session_id).get("session", {}).get("summary", {})


def same_expert_session(root, session_id, spaces=None):
    """True when `session_id` belongs to one of `root`'s own Spaces (root or `spaces/<role>`)."""
    if not session_id:
        return False
    if spaces is None:
        _, mine = me(root)
        spaces = mine.get("spaces") or {}
    valid_wids = set(spaces.values())
    if not valid_wids:
        return False
    try:
        wid = session_summary(session_id).get("workspaceId")
        if wid:
            return wid in valid_wids
    except ExpertError:
        pass
    for wid in valid_wids:
        if any(item.get("id") == session_id for item in sessions_of(wid)):
            return True
    return False


COST_RANK = {"veryLow": 0, "low": 1, "medium": 2, "high": 3, "veryHigh": 4}
TIERS = ("Ultra", "Max", "Pro", "Flash", "Mini")
MEDIA_TAGS = {"image": "图片理解", "video": "视频理解"}


def requester_summary(root):
    """The session this one is started on behalf of: the caller, or, from the timer, the expert's front."""
    current = os.environ.get("GENEHUB_SESSION_ID")
    summary = {}
    if current:
        try:
            summary = session_summary(current)
        except ExpertError:
            summary = {}
        if summary and not summary.get("workspaceId"):
            return summary
    try:
        _, mine = me(root)
        spaces = mine.get("spaces") or {}
    except ExpertError:
        spaces = {}
    if current and summary and (not spaces or same_expert_session(root, current, spaces)):
        return summary
    front = front_session(root, spaces) if "root" in spaces else None
    if not front:
        for role in ("work", "research", "leader"):
            wid = spaces.get(role)
            if wid:
                candidates = live_sessions(wid)
                if candidates:
                    front = max(candidates, key=lambda item: item.get("updatedAtMs", 0))["id"]
                    break
    if not front and current:
        return summary if summary else (session_summary(current) if current else {})
    if not front:
        for cand in candidate_roots(root):
            if os.path.realpath(cand) == os.path.realpath(root):
                continue
            try:
                _, cmine = me(cand)
                cspaces = cmine.get("spaces") or {}
            except ExpertError:
                cspaces = {}
            if "root" in cspaces:
                front = front_session(cand, cspaces)
                if front:
                    break
    if front:
        summary = session_summary(front)
    env_agent = open_env(root).get("EXPERT_AGENT")
    if not summary.get("agentId") or (env_agent and summary.get("agentId") != env_agent):
        try:
            all_routes = routes()
        except ExpertError:
            all_routes = []
        if all_routes:
            pool = [r for r in all_routes if r["agentId"] == env_agent] if env_agent else []
            if not pool:
                pool = [r for r in all_routes if any(t in (r.get("tags") or []) for t in TIERS)] or all_routes
            best = min(pool, key=lambda r: (COST_RANK.get(r.get("cost"), 2), 0 if r.get("default") else 1))
            return {"agentId": best["agentId"], "modelId": best.get("modelId")}
    return summary


def routes(*filters):
    return genet("agent", "list", "--routes", *filters).get("routes", [])


def pick_equivalent(inherited, everything, with_medium):
    """The route that does what the inherited one does and also understands the medium: same tier tags,
    cost level nearest to the inherited one, the cheaper on a tie. None when there is no such route."""
    mine = next((r for r in everything if r["agentId"] == inherited["agentId"] and r.get("modelId") == inherited.get("modelId")), None)
    if mine is None:
        return None
    tiers = [tag for tag in mine["tags"] if tag in TIERS]
    cost = COST_RANK.get(mine["cost"], 2)
    fits = [r for r in with_medium if r.get("modelId") and all(tag in r["tags"] for tag in tiers)]
    return min(fits, key=lambda r: (abs(COST_RANK.get(r["cost"], 2) - cost), COST_RANK.get(r["cost"], 2), r["agentId"], r["modelId"]), default=None)


def choose(root, model_key, tier=None, model=None, media=None):
    """The `agent run` arguments that pick the Agent and model, and one line saying why.
    Order: asked for explicitly, then this machine's own override, then what the requester runs on."""
    if tier and model:
        raise ExpertError("--tier 和 --model 不能同时给", "没有创建任何会话", "只留一个：档位让平台选，模型是点名")
    env = open_env(root)
    if tier:
        if tier not in TIERS:
            raise ExpertError("档位 %r 不是 Ultra / Max / Pro / Flash / Mini" % tier, "没有创建任何会话", "用 `genet agent list --routes` 看可用的档位")
        tags = [tier] + ([MEDIA_TAGS[media]] if media else [])
        args = ["--tag", tier] + (["--media", media] if media else [])
        if not routes(*sum((["--tag", tag] for tag in tags if tag in TIERS), []), *(["--media", media] if media else [])):
            raise ExpertError("本机没有同时满足 %s 的路由" % " + ".join(tags), "没有创建任何会话", "换一个档位，或让用户在设置里给模型加上对应标签")
        return args, "档位 %s%s" % (tier, " + " + media if media else "")
    agent = env.get("EXPERT_AGENT")
    if model:
        agent = agent or requester_summary(root).get("agentId")
        if not agent:
            raise ExpertError("不知道用哪个 Agent 开会话", "没有创建任何会话", "在 .genethub/open.env 里写 EXPERT_AGENT=<agent id>，或从一个会话里运行")
        if media and not any(r["agentId"] == agent and r.get("modelId") == model for r in routes("--media", media)):
            raise ExpertError("点名模型 %s/%s 看不了%s" % (agent, model, media), "没有创建任何会话", "换一个能看%s的模型，或去掉 --model 让系统按档位选择" % media)
        return ["--agent", agent, "--model", model], "点名模型 %s" % model
    override = env.get(model_key)
    inherited = requester_summary(root)
    if not agent:
        agent = inherited.get("agentId")
    if not agent:
        raise ExpertError("不知道用哪个 Agent 开会话", "没有创建任何会话", "在 .genethub/open.env 里写 EXPERT_AGENT=<agent id>，或从一个会话里运行")
    if override:
        return ["--agent", agent, "--model", override], "本机覆盖 %s=%s" % (model_key, override)
    args, why = ["--agent", agent], "Agent %s，模型用它自己的默认" % agent
    if inherited.get("agentId") == agent and inherited.get("modelId"):
        route = {"agentId": agent, "modelId": inherited["modelId"]}
        why = "沿用请求方的 %s/%s" % (agent, inherited["modelId"])
        if media:
            fits = routes("--media", media)
            if not any(r["agentId"] == agent and r.get("modelId") == inherited["modelId"] for r in fits):
                route = pick_equivalent(route, routes(), fits)
                if route is None:
                    raise ExpertError("请求方的模型 %s/%s 看不了%s，本机也没有同档位、能看%s的模型" % (agent, inherited["modelId"], media, media),
                                      "没有创建任何会话", "告诉用户这件事需要能看%s的模型；或用 --tier 指定一个有对应标签的档位" % media)
                agent = route["agentId"]
                why = "请求方的模型看不了%s，换成同档位、成本最接近的 %s/%s" % (media, agent, route["modelId"])
        args = ["--agent", agent, "--model", route["modelId"]]
        if inherited.get("effortId") and route["modelId"] == inherited["modelId"] and route["agentId"] == inherited["agentId"]:
            args += ["--effort", inherited["effortId"]]
    elif media:
        fits = routes("--media", media)
        raise ExpertError("请求方没有记录模型，无法判断它能不能看%s" % media, "没有创建任何会话",
                          "用 --tier 指定档位%s" % ("（本机有 %d 条能看%s的路由）" % (len(fits), media) if fits else "；本机没有能看%s的路由" % media))
    default_effort = env.get("EXPERT_EFFORT")
    if default_effort and "--effort" not in args and "--tag" not in args:
        args += ["--effort", default_effort]
    return args, why


def front_session(root, spaces):
    candidates = [item for item in live_sessions(spaces["root"]) if SYSTEM_LABEL not in (item.get("labels") or [])]
    return max(candidates, key=lambda item: item.get("updatedAtMs", 0))["id"] if candidates else None


def start(root, workspace_id, role, desc, text, model_key, tier=None, model=None, media=None):
    """Starts the session and returns (its id, why this Agent and model)."""
    picked, why = choose(root, model_key, tier, model, media)
    # The title defaults to the first line of the task, which starts with the user's own words: every session of one
    # request would then carry the same title in the list. Name it by what it does instead.
    role_label = ROLE_LABELS.get(role, role)[:10]
    auto_archive = open_env(root).get("EXPERT_ARCHIVE_OLD_SESSIONS") == "1"
    old_candidates = list(live_sessions(workspace_id)) if (auto_archive and role not in ("root", "front")) else []
    args = ["agent", "run", *picked, text, "--workspace", workspace_id, "--title", desc[:80], "--label", role_label,
            "--label", SYSTEM_LABEL, "--description", desc[:300],
            "--message-id", message_id("start", workspace_id, role, desc, text), "--no-wait"]
    new_sid = genet(*args).get("sessionId")
    clear_sessions_cache()
    if new_sid and old_candidates:
        for old in old_candidates:
            old_sid = old.get("id")
            if not old_sid or old_sid == new_sid:
                continue
            if old.get("status") in ("idle", "failed") and not os.path.isfile(state_dir(root, "pending", old_sid + ".json")):
                try:
                    genet("session", "archive", old_sid)
                except Exception:
                    pass
    return new_sid, why


def clip(text):
    raw = text.encode("utf-8")
    if len(raw) <= BODY_LIMIT:
        return text
    return raw[:BODY_LIMIT].decode("utf-8", "ignore") + "\n…（已截断，用 session narrative 取全文）"


def notice(session_id, purpose, sender, text, *id_parts, ref=None, unpause=False):
    """Queue a system notice. Idempotent: the id comes from what is said, so a repeat is dropped."""
    summary = session_summary(session_id)
    inputs = summary.get("inputSummary") or {}
    if len(inputs.get("pendingMessageIds") or []) >= 32:
        raise ExpertError("目标 %s 的队列已满（32 条）" % session_id, "没有排入任何消息", "等它处理完，或改发给别的会话")
    if summary.get("archived"):
        raise ExpertError("目标 %s 已归档" % session_id, "没有排入任何消息", "用 `directory` 找现在的会话，或发给 EXPERT:default")
    if unpause and (inputs.get("paused") or summary.get("status") == "failed"):
        head = "【人类唤醒】\n用途: %s\n发送方: %s\n" % (purpose, sender)
    else:
        head = "用途: %s\n发送方: %s\n" % (purpose, sender)
    if ref:
        head += "ref: %s\n" % ref
    body = clip("%s\n%s" % (head, text))
    send_args = ["session", "send", session_id, body, "--message-id", message_id(session_id, purpose, *id_parts), "--no-wait"]
    try:
        genet(*send_args)
    except ExpertError as err:
        if "messageId collides" not in err.what:
            raise


def candidate_roots(root):
    seen = set()
    out = []
    base = os.path.dirname(os.path.realpath(root))
    dirs = [root]
    if os.path.isdir(base):
        for entry in sorted(os.listdir(base)):
            if not entry.startswith("."):
                dirs.append(os.path.join(base, entry))
    for directory in dirs:
        real = os.path.realpath(directory)
        if real not in seen and os.path.isfile(os.path.join(real, ROOT_DESCRIPTOR)):
            seen.add(real)
            out.append(real)
    return out


def push_session_inbox(root, session_id, purpose, sender, text, ref=None):
    inbox_path = state_dir(root, "inbox", session_id + ".jsonl")
    os.makedirs(os.path.dirname(inbox_path), exist_ok=True)
    entry = {"atMs": now_ms(), "purpose": purpose, "sender": sender, "ref": ref, "text": clip(text)}
    with open(inbox_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def pop_session_inbox(root, session_id):
    inbox_path = state_dir(root, "inbox", session_id + ".jsonl")
    if not os.path.isfile(inbox_path):
        return []
    tmp = "%s.%d.read" % (inbox_path, os.getpid())
    try:
        os.replace(inbox_path, tmp)
    except OSError:
        return []
    items = []
    try:
        with open(tmp, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    items.append(json.loads(line))
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return items


def archive_guidance(root, kind, sender, target, text, ref=None):
    safe_kind = re.sub(r"[^a-z0-9_-]", "-", (kind or "note").lower()).strip("-") or "note"
    if not (os.path.isdir(os.path.join(root, ".pm")) or open_env(root).get("EXPERT_TEAM") or safe_kind in ("human", "patrol", "expert", "member")):
        return None
    gdir = os.path.join(root, ".pm", "guidance", safe_kind)
    os.makedirs(gdir, exist_ok=True)
    stamp = time.strftime("%y%m%d-%H%M%S")
    digest = hashlib.sha1(("%s\0%s\0%s\0%s" % (sender, target, text, now_ms())).encode("utf-8")).hexdigest()[:6]
    path = os.path.join(gdir, "%s-%s.md" % (stamp, digest))
    lines = [
        "# Guidance [%s]" % safe_kind,
        "",
        "- 时间: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
        "- 发送方: %s" % (sender or "-"),
        "- 接收方: %s" % (target or "-"),
    ]
    if ref:
        lines.append("- 引用: %s" % ref)
    lines.extend(["", "## 内容", "", text.strip(), ""])
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    return path


def _auto_unblock_waiting_system_session(session_id, summary):
    if not summary or summary.get("status") != "waiting":
        return False
    if SYSTEM_LABEL not in (summary.get("labels") or []) and not summary.get("managed"):
        return False
    reqs = (summary.get("interactionSummary") or {}).get("requests") or []
    unblocked = False
    for req in reqs:
        if req.get("kind") != "question":
            continue
        req_id = req.get("requestId") or req.get("id")
        if not req_id:
            continue
        try:
            genet("session", "respond", session_id, "--request", req_id, "--choose", "0", "--no-wait")
            unblocked = True
        except Exception:
            pass
    if unblocked:
        clear_sessions_cache()
    return unblocked


def format_coalesced_inbox_items(items, inline=False):
    items = list(items)
    items.sort(key=lambda item: (0 if item.get("purpose") == "human" else 1, item.get("atMs", 0)))
    human_items = [item for item in items if item.get("purpose") == "human"]
    parts = []
    if len(human_items) >= 2:
        parts.append(
            "⚠️ 【人类多条连续指令合并提示】收到 %d 条按时间先后排列的人类指令（#1 → #%d）。"
            "若后序指令对前序指令存在方向调整、数值修改或自我否定（如“不对 / 算了 / 别改X了 / 改成Y”），"
            "必须以最新一条（#%d）为准直接覆盖前序冲突要求，严禁机械执行已被推翻的前序指令！"
            % (len(human_items), len(human_items), len(human_items))
        )
    elif len(human_items) == 1 and inline:
        parts.append("⚠️ 【人类最新插队/修正指令到达】执行中途收到人类新指令，若与当前方向冲突请立即以最新指令为准覆盖调整！")
    human_seq = 0
    for idx, item in enumerate(items, 1):
        is_h = item.get("purpose") == "human"
        if is_h:
            human_seq += 1
            seq_tag = " [人类指令 #%d/%d%s]" % (human_seq, len(human_items), " · 最新为准" if human_seq == len(human_items) and len(human_items) >= 2 else "")
        else:
            seq_tag = ""
        head = "### [%d/%d]%s [%s] 来自 %s" % (idx, len(items), seq_tag, item.get("purpose") or "notice", item.get("sender") or "-")
        if item.get("ref"):
            head += " (ref: %s)" % item["ref"]
        parts.append("%s\n\n%s" % (head, item.get("text") or ""))
    return "\n\n".join(parts), bool(human_items), len(human_items)


def check_and_flush_self_inbox_inline(root, command_name):
    if command_name not in ("spawn", "publish", "worktree", "employee", "member", "board"):
        return
    self_id = os.environ.get("GENEHUB_SESSION_ID")
    if not self_id or not SESSION_ID.match(self_id):
        return
    all_items = []
    for cand in candidate_roots(root):
        all_items.extend(pop_session_inbox(cand, self_id))
    if not all_items:
        return
    formatted, has_human, _ = format_coalesced_inbox_items(all_items, inline=True)
    print(formatted)
    if has_human and command_name in ("spawn", "publish"):
        raise ExpertError(
            "执行 %s 前收到人类最新插队/修正指令（见上方收件箱合并输出）" % command_name,
            "已拦截基于旧指令的 %s 操作，防止继续推进已被用户推翻的内容" % command_name,
            "请先阅读上方【人类指令】并以最新一条为准覆盖旧方案（如回退已被取消的改动），再按新需求重新调用 %s" % command_name,
        )


def _advance_parent_baseline(root, parent_sid, parent_summary=None):
    """Before waking `parent_sid` with child results or inbox messages, advance its own pending baseline
    to its current latestReply so its intermediate pre-wakeup reply is never mistaken for its final reply."""
    if not parent_sid or not SESSION_ID.match(str(parent_sid)):
        return
    p_path = state_dir(root, "pending", parent_sid + ".json")
    p_rec = read_json(p_path)
    if not p_rec:
        return
    if parent_summary is None:
        try:
            parent_summary = session_summary(parent_sid)
        except ExpertError:
            parent_summary = {}
    latest_reply = ((parent_summary or {}).get("latestReply") or {}).get("itemId")
    if latest_reply:
        p_rec["baseline"] = latest_reply
    p_rec.pop("done", None)
    p_rec["wokenAtMs"] = now_ms()
    update_pending(root, p_path, p_rec)


def _has_unfinished_children(root, session_id):
    pdir = state_dir(root, "pending")
    if not os.path.isdir(pdir):
        return False
    for entry in os.listdir(pdir):
        if not entry.endswith(".json"):
            continue
        rec = read_json(os.path.join(pdir, entry))
        if rec and rec.get("requester") == session_id and not rec.get("done"):
            notified = rec.get("notified") or []
            if "stopped" not in notified and "stuck" not in notified:
                return True
    return False


def flush_session_inbox_if_idle(root, session_id, force=False):
    """If `session_id` has accumulated file-inbox messages and is now wakeable (`idle` or `failed`), deliver them as 1 merged turn."""
    inbox_path = state_dir(root, "inbox", session_id + ".jsonl")
    if not os.path.isfile(inbox_path):
        return False
    try:
        summary = session_summary(session_id)
    except ExpertError:
        pop_session_inbox(root, session_id)
        return False
    if _auto_unblock_waiting_system_session(session_id, summary):
        try:
            summary = session_summary(session_id)
        except ExpertError:
            return False
    status = summary.get("status")
    inputs = summary.get("inputSummary") or {}
    if status not in ("idle", "failed"):
        return False
    front = None
    try:
        _, mine = me(root)
        front = front_session(root, (mine or {}).get("spaces") or {})
    except ExpertError:
        pass
    if status == "idle" and inputs.get("paused") and session_id == front:
        return False
    if not force and _has_unfinished_children(root, session_id):
        try:
            with open(inbox_path, "r", encoding="utf-8") as handle:
                peek_items = [json.loads(ln) for ln in handle if ln.strip()]
        except Exception:
            peek_items = []
        if not any(i.get("purpose") in ("human", "patrol", "task", "question") for i in peek_items):
            return False
    should_unpause = (status == "failed") or bool(inputs.get("paused"))
    items = pop_session_inbox(root, session_id)
    if not items:
        return False
    _advance_parent_baseline(root, session_id, summary)
    # Sort so human instructions always lead the batch
    items.sort(key=lambda item: (0 if item.get("purpose") == "human" else 1, item.get("atMs", 0)))
    try:
        _deliver_coalesced_inbox(root, session_id, items, unpause=should_unpause)
    except Exception:
        # `pop_session_inbox` already removed the file, so a failed delivery would destroy the message for good —
        # put it back untouched (the next tick retries) instead of losing a result forever.
        for item in reversed(items):
            push_session_inbox(root, session_id, item.get("purpose") or "notice", item.get("sender") or "-", item.get("text") or "", ref=item.get("ref"))
        raise
    return True


def _deliver_coalesced_inbox(root, session_id, items, unpause=False):
    if len(items) == 1 and items[0].get("purpose") != "human":
        only = items[0]
        notice(session_id, only.get("purpose") or "notice", only.get("sender") or "-", only.get("text") or "",
               session_id, str(only.get("atMs", 0)), ref=only.get("ref"), unpause=unpause)
    else:
        formatted, has_human, human_count = format_coalesced_inbox_items(items, inline=False)
        purpose = "human" if has_human else (items[0].get("purpose") or "result")
        sender = "收件箱合并投递（%d 条%s）" % (len(items), "，含 %d 条人类高优指令" % human_count if has_human else "")
        notice(session_id, purpose, sender, formatted, session_id, *(str(i.get("atMs", 0)) for i in items), unpause=unpause)
    return True


def deliver_or_notice(root, session_id, purpose, sender, text, *id_parts, ref=None, unpause=False, use_inbox=False):
    team_mode = bool(use_inbox or purpose in ("human", "patrol", "expert", "member") or open_env(root).get("EXPERT_TEAM") or is_team_root(root))
    if team_mode:
        try:
            summary = session_summary(session_id)
            inputs = summary.get("inputSummary") or {}
            if len(inputs.get("pendingMessageIds") or []) < 32 and summary.get("status") in ("running", "waiting"):
                push_session_inbox(root, session_id, purpose, sender, text, ref=ref)
                return "inbox"
            if summary.get("status") in ("idle", "failed"):
                existing = pop_session_inbox(root, session_id)
                if existing:
                    for item in existing:
                        push_session_inbox(root, session_id, item.get("purpose") or "notice", item.get("sender") or "-", item.get("text") or "", ref=item.get("ref"))
                    push_session_inbox(root, session_id, purpose, sender, text, ref=ref)
                    flush_session_inbox_if_idle(root, session_id, force=True)
                    return "queue"
        except ExpertError:
            pass
    notice(session_id, purpose, sender, text, *id_parts, ref=ref, unpause=unpause)
    return "queue"


def close_pending_between(root, requester_id, responder_id):
    if not requester_id or not responder_id:
        return False
    closed_any = False
    for cand in candidate_roots(root):
        path = state_dir(cand, "pending", responder_id + ".json")
        record = read_json(path)
        if record and record.get("requester") == requester_id:
            move(cand, path)
            closed_any = True
    return closed_any


def resolve_send_target(root, target_spec, kind, text, sender):
    if SESSION_ID.match(target_spec):
        return target_spec, False, root, None
    parts = target_spec.split(":", 1)
    exp_name = parts[0].strip()
    role_spec = parts[1].strip() if len(parts) > 1 else None
    _, own_mine = me(root)
    own_spaces = own_mine.get("spaces") or {}
    if role_spec is None and (exp_name in ("default", "root", "front") or exp_name in own_spaces):
        target_root = root
        role_spec = exp_name
        exp_name = (descriptor(root) or {}).get("name") or os.path.basename(root)
    else:
        try:
            target_root = find_expert(root, exp_name)
        except ExpertError:
            raise ExpertError(
                "目标 %r 既不是会话 id，也不是已知专家名" % target_spec,
                "没有排入任何消息",
                "用 `directory` 查会话 id 或专家名；支持直接写 `s_xxx`、`专家名`、团队岗位名（如 `leader`、`qa`）或 `专家名:岗位名`",
            )
    _, target_mine = me(target_root)
    spaces = target_mine.get("spaces") or {}
    # A team has no generic `work` Space: the role that does the work is the leader.
    if role_spec == "work" and "work" not in spaces and "leader" in spaces:
        role_spec = "leader"
    if role_spec in ("default", "root", "front"):
        front = front_session(target_root, spaces) if "root" in spaces else None
        if front:
            return front, False, target_root, "root"
        role = "leader" if "leader" in spaces else "research"
    elif role_spec in spaces:
        role = role_spec
        existing = [item for item in live_sessions(spaces.get(role, "")) if item.get("status") in ("idle", "running", "waiting")] if spaces.get(role) else []
        if existing:
            return max(existing, key=lambda item: item.get("updatedAtMs", 0))["id"], False, target_root, role
    elif role_spec is None:
        if "leader" in spaces and kind in ("human", "patrol", "task"):
            role = "leader"
            existing = [item for item in live_sessions(spaces["leader"]) if item.get("status") in ("idle", "running", "waiting")]
            if existing:
                return max(existing, key=lambda item: item.get("updatedAtMs", 0))["id"], False, target_root, "leader"
        else:
            role = ("leader" if "leader" in spaces else "work") if kind == "task" else "research"
            if kind not in ("task", "question", "request") and "root" in spaces:
                front = front_session(target_root, spaces)
                if front:
                    return front, False, target_root, "root"
    else:
        raise ExpertError("未知的目标角色 %r" % role_spec, "没有排入任何消息", "支持 `<专家名>`、`<专家名>:<角色名>`（如 work、research、leader、qa）或 `<专家名>:default`")
    workspace_id = spaces.get(role)
    if not workspace_id:
        raise ExpertError("专家 %s 没有 %s 空间" % (exp_name, role), "没有创建或发送消息", "检查该专家的 spaces/%s/agent-space.genet.json" % role)
    role_env = open_env(os.path.join(target_root, "spaces", role))
    wt_dir = role_env.get("WORKTREE_DIR")
    wt_hint = ("，专属工位目录 WORKTREE_DIR: %s" % wt_dir) if wt_dir else ""
    prompt = "[系统说明：本会话由 %s 跨专家/跨岗位发起（用途: %s，专家根目录: %s，数据仓根目录: %s%s）。完成后直接在本会话输出最终结论即可，系统会自动将你的最终回复转交发起方。]\n\n%s" % (sender, kind, target_root, datas_root(target_root), wt_hint, text)
    model_key = "EXPERT_MODEL_RESEARCH" if role == "research" else "EXPERT_MODEL_WORK"
    session_id, _ = start(
        target_root,
        workspace_id,
        role,
        ("来自 %s 的 %s" % (sender, kind))[:60],
        clip(prompt),
        model_key,
    )
    return session_id, True, target_root, role


# ---------------------------------------------------------------- commands

def cmd_send(args):
    root = find_root()
    name, mine = me(root)
    sender = os.environ.get("GENEHUB_SESSION_ID") or "%s:hook" % name
    body_text = " ".join(args.text)
    target, created_now, target_root, target_role = resolve_send_target(root, args.to, args.kind, body_text, sender)
    archive_guidance(target_root or root, args.kind, sender, "%s (%s)" % (args.to, target), body_text)
    was_pending = close_pending_between(root, requester_id=target, responder_id=sender) if args.kind == "result" else False
    own_front = front_session(root, mine["spaces"]) if "root" in mine.get("spaces", {}) else None
    # `human` and `patrol` must be tracked too: they carry a Human request inward (forwarded by the front desk or a
    # patrol run) and the Human is waiting for the answer, so dropping them here leaves the request with no return
    # path at all. Only `result`/`report`/`note` are pure notifications of work already delivered and need no reply.
    track_reply = (
        not was_pending
        and SESSION_ID.match(str(sender))
        and target != own_front
        and target != sender
        and args.kind not in ("result", "report", "note")
    )
    desc_prefix = {"human": "老板诉求回执", "patrol": "巡查回执"}.get(args.kind, "协作")
    baseline = None
    if track_reply and not created_now:
        try:
            baseline = (session_summary(target).get("latestReply") or {}).get("itemId")
        except ExpertError:
            baseline = None
    if not created_now:
        payload = body_text
        if track_reply:
            payload += "\n\n[系统提示：直接在本会话输出回复即可，系统会自动将你的最终回复转交发送方 %s；无需再手动调用 send 回传。]" % sender
        mode = deliver_or_notice(
            target_root or root,
            target,
            args.kind,
            sender,
            payload,
            body_text,
            unpause=(target != own_front),
            use_inbox=getattr(args, "inbox", False),
        )
        if target_role == "leader" and args.kind in ("human", "patrol", "task"):
            snippet = " ".join(body_text.splitlines()).strip()[:36]
            auto_describe_session(target, "研发组长：响应最新需求（%s）" % snippet)
        elif target_role and target_role not in ("root", "front") and args.kind == "task":
            snippet = " ".join(body_text.splitlines()).strip()[:36]
            auto_describe_session(target, "%s：%s" % (target_role, snippet))
    else:
        mode = "spawned"
    if track_reply:
        pending_path = state_dir(root, "pending", target + ".json")
        existing_rec = read_json(pending_path)
        if existing_rec:
            primary_req = existing_rec.get("requester")
            if primary_req and primary_req != sender and not existing_rec.get("done"):
                # Law 2: Never let a third-party `send` hijack an active primary task's requester.
                if SESSION_ID.match(str(sender)):
                    watchers = existing_rec.setdefault("watchers", [])
                    if sender not in watchers:
                        watchers.append(sender)
                write_json(pending_path, existing_rec)
            else:
                existing_rec["baseline"] = baseline
                existing_rec["notified"] = []
                existing_rec["createdAtMs"] = now_ms()
                existing_rec.pop("done", None)
                if SESSION_ID.match(str(sender)):
                    existing_rec["requester"] = sender
                write_json(pending_path, existing_rec)
        else:
            write_json(pending_path, {
                "sessionId": target,
                "requester": sender,
                "batch": target,
                "kind": args.kind if args.kind in ("research", "work") else "research",
                "desc": ("%s %s (%s)" % (desc_prefix, args.to, args.kind))[:60],
                "createdAtMs": now_ms(),
                "baseline": baseline,
                "notified": [],
                "lock": None,
                "route": "send",
            })
    if mode == "inbox":
        print("已写入文件收件箱（0 打断，目标空闲时自动合并唤醒） → %s" % target)
    elif mode == "spawned":
        print("已为 %s 启动会话并投递 → %s（请直接结束本轮，系统收齐结果后将自动异步唤醒）" % (args.to, target))
    else:
        print("已排队 → %s" % target)


def writer_lock(path):
    """Where the markers for `path` live: in its own git directory when it is the root of a repository, else in
    its own `.genethub/`. A plain folder inside some other repository (the expert's own, say) must not share that
    repository's markers, or every such folder would share one lock."""
    git = subprocess.run(["git", "-C", path, "rev-parse", "--show-toplevel", "--absolute-git-dir"], capture_output=True, text=True)
    lines = git.stdout.splitlines()
    if git.returncode == 0 and len(lines) >= 2 and os.path.realpath(lines[0]) == os.path.realpath(path):
        return lines[1].strip()
    return os.path.join(path, ".genethub")


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


def resolve_expert_dir(target_root, dir_spec):
    """Resolve `--dir` relative to the target expert root when a relative path without `..` is passed
    or when the relative path does not exist under cwd, so callers in `front/` or `spaces/work/` never
    accidentally lock `front/datas/...` or `spaces/xianxia/...`."""
    if os.path.isabs(dir_spec):
        return os.path.realpath(dir_spec)
    in_root = os.path.join(target_root, dir_spec)
    if dir_spec.startswith(("datas/", "datas\\", "temp/", "temp\\")) or os.path.exists(in_root):
        return os.path.realpath(in_root)
    if os.path.exists(dir_spec):
        return os.path.realpath(dir_spec)
    return os.path.realpath(in_root)


def _cut_worker_sub_worktree(target_root, role, base_repo_hint, desc, explicit_slot=None):
    base_repo = None
    for cand in (base_repo_hint, _find_team_base_repo(target_root)):
        if cand and os.path.isdir(cand) and subprocess.run(["git", "-C", cand, "rev-parse", "--git-dir"], capture_output=True).returncode == 0:
            base_repo = os.path.realpath(cand)
            break
    if not base_repo:
        raise ExpertError(
            "找不到可用于切出并发子工位的 git 仓库",
            "没有创建子工位或启动会话",
            "请先为团队绑定主工位（team.py worktree create），或通过 --dir 指定目录",
        )
    if explicit_slot and explicit_slot != "auto":
        slot = re.sub(r"[^a-zA-Z0-9_-]+", "-", explicit_slot).strip("-") or role
    else:
        slug = re.sub(r"[^a-z0-9]+", "-", (desc or "").lower()).strip("-")[:16] or "worker"
        digest = hashlib.sha1(("%s\0%s\0%d\0%d" % (role, desc, now_ms(), os.getpid())).encode("utf-8")).hexdigest()[:6]
        slot = "%s-%s-%s" % (role, slug, digest)
    wt_dir = os.path.join(target_root, "worktrees", slot)
    os.makedirs(os.path.dirname(wt_dir), exist_ok=True)
    branch = "worker/%s" % slot
    if not os.path.exists(wt_dir):
        done = subprocess.run(["git", "-C", base_repo, "worktree", "add", "-B", branch, wt_dir, "HEAD"], capture_output=True, text=True, timeout=60)
        if done.returncode != 0:
            raise ExpertError(
                "自动切出并发子工位失败: %s" % (done.stderr or done.stdout).strip()[-300:],
                "没有创建会话",
                "检查 git 仓库状态后重试",
            )
    return os.path.realpath(wt_dir), branch


def cmd_spawn(args):
    root = find_root()
    target_root = find_expert(root, getattr(args, "expert", None)) if getattr(args, "expert", None) else root
    name, mine = me(target_root)
    role = getattr(args, "space", None) or args.kind
    workspace_id = mine["spaces"].get(role)
    if not workspace_id and role == "work" and not getattr(args, "space", None):
        # A team has no generic `work` Space: the role that does the work is its leader, which is how a
        # 1+0 team (front + leader + qa + research + team-reflect) takes a plain `--kind work` task.
        role = "leader"
        workspace_id = mine["spaces"].get(role)
    if not workspace_id:
        raise ExpertError("专家 %s 没有 %s 空间" % (name, role), "没有创建会话", "确认专家目录里有 spaces/%s/agent-space.genet.json" % role)
    requester = os.environ.get("GENEHUB_SESSION_ID")
    if requester and not getattr(args, "expert", None):
        # When an external session (such as `admin` bootstrapping a team) runs
        # `<team>/tools/team.py spawn --space leader` directly without `--expert`,
        # isolate the completion callback so `<team>:hook` reports to `<team>`'s
        # own front session instead of waking `admin` across space boundaries.
        if not same_expert_session(target_root, requester, mine.get("spaces")):
            requester = front_session(target_root, mine["spaces"]) if "root" in (mine.get("spaces") or {}) else None
    role_env = open_env(os.path.join(target_root, "spaces", role))
    wt_dir = role_env.get("WORKTREE_DIR")
    spawned_wt = None
    spawned_branch = None
    wt_opt = getattr(args, "worktree", None)
    if wt_opt and role != "research":
        spawned_wt, spawned_branch = _cut_worker_sub_worktree(target_root, role, wt_dir, args.desc, wt_opt)
        wt_dir = spawned_wt
    lock = None
    effective_dir = args.dir or spawned_wt or (wt_dir if role not in ("research", "reflect", "team-reflect", "leader") else None)
    if effective_dir and role != "research":
        path = resolve_expert_dir(target_root, effective_dir)
        marker, won = claim(path, {"session": None, "expert": name, "at": now_ms()}, "genet-writer.json")
        if not won:
            holder = (read_json(marker) or {}).get("session")
            same_holder = bool(holder and requester and holder == requester)
            alive = same_holder or bool(holder and not session_missing(holder) and session_summary(holder).get("status") in ("running", "waiting"))
            if alive and not args.dir and not spawned_wt and is_team_root(target_root):
                # Multi-tier team support (`Leader -> Lead -> 5~10 Workers`): when a Lead (who holds its space's
                # primary worktree lock) or Leader spawns concurrent Workers into the same role space without `--dir`,
                # automatically cut an isolated child git worktree so all Workers run in parallel with zero lock conflict.
                spawned_wt, spawned_branch = _cut_worker_sub_worktree(target_root, role, path, args.desc, "auto")
                wt_dir = spawned_wt
                path = spawned_wt
                marker, won = claim(path, {"session": None, "expert": name, "at": now_ms()}, "genet-writer.json")
            if not won:
                if same_holder:
                    raise ExpertError(
                        "当前会话 %s 自己就已经持有 %s 的写者锁" % (holder, path),
                        "没有创建会话",
                        "你本身就是这个目录的后台写会话，不要再递归调用 spawn work，直接在当前会话里修改文件并运行测试即可",
                    )
                if alive:
                    raise ExpertError("%s 已有写会话 %s 在工作" % (path, holder), "没有创建会话", "等它完成，或换一个目录")
                if holder:
                    for cand in candidate_roots(root):
                        old_pending = state_dir(cand, "pending", holder + ".json")
                        if os.path.isfile(old_pending):
                            move(cand, old_pending)
                os.remove(marker)
                marker, won = claim(path, {"session": None, "expert": name, "at": now_ms()}, "genet-writer.json")
                if not won:
                    raise ExpertError("%s 的写者锁刚被别人拿走" % path, "没有创建会话", "稍后重试")
        lock = marker
    wt_hint = ("，专属工位目录 WORKTREE_DIR: %s%s" % (wt_dir, " (branch: %s)" % spawned_branch if spawned_branch else "")) if wt_dir else ""
    task_body = " ".join(args.task)
    archive_guidance(target_root, "task", requester or name, "%s/%s" % (name, role), "[%s] %s" % (args.desc, task_body))
    if spawned_wt:
        exec_guidance = "你是并发派出的叶子 Worker 会话（独立子工位: %s，分支: %s），请直接在本会话内完成编码与自测并 git commit 到本分支（严禁再递归 spawn 子会话），完成后直接输出分支名、commit SHA 与验证结果即可，系统会自动回传给上级。" % (spawned_wt, spawned_branch)
    elif is_team_root(target_root) and role not in ("research", "reflect", "team-reflect", "leader"):
        exec_guidance = "你是团队 `%s` 管线负责人（专家根目录: %s，数据仓根目录: %s%s）。单模块任务请直接在工位内完成编码、自测并 commit；若需拆分为多子模块并发推进，可作为小组长连续调用 `team.py spawn --space %s --kind work --worktree auto --desc \"子模块\" \"任务\"` 派生多名 Worker（及 `--space research --kind research`）后立即结束本轮，系统收齐全部子任务后会唤醒你合并各 `worker/*` 分支。最终直接在本会话输出结论即可，无需手动调用 team.py send 回传。" % (role, target_root, datas_root(target_root), wt_hint, role)
    else:
        exec_guidance = "你本身就是被派出的后台 %s 会话（专家根目录: %s，数据仓根目录: %s%s），请直接在本会话内执行任务（不要再递归 spawn 同类会话），完成后直接输出最终结论即可，系统会自动将你的最终回复转交发起方，无需再手动调用 team.py send 回传。" % (role, target_root, datas_root(target_root), wt_hint)
    task = "[系统说明：本会话由 %s 发起（用途: %s）。%s]\n\n%s" % (
        requester or name,
        role,
        exec_guidance,
        task_body,
    )
    if lock:
        task += "\n\n业务目录: %s（你是这个目录唯一的写会话）" % path
    turn = latest_round(requester) if requester else None
    round_key = (turn or {}).get("roundId") or (turn or {}).get("userItemId")
    batch = "%s:%s" % (requester, round_key) if requester and round_key else None
    model_key = "EXPERT_MODEL_RESEARCH" if role == "research" else "EXPERT_MODEL_WORK"
    try:
        session_id, why = start(target_root, workspace_id, role, args.desc, clip(task), model_key,
                                args.tier, args.model, args.media)
    except ExpertError:
        if lock:
            os.remove(lock)  # no session will ever hold this directory
        raise
    if lock:
        write_json(lock, {"session": session_id, "expert": name, "at": now_ms()})
    pending_rec = {
        "sessionId": session_id, "requester": requester, "batch": batch or session_id, "kind": role, "desc": args.desc, "createdAtMs": now_ms(),
        "baseline": None, "notified": [], "lock": lock, "route": why,
    }
    if spawned_wt:
        pending_rec["worktree"] = spawned_wt
        pending_rec["branch"] = spawned_branch
    write_json(state_dir(root, "pending", session_id + ".json"), pending_rec)
    wt_msg = ("，子工位 %s [%s]" % (spawned_wt, spawned_branch)) if spawned_wt else ""
    print("已开始 %s 会话 %s（%s%s）；请直接结束本轮，系统收齐同批结果后将自动异步唤醒" % (role, session_id, why, wt_msg))


def refresh_live_status(root, force=False):
    if not (os.path.isdir(os.path.join(root, ".pm")) or open_env(root).get("EXPERT_TEAM")):
        return
    trunk_dir = os.path.join(root, ".pm", "trunk")
    status_path = os.path.join(trunk_dir, "status-live.md")
    if not force and os.path.isfile(status_path):
        try:
            if time.time() - os.path.getmtime(status_path) < 30:
                return
        except OSError:
            pass
    try:
        name, mine = me(root)
    except ExpertError:
        return
    os.makedirs(trunk_dir, exist_ok=True)
    lines = [
        "# 团队实时状态看板（status-live）",
        "",
        "- 更新时间: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
        "- 团队根: `%s` (`%s`)" % (name, root),
        "",
        "## 1. 各角色与活跃会话",
    ]
    for role, wid in sorted((mine.get("spaces") or {}).items()):
        role_dir = root if role == "root" else os.path.join(root, "spaces", role)
        wt = open_env(role_dir).get("WORKTREE_DIR") or ("主入口" if role == "root" else "未绑定工位（待岗）")
        live = live_sessions(wid)
        if not live:
            lines.append("- **%s** (工位: `%s`): 暂无会话" % (role, wt))
        else:
            for item in sorted(live, key=lambda s: -s.get("updatedAtMs", 0))[:3]:
                lines.append("- **%s** `%s` [%s] (%s) — %s (工位: `%s`)" % (
                    role, item["id"], item.get("status"), ",".join(item.get("labels") or []),
                    item.get("description") or item.get("title") or "", wt,
                ))
    pdir = state_dir(root, "pending")
    pending_recs = [read_json(os.path.join(pdir, f)) for f in sorted(os.listdir(pdir))] if os.path.isdir(pdir) else []
    pending_recs = [r for r in pending_recs if r]
    lines += ["", "## 2. 待完成后台任务 (%d)" % len(pending_recs)]
    for rec in pending_recs:
        lines.append("- `%s` [%s] %s (请求方: `%s`)" % (rec.get("sessionId"), rec.get("kind"), rec.get("desc"), rec.get("requester") or "-"))
    rel_dir = os.path.join(datas_root(root), "releases")
    releases = sorted(d for d in os.listdir(rel_dir) if os.path.isdir(os.path.join(rel_dir, d))) if os.path.isdir(rel_dir) else []
    lines += ["", "## 3. 已发布可玩版本 (%d)" % len(releases)]
    for ver in releases:
        lines.append("- [%s 试玩入口](datas/releases/%s/index.html)" % (ver, ver))
    rep_dir = os.path.join(datas_root(root), "reports")
    reports = sorted(d for d in os.listdir(rep_dir) if os.path.isdir(os.path.join(rep_dir, d))) if os.path.isdir(rep_dir) else []
    lines += ["", "## 4. 已归档报告 (%d)" % len(reports)]
    for rep in reports[-10:]:
        lines.append("- [%s 报告](datas/reports/%s/index.html)" % (rep, rep))
    status_path = os.path.join(trunk_dir, "status-live.md")
    tmp = "%s.%d.tmp" % (status_path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    os.replace(tmp, status_path)
    try:
        board_mod_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), "pm_board_server.py")
        if os.path.isfile(board_mod_path):
            import importlib.util
            spec = importlib.util.spec_from_file_location("pm_board_server", board_mod_path)
            if spec and spec.loader:
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                # The board is a standing service; EXPERT_BOARD_PORT=0 turns it off, from the process or from
                # this Space's own open.env, so a Space that does not want one (a test, a headless run) says so once.
                board_off = os.environ.get("EXPERT_BOARD_PORT") == "0" or open_env(root).get("EXPERT_BOARD_PORT") == "0"
                mod.ensure_team_board(root, start_service=not board_off, force_sync=force)
    except Exception:
        pass


def _folder_names(space_dir, folders):
    """SpaceBuilder keys a workspace folder by the directory name it resolves to; two folders resolving to the same
    name fail the whole tree with SB004 (`Duplicate workspace folder name`), so names must be checked before adding."""
    names = set()
    for item in folders:
        path = (item.get("path") if isinstance(item, dict) else item) or "."
        explicit = item.get("name") if isinstance(item, dict) else None
        names.add(explicit or os.path.basename(os.path.realpath(os.path.join(space_dir, path))))
    return names


def _worktree_folder_entry(space_dir, wt_real, folders):
    """The entry for a worktree mounted as an extra workspace folder, or None when it is already declared."""
    rel_wt = os.path.relpath(wt_real, os.path.realpath(space_dir)).replace(os.sep, "/")
    if any((item.get("path") if isinstance(item, dict) else item) == rel_wt for item in folders):
        return None
    name = os.path.basename(wt_real)
    if name in _folder_names(space_dir, folders):
        name = "%s-worktree" % name
    entry = {"path": rel_wt}
    if name != os.path.basename(wt_real):
        entry["name"] = name
    return entry


def scaffold_role_space(root, role, desc, style_text, skills=None, worktree_dir=None):
    role_dir = os.path.join(root, "spaces", role)
    os.makedirs(role_dir, exist_ok=True)
    skills_list = skills or (["expert-core", "expert-reflect"] if role in ("reflect", "team-reflect") else (["expert-core", "expert-research"] if role == "research" else ["expert-core", "expert-work"]))
    folders = [{"path": "."}, {"path": "../../datas"}, {"path": "../../temp"}]
    if worktree_dir and os.path.isdir(worktree_dir):
        entry = _worktree_folder_entry(role_dir, os.path.realpath(worktree_dir), folders)
        if entry:
            folders.append(entry)
    manifest = {
        "schema": "agent-space.v1",
        "name": role,
        "description": desc,
        "tags": [],
        "agents": ["codex", "claude-code", "codebuddy", "cursor"],
        "skills": skills_list,
        "skillProviders": [{"type": "folder", "path": "../../skills"}],
        "identity": ["../../soul.md", "../../memory.md", "style.md", "index.md"],
        "folders": folders,
    }
    write_json(os.path.join(role_dir, ROOT_DESCRIPTOR), manifest)
    style_path = os.path.join(role_dir, "style.md")
    if style_text or not os.path.isfile(style_path):
        body = style_text or ("# %s 角色规范\n\n我是团队的 `%s`（%s）。动手前必读 `expert-core` 与对应技能，严格在分配的职责与工位目录内交付。\n" % (role, role, desc))
        with open(style_path, "w", encoding="utf-8") as handle:
            handle.write(body.rstrip() + "\n")
        with open(os.path.join(role_dir, "role.md"), "w", encoding="utf-8") as handle:
            handle.write(body.rstrip() + "\n")
    idx_path = os.path.join(role_dir, "index.md")
    if not os.path.isfile(idx_path):
        with open(idx_path, "w", encoding="utf-8") as handle:
            handle.write("# %s 经验与检索索引\n" % role)
    env = open_env(role_dir)
    env.setdefault("EXPERT_EFFORT", "high")
    if worktree_dir:
        env["WORKTREE_DIR"] = os.path.realpath(worktree_dir)
    write_open_env(role_dir, env)
    return role_dir


def setup_team_structure(root, team_name, desc, members=None, final_root=None):
    for single_only in ("reflect", "work"):
        shutil.rmtree(os.path.join(root, "spaces", single_only), ignore_errors=True)
    os.makedirs(os.path.join(root, "worktrees"), exist_ok=True)
    os.makedirs(os.path.join(root, "datas", "releases"), exist_ok=True)
    os.makedirs(os.path.join(root, "datas", "reports"), exist_ok=True)
    os.makedirs(os.path.join(root, ".pm", "trunk"), exist_ok=True)
    for kind in ("human", "patrol", "expert", "member", "task"):
        os.makedirs(os.path.join(root, ".pm", "guidance", kind), exist_ok=True)
    root_env = open_env(root)
    root_env["EXPERT_TEAM"] = "1"
    root_env.setdefault("EXPERT_EFFORT", "high")
    root_env.setdefault("EXPERT_WAKE_ROUNDS", "10")
    root_env.setdefault("EXPERT_WAKE_GAP", "1800")
    write_open_env(root, root_env)
    front_env = open_env(os.path.join(root, "front"))
    front_env["WORKTREE_DIR"] = os.path.realpath(final_root or root)
    front_env.setdefault("EXPERT_EFFORT", "high")
    write_open_env(os.path.join(root, "front"), front_env)
    if not os.path.isdir(os.path.join(root, "spaces", "leader")):
        front_style = (
            "# 风格与铁律（巡查 / 接待台 Front）\n\n"
            "- 我是 `%s` 团队的**巡查（主入口接待台）**，唯一直接面向人类用户的窗口。\n"
            "- **用户零命令/零内部结构负担**：用户只会用简单自然语言表达“参考什么项目、下个版本想要什么内容”、“现在进展怎么样”、“刚玩了下哪里不够爽”。我严禁要求用户知道 `.pm/` 目录结构、里程碑文件名或 `team.py` 命令。\n"
            "- **自动驱动组长（首次启动 vs 中途反馈）**：收到用户的版本诉求或试玩修改意见时，若组长 `leader` 尚无会话，立即用 `team.py spawn --space leader --kind work --desc \"评估里程碑规划与推进版本交付\" \"<用户原话与目标>\"` 启动组长；若组长已在岗，立即用 `team.py send --to leader --kind human \"<用户原话与要求>\"` 投递给组长（0 打断写入收件箱并归档 `.pm/guidance/human/`）。\n"
            "- **常驻团队看板服务与秒回汇报**：用户查进度或要看板时，调用 `team.py board refresh`，基于实时数据直接给出清晰零黑话汇报，并固定附上**常驻实时看板 `[📊 实时团队看板](datas/board/index.html)`** 与 **`[🎮 最新可玩版本](datas/releases/index.html)`**（及当前版本试玩入口）。\n"
        ) % team_name
        with open(os.path.join(root, "front", "style.md"), "w", encoding="utf-8") as handle:
            handle.write(front_style)
        with open(os.path.join(root, "front", "role.md"), "w", encoding="utf-8") as handle:
            handle.write(front_style)
        scaffold_role_space(
            root,
            "leader",
            "研发组长（里程碑规划与版本可达性评估、多级并发派单、预检合入、QA 验收与版本发布）",
            "# 研发组长（Leader）角色规范\n\n"
            "- 我是团队的**后台研发组长（Leader）**。用户只提供参考项目与下个版本想要的核心内容，**里程碑规划与版本内容可达性评估由我全权负责**。\n"
            "- **纯异步回合接力自驱闭环（严禁调用 sleep 或同步阻塞等待）**：① 收到用户诉求后，先盘点当前代码基线，评估版本内容可达性，自主编写/更新 `<团队根>/.pm/trunk/MILESTONE_PLAN.md`（用 `- [ ]` 列出待交付版本与模块，全部完成时标 `- [x]`）与 `milestone-vX.Y.md` 契约 → ② 连续调用 `team.py spawn --space <组员> --kind work` 并发派单到各组员（或小组长）独立 `worktrees/<slot>` 工位后**立即结束本轮**（系统收齐全部子任务结果后会自动唤醒我，若中途异常中断看门狗也会自动自愈唤醒） → ③ 收到组员批次汇总回执后，在集成工位用 `git merge-tree` 预检无冲突后合入 `main` → ④ 派 `qa` 执行无头浏览器实操截图与数值断言验收（若有数值对比诉求同时派 `research` 产出报告并 `publish report`）后结束本轮 → ⑤ 收到 QA PASS 回执后调用 `team.py publish release <构建目录> --name vX.Y` 发布可玩版本、勾选 `MILESTONE_PLAN.md` 并同步刷新常驻团队看板 `datas/board/index.html`。\n",
            skills=["expert-core", "expert-work"],
        )
        scaffold_role_space(
            root,
            "qa",
            "QA 验收测试专家（无头浏览器真实按键巡检、截图取证、数值平衡断言）",
            "# QA 验收测试专家角色规范\n\n"
            "- 我是团队的 **QA 验收专家**，只认真实运行证据：必须用 Playwright/无头浏览器加载真实页面、模拟按键/点击操作、捕获 console/pageerror 零报错、保存截图并跑数值仿真断言。\n"
            "- 验收报告与截图归档后，通过 `team.py publish report` 发布至 `datas/reports/`，向组长返回明确 PASS/FAIL 与截图链接。\n",
            skills=["expert-core", "expert-work"],
        )
        scaffold_role_space(
            root,
            "research",
            "数值与玩法研究专家（战斗公式推演、关卡节奏设计、竞品与机制调研）",
            "# 数值与玩法研究专家角色规范\n\n"
            "- 我是团队的**数值与玩法研究专家**，负责伤害/成长曲线推演、多套平衡参数仿真对比与机制设计，只读业务仓，产出写进 `temp/` 或通过 `team.py publish report` 发布到 `datas/reports/`。\n",
            skills=["expert-core", "expert-research"],
        )
        scaffold_role_space(
            root,
            "team-reflect",
            "团队自省与进化专家（跨角色会话复盘、二级记忆提炼、Skill 与流程持续调优）",
            "# 团队自省专家（TeamReflect）角色规范\n\n"
            "- 我是团队的 **TeamReflect 自省专家**，扫描全队（`front`、`leader`、各管线组员、`qa`、`research`）的增量会话与留言，执行**二级记忆提炼**：先把各岗位经验与 `ghref` 证据指针写入 `spaces/<角色>/index.md`，再将跨角色高频铁律提炼入根 `memory.md`（≤30 行），必要时升级团队 Skill/脚本并 `snapshot` 提交。\n",
            skills=["expert-core", "expert-reflect"],
        )
    else:
        for base_role in ("leader", "qa", "research", "team-reflect"):
            rdir = os.path.join(root, "spaces", base_role)
            if os.path.isdir(rdir):
                renv = open_env(rdir)
                renv.setdefault("EXPERT_EFFORT", "high")
                write_open_env(rdir, renv)
    for member_spec in (members or []):
        m_parts = member_spec.split(":", 1)
        m_name = m_parts[0].strip()
        m_desc = m_parts[1].strip() if len(m_parts) > 1 else ("%s 研发管线专员" % m_name)
        if m_name and m_name not in ("leader", "qa", "research", "reflect", "team-reflect"):
            scaffold_role_space(
                root,
                m_name,
                m_desc,
                "# %s 管线负责人（小组长 / 组员）角色规范\n\n"
                "- 我是团队的 `%s`（%s）。我只在自己绑定的专属 `WORKTREE_DIR` 工位分支上修改或集成负责模块，严禁跨模块污染或直接改主仓 `main`。\n"
                "- **单模块直做 vs 多级并发拆解**：聚焦模块直接在本工位编码、自测并 `git commit`；复杂模块可作为小组长连续调用 `team.py spawn --space %s --kind work --worktree auto --desc \"子模块\" \"任务\"` 并发派生多名独立子工位 Worker（及 `--space research --kind research`）后立即结束本轮，待系统收齐全部子任务回执唤醒我后再合入本工位分支。\n"
                "- 完成后直接在本会话输出分支名、commit SHA、改动摘要与验证结果，系统自动回传给研发组长。\n" % (m_name, m_name, m_desc, m_name),
                skills=["expert-core", "expert-work"],
            )


def _normalize_project_slug(name):
    slug = (name or "").strip().lower()
    slug = re.sub(r"[-_](team|project|expert|game|dev|v\d+)$", "", slug)
    return slug


def _extract_project_titles(*texts):
    titles = set()
    for text in texts:
        if not text:
            continue
        for match in re.findall(r"《([^》]{2,30})》", str(text)):
            titles.add(match.strip())
    return titles


def find_existing_project_conflict(base, new_name, desc="", soul=""):
    """Detect whether another expert/team in `base` already manages the same project."""
    if not os.path.isdir(base):
        return None
    new_slug = _normalize_project_slug(new_name)
    new_titles = _extract_project_titles(desc, soul)
    try:
        entries = sorted(os.listdir(base))
    except OSError:
        return None
    for item in entries:
        if item.startswith(".") or item in ("admin", new_name):
            continue
        cand_dir = os.path.join(base, item)
        info = descriptor(cand_dir)
        if not (info and "expert" in (info.get("tags") or [])):
            continue
        cand_name = info.get("name") or item
        cand_desc = info.get("description") or ""
        cand_soul = ""
        try:
            with open(os.path.join(cand_dir, "soul.md"), "r", encoding="utf-8") as handle:
                cand_soul = handle.read(4096)
        except OSError:
            pass
        if new_slug and _normalize_project_slug(cand_name) == new_slug:
            return cand_name, cand_dir, "同名项目标识 (%s)" % new_slug
        cand_titles = _extract_project_titles(cand_desc, cand_soul)
        overlap = new_titles & cand_titles
        if overlap:
            return cand_name, cand_dir, "同一项目名称《%s》" % sorted(overlap)[0]
    return None


def cmd_init(args):
    root = find_root()
    base = os.path.realpath(args.spaces_dir) if args.spaces_dir else os.path.dirname(os.path.realpath(root))
    new_name = (args.name or "").strip()
    if not new_name or new_name in (".", "..", "expert") or "/" in new_name or "\\" in new_name or new_name.startswith("."):
        raise ExpertError("专家名 %r 不合法" % new_name, "没有创建任何目录", "使用简洁名字（如 game-lead、qa-expert），不要叫 expert 或包含路径分隔符")
    target = os.path.join(base, new_name)
    if os.path.exists(target):
        raise ExpertError("目标专家目录已存在: %s" % target, "没有改动现有目录", "换一个名字，或直接在该专家目录里修改 soul.md")
    if not getattr(args, "force", False):
        conflict = find_existing_project_conflict(base, new_name, getattr(args, "desc", ""), getattr(args, "soul", ""))
        if conflict:
            existing_name, existing_dir, reason = conflict
            raise ExpertError(
                "已存在同项目的专家/团队 %s (%s，命中原因：%s)" % (existing_name, existing_dir, reason),
                "没有重复创建专家目录",
                "请直接复用现有团队 %s（在 %s 下操作或用 team.py send --to %s）；若确需另建独立副本请显式加 --force" % (existing_name, existing_dir, existing_name),
            )
    # Every thing a person builds is a team: a 1+0 team (front + leader + qa + research + team-reflect)
    # is the smallest one, and `--team` / `--member` are accepted but no longer change the shape.
    template = template_dir(root, team=True)
    staging = os.path.join(base, ".init-%s-%d" % (new_name, os.getpid()))
    if os.path.exists(staging):
        shutil.rmtree(staging, ignore_errors=True)
    try:
        for relative, contents, mode in template_files(template):
            dest = os.path.join(staging, relative)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as handle:
                handle.write(contents)
            os.chmod(dest, mode)
        desc_path = os.path.join(staging, ROOT_DESCRIPTOR)
        desc_data = read_json(desc_path, {}) or {}
        desc_data["name"] = new_name
        desc_data["description"] = args.desc.strip()
        if "team" not in (desc_data.get("tags") or []):
            desc_data["tags"] = list(desc_data.get("tags") or ["expert"]) + ["team"]
        write_json(desc_path, desc_data)
        soul_path = os.path.join(staging, "soul.md")
        try:
            raw_soul = open(soul_path, "r", encoding="utf-8").read()
        except OSError:
            raw_soul = ""
        soul_body = (args.soul or args.desc).strip()
        role_block = "## 我是谁（%s）\n\n- **一句话职责**：%s\n- **角色定位与工作原则**：%s\n" % (new_name, args.desc.strip(), soul_body)
        marker = "（以下由"
        idx = raw_soul.find(marker)
        if idx >= 0:
            new_soul = raw_soul[:idx].rstrip() + "\n\n" + role_block + "\n\n" + raw_soul[idx:]
        elif raw_soul.strip():
            new_soul = raw_soul.rstrip() + "\n\n" + role_block
        else:
            new_soul = "# 灵魂\n\n" + role_block
        with open(soul_path, "w", encoding="utf-8") as handle:
            handle.write(new_soul.rstrip() + "\n")
        with open(os.path.join(staging, "charter.md"), "w", encoding="utf-8") as handle:
            handle.write(new_soul.rstrip() + "\n")
        setup_team_structure(staging, new_name, args.desc.strip(), getattr(args, "members", None), final_root=target)
        ensure_git(staging)
        os.replace(staging, target)
    except Exception:
        if os.path.exists(staging):
            shutil.rmtree(staging, ignore_errors=True)
        raise
    sync_identity(target)
    if getattr(args, "team", False) or getattr(args, "members", None):
        refresh_live_status(target)
    opened_info = ""
    if os.environ.get("GENEHUB_CLI"):
        try:
            genet("space", "open", target)
            _, opened_mine = me(target)
            spaces_map = opened_mine.get("spaces") or {}
            if spaces_map:
                opened_info = "\n已打开空间: " + ", ".join("%s=%s" % (k, v) for k, v in sorted(spaces_map.items()))
        except ExpertError as err:
            opened_info = "\n注意: 自动打开空间未完成（%s），可稍后运行 genet space open %s" % (err.what, target)
    print("已创建并初始化专家 %s: %s%s" % (new_name, target, opened_info))


def _unbind_space_worktree(root, space_name):
    role_dir = os.path.join(root, "spaces", space_name)
    if not os.path.isdir(role_dir):
        raise ExpertError("组员空间不存在: spaces/%s" % space_name, "没有改动", "用 `team.py employee ls` 查看现有岗位")
    env = open_env(role_dir)
    old_wt = env.pop("WORKTREE_DIR", None)
    write_open_env(role_dir, env)
    desc_path = os.path.join(role_dir, ROOT_DESCRIPTOR)
    data = read_json(desc_path, {}) or {}
    if old_wt:
        rel_wt = os.path.relpath(os.path.realpath(old_wt), os.path.realpath(role_dir)).replace(os.sep, "/")
        folders = [f for f in (data.get("folders") or []) if (f.get("path") if isinstance(f, dict) else f) != rel_wt]
        data["folders"] = folders
        write_json(desc_path, data)
    sync_identity(root)
    if os.environ.get("GENEHUB_CLI"):
        try:
            genet("space", "open", role_dir)
        except ExpertError:
            pass
    return old_wt


def _find_team_base_repo(root):
    leader_wt = open_env(os.path.join(root, "spaces", "leader")).get("WORKTREE_DIR")
    if leader_wt and os.path.isdir(leader_wt) and subprocess.run(["git", "-C", leader_wt, "rev-parse", "--git-dir"], capture_output=True).returncode == 0:
        return os.path.realpath(leader_wt)
    wt_base = os.path.join(root, "worktrees")
    if os.path.isdir(wt_base):
        for entry in sorted(os.listdir(wt_base)):
            cand = os.path.join(wt_base, entry)
            if os.path.isdir(cand) and subprocess.run(["git", "-C", cand, "rev-parse", "--git-dir"], capture_output=True).returncode == 0:
                return os.path.realpath(cand)
    return None


def cmd_employee(args):
    root = find_root()
    subcmd = args.employee_command
    if subcmd == "ls":
        _, mine = me(root)
        spaces_map = mine.get("spaces") or {}
        roles = child_role_names(root)
        if not roles:
            print("（还没有子空间岗位）")
            return
        for r in roles:
            rdir = os.path.join(root, "spaces", r)
            info = descriptor(rdir) or {}
            wt = open_env(rdir).get("WORKTREE_DIR")
            active = bool(wt) or r in ("leader", "team-reflect", "reflect")
            wid = spaces_map.get(r, "")
            live = live_sessions(wid) if wid else []
            state_tag = "active(在岗)" if active else "standby(待岗)"
            print("- %s [%s]: %s | 工位: %s | 活跃会话: %d" % (r, state_tag, info.get("description") or "-", wt or "未绑定", len(live)))
        return
    if subcmd in ("retire", "standby"):
        role = (args.name or "").strip()
        old_wt = _unbind_space_worktree(root, role)
        refresh_live_status(root, force=True)
        print("已将岗位 spaces/%s 解除工位绑定转入待岗（原工位: %s）" % (role, old_wt or "无"))
        return
    if subcmd != "add":
        raise ExpertError("未知 employee 子命令", "没有改动", "用 `team.py employee add|ls|retire`")
    role = (args.name or "").strip()
    if not role or "/" in role or "\\" in role or role.startswith("."):
        raise ExpertError("组员名 %r 不合法" % role, "没有创建子空间", "用简洁英文/数字/连字符名称（如 skill-lead、combat-lead）")
    style_text = None
    if getattr(args, "role", None):
        style_text = args.role.strip()
    wt = getattr(args, "worktree", None)
    repo = getattr(args, "repo", None)
    if not wt and not getattr(args, "no_worktree", False) and not repo and role not in ("research", "reflect", "team-reflect"):
        repo = _find_team_base_repo(root)
    if not wt and repo:
        repo_abs = _find_team_base_repo(root) if repo == "auto" else os.path.realpath(repo)
        if not repo_abs or not os.path.isdir(repo_abs):
            raise ExpertError("仓库路径不存在: %s" % repo, "没有创建子空间与工位", "传入有效的主仓或 bare 仓库路径")
        slot = "%s-wt" % role
        wt_dir = os.path.join(root, "worktrees", slot)
        os.makedirs(os.path.dirname(wt_dir), exist_ok=True)
        branch = getattr(args, "branch", None) or ("pipeline/%s" % role)
        if not os.path.exists(wt_dir):
            done = subprocess.run(["git", "-C", repo_abs, "worktree", "add", "-B", branch, wt_dir, "HEAD"], capture_output=True, text=True, timeout=60)
            if done.returncode != 0:
                raise ExpertError("git worktree add 失败: %s" % (done.stderr or done.stdout).strip()[-300:], "没有完成工位切出", "检查仓库状态或分支名后重试")
        wt = wt_dir
    role_dir = scaffold_role_space(root, role, args.desc.strip(), style_text, worktree_dir=wt)
    sync_identity(root)
    if os.environ.get("GENEHUB_CLI"):
        try:
            genet("space", "open", root)
            genet("space", "open", role_dir)
        except ExpertError:
            pass
    refresh_live_status(root, force=True)
    wt_note = "，已绑定工位 %s" % os.path.realpath(wt) if wt else ""
    print("已添加组员空间 spaces/%s (%s%s)" % (role, role_dir, wt_note))


def bind_space_worktree(root, space_name, wt_abs):
    wt_real = os.path.realpath(wt_abs)
    if space_name in ("root", "front", "."):
        target_dir = os.path.join(root, "front") if os.path.isdir(os.path.join(root, "front")) else root
        manifest_dir = root
    else:
        target_dir = os.path.join(root, "spaces", space_name)
        manifest_dir = target_dir
    if not os.path.isdir(target_dir):
        raise ExpertError("空间 %r 不存在 (%s)" % (space_name, target_dir), "没有绑定工位", "先用 `team.py employee add %s --desc ...` 创建子空间" % space_name)
    env = open_env(target_dir)
    env["WORKTREE_DIR"] = wt_real
    env.setdefault("EXPERT_EFFORT", "high")
    write_open_env(target_dir, env)
    desc_path = os.path.join(manifest_dir, ROOT_DESCRIPTOR)
    data = read_json(desc_path, {}) or {}
    folders = list(data.get("folders") or [])
    entry = _worktree_folder_entry(manifest_dir, wt_real, folders)
    if entry:
        folders.append(entry)
        data["folders"] = folders
        write_json(desc_path, data)
    sync_identity(root)
    if os.environ.get("GENEHUB_CLI"):
        try:
            genet("space", "open", manifest_dir)
        except ExpertError:
            pass


def cmd_worktree(args):
    root = find_root()
    if args.worktree_command == "ls":
        wt_base = os.path.join(root, "worktrees")
        if not os.path.isdir(wt_base):
            print("（还没有 worktrees/ 目录）")
            return
        rows = []
        for entry in sorted(os.listdir(wt_base)):
            full = os.path.join(wt_base, entry)
            if os.path.isdir(full):
                branch = subprocess.run(["git", "-C", full, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip() or "?"
                rows.append("- %s: %s (branch: %s)" % (entry, full, branch))
        print("\n".join(rows) if rows else "（还没有工位）")
        return
    if args.worktree_command == "bind":
        sp = getattr(args, "space_opt", None) or args.space
        raw_path = args.space if getattr(args, "space_opt", None) and not getattr(args, "path", None) else getattr(args, "path", None)
        if not sp or not raw_path:
            raise ExpertError("worktree bind 需要指定空间与工位路径/槽名", "没有绑定工位", "用 `team.py worktree bind <角色空间> <工位路径或槽名>`")
        cand_wt = os.path.join(root, "worktrees", raw_path)
        wt_target = cand_wt if (not os.path.isdir(raw_path) and os.path.isdir(cand_wt)) else raw_path
        bind_space_worktree(root, sp, wt_target)
        refresh_live_status(root, force=True)
        print("已将空间 %s 绑定工位 %s" % (sp, os.path.realpath(wt_target)))
        return
    if args.worktree_command != "create":
        raise ExpertError("未知 worktree 子命令", "没有改动", "用 create / bind / ls")
    slot = (args.slot or "").strip()
    if not slot or "/" in slot or "\\" in slot:
        raise ExpertError("工位名 %r 不合法" % slot, "没有创建 worktree", "使用简洁名字（如 leader-main、skill-v11）")
    repo = os.path.realpath(args.repo)
    if not os.path.isdir(repo):
        raise ExpertError("仓库路径不存在: %s" % repo, "没有创建 worktree", "传入有效的主仓或 bare 仓库路径")
    wt_dir = os.path.join(root, "worktrees", slot)
    os.makedirs(os.path.dirname(wt_dir), exist_ok=True)
    branch = args.branch or ("wt/%s" % slot)
    if not os.path.exists(wt_dir):
        base_ref = args.base or "HEAD"
        done = subprocess.run(["git", "-C", repo, "worktree", "add", "-B", branch, wt_dir, base_ref], capture_output=True, text=True, timeout=60)
        if done.returncode != 0:
            raise ExpertError("git worktree add 失败: %s" % (done.stderr or done.stdout).strip()[-300:], "没有完成工位切出", "检查仓库状态或分支名后重试")
    if getattr(args, "space", None):
        bind_space_worktree(root, args.space, wt_dir)
    refresh_live_status(root)
    print("已就绪工位 %s -> %s (branch: %s%s)" % (slot, wt_dir, branch, ", 绑定空间: %s" % args.space if getattr(args, "space", None) else ""))


def _valid_release_versions(rel_root):
    if not os.path.isdir(rel_root):
        return []
    out = []
    for d in os.listdir(rel_root):
        if d == "latest" or d.startswith("."):
            continue
        idx = os.path.join(rel_root, d, "index.html")
        try:
            if os.path.isdir(os.path.join(rel_root, d)) and os.path.isfile(idx) and os.path.getsize(idx) > 0:
                out.append(d)
        except OSError:
            pass
    return sorted(out, reverse=True)


def update_releases_index(root, preferred_latest=None):
    rel_root = os.path.join(datas_root(root), "releases")
    os.makedirs(rel_root, exist_ok=True)
    versions = _valid_release_versions(rel_root)
    pin_file = os.path.join(rel_root, ".latest_version")
    chosen = preferred_latest if (preferred_latest and preferred_latest in versions) else None
    if not chosen and os.path.isfile(pin_file):
        try:
            pinned = open(pin_file, "r", encoding="utf-8").read().strip()
            if pinned in versions:
                chosen = pinned
        except OSError:
            pass
    if not chosen and versions:
        chosen = versions[0]
    if chosen:
        try:
            with open(pin_file, "w", encoding="utf-8") as handle:
                handle.write(chosen + "\n")
        except OSError:
            pass
        latest_src = os.path.join(rel_root, chosen)
        latest_dst = os.path.join(rel_root, "latest")
        staging_dst = os.path.join(rel_root, ".latest-tmp-%d" % os.getpid())
        if os.path.exists(staging_dst):
            shutil.rmtree(staging_dst, ignore_errors=True)
        try:
            shutil.copytree(latest_src, staging_dst)
            if os.path.exists(latest_dst):
                shutil.rmtree(latest_dst, ignore_errors=True)
            os.replace(staging_dst, latest_dst)
        except OSError:
            if os.path.exists(staging_dst):
                shutil.rmtree(staging_dst, ignore_errors=True)
    items_html = "\n".join(
        '<li><a href="%s/index.html"><strong>%s%s</strong> — 点击进入试玩</a></li>' % (ver, ver, " (当前最新生效)" if ver == chosen else "")
        for ver in versions
    ) or "<li>暂无已发布版本</li>"
    html = (
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<title>版本发布总览</title>\n"
        "<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;background:#0f141c;color:#e6edf3}"
        "a{color:#58a6ff;text-decoration:none}li{margin:.75rem 0;padding:.75rem;background:#161b22;border:1px solid #30363d;border-radius:8px}"
        ".top{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem}</style>\n"
        "</head>\n<body>\n<div class=\"top\"><h1>🎮 已发布可玩版本总览</h1><a href=\"../board/index.html\">📊 打开实时团队看板 &rarr;</a></div>\n<ul>\n%s\n</ul>\n</body>\n</html>\n" % items_html
    )
    with open(os.path.join(rel_root, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(html)
    return chosen


def _copy_publish_source(src, dest):
    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.isdir(src):
        shutil.copytree(src, dest)
    else:
        os.makedirs(dest, exist_ok=True)
        shutil.copy2(src, os.path.join(dest, "index.html"))


def _validate_publish_source(src):
    if not os.path.exists(src):
        raise ExpertError("待发布源路径不存在: %s" % src, "没有发布产物", "先生成构建产物或报告目录，再调用 publish")
    if os.path.isdir(src):
        idx = os.path.join(src, "index.html")
        if not os.path.isfile(idx) or os.path.getsize(idx) == 0:
            raise ExpertError("待发布目录缺少非空入口文件 index.html: %s" % src, "已拦截损坏版本/报告发布，线上版本未受影响", "检查构建输出目录确认 index.html 存在且非空后重试")
    else:
        if os.path.getsize(src) == 0:
            raise ExpertError("待发布入口文件为空: %s" % src, "已拦截损坏版本/报告发布，线上版本未受影响", "检查构建输出文件非空后重试")


def _update_leader_description(root, desc_text):
    try:
        _, mine = me(root)
        leader_wid = (mine.get("spaces") or {}).get("leader")
        if leader_wid:
            live = [s for s in live_sessions(leader_wid) if s.get("status") in ("idle", "running", "waiting")]
            if live:
                latest_sid = max(live, key=lambda s: s.get("updatedAtMs", 0))["id"]
                auto_describe_session(latest_sid, desc_text)
    except Exception:
        pass


def cmd_publish(args):
    root = find_root()
    if args.publish_command == "rollback":
        rel_root = os.path.join(datas_root(root), "releases")
        versions = _valid_release_versions(rel_root)
        if not versions:
            raise ExpertError("没有任何可回退的有效已发布版本", "没有改动", "先发布至少一个包含非空 index.html 的版本")
        pin_file = os.path.join(rel_root, ".latest_version")
        cur_ver = None
        if os.path.isfile(pin_file):
            try:
                cur_ver = open(pin_file, "r", encoding="utf-8").read().strip()
            except OSError:
                pass
        if not cur_ver and versions:
            cur_ver = versions[0]
        target_ver = (getattr(args, "to", None) or "").strip()
        if target_ver:
            if target_ver not in versions:
                raise ExpertError("目标回退版本 %r 不存在或缺少有效 index.html（可选版本: %s）" % (target_ver, ", ".join(versions)), "没有改动", "指定已存在的有效版本号")
        else:
            candidates = [v for v in versions if v != cur_ver]
            target_ver = candidates[0] if candidates else versions[0]
        update_releases_index(root, preferred_latest=target_ver)
        inc_path = os.path.join(root, ".pm", "incidents.md")
        os.makedirs(os.path.dirname(inc_path), exist_ok=True)
        reason = (getattr(args, "reason", None) or "线上版本紧急回退").strip()
        with open(inc_path, "a", encoding="utf-8") as handle:
            handle.write("\n- [%s] **版本回滚 (`%s` -> `%s`)**: %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), cur_ver or "?", target_ver, reason))
        _update_leader_description(root, "研发组长：已回滚至稳定版 %s，排查修复问题版本" % target_ver)
        refresh_live_status(root, force=True)
        print("已原子回滚 latest 至稳定版本 %s（原版本: %s）: [立即试玩最新稳定版](datas/releases/latest/index.html) | [%s 专版入口](datas/releases/%s/index.html) | [实时团队看板](datas/board/index.html)" % (target_ver, cur_ver or "-", target_ver, target_ver))
        return
    raw_src = getattr(args, "src", None) or getattr(args, "source_opt", None)
    if not raw_src:
        raise ExpertError("publish 需要提供待发布目录或入口文件路径", "没有发布产物", "用 `team.py publish release <构建目录> --name vX.Y`")
    src = os.path.realpath(raw_src)
    _validate_publish_source(src)
    if args.publish_command == "release":
        ver = (getattr(args, "name", None) or getattr(args, "version_opt", None) or "").strip()
        if not ver or "/" in ver or "\\" in ver:
            raise ExpertError("版本号 %r 不合法" % ver, "没有发布版本", "用 --name v1.1 这样的简洁版本名")
        dest = os.path.join(datas_root(root), "releases", ver)
        _copy_publish_source(src, dest)
        update_releases_index(root, preferred_latest=ver)
        _update_leader_description(root, "研发组长：已发布 %s，统筹后续版本与管线集成" % ver)
        refresh_live_status(root, force=True)
        rel_link = "datas/releases/%s/index.html" % ver
        print("已发布版本 %s: [%s 立即试玩](%s) | [全部版本总览](datas/releases/index.html) | [实时团队看板](datas/board/index.html)" % (ver, ver, rel_link))
        return
    if args.publish_command == "report":
        slug = (getattr(args, "slug", None) or getattr(args, "name_opt", None) or "report").strip()
        day = time.strftime("%y%m%d")
        stable_slug = slug[7:] if (len(slug) > 7 and slug[:6].isdigit() and slug[6] == "-") else slug
        dated_slug = "%s-%s" % (day, stable_slug)
        stable_dest = os.path.join(datas_root(root), "reports", stable_slug)
        _copy_publish_source(src, stable_dest)
        if dated_slug != stable_slug:
            dated_dest = os.path.join(datas_root(root), "reports", dated_slug)
            _copy_publish_source(src, dated_dest)
        refresh_live_status(root, force=True)
        rel_link = "datas/reports/%s/index.html" % stable_slug
        print("已发布报告 %s: [%s 报告](%s) | [实时团队看板](datas/board/index.html)" % (stable_slug, stable_slug, rel_link))
        return
    raise ExpertError("未知 publish 子命令", "没有发布", "使用 `team.py publish release` 或 `team.py publish report`")


def cmd_board(args):
    root = find_root()
    refresh_live_status(root, force=True)
    state = read_json(state_dir(root, "board-service.json"), {}) or {}
    pid = state.get("pid")
    port = state.get("port")
    print("常驻团队看板已就绪: [📊 实时团队看板](datas/board/index.html) (PID=%s, port=%s)" % (pid or "-", port or "-"))


def cmd_models(args):
    root = find_root()
    name, mine = me(root)
    print("专家/团队: %s (%s)" % (name, root))
    for role in sorted((mine.get("spaces") or {}).keys()):
        role_dir = os.path.join(root, "front") if role == "root" and os.path.isdir(os.path.join(root, "front")) else (root if role == "root" else os.path.join(root, "spaces", role))
        env = dict(open_env(root))
        env.update(open_env(role_dir))
        effort = env.get("EXPERT_EFFORT") or "default"
        wt = env.get("WORKTREE_DIR") or "-"
        model_cfg = env.get("EXPERT_MODEL") or env.get("EXPERT_MODEL_%s" % role.upper().replace("-", "_")) or "auto(Max/Pro)"
        print("- %s: model=%s | effort=%s | worktree=%s" % (role, model_cfg, effort, wt))


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
        for held in project_places(expert["root"]):
            lines.append("项目 %s" % held)
        for role, workspace_id in expert["spaces"].items():
            for item in sorted(live_sessions(workspace_id), key=lambda value: -value.get("updatedAtMs", 0)):
                labels = ",".join(item.get("labels") or [])
                lines.append("%s/%s %s [%s] %s %s" % (name, role, item["id"], item.get("status"), labels, item.get("description") or item.get("title") or ""))
    print("\n".join(lines) if lines else "没有专家")


def project_dirs(env):
    return [item for item in env.get("PROJECT_DIRS", "").split(":") if item]


def project_places(root):
    """What the expert keeps: everything two levels down in datas/, then the directories claimed with `mount`."""
    places = []
    base = datas_root(root)
    for group in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        full = os.path.join(base, group)
        if group.startswith(".") or not os.path.isdir(full):
            continue
        places.extend("%s/%s  (datas)" % (group, name) for name in sorted(os.listdir(full)) if not name.startswith(".") and os.path.isdir(os.path.join(full, name)))
    places.extend("%s  (mounted)" % item for item in project_dirs(open_env(root)))
    return places


def stale_worktree(path):
    """Why the files in this working copy may not match upstream: `git fetch` moves objects only, never the files."""
    probe = subprocess.run(["git", "-C", path, "status", "--porcelain", "-b"], capture_output=True, text=True)
    if probe.returncode != 0:
        return []
    lines = probe.stdout.splitlines()
    warnings = []
    head = next((line for line in lines if line.startswith("## ")), "")
    if "behind" in head or "ahead" in head:
        warnings.append("工作区与上游不一致：%s" % head[3:].strip())
    dirty = sum(1 for line in lines if line and not line.startswith("## "))
    if dirty:
        warnings.append("有 %d 个未提交或未跟踪的文件" % dirty)
    return warnings


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
    for why in stale_worktree(path):
        print("注意: %s —— 读它的磁盘文件读的是这个工作区的当前状态，git fetch 不会自动更新工作区文件。" % why)


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


# ---------------------------------------------------------------- datas/ and temp/

def datas_root(root):
    return os.path.join(root, "datas")


def temp_root(root):
    return os.path.join(root, "temp")


def datas_spec_from_url(url):
    """https://host/group/name(.git) or git@host:group/name(.git) -> group/name."""
    text = url.strip().rstrip("/")
    if text.endswith(".git"):
        text = text[:-4]
    tail = text.split(":", 1)[1] if re.match(r"^[\w.-]+@[\w.-]+:", text) else re.sub(r"^[a-z+]+://[^/]+/", "", text)
    parts = [item for item in tail.split("/") if item]
    if len(parts) < 2:
        raise ExpertError("从 %r 取不出 group/name" % url, "没有解析出路径", "直接写 group/name，如 aikenc/genethub")
    return "/".join(parts[-2:])


def datas_path(root, spec=None, url=None, create=False):
    """datas/<group>/<name>: two levels are the advice, anything below is the owner's business. Never leaves datas/."""
    if url:
        spec = datas_spec_from_url(url)
    base = datas_root(root)
    if not spec:
        target = base
    else:
        parts = spec.split("/")
        if "\\" in spec or spec.startswith("/") or any(item in ("", ".", "..") for item in parts):
            raise ExpertError("%r 不是 datas/ 下的相对路径" % spec, "没有创建或返回任何路径", "写成 group/name，如 aikenc/genethub；不能含 .. 或绝对路径")
        target = os.path.join(base, *parts)
    if create:
        os.makedirs(target, exist_ok=True)
    return target


def local_stamp(now):
    moment = time.localtime(now)
    return time.strftime("%y%m%d", moment), time.strftime("%H%M", moment)


def caller_identity():
    return os.environ.get("GENEHUB_SESSION_ID") or "ppid%d" % os.getppid()


def temp_new(root, slug, purpose, now=None, caller=None):
    """Create (or return, when the same caller asks again in the same minute) temp/YYMMDD/hhmm_slug_hash4."""
    if not isinstance(slug, str) or not SLUG.match(slug) or len(slug) > 30:
        raise ExpertError("slug %r 不合规" % (slug,), "没有创建任何目录", SLUG_RULE)
    if not purpose or not purpose.strip():
        raise ExpertError("没有写用途", "没有创建任何目录", "用 --purpose 写一句话：这个目录是干什么的")
    now = time.time() if now is None else now
    day, minute = local_stamp(now)
    who = caller or caller_identity()
    digest = hashlib.sha1("\x1f".join((slug, day, minute, who)).encode("utf-8")).hexdigest()[:4]
    path = os.path.join(temp_root(root), day, "%s_%s_%s" % (minute, slug, digest))
    os.makedirs(path, exist_ok=True)
    meta = os.path.join(path, ".temp.json")
    if not os.path.exists(meta):
        write_json(meta, {"slug": slug, "createdAtMs": int(now * 1000), "creator": who, "purpose": purpose.strip()})
    return path


def tree_stats(path):
    """(bytes, newest modification time) of a file or directory tree, symlinks not followed."""
    size, newest = 0, os.lstat(path).st_mtime
    for current, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            try:
                info = os.lstat(os.path.join(current, name))
            except OSError:
                continue
            size += info.st_size
            newest = max(newest, info.st_mtime)
    return size, newest


def temp_entries(root):
    """Every unit under temp/: a directory inside a YYMMDD directory, or anything else sitting directly in temp/."""
    base = temp_root(root)
    units = []
    for entry in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        full = os.path.join(base, entry)
        if entry == "README.md":
            continue
        if DATE_DIR.match(entry) and os.path.isdir(full) and not os.path.islink(full):
            units.extend((entry, os.path.join(full, child)) for child in sorted(os.listdir(full)))
        else:
            units.append((None, full))
    return units


def temp_list(root, date=None, slug=None, mine=False):
    rows = []
    me_id = caller_identity()
    for day, full in temp_entries(root):
        if date and day != date:
            continue
        meta = read_json(os.path.join(full, ".temp.json"), {}) or {}
        name = os.path.basename(full)
        if slug and slug not in name:
            continue
        if mine and meta.get("creator") != me_id:
            continue
        size, newest = tree_stats(full)
        rows.append({"path": full, "creator": meta.get("creator", "?"), "purpose": meta.get("purpose", "（没有 .temp.json，命名不合规）"), "bytes": size, "modifiedAt": newest})
    return rows


def inside(path, base):
    base = os.path.realpath(base)
    try:
        return os.path.commonpath([path, base]) == base and path != base
    except ValueError:
        return False


def temp_remove(root, target):
    """Delete one thing under temp/: given as a path, or as a fragment that names exactly one directory."""
    base = temp_root(root)
    if os.sep in target or os.path.exists(target):
        candidates = [os.path.abspath(target)]
    else:
        candidates = [row["path"] for row in temp_list(root, slug=target)]
    if len(candidates) != 1:
        raise ExpertError("%r 对应 %d 个目录" % (target, len(candidates)), "没有删除任何东西", "用 `temp ls` 查看，再给出完整路径" if candidates else "用 `temp ls` 确认名字")
    path = candidates[0]
    parent = os.path.realpath(os.path.dirname(path))
    if not inside(os.path.join(parent, os.path.basename(path)), base):
        raise ExpertError("%s 不在 temp/ 里" % path, "没有删除任何东西", "只能删除 %s 下的内容" % base)
    if not os.path.lexists(path):
        raise ExpertError("%s 不存在" % path, "没有删除任何东西", "用 `temp ls` 确认")
    if os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
    else:
        shutil.rmtree(path)
    return path


def temp_clean(root, keep_days=None, dry_run=False, now=None):
    """Remove what has not changed for keep_days days and, regardless of that setting, never what changed in the last 24 hours."""
    now = time.time() if now is None else now
    limit = max(TEMP_KEEP_DAYS if keep_days is None else keep_days, 0) * 86400
    removed = []
    for day, full in temp_entries(root):
        size, newest = tree_stats(full)
        age = now - newest
        if age > limit and age > TEMP_ACTIVE_S:
            removed.append((full, size))
            if not dry_run:
                if os.path.isdir(full) and not os.path.islink(full):
                    shutil.rmtree(full)
                else:
                    os.unlink(full)
    base = temp_root(root)
    if not dry_run and os.path.isdir(base):
        for entry in os.listdir(base):
            full = os.path.join(base, entry)
            if DATE_DIR.match(entry) and os.path.isdir(full) and not os.path.islink(full) and not os.listdir(full):
                os.rmdir(full)
    if removed and not dry_run:
        log = state_dir(root, "temp-clean.log")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "a", encoding="utf-8") as handle:
            handle.write("%s 清理 %d 项，%d 字节: %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)), len(removed), sum(size for _, size in removed), ", ".join(os.path.relpath(path, base) for path, _ in removed)))
    return removed


def clean_temp_hourly(root):
    marker = state_dir(root, "temp-clean.json")
    if now_ms() - (read_json(marker, {}) or {}).get("atMs", 0) < TEMP_CLEAN_EVERY_S * 1000:
        return
    try:
        temp_clean(root)
    except OSError as error:
        raise ExpertError("清理 temp/ 失败: %s" % error, "已清理的保持清理，其余留在原处", "检查 temp/ 的权限；下一小时自动重试")
    write_json(marker, {"atMs": now_ms()})


def humanize(size):
    for unit in ("B", "K", "M", "G"):
        if size < 1024 or unit == "G":
            return "%d%s" % (size, unit) if unit == "B" else "%.1f%s" % (size, unit)
        size /= 1024.0


def cmd_path(args):
    root = find_root()
    if args.area == "root":
        print(root)
    elif args.area == "datas":
        print(datas_path(root, args.spec, args.source, args.create))
    else:
        if args.spec or args.source:
            raise ExpertError("temp 的路径不能自己起名", "没有返回路径", "用 `temp new <slug> --purpose ...` 创建")
        base = temp_root(root)
        if args.create:
            os.makedirs(base, exist_ok=True)
        print(base)


def cmd_datas(args):
    root = find_root()
    base = datas_root(root)
    lines = []
    for group in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        full = os.path.join(base, group)
        if group.startswith(".") or group == "README.md" or not os.path.isdir(full):
            continue
        for name in sorted(os.listdir(full)):
            item = os.path.join(full, name)
            if name.startswith(".") or not os.path.isdir(item):
                continue
            holder = (read_json(os.path.join(writer_lock(item), "genet-writer.json"), {}) or {}).get("session")
            lines.append("%s/%s  %s%s" % (group, name, time.strftime("%Y-%m-%d %H:%M", time.localtime(tree_stats(item)[1])), "  写会话 %s" % holder if holder else ""))
    print("\n".join(lines) if lines else "datas/ 里还没有内容")


def cmd_temp(args):
    root = find_root()
    if args.temp_command == "new":
        print(temp_new(root, args.slug, args.purpose or ""))
    elif args.temp_command == "ls":
        rows = temp_list(root, args.date, args.slug, args.mine)
        base = temp_root(root)
        print("\n".join("%s  %s  %s  %s  %s" % (os.path.relpath(row["path"], base), row["creator"], humanize(row["bytes"]), time.strftime("%m-%d %H:%M", time.localtime(row["modifiedAt"])), row["purpose"]) for row in rows) if rows else "temp/ 是空的")
    elif args.temp_command == "rm":
        print("已删除 %s" % temp_remove(root, args.target))
    else:
        keep = None if args.older_than is None else float(args.older_than.rstrip("d"))
        removed = temp_clean(root, keep, args.dry_run)
        verb = "将清理" if args.dry_run else "已清理"
        print("\n".join("%s %s（%s）" % (verb, os.path.relpath(path, temp_root(root)), humanize(size)) for path, size in removed) if removed else "没有需要清理的")


# ---------------------------------------------------------------- reset

RESET_BACKUPS = "reset"
ROOT_DESCRIPTOR = "agent-space.genet.json"


def is_team_root(root):
    if not root or not os.path.isdir(root):
        return False
    desc = descriptor(root) or {}
    if "team" in (desc.get("tags") or []):
        return True
    if open_env(root).get("EXPERT_TEAM"):
        return True
    if (
        os.path.isdir(os.path.join(root, ".pm"))
        or os.path.isdir(os.path.join(root, "spaces", "leader"))
        or os.path.isdir(os.path.join(root, "spaces", "team-reflect"))
    ):
        return True
    return False


def template_dir(root, team=None):
    """The template teams are made from ships in the data directory next to `spaces/`;
    EXPERT_TEMPLATE / EXPERT_TEAM_TEMPLATE override. There is one template: a team."""
    use_team = True
    tpl_name = "team-template"
    if use_team and os.environ.get("EXPERT_TEAM_TEMPLATE"):
        path = os.path.realpath(os.environ["EXPERT_TEAM_TEMPLATE"])
        if os.path.isdir(path):
            return path
    if os.environ.get("EXPERT_TEMPLATE"):
        base_tpl = os.path.realpath(os.environ["EXPERT_TEMPLATE"])
        if use_team:
            sibling = os.path.join(os.path.dirname(base_tpl), "team-template")
            if os.path.isdir(sibling):
                return os.path.realpath(sibling)
        if os.path.isdir(base_tpl):
            return base_tpl
    for start_dir in (os.path.realpath(root), os.path.realpath(os.path.dirname(os.path.abspath(__file__)))):
        cur = start_dir
        while True:
            cand = os.path.join(cur, "builtin-skills", "genehub", "references", tpl_name)
            if os.path.isdir(cand):
                return os.path.realpath(cand)
            if os.path.basename(cur) == "team-template" and os.path.basename(os.path.dirname(cur)) == "references":
                cand2 = os.path.join(os.path.dirname(cur), tpl_name)
                if os.path.isdir(cand2):
                    return os.path.realpath(cand2)
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
    path = os.path.realpath(os.path.join(root, "..", "..", "builtin-skills", "genehub", "references", tpl_name))
    if not os.path.isdir(path):
        raise ExpertError("找不到专家模板: %s" % path, "没有改动任何文件", "把模板路径写进环境变量 EXPERT_TEMPLATE，或确认 GeneHub 的内置技能目录完整")
    return path


def template_files(template):
    """(relative path, bytes, mode) of every file the template ships, in a stable order."""
    found = []
    skip_dirs = {"__pycache__", ".genethub", ".spacebuilder", ".agents", ".claude", ".codebuddy", ".cursor", ".git"}
    skip_files = {"AGENTS.md", "CLAUDE.md", ".rgignore", ".DS_Store"}
    for current, dirs, files in os.walk(template):
        dirs[:] = sorted(name for name in dirs if name not in skip_dirs)
        for name in sorted(files):
            if name.endswith(".pyc") or name in skip_files:
                continue
            full = os.path.join(current, name)
            with open(full, "rb") as handle:
                found.append((os.path.relpath(full, template).replace(os.sep, "/"), handle.read(), os.stat(full).st_mode & 0o777))
    return found


def merge_descriptor(template, existing):
    """The template's root descriptor with what its owner chose kept: name, description, what they added to
    tags/skills/agents, and keys the template does not know. The template wins everywhere else."""
    merged = json.loads(template.decode("utf-8"))
    for key in ("name", "description"):
        if key in (existing or {}):
            merged[key] = existing[key]
    for key in ("tags", "skills", "agents"):
        if isinstance(merged.get(key), list):
            merged[key] += [item for item in (existing or {}).get(key) or [] if item not in merged[key]]
    for key, value in (existing or {}).items():
        merged.setdefault(key, value)
    return (json.dumps(merged, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def find_expert(root, name):
    """The expert to reset: this one, or another one named `name` (its name or its directory name)."""
    if not name:
        return root
    siblings = os.path.dirname(root)
    matches = set()
    for entry in sorted(os.listdir(siblings)) if os.path.isdir(siblings) else []:
        directory = os.path.join(siblings, entry)
        info = descriptor(directory)
        if info and "expert" in (info.get("tags") or []) and name in (info.get("name"), entry):
            matches.add(os.path.realpath(directory))
    if not matches:
        try:  # an expert kept outside spaces/ is only known to the daemon; without it, the name is simply not found
            known = experts().get(name)
        except ExpertError:
            known = None
        if known:
            matches.add(os.path.realpath(known["root"]))
    if not matches:
        raise ExpertError("找不到专家 %s" % name, "没有改动任何文件", "用 `team.py directory` 看这台机器上有哪些专家，名字照抄")
    if len(matches) > 1:
        raise ExpertError("%s 对应多个专家目录: %s" % (name, "、".join(sorted(matches))), "没有改动任何文件", "改用目录名，或先让用户改掉重名")
    return matches.pop()


def reset_plan(target, template, with_memory):
    """What a reset would write into `target`: (relative path, new bytes, mode, "新增" | "覆盖"). What already equals the template is left out.

    The template's files replace the expert's, soul.md included; memory.md and index.md files only when asked. Never listed, so never touched:
    posts/, datas/ and temp/ contents, files the template does not have, sessions. The root descriptor keeps its owner's choices.
    """
    plan = []
    for relative, contents, mode in template_files(template):
        if (relative == "memory.md" or relative == "front/index.md" or (relative.startswith("spaces/") and relative.endswith("/index.md"))) and not with_memory:
            continue
        path = os.path.join(target, relative)
        existing = None
        try:
            with open(path, "rb") as handle:
                existing = handle.read()
        except OSError:
            pass
        if relative == ROOT_DESCRIPTOR:
            contents = merge_descriptor(contents, json.loads(existing.decode("utf-8")) if existing else {})
        if existing != contents:
            plan.append((relative, contents, mode, "覆盖" if existing is not None else "新增"))
    return plan


def reset_expert(target, template, with_memory=False, apply=False, now=None):
    """Returns (plan, backup directory or None). With `apply` the plan is written, replaced files are copied to
    .genethub/expert/reset/<time>/ first, and the expert is built again so the new soul.md reaches its Agents."""
    plan = reset_plan(target, template, with_memory)
    if not apply or not plan:
        return plan, None
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now or time.time()))
    backup = state_dir(target, RESET_BACKUPS, stamp)
    for relative, contents, mode, action in plan:
        path = os.path.join(target, relative)
        if action == "覆盖":
            kept = os.path.join(backup, relative)
            os.makedirs(os.path.dirname(kept), exist_ok=True)
            shutil.copy2(path, kept)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = path + ".reset-tmp"
        with open(temporary, "wb") as handle:
            handle.write(contents)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    return plan, backup


def cmd_reset(args):
    root = find_root()
    target = find_expert(root, args.expert)
    template = template_dir(target)
    plan, _ = reset_expert(target, template, args.with_memory, False)
    who = "自己" if target == root else "专家 %s" % ((descriptor(target) or {}).get("name") or os.path.basename(target))
    if not plan:
        print("%s已经和模板一致，没有什么可重置的" % who)
        return
    lines = ["%s %s" % (action, relative) for relative, _c, _m, action in plan]
    if not args.apply:
        print("预演：将重置%s，共 %d 个文件（还没有改动任何东西）\n%s\n保留：name/description、posts/、datas/、temp/、会话%s\n用户确认后加 --apply 执行；被覆盖的文件会先备份到 %s\n只在用户明确要求时才重置。想升级平台文件又不想丢掉自己的改动：让反思会话来做（`team.py reflect now 升级平台文件`），它在 temp/ 里合并并验证；用户明确授权才直接重置。重置后正在进行的会话仍是旧身份，新开会话才读到新的 soul.md" % (
            who, len(plan), "\n".join(lines), "" if args.with_memory else "、memory.md（要连 memory.md 一起重置加 --with-memory）", os.path.relpath(state_dir(target, RESET_BACKUPS), target)))
        return
    if has_repo(target):
        git_snapshot(target, "snapshot: 重置之前")  # `git revert` brings the old files back
    plan, backup = reset_expert(target, template, args.with_memory, True)
    os.makedirs(state_dir(target), exist_ok=True)
    with open(state_dir(target, "reset.log"), "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"atMs": now_ms(), "by": os.path.basename(root), "files": [item[0] for item in plan], "withMemory": args.with_memory, "backup": backup}, ensure_ascii=False) + "\n")
    try:
        done = subprocess.run([sys.executable, builder_script(target), "build", target], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise ExpertError("重建 %s 超时" % who, "文件已经重置（旧文件在 %s），但还没有重新编译" % backup, "手动运行 spacebuilder.py build %s" % target)
    if done.returncode != 0:
        tail = "\n".join(line for line in (done.stdout + done.stderr).splitlines() if line.strip())[-400:]
        raise ExpertError("重建 %s 失败: %s" % (who, tail), "文件已经重置（旧文件在 %s），但还没有重新编译" % backup, "按错误修正后手动运行 spacebuilder.py build %s" % target)
    if has_repo(target):
        platform_commit(target, template)
        git_snapshot(target, "reset: 恢复为平台模板")
    print("已重置%s：%d 个文件已恢复为模板（含 soul.md），旧文件备份在 %s\n正在进行的会话仍带着旧身份，新开会话才会读到新的 soul.md" % (who, len(plan), backup))


# ---------------------------------------------------------------- git at the root: the expert's own files

# Allowlist: the repository tracks what the reflect session maintains and nothing else. Everything unlisted (runtime
# state, datas/, temp/, SpaceBuilder's generated files) stays out, including repositories nested under datas/ and temp/.
GITIGNORE = """# 专家根目录的仓库只跟踪专家自己的文件（允许名单）。要纳入新路径，加一行 !/路径
/*
!/.gitignore
!/agent-space.genet.json
!/soul.md
!/charter.md
!/memory.md
!/front/
/front/*
!/front/style.md
!/front/role.md
!/front/index.md
!/skills/
!/tools/
!/posts/
!/docs/
!/spaces/
/spaces/*/*
!/spaces/*/agent-space.genet.json
!/spaces/*/style.md
!/spaces/*/role.md
!/spaces/*/index.md
__pycache__/
*.pyc
"""
GIT_FLAGS = ["-c", "user.name=expert", "-c", "user.email=expert@genethub.local", "-c", "commit.gpgsign=false", "-c", "core.quotepath=off"]
EXPERT_PATHS = re.compile(r"^(soul\.md|charter\.md|memory\.md|front/index\.md|front/role\.md|spaces/[^/]+/index\.md|spaces/[^/]+/role\.md|spaces/[^/]+/style\.md|spaces/[^/]+/agent-space\.genet\.json|skills/local-[^/]+/.*|tools/local/.*)$")


def git(root, *args, input=None, env=None, check=True):
    done = subprocess.run(["git", "-C", root] + GIT_FLAGS + list(args), input=input, capture_output=True, env=env, timeout=60)
    if check and done.returncode != 0:
        raise ExpertError("git %s 失败: %s" % (" ".join(args[:2]), (done.stderr or done.stdout).decode("utf-8", "replace").strip()[-300:]),
                          "专家目录的仓库保持原样或已部分完成，见错误", "按错误处理后下一次运行自动重试")
    return done


def git_text(root, *args, check=True):
    return git(root, *args, check=check).stdout.decode("utf-8", "replace").strip()


def has_repo(root):
    return os.path.isdir(os.path.join(root, ".git"))


def template_tracked(template):
    """The template files that belong on the `platform` branch: every file the template ships, plus `.gitignore`."""
    files = [
        (relative, contents, mode)
        for relative, contents, mode in template_files(template)
        if not relative.startswith(("datas/", "temp/", "posts/"))
    ]
    if not any(relative == ".gitignore" for relative, _c, _m in files):
        files.insert(0, (".gitignore", GITIGNORE.encode("utf-8"), 0o644))
    return files


def template_digest(template):
    digest = hashlib.sha256()
    for relative, contents, mode in template_tracked(template):
        digest.update(relative.encode() + b"\0" + contents + b"\0")
    return digest.hexdigest()[:16]


def platform_ref(root):
    for ref in ("refs/heads/platform", "refs/remotes/origin/platform"):
        if git(root, "rev-parse", "--verify", "-q", ref, check=False).returncode == 0:
            return ref
    return None


def platform_digest(root):
    """The template version the `platform` branch holds, read from its latest commit; None without the branch."""
    ref = platform_ref(root)
    if not ref:
        return None
    done = git(root, "log", "-1", "--format=%s", ref, check=False)
    subject = done.stdout.decode("utf-8", "replace").strip()
    return subject.split(":", 1)[1].strip() if done.returncode == 0 and subject.startswith("platform:") else None


def platform_commit(root, template):
    """Records the template as it is now on the `platform` branch (one commit per version). Returns whether it added one."""
    if not template_files(template):
        # A template that ships nothing (removed, or not unpacked yet) must never be recorded:
        # `template_tracked` would keep only `.gitignore`, and merging that tree strips the team bare.
        print("平台模板目录是空的（%s），跳过这次 platform 记录" % template)
        return False
    digest = template_digest(template)
    ref = platform_ref(root)
    if platform_digest(root) == digest and ref == "refs/heads/platform":
        return False
    with tempfile.TemporaryDirectory() as scratch:
        env = dict(os.environ, GIT_INDEX_FILE=os.path.join(scratch, "index"))
        for relative, contents, mode in template_tracked(template):
            blob = git(root, "hash-object", "-w", "--stdin", input=contents, env=env).stdout.decode().strip()
            git(root, "update-index", "--add", "--cacheinfo", "%s,%s,%s" % ("100755" if mode & 0o100 else "100644", blob, relative), env=env)
        tree = git(root, "write-tree", env=env).stdout.decode().strip()
    parent = git(root, "rev-parse", "--verify", "-q", ref, check=False).stdout.decode().strip() if ref else ""
    if platform_digest(root) == digest and parent:
        git(root, "update-ref", "refs/heads/platform", parent)
        return False
    commit = git(root, "commit-tree", tree, *(["-p", parent] if parent else []), "-m", "platform: %s" % digest).stdout.decode().strip()
    git(root, "update-ref", "refs/heads/platform", commit)
    return True


def git_snapshot(root, message):
    """Commits whatever changed in the tracked set. Returns the short commit id, or None when nothing changed."""
    git(root, "add", "-A")
    if git(root, "diff", "--cached", "--quiet", check=False).returncode == 0:
        return None
    git(root, "commit", "-q", "-m", message)
    return git_text(root, "rev-parse", "--short", "HEAD")


def ensure_git(root):
    """Initialises the repository at the root (idempotent). Returns "ready" or "initialized"."""
    if not shutil.which("git"):
        raise ExpertError("这台机器没有 git", "专家目录没有版本管理：反思会话的改动无法回退，也看不到平台差异", "请用户安装 git；装好后下一次运行自动初始化")
    if has_repo(root):
        ignore = os.path.join(root, ".gitignore")
        try:
            existing_ignore = open(ignore, encoding="utf-8").read() if os.path.isfile(ignore) else ""
        except OSError:
            existing_ignore = ""
        if "!/front/index.md" not in existing_ignore:
            with open(ignore, "w", encoding="utf-8") as handle:
                handle.write(GITIGNORE)
        return "ready"
    git(root, "init", "-q")
    git(root, "symbolic-ref", "HEAD", "refs/heads/main")
    ignore = os.path.join(root, ".gitignore")
    if not os.path.exists(ignore):
        with open(ignore, "w", encoding="utf-8") as handle:
            handle.write(GITIGNORE)
    parent = None
    try:
        platform_commit(root, template_dir(root))
        parent = git(root, "rev-parse", "--verify", "-q", "refs/heads/platform", check=False).stdout.decode().strip() or None
    except ExpertError:
        pass  # no template on this machine: the branch appears once there is one
    git(root, "add", "-A")
    tree = git(root, "write-tree").stdout.decode().strip()
    commit = git(root, "commit-tree", tree, *(["-p", parent] if parent else []), "-m", "expert: 初始状态").stdout.decode().strip()
    git(root, "update-ref", "refs/heads/main", commit)
    return "initialized"


def platform_watch(root):
    """Keeps the repository and the `platform` branch in order, and leaves one note when the template has a newer
    version than the branch holds: upgrading is the reflect session's work. Checked at most once a minute."""
    marker = state_dir(root, "platform-check.json")
    if has_repo(root) and now_ms() - (read_json(marker, {}) or {}).get("atMs", 0) < PLATFORM_CHECK_S * 1000:
        return
    ensure_git(root)
    write_json(marker, {"atMs": now_ms()})
    try:
        template = template_dir(root)
    except ExpertError:
        return
    held = platform_digest(root)
    digest = template_digest(template)
    if held is None:
        platform_commit(root, template)
    elif held == digest:
        for note in pending_notes(root):
            if note.get("kind") == "upgrade":
                source = os.path.join(notes_dir(root), note["id"] + ".json")
                if os.path.isfile(source):
                    write_json(os.path.join(notes_dir(root, True), note["id"] + ".json"), dict(note, handledAtMs=now_ms(), result="platform 已与模板一致"))
                    os.remove(source)
    else:
        record = {"kind": "upgrade", "session": None, "turn": None, "ref": None, "from": "platform", "quote": "无",
                  "context": "平台模板有新版本（%s，平台分支上是 %s）。升级由反思会话在 temp/ 里做：见 expert-reflect。" % (digest, held),
                  "text": "template %s" % digest}
        note_id = "n" + hashlib.sha1("\x1f".join(("upgrade", digest)).encode("utf-8")).hexdigest()[:12]
        done_path = os.path.join(notes_dir(root, True), note_id + ".json")
        if os.path.isfile(done_path):
            os.remove(done_path)
        add_note(root, record, "upgrade", digest)


def drift_lines(root):
    """Files whose content differs from the template's `platform` branch, expert-owned ones left out. Raises when there is no branch."""
    ref = platform_ref(root)
    if ref is None:
        raise ExpertError("还没有 platform 分支", "没有可比较的基准", "等下一次定时运行初始化，或确认本机有专家模板")
    names = git_text(root, "diff", "--name-status", ref, "--", "agent-space.genet.json", "front", "skills", "tools", "docs", "spaces").splitlines()
    return [line for line in names if not EXPERT_PATHS.match(line.split("\t", 1)[-1])]


def cmd_drift(_args):
    root = find_root()
    if not has_repo(root):
        raise ExpertError("专家目录还没有 git 仓库", "没有可比较的基准", "等定时运行初始化（几秒内），或运行 `team.py snapshot`")
    git_snapshot(root, "snapshot: drift 之前")
    lines = drift_lines(root)
    try:
        current = template_digest(template_dir(root))
    except ExpertError:
        current = None
    print("\n".join(lines) if lines else "平台文件与 platform 分支一致")
    if current and current != platform_digest(root):
        print("平台模板有新版本 %s，platform 分支上是 %s：升级见 expert-reflect 的 references/upgrade.md" % (current, platform_digest(root)))


def cmd_snapshot(args):
    root = find_root()
    ensure_git(root)
    if getattr(args, "refresh_platform", False):
        platform_commit(root, template_dir(root))
        marker = state_dir(root, "platform-check.json")
        if os.path.exists(marker):
            os.remove(marker)
        platform_watch(root)
    done = git_snapshot(root, args.message or "snapshot")
    print("已提交 %s" % done if done else "没有需要提交的改动")


# ---------------------------------------------------------------- notes: what the reflect session reads

NOTE_KINDS = ("unhappy", "preference", "external", "observation", "upgrade", "anomaly")


def notes_dir(root, done=False):
    return state_dir(root, "notes-done" if done else "notes")


def pending_notes(root):
    base = notes_dir(root)
    found = [read_json(os.path.join(base, entry)) for entry in sorted(os.listdir(base)) if entry.endswith(".json")] if os.path.isdir(base) else []
    return sorted((note for note in found if note), key=lambda note: note.get("at", 0))


def add_note(root, record, *identity):
    """Writes the note once: its id comes from what it is about, so a repeat (or a handled note) is not written again."""
    note_id = "n" + hashlib.sha1("\x1f".join(str(part) for part in identity).encode("utf-8")).hexdigest()[:12]
    for done in (False, True):
        if os.path.exists(os.path.join(notes_dir(root, done), note_id + ".json")):
            return note_id, False
    write_json(os.path.join(notes_dir(root), note_id + ".json"), dict(record, id=note_id, at=now_ms()))
    return note_id, True


def latest_round(session_id):
    """The newest round of a session: its round id and the id of the user message that started it. None when unknown."""
    try:
        rounds = genet("session", "rounds", session_id).get("page", {}).get("rounds", [])
    except ExpertError:
        return None
    if not rounds:
        return None
    last = rounds[-1]
    return {"roundId": last.get("roundId"), "userItemId": last.get("userItemId")}


def cmd_note(args):
    root = find_root()
    target = root
    if args.expert:
        known = experts().get(args.expert)
        if not known:
            raise ExpertError("没有专家 %r" % args.expert, "没有留言", "用 `directory` 查看有哪些专家")
        target = known["root"]
    session = args.session or os.environ.get("GENEHUB_SESSION_ID")
    turn = latest_round(session) if session else None
    ref = "ghref:item:%s:%s" % (session, turn["userItemId"]) if session and turn and turn.get("userItemId") else None
    text = " ".join(args.words)
    context = args.context or text
    hints = []
    if not args.quote:
        hints.append("没写 --quote（用户原话），反思时少一个判断依据")
    if not context:
        hints.append("没写 --context（当时在做什么、可能错在哪），建议补上")
    if not session:
        hints.append("没有会话 id，反思时回不到那一轮；在会话里运行，或加 --session")
    elif not turn:
        hints.append("取不到这个会话的轮次，只记了会话 id")
    sender = (descriptor(root) or {}).get("name") or os.path.basename(root)
    record = {"kind": args.kind, "session": session, "turn": turn, "ref": ref, "from": sender, "quote": args.quote or "", "context": context, "text": text}
    note_id, fresh = add_note(target, record, session, (turn or {}).get("userItemId"), args.kind, args.quote or "", context, sender)
    print(("已留言 %s" if fresh else "这条留言已经记过了 %s") % note_id + ("；" + "；".join(hints) if hints and fresh else ""))


def cmd_notes(args):
    root = find_root()
    action, ids = (args.words or ["ls"])[0], (args.words or ["ls"])[1:]
    if action not in ("ls", "done"):
        raise ExpertError("notes 只有 ls 和 done，收到 %r" % action, "没有改动任何留言", "`notes`（看未处理的）、`notes ls --all`、`notes done <编号>…`")
    if action == "ls":
        rows = pending_notes(root)
        if args.all:
            done = notes_dir(root, True)
            rows += sorted((read_json(os.path.join(done, entry)) for entry in os.listdir(done) if entry.endswith(".json")), key=lambda note: note.get("at", 0)) if os.path.isdir(done) else []
        for note in rows:
            print("%s  %s  %s  会话 %s  %s\n    原话: %s\n    情况: %s" % (note["id"], time.strftime("%m-%d %H:%M", time.localtime(note["at"] / 1000)), note.get("kind"),
                                                              note.get("session") or "-", note.get("ref") or "（无引用）", note.get("quote") or "（无）", note.get("context") or "（无）"))
        if not rows:
            print("没有未处理的留言")
        return
    if not ids:
        raise ExpertError("没有给留言编号", "没有改动任何留言", "notes done <编号>…；编号用 `notes` 查")
    for note_id in ids:
        source = os.path.join(notes_dir(root), note_id + ".json")
        note = read_json(source)
        if not note:
            raise ExpertError("没有未处理的留言 %s" % note_id, "没有改动这条留言", "用 `notes` 看编号")
        write_json(os.path.join(notes_dir(root, True), note_id + ".json"), dict(note, handledAtMs=now_ms(), result=args.result or ""))
        os.remove(source)
    print("已处理 %d 条留言" % len(ids))


def cmd_tell_user(args):
    root = find_root()
    name, mine = me(root)
    front = front_session(root, mine["spaces"])
    text = " ".join(args.text)
    if not front:
        raise ExpertError("用户还没有和前台说过话，没有可转告的会话", "没有转告", "把要说的写进 memory.md 或留言，等前台有了会话再说")
    notice(front, "tell-user", os.environ.get("GENEHUB_SESSION_ID") or "%s:hook" % name, text, hashlib.sha1(text.encode()).hexdigest())
    print("已请前台转告用户")


# ---------------------------------------------------------------- the reflect session

def reflect_space_key(spaces):
    if "team-reflect" in spaces:
        return "team-reflect"
    if "reflect" in spaces:
        return "reflect"
    return None


def reflect_sessions(spaces):
    key = reflect_space_key(spaces)
    wid = spaces.get(key) if key else None
    return live_sessions(wid) if wid else []


def user_rounds_since(spaces, since, team_mode=False, limit=None):
    """(how many rounds started after `since`, when the last one ended).
    In team mode, counts completed rounds across all non-reflect spaces so TeamReflect wakes after team progress.
    Each `session rounds` costs about a second, so the walk goes newest-first and stops at `limit`: the caller only
    needs to know whether enough rounds piled up."""
    count, last = 0, 0
    target_wids = [wid for role, wid in spaces.items() if role not in ("reflect", "team-reflect")] if team_mode else [spaces["root"]]
    for wid in target_wids:
        for item in sorted(live_sessions(wid), key=lambda value: -(value.get("updatedAtMs") or 0)):
            if not team_mode and SYSTEM_LABEL in (item.get("labels") or []):
                continue
            if item.get("updatedAtMs", 0) <= since:
                continue
            for found in genet("session", "rounds", item["id"]).get("page", {}).get("rounds", []):
                user_item = found.get("userItemId") or ""
                if found.get("endedAtMs", 0) > since and (team_mode or (user_item and not user_item.startswith("x."))):
                    count += 1
                    last = max(last, found["endedAtMs"])
                    if limit and count >= limit:
                        return count, last
    return count, last


def briefing(root, mine, reason):
    """The reflect session's starting file, assembled by the script without a model. Returns its path."""
    now = now_ms()
    stuck_after = setting(root, "EXPERT_STUCK_AFTER", STUCK_AFTER_S)
    lines = ["# 反思简报（脚本生成，没有调用模型）", "", "原因: %s" % reason, "时间: %s" % time.strftime("%Y-%m-%d %H:%M:%S"), ""]
    notes = pending_notes(root)
    lines.append("## 未处理的留言（%d）" % len(notes))
    for note in notes:
        lines += ["- %s [%s] 会话 %s 轮 %s" % (note["id"], note.get("kind"), note.get("session") or "-", (note.get("turn") or {}).get("roundId") or "-"),
                  "  ref: %s" % (note.get("ref") or "（无）"), "  原话: %s" % (note.get("quote") or "（无）"), "  情况: %s" % (note.get("context") or "（无）")]
    session_lines, suspect_lines = [], []
    for role, workspace_id in mine["spaces"].items():
        for item in sorted(live_sessions(workspace_id), key=lambda value: -value.get("updatedAtMs", 0))[:30]:
            last_active = item.get("lastActivityAtMs") or item.get("updatedAtMs") or now
            quiet_s = max(0, int((now - last_active) / 1000))
            status = item.get("status")
            inputs = item.get("inputSummary") or {}
            requests = (item.get("interactionSummary") or {}).get("requests") or []
            row = "- %s/%s %s [%s] %s %s" % (role, item["id"], ",".join(item.get("labels") or []), status, item.get("description") or item.get("title") or "", time.strftime("%m-%d %H:%M", time.localtime(item.get("updatedAtMs", 0) / 1000)))
            session_lines.append(row)
            if not requests and (status == "failed" or inputs.get("paused") or (status == "running" and quiet_s >= stuck_after)):
                suspect_lines.append("%s（静默 %ds%s）" % (row, quiet_s, "，错误: %s" % inputs["error"] if inputs.get("error") else ""))
    if suspect_lines:
        lines += ["", "## 疑似异常会话（%d）" % len(suspect_lines)] + suspect_lines
    lines += ["", "## 各会话"] + session_lines
    done = state_dir(root, "done")
    records = sorted((read_json(os.path.join(done, entry)) or {} for entry in os.listdir(done)), key=lambda value: value.get("createdAtMs", 0))[-10:] if os.path.isdir(done) else []
    lines += ["", "## 最近完成的后台会话（%d）" % len(records)] + ["- %s %s %s" % (record.get("sessionId"), record.get("kind"), record.get("desc")) for record in records]
    if has_repo(root):
        try:
            changed = drift_lines(root)
        except ExpertError:
            changed = []
        lines += ["", "## 与平台模板的差异（%d）" % len(changed)] + ["- %s" % line for line in changed]
    path = state_dir(root, "briefings", time.strftime("%Y%m%d-%H%M%S") + ".md")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


def reflect_title(reason, notes, request=None):
    if request:
        snippet = " ".join(request.split())[:36]
        return "反思：%s（%s）" % (reason[:24], snippet) if snippet else "反思：%s" % reason[:60]
    if notes:
        parts = []
        for note in notes[:2]:
            kind = note.get("kind") or "note"
            raw = note.get("quote") if note.get("quote") and note.get("quote") != "无" else (note.get("context") or note.get("text") or "")
            snippet = " ".join(str(raw).split())[:22]
            parts.append("%s:%s" % (kind, snippet) if snippet else kind)
        summary = "；".join(parts) + (" 等" if len(notes) > 2 else "")
        return ("反思：%s｜%s" % (reason[:28], summary))[:80]
    return "反思：%s" % reason[:60]


def start_reflect(root, name, mine, reason, request=None, requester=None, tier=None, model=None):
    """Starts a one-shot reflect session, or hands the request to the one that is running. Returns a sentence saying what happened."""
    ref_key = reflect_space_key(mine["spaces"])
    if not ref_key:
        raise ExpertError("这个专家没有 reflect 空间", "没有创建会话", "它的目录早于反思机制；用户要求时 `reset` 会补上 spaces/reflect")
    busy = [item for item in reflect_sessions(mine["spaces"]) if item.get("status") in ("running", "waiting")]
    sender = os.environ.get("GENEHUB_SESSION_ID") or "%s:hook" % name
    if busy:
        if request:
            notice(busy[0]["id"], "task", sender, request, request)
            return "已有反思会话 %s 在运行，已把要求排进它的队列" % busy[0]["id"]
        return "已有反思会话 %s 在运行，这次不再开" % busy[0]["id"]
    if has_repo(root):
        git_snapshot(root, "snapshot: 反思开始前")  # whatever others changed is committed first, so every change after it is the reflect session's
    notes = pending_notes(root)
    title = reflect_title(reason, notes, request)
    path = briefing(root, mine, reason)
    team_hint = ""
    if os.path.isdir(os.path.join(root, ".pm")) or open_env(root).get("EXPERT_TEAM"):
        team_hint = "\n团队模式二级记忆提炼要求：先将各岗位（leader/组员/qa/research）具体经验与 ghref 证据写入对应 `spaces/<岗位>/index.md`，再将跨角色通用铁律提炼入根 `memory.md`（≤30 行）。"
    text = clip("[系统说明：本反思会话由 %s 发起（用途: reflect）]\n\n原因: %s\n简报: %s\n%s%s\n按 expert-reflect 办：先读简报，再按留言里的 ref 回到那一轮。处理完的留言用 `team.py notes done <编号>`；没有要告诉用户的就不要 tell-user。" % (
        sender, reason, path, ("用户的要求（原话在前，引用在后）:\n%s" % request) if request else "", team_hint))
    session_id, why = start(root, mine["spaces"][ref_key], ref_key, title, text, "EXPERT_MODEL_REFLECT", tier, model)
    write_json(state_dir(root, "pending", session_id + ".json"), {
        "sessionId": session_id, "requester": requester, "kind": "reflect", "desc": title, "createdAtMs": now_ms(),
        "baseline": None, "notified": [], "lock": None, "route": why, "quiet": requester is None})
    write_json(state_dir(root, "reflect.json"), {"atMs": now_ms(), "sessionId": session_id, "reason": reason})
    return "已开始反思会话 %s（%s）" % (session_id, why)


def cmd_reflect(args):
    root = find_root()
    if is_builtin_admin(root):
        raise ExpertError(
            "内置管理员（spaces/admin）在守护进程启动时始终与平台模板对齐，不维护独立记忆或跑自进化反思",
            "没有创建反思会话",
            "若要体验或验证专家自进化闭环，请在 spaces/<新专家> 下新建或选择一个普通专家目录执行",
        )
    name, mine = me(root)
    request = " ".join(args.text)
    print(start_reflect(root, name, mine, "用户要求立刻反思", request, os.environ.get("GENEHUB_SESSION_ID") or front_session(root, mine["spaces"]), args.tier, args.model))


URGENT_NOTE_KINDS = ("unhappy", "anomaly", "upgrade")


def wake(root, name, mine):
    """The timer decides whether the reflect session should start, without calling a model: the person started
    WAKE_ROUNDS rounds since the last wake, or there are pending notes. Urgent notes (unhappy, anomaly, upgrade)
    wake immediately; ordinary notes wait NOTE_QUIET_S and respect WAKE_GAP_S. If a reflect session is already
    running and new notes arrive, they are queued into it."""
    if not reflect_space_key(mine["spaces"]):
        return
    state = read_json(state_dir(root, "reflect.json"), {}) or {}
    now = now_ms()
    notes = pending_notes(root)
    busy = [item for item in reflect_sessions(mine["spaces"]) if item.get("status") in ("running", "waiting")]
    if busy and notes:
        running_id = busy[0]["id"]
        notified = set(state.get("notifiedNotes") or []) if state.get("notifiedSessionId") == running_id else set()
        fresh = [note for note in notes if note["id"] not in notified]
        if fresh:
            lines = ["- %s [%s] 会话 %s: 原话=%s | 情况=%s (ref: %s)" % (
                note["id"], note.get("kind"), note.get("session") or "-",
                note.get("quote") or "（无）", note.get("context") or "（无）", note.get("ref") or "（无）"
            ) for note in fresh]
            notice(running_id, "note", "%s:hook" % name, "反思期间收到 %d 条新留言，请一并处理并 notes done:\n%s" % (len(fresh), "\n".join(lines)),
                   running_id, *(note["id"] for note in fresh))
            state["notifiedSessionId"] = running_id
            state["notifiedNotes"] = sorted(notified | {note["id"] for note in fresh})
            write_json(state_dir(root, "reflect.json"), state)
        return
    already_notified = set(state.get("notifiedNotes") or [])
    has_urgent = any(note.get("kind") in URGENT_NOTE_KINDS for note in notes)
    has_fresh_urgent = any(
        note.get("kind") in URGENT_NOTE_KINDS and note["id"] not in already_notified
        for note in notes
    )
    has_anomaly = any(note.get("kind") == "anomaly" for note in notes)
    if not has_fresh_urgent and now - state.get("atMs", 0) < setting(root, "EXPERT_WAKE_GAP", WAKE_GAP_S) * 1000:
        return
    reason = None
    if notes and (has_urgent or now - max(note.get("at", 0) for note in notes) >= setting(root, "EXPERT_NOTE_QUIET", NOTE_QUIET_S) * 1000):
        reason = "有 %d 条未处理的留言%s" % (len(notes), "（含会话异常）" if has_anomaly else "")
    elif not has_urgent and now - state.get("checkedAtMs", 0) >= setting(root, "EXPERT_WAKE_CHECK", WAKE_CHECK_S) * 1000:
        state["checkedAtMs"] = now
        write_json(state_dir(root, "reflect.json"), state)
        is_team = bool(os.path.isdir(os.path.join(root, ".pm")) or open_env(root).get("EXPERT_TEAM"))
        need = setting(root, "EXPERT_WAKE_ROUNDS", WAKE_ROUNDS)
        count, last = user_rounds_since(mine["spaces"], state.get("atMs", 0), team_mode=is_team, limit=need)
        write_json(state_dir(root, "reflect.json"), dict(state, seen={"rounds": count, "lastEndedAtMs": last}))  # what the last count saw, for whoever wonders why no wake
        if count >= need:
            reason = "自上次反思以来累计完成 %d 轮对话" % count if is_team else "自上次反思以来用户发起了 %d 轮对话" % count
    if reason:
        result = start_reflect(root, name, mine, reason)
        current = read_json(state_dir(root, "reflect.json"), {}) or {}
        if current.get("sessionId") and notes:
            current["notifiedSessionId"] = current["sessionId"]
            current["notifiedNotes"] = sorted(already_notified | {note["id"] for note in notes})
            write_json(state_dir(root, "reflect.json"), current)
        print(result, file=sys.stderr)


# ---------------------------------------------------------------- the timer

def last_reply_text(session_id, item_id):
    page = genet("session", "narrative", session_id, "--item", item_id).get("page", {})
    for item in page.get("items", []):
        if item.get("id") == item_id and item.get("text"):
            return item["text"]
    return ""


def _team_unfinished_milestones(root):
    """Return a short summary string of unfinished milestones if this team has an active unfinished plan, else None."""
    if not is_team_root(root):
        return None
    plan_path = os.path.join(root, ".pm", "trunk", "MILESTONE_PLAN.md")
    if not os.path.isfile(plan_path):
        return None
    try:
        raw = open(plan_path, "r", encoding="utf-8").read()
    except OSError:
        return None
    text = raw.strip()
    if not text:
        return None
    todo_lines = []
    done_lines = []
    for line in text.splitlines():
        s = line.strip()
        if re.match(r"^[-*]\s*\[\s\]\s+", s):
            todo_lines.append(re.sub(r"^[-*]\s*\[\s\]\s+", "", s).strip())
        elif re.match(r"^[-*]\s*\[[xX]\]\s+", s):
            done_lines.append(s)
    if todo_lines:
        return "；".join(todo_lines[:3]) + (" 等 %d 项" % len(todo_lines) if len(todo_lines) > 3 else "")
    if done_lines:
        return None
    if "ALL_MILESTONES_COMPLETED" in text or "全部里程碑已完成" in text:
        return None
    planned_versions = sorted(set(re.findall(r"\bv\d+\.\d+(?:\.\d+)?\b", text)))
    published = set(_valid_release_versions(os.path.join(datas_root(root), "releases")))
    missing_versions = [v for v in planned_versions if v not in published]
    if missing_versions:
        return "待交付版本: " + ", ".join(missing_versions)
    if any(k in text for k in ("进行中", "待完成", "待交付", "IN_PROGRESS", "PENDING", "TODO")) and not published:
        first_line = next((ln.strip("# ").strip() for ln in text.splitlines() if ln.strip()), "未完成里程碑")
        return first_line[:60]
    return None


def _team_progress_fingerprint(root):
    done_dir = state_dir(root, "done")
    done_files = sorted(os.listdir(done_dir)) if os.path.isdir(done_dir) else []
    latest_done_ms = 0
    for fname in done_files:
        rec = read_json(os.path.join(done_dir, fname)) or {}
        latest_done_ms = max(latest_done_ms, rec.get("createdAtMs") or 0)
    releases = _valid_release_versions(os.path.join(datas_root(root), "releases"))
    wt_heads = []
    wt_base = os.path.join(root, "worktrees")
    if os.path.isdir(wt_base):
        for entry in sorted(os.listdir(wt_base)):
            full = os.path.join(wt_base, entry)
            if os.path.isdir(full):
                sha = subprocess.run(["git", "-C", full, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
                if sha:
                    wt_heads.append("%s:%s" % (entry, sha))
    raw = "%d|%d|%s|%s" % (len(done_files), latest_done_ms, ",".join(releases), ",".join(wt_heads))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def leader_watchdog(root, name, mine):
    """Law 3 (Root Leader Watchdog): When a team has unfinished milestones in `.pm/trunk/MILESTONE_PLAN.md`,
    the leader session is idle/failed past `EXPERT_WATCHDOG_AFTER`, and no active child/descendant tasks remain
    in `pending/`, automatically wake the leader with disk progress state. Trips a 3-strike circuit breaker if
    the leader wakes 3 consecutive times without making progress."""
    unfinished = _team_unfinished_milestones(root)
    if not unfinished:
        return
    spaces = (mine or {}).get("spaces") or {}
    leader_wid = spaces.get("leader")
    if not leader_wid:
        return
    live = live_sessions(leader_wid)
    if not live:
        return
    leader_sess = max(live, key=lambda s: s.get("updatedAtMs", 0))
    leader_sid = leader_sess["id"]
    inbox_path = state_dir(root, "inbox", leader_sid + ".jsonl")
    if os.path.isfile(inbox_path) and os.path.getsize(inbox_path) > 0:
        return
    pdir = state_dir(root, "pending")
    if os.path.isdir(pdir):
        for entry in os.listdir(pdir):
            if not entry.endswith(".json"):
                continue
            rec = read_json(os.path.join(pdir, entry))
            if not rec:
                continue
            sid = rec.get("sessionId")
            if sid == leader_sid or rec.get("kind") in ("reflect", "team-reflect"):
                continue
            notified = rec.get("notified") or []
            if "stopped" in notified or "stuck" in notified:
                continue
            return
    try:
        leader_summary = session_summary(leader_sid)
    except ExpertError:
        return
    status = leader_summary.get("status")
    if status not in ("idle", "failed"):
        return
    watchdog_after = setting(root, "EXPERT_WATCHDOG_AFTER", WATCHDOG_AFTER_S)
    max_wakes = int(setting(root, "EXPERT_WATCHDOG_MAX_WAKES", WATCHDOG_MAX_WAKES))
    now = now_ms()
    last_active = max(
        leader_summary.get("lastActivityAtMs") or 0,
        leader_summary.get("updatedAtMs") or 0,
    )
    if (now - last_active) / 1000.0 < watchdog_after:
        return
    wd_path = state_dir(root, "watchdog.json")
    wd = read_json(wd_path, {}) or {}
    fp = _team_progress_fingerprint(root)
    if wd.get("leaderSessionId") != leader_sid or wd.get("progressFingerprint") != fp:
        wd = {
            "leaderSessionId": leader_sid,
            "progressFingerprint": fp,
            "consecutiveWakes": 0,
            "lastWakeAtMs": 0,
            "circuitBroken": False,
        }
    if now - (wd.get("lastWakeAtMs") or 0) < watchdog_after * 1000:
        return
    wakes = int(wd.get("consecutiveWakes") or 0)
    if wakes >= max_wakes:
        if not wd.get("circuitBroken"):
            wd["circuitBroken"] = True
            wd["brokenAtMs"] = now
            write_json(wd_path, wd)
            front = front_session(root, spaces) if "root" in spaces else None
            msg = "研发组长会话 %s 连续 %d 次看门狗唤醒后仍无实质进展（未完成里程碑：%s），已触发看门狗熔断停止自动唤醒。" % (leader_sid, max_wakes, unfinished)
            add_note(
                root,
                {
                    "kind": "anomaly",
                    "session": leader_sid,
                    "turn": latest_round(leader_sid),
                    "ref": None,
                    "from": "%s:watchdog" % name,
                    "quote": "无",
                    "context": msg,
                    "text": unfinished,
                },
                "anomaly",
                leader_sid,
                "watchdog-circuit-break",
                fp,
            )
            if front:
                deliver_or_notice(root, front, "report", "%s:watchdog" % name, msg, leader_sid, "watchdog-circuit-break", fp)
        return
    wakes += 1
    wd["consecutiveWakes"] = wakes
    wd["lastWakeAtMs"] = now
    wd["progressFingerprint"] = fp
    wd["circuitBroken"] = False
    write_json(wd_path, wd)
    _advance_parent_baseline(root, leader_sid, leader_summary)
    releases = _valid_release_versions(os.path.join(datas_root(root), "releases"))
    rel_str = "、".join(releases) if releases else "暂无已发布版本"
    prompt = (
        "当前团队存在未完成的里程碑（%s），且后台已无任何运行中的子任务（看门狗自愈唤醒 #%d/%d，已发布版本：%s）。\n"
        "请立即检查 `.pm/trunk/MILESTONE_PLAN.md` 与各工位分支状态：\n"
        "1. 若下一阶段模块、QA 验收或 `publish release` 尚未发起，请立即调用 `team.py spawn` 或 `team.py publish release` 推进；\n"
        "2. 若所有规划里程碑均已真实发布完毕，请将 `.pm/trunk/MILESTONE_PLAN.md` 中对应条目勾选为 `- [x]`（或写入 `全部里程碑已完成`）并做最终总结。"
        % (unfinished, wakes, max_wakes, rel_str)
    )
    notice(leader_sid, "watchdog", "%s:watchdog" % name, prompt, leader_sid, "watchdog", fp, str(wakes), unpause=True)


def reconcile(root, name, mine):
    front = front_session(root, mine["spaces"])
    pending_dir = state_dir(root, "pending")
    entries = sorted(os.listdir(pending_dir)) if os.path.isdir(pending_dir) else []
    records = []
    for entry in entries:
        path = os.path.join(pending_dir, entry)
        record = read_json(path)
        if record:
            records.append((path, record))
    batch_counts = {}
    batch_has_done = set()
    for _, rec in records:
        bkey = rec.get("batch") or rec["sessionId"]
        batch_counts[bkey] = batch_counts.get(bkey, 0) + 1
        if rec.get("done"):
            batch_has_done.add(bkey)
    closed = set()
    stopped_after = setting(root, "EXPERT_STOPPED_AFTER", STOPPED_AFTER_S)
    giveup_after = setting(root, "EXPERT_GIVEUP_AFTER", GIVEUP_AFTER_S)
    stuck_after = setting(root, "EXPERT_STUCK_AFTER", STUCK_AFTER_S)
    batch_stuck_after = setting(root, "EXPERT_BATCH_STUCK_AFTER", BATCH_STUCK_AFTER_S)
    for path, record in records:
        session_id = record["sessionId"]
        bkey = record.get("batch") or session_id
        is_multi_batch = batch_counts.get(bkey, 1) > 1
        is_quiet_reflect = bool(record.get("quiet") or (record.get("kind") in ("reflect", "team-reflect") and not record.get("requester")))
        to = None if is_quiet_reflect else (record.get("requester") or front)
        finish = lambda p=path, sid=session_id: (move(root, p), closed.add(sid))  # noqa: E731
        has_children = any(other.get("requester") == session_id for _, other in records if other["sessionId"] != session_id)
        try:
            summary = session_summary(session_id)
        except ExpertError:
            if to:
                deliver_or_notice(root, to, "report", "%s:hook" % name, "会话 %s（%s）已不存在，待办记录已清除。" % (session_id, record["desc"]), session_id, "gone")
            if is_multi_batch and not record.get("quiet"):
                record["done"] = {
                    "outcome": "gone",
                    "reply": "gone:%s" % session_id,
                    "ref": "ghref:session:%s" % session_id,
                    "text": "⚠️ 会话已不存在，待办记录已归档。",
                }
                update_pending(root, path, record)
            else:
                finish()
            continue
        status = summary.get("status")
        inputs = summary.get("inputSummary") or {}
        requests = (summary.get("interactionSummary") or {}).get("requests") or []
        reply = (summary.get("latestReply") or {}).get("itemId")
        age = (now_ms() - record["createdAtMs"]) / 1000
        said = record.setdefault("notified", [])
        if requests and (is_team_root(root) or setting(root, "EXPERT_AUTO_UNBLOCK", 0) > 0):
            if _auto_unblock_waiting_system_session(session_id, summary):
                try:
                    summary = session_summary(session_id)
                    status = summary.get("status")
                    inputs = summary.get("inputSummary") or {}
                    requests = (summary.get("interactionSummary") or {}).get("requests") or []
                    reply = (summary.get("latestReply") or {}).get("itemId")
                except ExpertError:
                    pass
        if requests:
            key = "wait:%s" % json.dumps(requests, sort_keys=True)[:200]
            if front and key not in said:
                deliver_or_notice(root, front, "report", "%s:hook" % name, "会话 %s（%s）在等人处理：%s" % (session_id, record["desc"], json.dumps(requests, ensure_ascii=False)[:600]), session_id, key)
                said.append(key)
                update_pending(root, path, record)
            continue
        paused = bool(inputs.get("paused"))
        # The kernel pauses a session for two different reasons: the person stopped it (`interrupt`,
        # `session/manager.rs:3362`, no error) and a turn that died (`session/inbox.rs:808`, this message).
        # Only the second is a failure. Reporting the person's own stop as a failure hides who is holding it up.
        stopped_by_person = paused and TURN_FAILED_ERROR not in (inputs.get("error") or "")
        if paused or status == "failed":
            # Told once. An interrupted session's partial reply is not a result, so it is not delivered as one;
            # a paused record stays until the person resumes it, a failed one is closed (or converted to a bounded
            # terminal batch item so it never hangs sibling tasks in the same batch).
            verdict = "已失败" if (status == "failed" and not stopped_by_person) else "被暂停"
            if "stop" not in said:
                if to:
                    deliver_or_notice(root, to, "report", "%s:hook" % name, "会话 %s（%s）%s：%s" % (session_id, record["desc"], verdict, inputs.get("error") or "无附加信息"), session_id, "stop", unpause=(status == "failed" and not paused and to != front))
                if (status == "failed" or inputs.get("error")) and record.get("kind") not in ("reflect", "team-reflect"):
                    add_note(root, {"kind": "anomaly", "session": session_id, "turn": latest_round(session_id), "ref": "ghref:item:%s:%s" % (session_id, reply) if reply else None, "from": "%s:hook" % name, "quote": "无", "context": "会话 %s（%s）%s：%s" % (session_id, record["desc"], verdict, inputs.get("error") or "无附加信息"), "text": record["desc"]}, "anomaly", session_id, "stop")
                said.append("stop")
                update_pending(root, path, record)
            if status == "failed" and not paused and not has_children:
                if is_multi_batch and not record.get("quiet"):
                    if not record.get("done"):
                        record["done"] = {
                            "outcome": "failed",
                            "reply": "failed:%s" % session_id,
                            "ref": ("ghref:item:%s:%s" % (session_id, reply)) if reply else ("ghref:session:%s" % session_id),
                            "text": "⚠️ 会话已失败：%s" % (inputs.get("error") or "无附加信息"),
                        }
                        update_pending(root, path, record)
                else:
                    parent_busy = False
                    if to and to != front:
                        try:
                            tsum = session_summary(to)
                            if tsum.get("status") not in ("idle", "failed"):
                                parent_busy = True
                            else:
                                _advance_parent_baseline(root, to, tsum)
                                flush_session_inbox_if_idle(root, to, force=True)
                        except ExpertError:
                            pass
                    if not parent_busy:
                        finish()
            elif record.get("kind") in ("reflect", "team-reflect") or age > giveup_after:
                finish()
            continue
        if status == "idle" and reply and reply != record.get("baseline"):
            if has_children:
                record["baseline"] = reply
                record.pop("done", None)
                update_pending(root, path, record)
            elif record.get("quiet"):
                finish()  # routine reflect runs wake quietly; requested ones report back like any task
            else:
                if not record.get("done") or record["done"].get("reply") != reply:
                    text = last_reply_text(session_id, reply) or (summary.get("messagePreview") or {}).get("text", "")
                    record["done"] = {"outcome": "ok", "reply": reply, "ref": "ghref:item:%s:%s" % (session_id, reply), "text": text}
                    update_pending(root, path, record)
        elif status == "idle" and not record.get("done") and not has_children:
            idle_anchor = max(record["createdAtMs"], record.get("wokenAtMs") or 0, summary.get("lastActivityAtMs") or 0)
            idle_s = (now_ms() - idle_anchor) / 1000
            if age > giveup_after:
                finish()
            elif idle_s > stopped_after:
                if "stopped" not in said:
                    if to:
                        deliver_or_notice(root, to, "report", "%s:hook" % name, "会话 %s（%s）已停止，没有给出回复。" % (session_id, record["desc"]), session_id, "stopped")
                    if record.get("kind") not in ("reflect", "team-reflect"):
                        add_note(root, {"kind": "anomaly", "session": session_id, "turn": latest_round(session_id), "ref": None, "from": "%s:hook" % name, "quote": "无", "context": "会话 %s（%s）已停止超过 %d 秒仍未给出回复" % (session_id, record["desc"], stopped_after), "text": record["desc"]}, "anomaly", session_id, "stopped")
                    said.append("stopped")
                    update_pending(root, path, record)
                if record.get("kind") in ("reflect", "team-reflect"):
                    finish()
                elif is_multi_batch:
                    record["done"] = {
                        "outcome": "stopped",
                        "reply": "stopped:%s" % session_id,
                        "ref": "ghref:session:%s" % session_id,
                        "text": "⚠️ 会话已停止，没有给出回复。",
                    }
                    update_pending(root, path, record)
        elif status == "running":
            last_active = summary.get("lastActivityAtMs") or summary.get("updatedAtMs") or now_ms()
            # A member holding up finished siblings gets less patience than one running on its own.
            patience = min(stuck_after, batch_stuck_after) if bkey in batch_has_done else stuck_after
            if (now_ms() - last_active) / 1000 > patience:
                if "stuck" not in said:
                    if to:
                        deliver_or_notice(root, to, "report", "%s:hook" % name, "会话 %s（%s）超过 %d 秒没有进展，可能卡住了。" % (session_id, record["desc"], patience), session_id, "stuck")
                    if record.get("kind") not in ("reflect", "team-reflect"):
                        add_note(root, {"kind": "anomaly", "session": session_id, "turn": latest_round(session_id), "ref": None, "from": "%s:hook" % name, "quote": "无", "context": "会话 %s（%s）超过 %d 秒没有进展，可能卡住了" % (session_id, record["desc"], patience), "text": record["desc"]}, "anomaly", session_id, "stuck")
                    said.append("stuck")
                    update_pending(root, path, record)
                if is_multi_batch and not record.get("done"):
                    record["done"] = {
                        "outcome": "stuck",
                        "reply": "stuck:%s" % session_id,
                        "ref": "ghref:session:%s" % session_id,
                        "text": "⚠️ 会话超过 %d 秒没有进展（已熔断，不阻塞同批次其他子任务）。" % patience,
                    }
                    update_pending(root, path, record)
    batches = {}
    for path, record in records:
        if record["sessionId"] not in closed:
            batches.setdefault(record.get("batch") or record["sessionId"], []).append((path, record))
    for batch_key, group in batches.items():
        if not all(item[1].get("done") for item in group):
            continue
        to = group[0][1].get("requester") or front
        should_unpause = False
        if to:
            try:
                to_summary = session_summary(to)
            except ExpertError:
                to_summary = None
                if front and to != front:
                    try:
                        to_summary = session_summary(front)
                        to = front
                    except ExpertError:
                        to = None
                else:
                    to = None
            if to and to_summary:
                to_status = to_summary.get("status")
                if to_status not in ("idle", "failed"):
                    # Law 2 (Hold-Until-Parent-Ready): the parent is still in its own round.
                    # Keep completed children in pending/ so `has_children` stays True until the parent is ready!
                    continue
                to_inputs = to_summary.get("inputSummary") or {}
                if to_status == "idle" and to_inputs.get("paused") and to == front:
                    should_unpause = False
                else:
                    should_unpause = (to_status == "failed") or bool(to_inputs.get("paused"))
                _advance_parent_baseline(root, to, to_summary)
        watchers = []
        for _, rec in group:
            for w in (rec.get("watchers") or []):
                if w and w != to and w not in watchers:
                    watchers.append(w)
        if len(group) == 1:
            path, record = group[0]
            done = record["done"]
            wt_extra = (" [工位: %s, 分支: %s]" % (record["worktree"], record.get("branch") or "-")) if record.get("worktree") else ""
            if to:
                deliver_or_notice(root, to, "result", "%s（%s）%s" % (record["sessionId"], record["desc"], wt_extra), "%s\n\nref: %s" % (done["text"], done["ref"]), record["sessionId"], done["reply"], ref=done["ref"], unpause=should_unpause)
            for w in watchers:
                try:
                    deliver_or_notice(root, w, "result", "%s（%s）" % (record["sessionId"], record["desc"]), "%s\n\nref: %s" % (done["text"], done["ref"]), record["sessionId"], done["reply"], "watcher", w, ref=done["ref"])
                except Exception:
                    pass
            move(root, path)
        else:
            if to:
                refs = ", ".join(item[1]["done"]["ref"] for item in group)
                parts = []
                for _, rec in group:
                    wt_line = ("\nworktree: %s (branch: %s)" % (rec["worktree"], rec.get("branch") or "-")) if rec.get("worktree") else ""
                    parts.append("### %s（%s）\nref: %s%s\n\n%s" % (rec["sessionId"], rec["desc"], rec["done"]["ref"], wt_line, rec["done"]["text"]))
                sender = "批次完成（%d 项）：%s" % (len(group), "、".join(item[1]["sessionId"] for item in group))
                deliver_or_notice(root, to, "result", sender, "\n\n".join(parts), batch_key, *(item[1]["done"]["reply"] for item in group), ref=refs, unpause=should_unpause)
            for w in watchers:
                try:
                    deliver_or_notice(root, w, "result", sender, "\n\n".join(parts), batch_key, "watcher", w, ref=refs)
                except Exception:
                    pass
            for path, _ in group:
                move(root, path)
    inbox_dir = state_dir(root, "inbox")
    if os.path.isdir(inbox_dir):
        for entry in sorted(os.listdir(inbox_dir)):
            if entry.endswith(".jsonl"):
                sid = entry[:-6]
                try:
                    flush_session_inbox_if_idle(root, sid)
                except Exception as error:  # noqa: BLE001 - the message is put back, so this must not kill the tick
                    report(root, name, mine, "出了什么: 收件箱投递失败 %r\n现在状态: 给 %s 的消息还在 inbox/%s.jsonl，下一轮会重试\n下一步: 检查 tools/team.py 的 flush_session_inbox_if_idle" % (error, sid, sid))
    try:
        leader_watchdog(root, name, mine)
    except Exception as error:  # noqa: BLE001
        report(root, name, mine, "出了什么: 组长看门狗异常 %r\n现在状态: 下一次定时运行自动重试\n下一步: 检查 tools/team.py 的 leader_watchdog" % error)
    refresh_live_status(root)


def update_pending(root, path, record):
    """Persist a pending record while it is still pending.

    A `done/<same name>` left over from an earlier cycle of the same long-lived session must not suppress this
    write: the record is about to be moved onto that very file and has to carry its own fresh `done` payload,
    otherwise the result text is lost and the board and any re-arm see "no result" forever."""
    if not os.path.exists(path):
        return
    write_json(path, record)


def move(root, path):
    destination = state_dir(root, "done", os.path.basename(path))
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    try:
        os.replace(path, destination)
    except FileNotFoundError:
        pass


def health(root, name, mine):
    front = front_session(root, mine["spaces"])
    if not front:
        return
    marker = state_dir(root, "health-check.json")
    # `hook list` 单次约 2s，而钩子每 5s 一轮：钩子坏没坏不需要每轮问一次，60s 一次足够。
    if now_ms() - (read_json(marker, {}) or {}).get("atMs", 0) < HEALTH_CHECK_S * 1000:
        return
    write_json(marker, {"atMs": now_ms()})
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


IDENTITY_RETRY_S = 60


def builder_script(root):
    """SpaceBuilder lives in the expert's own `spaceBuilder` path (tools/spacebuilder.py), falling back to the data directory."""
    if os.environ.get("EXPERT_SPACEBUILDER"):
        path = os.path.realpath(os.environ["EXPERT_SPACEBUILDER"])
    else:
        declared = (descriptor(root) or {}).get("spaceBuilder") or "tools/spacebuilder.py"
        local = os.path.realpath(os.path.join(root, declared))
        if os.path.isfile(local) and local.startswith(os.path.realpath(root) + os.sep):
            return local
        path = os.path.realpath(os.path.join(root, "..", "..", "builtin-skills", "genehub", "references", "spacebuilder", "spacebuilder.py"))
    if not os.path.isfile(path):
        raise ExpertError("找不到 SpaceBuilder: %s" % path, "soul.md 没有重新编译，新会话仍读到旧身份", "把 SpaceBuilder 路径写进环境变量 EXPERT_SPACEBUILDER，或手动运行 spacebuilder.py build <专家目录>")
    return path


def identity_inputs_digest(root):
    """Combined SHA-256 of the root and child descriptors, every declared identity file, and `skills/`."""
    info = descriptor(root) or {}
    declared = info.get("identity")
    if not declared:
        return None, None
    hasher = hashlib.sha256()
    space_dirs = [root]
    spaces_parent = os.path.join(root, "spaces")
    if os.path.isdir(spaces_parent):
        for entry in sorted(os.listdir(spaces_parent)):
            child = os.path.join(spaces_parent, entry)
            if os.path.isfile(os.path.join(child, ROOT_DESCRIPTOR)):
                space_dirs.append(child)
    for space_dir in space_dirs:
        desc_path = os.path.join(space_dir, ROOT_DESCRIPTOR)
        try:
            with open(desc_path, "rb") as handle:
                raw = handle.read()
        except OSError as error:
            raise ExpertError("读不到描述文件 %s: %s" % (desc_path, error), "没有重新编译", "恢复描述文件后下一次运行自动重试")
        rel_desc = os.path.relpath(desc_path, root).replace(os.sep, "/")
        hasher.update(b"desc\0" + rel_desc.encode() + b"\0" + raw + b"\0")
        space_info = descriptor(space_dir) or {}
        id_field = space_info.get("identity")
        items = [id_field] if isinstance(id_field, str) else (id_field if isinstance(id_field, list) else [])
        for rel in items:
            source = os.path.normpath(os.path.join(space_dir, rel))
            rel_from_root = os.path.relpath(source, root).replace(os.sep, "/")
            try:
                with open(source, "rb") as handle:
                    body = handle.read()
            except OSError as error:
                raise ExpertError("读不到身份文件 %s: %s" % (rel_from_root, error), "没有重新编译", "恢复 %s 后下一次运行自动重试" % rel_from_root)
            hasher.update(b"id\0" + rel_from_root.encode() + b"\0" + body + b"\0")
    skills_dir = os.path.join(root, "skills")
    if os.path.isdir(skills_dir):
        for current, dirs, files in os.walk(skills_dir):
            dirs[:] = sorted(name for name in dirs if name != "__pycache__")
            for filename in sorted(files):
                if filename.endswith(".pyc") or filename == ".DS_Store":
                    continue
                full = os.path.join(current, filename)
                if os.path.islink(full) or not os.path.isfile(full):
                    continue
                rel_skill = os.path.relpath(full, root).replace(os.sep, "/")
                with open(full, "rb") as handle:
                    hasher.update(b"skill\0" + rel_skill.encode() + b"\0" + handle.read() + b"\0")
    label = ", ".join(declared) if isinstance(declared, list) else str(declared)
    return hasher.hexdigest(), label


def heal_identity_aliases(root):
    """A Space built from an older template may declare `style.md` while only `role.md` exists on disk (or the other
    way round). Copy whichever exists onto the missing name so a template upgrade cannot break `spacebuilder.py build`."""
    def spaces():
        yield os.path.join(root, "front")
        base = os.path.join(root, "spaces")
        if os.path.isdir(base):
            for entry in sorted(os.listdir(base)):
                if os.path.isdir(os.path.join(base, entry)):
                    yield os.path.join(base, entry)

    healed = []
    for role_dir in spaces():
        desc = read_json(os.path.join(role_dir, ROOT_DESCRIPTOR))
        if not desc:
            continue
        declared = {os.path.basename(str(item)) for item in (desc.get("identity") or [])}
        style = os.path.join(role_dir, "style.md")
        role = os.path.join(role_dir, "role.md")
        if "style.md" in declared and not os.path.isfile(style) and os.path.isfile(role):
            shutil.copyfile(role, style)
            healed.append(style)
        elif "role.md" in declared and not os.path.isfile(role) and os.path.isfile(style):
            shutil.copyfile(style, role)
            healed.append(role)
    return healed


def sync_identity(root):
    """Identity files and Skills are compiled into the instruction files Agents read natively; when any of them changes, compile again.

    Returns "none" (the expert declares no identity), "unchanged", or "rebuilt". A failed build is remembered by the
    digest it failed on so the five-second tick does not rerun it more than once a minute.
    """
    heal_identity_aliases(root)
    digest, label = identity_inputs_digest(root)
    if not digest:
        return "none"
    marker = state_dir(root, "identity.json")
    record = read_json(marker, {}) or {}
    if record.get("digest") == digest:
        return "unchanged"
    if record.get("failedDigest") == digest and now_ms() - record.get("failedAtMs", 0) < IDENTITY_RETRY_S * 1000:
        return "unchanged"
    done = subprocess.run([sys.executable, builder_script(root), "build", root], capture_output=True, text=True, timeout=20)
    if done.returncode != 0:
        if "SB013" in (done.stdout + done.stderr):
            return "unchanged"
        write_json(marker, {"digest": record.get("digest"), "failedDigest": digest, "failedAtMs": now_ms()})
        tail = "\n".join(line for line in (done.stdout + done.stderr).splitlines() if line.strip())[-400:]
        raise ExpertError("soul.md 编译进 AGENTS.md/CLAUDE.md 失败: %s" % tail, "前台仍是上一次编译的身份；soul.md 本身已保存", "按上面的错误修改 %s（超过 32 KiB 要精简），60 秒后自动重试" % label)
    write_json(marker, {"digest": digest})
    return "rebuilt"


def cmd_sync_identity(_args):
    print(sync_identity(find_root()))


def is_builtin_admin(root):
    info = descriptor(root) or {}
    return os.path.basename(root) == "admin" and "expert-admin" in (info.get("skills") or [])


def cmd_hook(_args):
    global SESSIONS_TTL
    SESSIONS_TTL = HOOK_SESSIONS_TTL  # 一轮钩子共用一份 session 快照；非钩子命令仍用 2s
    root = find_root()
    name, mine = me(root)
    builtin_admin = is_builtin_admin(root)
    write_json(state_dir(root, "alive"), {"atMs": now_ms()})
    routines = (sync_identity, clean_temp_hourly) if builtin_admin else (sync_identity, clean_temp_hourly, platform_watch)
    for routine in routines:
        try:
            routine(root)
        except ExpertError as error:
            report(root, name, mine, error.text())
    try:
        reconcile(root, name, mine)
        health(root, name, mine)
        if not builtin_admin:
            wake(root, name, mine)
    except ExpertError as error:
        report(root, name, mine, error.text())
        raise
    except Exception as error:  # noqa: BLE001 - turned into a system message below, never swallowed
        report(root, name, mine, "出了什么: 未处理的异常 %r\n现在状态: 待办记录都还在 .genethub/expert/pending/\n下一步: 检查 tools/team.py；修好后下一次运行自动恢复" % error)
        raise


def report(root, name, mine, text):
    try:
        front = front_session(root, mine["spaces"])
        if front:
            notice(front, "report", "%s:hook" % name, text, hashlib.sha1(text.encode()).hexdigest(), str(now_ms() // (REPORT_AGAIN_S * 1000)))
    except Exception:  # noqa: BLE001 - the original failure is re-raised by the caller
        pass


def main(argv):
    parser = argparse.ArgumentParser(prog="team.py")
    sub = parser.add_subparsers(dest="command", required=True)
    send = sub.add_parser("send")
    send.add_argument("--to", required=True)
    send.add_argument("--kind", default="note")
    send.add_argument("--inbox", action="store_true", help="write to file inbox when target is busy without interrupting")
    send.add_argument("text", nargs="+")
    spawn = sub.add_parser("spawn")
    spawn.add_argument("--expert", help="spawn inside another expert's research/work space")
    spawn.add_argument("--space", help="spawn inside a specific child space of the current team/expert (e.g. leader, skill-lead, qa)")
    spawn.add_argument("--kind", choices=["research", "work"], required=True)
    spawn.add_argument("--desc", required=True)
    spawn.add_argument("--dir")
    spawn.add_argument("--worktree", help="auto or slot name: cut an isolated git worktree under worktrees/ for parallel workers")
    spawn.add_argument("--tier", help="Ultra, Max, Pro, Flash or Mini; the platform picks the cheapest live model with it")
    spawn.add_argument("--model", help="an exact model id on the expert's Agent")
    spawn.add_argument("--media", choices=sorted(MEDIA_TAGS), help="the task has images or video: the model must understand them")
    spawn.add_argument("task", nargs="+")
    init_p = sub.add_parser("init")
    init_p.add_argument("name", help="new expert directory and display name")
    init_p.add_argument("--desc", required=True, help="one-line description of the expert")
    init_p.add_argument("--soul", help="detailed role & boundaries written into soul.md")
    init_p.add_argument("--spaces-dir", help="parent spaces directory (default: sibling of current expert)")
    init_p.add_argument("--team", action="store_true", help="initialize as a 1+N project team with leader/qa/research/team-reflect")
    init_p.add_argument("--member", dest="members", action="append", help="add team member space NAME:DESC (repeatable)")
    init_p.add_argument("--force", action="store_true", help="allow creating another expert/team even if a matching project already exists")
    for emp_cmd in ("employee", "member"):
        emp_p = sub.add_parser(emp_cmd)
        emp_sub = emp_p.add_subparsers(dest="employee_command", required=True)
        emp_add = emp_sub.add_parser("add")
        emp_add.add_argument("name")
        emp_add.add_argument("--desc", required=True)
        emp_add.add_argument("--role", help="role/style markdown content")
        emp_add.add_argument("--worktree", help="optional worktree directory to bind immediately")
        emp_add.add_argument("--repo", help="optional git repository path to cut a dedicated worktree slot from")
        emp_add.add_argument("--branch", help="optional branch name when cutting worktree from --repo")
        emp_add.add_argument("--no-worktree", action="store_true", help="do not auto-cut a worktree slot")
        emp_sub.add_parser("ls")
        for ret_name in ("retire", "standby"):
            emp_ret = emp_sub.add_parser(ret_name)
            emp_ret.add_argument("name")
    wt_p = sub.add_parser("worktree")
    wt_sub = wt_p.add_subparsers(dest="worktree_command", required=True)
    wt_create = wt_sub.add_parser("create")
    wt_create.add_argument("slot")
    wt_create.add_argument("--repo", required=True)
    wt_create.add_argument("--branch")
    wt_create.add_argument("--base")
    wt_create.add_argument("--space", help="bind this worktree to a child space (e.g. leader, skill-lead) or root")
    wt_bind = wt_sub.add_parser("bind")
    wt_bind.add_argument("space")
    wt_bind.add_argument("path", nargs="?")
    wt_bind.add_argument("--space", dest="space_opt", help="optional target child space")
    wt_sub.add_parser("ls")
    pub_p = sub.add_parser("publish")
    pub_sub = pub_p.add_subparsers(dest="publish_command", required=True)
    pub_rel = pub_sub.add_parser("release")
    pub_rel.add_argument("src", nargs="?")
    pub_rel.add_argument("--source", "--src", dest="source_opt", help="source build directory or html file")
    pub_rel.add_argument("--name", help="release version name (e.g. v1.1)")
    pub_rel.add_argument("--version", dest="version_opt", help="alias of --name")
    pub_rep = pub_sub.add_parser("report")
    pub_rep.add_argument("src", nargs="?")
    pub_rep.add_argument("--source", "--src", dest="source_opt", help="source report directory or html file")
    pub_rep.add_argument("--slug", help="report slug")
    pub_rep.add_argument("--name", dest="name_opt", help="alias of --slug")
    pub_rb = pub_sub.add_parser("rollback")
    pub_rb.add_argument("--to", help="target version to rollback latest to (default: previous valid version)")
    pub_rb.add_argument("--reason", help="reason recorded into .pm/incidents.md")
    board_p = sub.add_parser("board")
    board_p.add_argument("board_command", nargs="?", default="refresh")
    models_p = sub.add_parser("models")
    models_p.add_subparsers(dest="models_command", required=False).add_parser("check")
    directory = sub.add_parser("directory")
    directory.add_argument("--expert")
    for verb in ("mount", "unmount"):
        sub.add_parser(verb).add_argument("path")
    path = sub.add_parser("path")
    path.add_argument("area", choices=["datas", "temp", "root"])
    path.add_argument("spec", nargs="?", help="datas only: GROUP/NAME, e.g. aikenc/genethub")
    path.add_argument("--from", dest="source", help="datas only: a git URL; the path is GROUP/NAME taken from it")
    path.add_argument("--create", action="store_true")
    datas = sub.add_parser("datas")
    datas.add_subparsers(dest="datas_command", required=True).add_parser("ls")
    temp = sub.add_parser("temp")
    temp_sub = temp.add_subparsers(dest="temp_command", required=True)
    new = temp_sub.add_parser("new")
    new.add_argument("slug")
    new.add_argument("--purpose", required=True)
    listing = temp_sub.add_parser("ls")
    listing.add_argument("--date", help="YYMMDD")
    listing.add_argument("--slug", help="a fragment of the slug")
    listing.add_argument("--mine", action="store_true")
    temp_sub.add_parser("rm").add_argument("target")
    clean = temp_sub.add_parser("clean")
    clean.add_argument("--older-than", help="days, e.g. 3d (default EXPERT_TEMP_KEEP_DAYS, 7)")
    clean.add_argument("--dry-run", action="store_true")
    reset = sub.add_parser("reset")
    reset.add_argument("--expert", help="reset this expert instead of yourself")
    reset.add_argument("--with-memory", action="store_true", help="also reset memory.md (default: kept)")
    reset.add_argument("--apply", action="store_true", help="do it; without it only the plan is printed")
    note = sub.add_parser("note")
    note.add_argument("--kind", default="observation", help="unhappy | preference | external | observation (free text is accepted)")
    note.add_argument("--quote", help="what the person said, in their words")
    note.add_argument("--context", help="what was going on, what you did, where it may have gone wrong")
    note.add_argument("--session", help="default: the session you are in")
    note.add_argument("--expert", help="leave the note for another expert's reflect session")
    note.add_argument("words", nargs="*")
    notes = sub.add_parser("notes")
    notes.add_argument("--all", action="store_true", help="with ls: handled notes too")
    notes.add_argument("--result", help="with done: what was done about it")
    notes.add_argument("words", nargs="*", help="ls | done ID...")
    tell = sub.add_parser("tell-user")
    tell.add_argument("text", nargs="+")
    reflect = sub.add_parser("reflect")
    reflect_sub = reflect.add_subparsers(dest="reflect_command", required=True)
    now = reflect_sub.add_parser("now")
    now.add_argument("--tier", help="Ultra, Max, Pro, Flash or Mini")
    now.add_argument("--model", help="an exact model id")
    now.add_argument("text", nargs="+")
    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("-m", "--message")
    snapshot.add_argument("--refresh-platform", action="store_true", help="also update the platform branch from the current template")
    sub.add_parser("drift")
    sub.add_parser("sync-identity")
    sub.add_parser("hook")
    args = parser.parse_args(argv)
    handlers = {"send": cmd_send, "spawn": cmd_spawn, "init": cmd_init,
                "employee": cmd_employee, "member": cmd_employee, "worktree": cmd_worktree, "publish": cmd_publish, "board": cmd_board, "models": cmd_models,
                "directory": cmd_directory, "mount": cmd_mount, "unmount": cmd_unmount, "path": cmd_path, "datas": cmd_datas, "temp": cmd_temp, "reset": cmd_reset, "sync-identity": cmd_sync_identity, "hook": cmd_hook,
                "note": cmd_note, "notes": cmd_notes, "tell-user": cmd_tell_user, "reflect": cmd_reflect, "snapshot": cmd_snapshot, "drift": cmd_drift}
    try:
        try:
            check_and_flush_self_inbox_inline(find_root(), args.command)
        except ExpertError:
            raise
        except Exception:
            pass
        handlers[args.command](args)
    except ExpertError as error:
        print(error.text(), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
