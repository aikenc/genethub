"""A stand-in for a Claude-protocol CLI, driven by a JSON script. Test fixture
for ``replay`` (run it as ``python fakecli.py <args the CLI would get>``).

Environment:
  FAKE_CLI_SCRIPT  path of the script
  FAKE_CLI_LOG     file every received frame (and the argv) is appended to

Script keys:
  hello         body answered to an ``initialize`` control request
  control       {subtype: "success" | "silent" | "error:<message>"}
  turns         one entry per user frame, counted across processes (the last repeats):
                {"emit": [frames], "await": "<request id>",
                 "thenAllow"/"thenDeny"/"then": [frames], "hang": true,
                 "exit": {"code": n, "stderr": "..."}}
  onInterrupt   frames emitted when an interrupt arrives while hanging
  exitOnStart   {"code": n, "stderr": "..."} to refuse to run

Account side (for flows that install, log in and log out):
  version       printed by ``--version`` (overridden by what the fake ``npm``
                last installed, kept in ``$FAKE_CLI_LOG.version``)
  brokenVersions  versions whose ``--version`` crashes
  latest        what the fake ``npm view`` reports
  help          printed by ``--help``
  loggedIn      initial state; kept in ``$FAKE_CLI_LOG.state`` afterwards
  account       extra fields on the account initialize reports (a bearer token,
                to prove it is never kept)
  authLogin     ``auth login``: {"print": [lines], "code": "<expected pasted
                code>", "hold": seconds, "exit": n}; ends logged in on success
  acp           ``--acp``: {"hold": seconds, "verdict": "ok" | "error:<message>",
                "url": "<link>"}; ends logged in on ok
"""

from __future__ import annotations

import json
import os
import sys
import time


def main() -> None:
    with open(os.environ["FAKE_CLI_SCRIPT"], "r", encoding="utf-8") as handle:
        script = json.load(handle)
    state_path = os.environ["FAKE_CLI_LOG"] + ".state"

    def logged_in() -> bool:
        try:
            with open(state_path, "r", encoding="utf-8") as handle:
                return bool(json.load(handle)["loggedIn"])
        except (OSError, ValueError, KeyError):
            return bool(script.get("loggedIn", False))

    def set_logged_in(value: bool) -> None:
        with open(state_path, "w", encoding="utf-8") as handle:
            json.dump({"loggedIn": value}, handle)

    def account() -> dict:
        if not logged_in():
            return {}
        return {"account": {"tokenSource": "oauth", **script.get("account", {})}}

    # `turns` is indexed across processes: a process started again after a
    # crash picks up with the next entry, not the first.
    users = 0
    with open(os.environ["FAKE_CLI_LOG"], "r", encoding="utf-8") as earlier:
        for raw in earlier:
            if raw.strip() and json.loads(raw).get("in", {}).get("type") == "user":
                users += 1
    log = open(os.environ["FAKE_CLI_LOG"], "a", encoding="utf-8")

    def record(entry: dict) -> None:
        log.write(json.dumps(entry) + "\n")
        log.flush()

    record({"argv": sys.argv[1:], "env": {name: os.environ.get(name) for name in script.get("logEnv", [])}})
    args = sys.argv[1:]
    if args[:1] == ["--version"] or (args[-1:] == ["--version"] and "--print" not in args):
        version = script.get("version", "9.9.9")
        try:
            with open(os.environ["FAKE_CLI_LOG"] + ".version", "r", encoding="utf-8") as handle:
                version = handle.read().strip() or version
        except OSError:
            pass
        if version in script.get("brokenVersions", []):
            sys.stderr.write("illegal instruction\n")
            sys.exit(132)
        print(f"{version} (Fake)")
        return
    if args[:1] == ["--help"]:
        print(script.get("help", ""))
        return
    if args[:1] == ["auth"]:
        auth(args[1:], script, logged_in, set_logged_in, record)
        return
    if args[:1] == ["--acp"]:
        acp(script, logged_in, set_logged_in, record, account)
        return
    refuse = script.get("exitOnStart")
    if refuse:
        sys.stderr.write(refuse.get("stderr", "") + "\n")
        sys.stderr.flush()
        sys.exit(refuse.get("code", 1))

    def out(frame: dict) -> None:
        sys.stdout.write(json.dumps(frame) + "\n")
        sys.stdout.flush()

    def frames_in():
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            frame = json.loads(raw)
            record({"in": frame})
            yield frame

    incoming = frames_in()

    def answer_control(frame: dict) -> None:
        subtype = frame["request"]["subtype"]
        rule = script.get("control", {}).get(subtype, "success")
        if rule == "silent":
            return
        if rule.startswith("error:"):
            body = {"subtype": "error", "request_id": frame["request_id"], "error": rule[len("error:") :]}
        else:
            body = {"subtype": "success", "request_id": frame["request_id"]}
            if subtype == "initialize":
                body["response"] = {**script.get("hello", {}), **account()}
            if subtype == "logout":
                set_logged_in(False)
        out({"type": "control_response", "response": body})

    def run_turn(turn: dict) -> None:
        for frame in turn.get("emit", []):
            out(frame)
        if "exit" in turn:
            sys.stderr.write(turn["exit"].get("stderr", "") + "\n")
            sys.stderr.flush()
            sys.exit(turn["exit"].get("code", 1))
        if "await" in turn:
            for frame in incoming:
                response = frame.get("response") if frame.get("type") == "control_response" else None
                if isinstance(response, dict) and response.get("request_id") == turn["await"]:
                    body = response.get("response") or {}
                    allowed = body.get("behavior") == "allow" or body.get("allowed") is True
                    key = "thenAllow" if allowed else "thenDeny"
                    for later in turn.get(key, turn.get("then", [])):
                        out(later)
                    return
                if frame.get("type") == "control_request":
                    answer_control(frame)
            return
        if turn.get("hang"):
            for frame in incoming:
                if frame.get("type") == "control_request":
                    if frame["request"]["subtype"] == "interrupt":
                        for later in script.get("onInterrupt", []):
                            out(later)
                        return
                    answer_control(frame)
            return
        for later in turn.get("then", []):
            out(later)

    turns = script.get("turns") or [{}]
    for frame in incoming:
        kind = frame.get("type")
        if kind == "user":
            run_turn(turns[min(users, len(turns) - 1)])
            users += 1
        elif kind == "control_request":
            answer_control(frame)


def auth(args: list, script: dict, logged_in, set_logged_in, record) -> None:
    command = args[:1]
    if command == ["status"]:
        print(json.dumps({"loggedIn": logged_in()}))
    elif command == ["logout"]:
        set_logged_in(False)
    elif command == ["login"]:
        plan = script.get("authLogin", {})
        for line in plan.get("print", []):
            print(line, flush=True)
        if "code" in plan:
            pasted = sys.stdin.readline().strip()
            record({"stdin": pasted})
            if pasted != plan["code"]:
                print("Invalid code", flush=True)
                sys.exit(1)
        time.sleep(plan.get("hold", 0))
        if plan.get("exit", 0) == 0:
            set_logged_in(True)
        sys.exit(plan.get("exit", 0))
    else:
        sys.exit(2)


def acp(script: dict, logged_in, set_logged_in, record, account) -> None:
    plan = script.get("acp", {})

    def out(frame: dict) -> None:
        sys.stdout.write(json.dumps(frame) + "\n")
        sys.stdout.flush()

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        frame = json.loads(raw)
        record({"in": frame})
        if frame.get("method") == "initialize":
            out({"jsonrpc": "2.0", "id": frame["id"], "result": {"protocolVersion": 1, **account()}})
        elif frame.get("method") == "authenticate":
            if plan.get("url"):
                out({"jsonrpc": "2.0", "method": "_codebuddy.ai/authUrl", "params": {"authUrl": plan["url"]}})
            time.sleep(plan.get("hold", 0))
            verdict = plan.get("verdict", "ok")
            if verdict == "ok":
                set_logged_in(True)
                out({"jsonrpc": "2.0", "id": frame["id"], "result": {"token": "secret-token-value"}})
            else:
                out({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": -32000, "message": verdict[len("error:") :]}})
            return


if __name__ == "__main__":
    main()
