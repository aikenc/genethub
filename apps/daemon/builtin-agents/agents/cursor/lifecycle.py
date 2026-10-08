"""Finding, probing, installing, logging in and updating `cursor-agent`.

Everything here runs a subprocess with a deadline; none of it blocks the
event loop.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from typing import Callable, Dict, List, Optional

from genehub_agent.process import WINDOWS, child_environment, find_executable, kill_tree, run, spawn

PROGRAM = "cursor-agent"
STATUS_TIMEOUT = 5.0
VERSION_TIMEOUT = 10.0
HELP_TIMEOUT = 10.0
LIST_MODELS_TIMEOUT = 15.0
LOGOUT_TIMEOUT = 30.0
INSTALL_TIMEOUT = 15 * 60.0
UPDATE_TIMEOUT = 10 * 60.0
LOGIN_URL_TIMEOUT = 60.0
LOGIN_TIMEOUT = 10 * 60.0

if WINDOWS:
    INSTALL_SOURCE = "https://cursor.com/install?win32=true"
    INSTALL_LINE = "irm 'https://cursor.com/install?win32=true' | iex"
    INSTALL_ARGV = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", INSTALL_LINE]
else:
    INSTALL_SOURCE = "https://cursor.com/install"
    INSTALL_LINE = "curl https://cursor.com/install -fsS | bash"
    INSTALL_ARGV = ["sh", "-c", INSTALL_LINE]

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
_URL = re.compile(r"https://[^\s\"'<>\x1b]+")


# -- discovery -----------------------------------------------------------------


def install_dirs() -> List[str]:
    """Official install locations. Desktop daemons on Windows often inherit
    Explorer's PATH, which lacks `%LOCALAPPDATA%\\cursor-agent` until the next
    login; guessing `.exe` vs `.cmd` would break when the installer changes
    suffix, so the PATHEXT walk is used here too."""
    dirs: List[str] = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        dirs.append(os.path.join(local, "cursor-agent"))
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    if home:
        dirs.append(os.path.join(home, ".local", "bin"))
    return dirs


def find_program(remembered: Optional[str] = None) -> Optional[str]:
    found = find_executable(PROGRAM, install_dirs())
    if found:
        return found
    if remembered and os.path.isfile(remembered):
        return remembered
    if WINDOWS:
        # After PATHEXT, a suffix-less file: what the Linux installer leaves in
        # ~/.local/bin when an Agent ran it under Git Bash.
        for directory in os.environ.get("PATH", "").split(os.pathsep) + install_dirs():
            candidate = os.path.join(directory, PROGRAM) if directory else ""
            if candidate and os.path.isfile(candidate):
                return candidate
    return None


# -- probes --------------------------------------------------------------------


def json_object_in(text: str) -> Optional[dict]:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def login_from_status_output(stdout: str, stderr: str) -> Optional[bool]:
    """Phrased as "is it logged in". Unknown wording means the CLI is usable;
    a check that guessed would hide working installs."""
    said = stdout + stderr
    value = json_object_in(said)
    if value is not None:
        for key in ("loggedIn", "logged_in", "authenticated", "isAuthenticated", "is_authenticated"):
            if isinstance(value.get(key), bool):
                return value[key]
    lower = said.lower()
    if "not authenticated" in lower or "not logged in" in lower:
        return False
    if "logged in" in lower:
        return True
    return None


async def logged_in(program: str) -> Optional[bool]:
    for args in (["status", "--format", "json"], ["status"]):
        try:
            done = await run([program] + args, env=child_environment(), timeout=STATUS_TIMEOUT)
        except (OSError, TimeoutError) as error:
            _log(f"cursor-agent {' '.join(args)}: {error}")
            continue
        answer = login_from_status_output(done.stdout, done.stderr)
        if answer is not None:
            return answer
    return None


async def version(program: str) -> Optional[str]:
    try:
        done = await run([program, "--version"], env=child_environment(), timeout=VERSION_TIMEOUT)
    except (OSError, TimeoutError):
        return None
    for line in (done.stdout + "\n" + done.stderr).splitlines():
        if line.strip():
            return line.strip()
    return None


async def help_text(program: str, args: List[str]) -> str:
    try:
        done = await run([program] + args + ["--help"], env=child_environment(), timeout=HELP_TIMEOUT)
    except (OSError, TimeoutError):
        return ""
    return done.stdout + "\n" + done.stderr


def help_lists_command(text: str, command: str) -> bool:
    pattern = re.compile(r"^\s+" + re.escape(command) + r"(\s|\||$)", re.MULTILINE)
    return bool(pattern.search(text))


def browser_variable(login_help: str) -> str:
    """The variable `cursor-agent login --help` names for not opening a
    browser ("Set NO_OPEN_BROWSER to disable browser opening")."""
    found = re.search(r"\bSet\s+([A-Z][A-Z0-9_]+)\s+to\s+disable\s+browser", login_help)
    return found.group(1) if found else "NO_OPEN_BROWSER"


async def list_raw_models(program: str):
    from models import models_from_cli_list

    for args in (["--list-models"], ["models"]):
        try:
            done = await run([program] + args, env=child_environment(), timeout=LIST_MODELS_TIMEOUT)
        except (OSError, TimeoutError):
            continue
        text = done.stdout if done.stdout.strip() else done.stderr
        listed = models_from_cli_list(text)
        if listed[0]:
            return listed
    return None


# -- long commands -------------------------------------------------------------


async def stream_logged(
    argv: List[str],
    on_line: Callable[[str], None],
    timeout: float,
    env: Optional[Dict[str, str]] = None,
) -> int:
    """Like `process.stream_lines`, but bounded: past `timeout` the whole
    process tree is ended."""
    process = await spawn(argv, env=env if env is not None else child_environment(), stderr=subprocess.STDOUT)

    async def pump() -> int:
        assert process.stdout is not None
        while True:
            raw = await process.stdout.readline()
            if not raw:
                break
            on_line(strip_ansi(raw.decode("utf-8", "replace")).rstrip("\r\n"))
        return await process.wait()

    try:
        return await asyncio.wait_for(pump(), timeout)
    except asyncio.TimeoutError:
        await kill_tree(process)
        raise RuntimeError(f"{os.path.basename(argv[0])} 在 {int(timeout // 60)} 分钟内没有完成，已停止")
    except asyncio.CancelledError:
        await kill_tree(process)
        raise


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


def find_login_url(line: str) -> Optional[str]:
    found = _URL.search(strip_ansi(line))
    return found.group(0).rstrip(".,);") if found else None


def hide_urls(line: str) -> str:
    """Login links belong in the request card only, never in a log."""
    return _URL.sub("<登录链接见请求卡片>", strip_ansi(line))


def _log(message: str) -> None:
    import sys

    sys.stderr.write(message.rstrip("\n") + "\n")
    sys.stderr.flush()
