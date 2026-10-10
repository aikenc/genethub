"""Installing and updating a CLI on the user's machine, without administrator
rights and with the steps visible in the job log.

Each helper confirms with a person first (an Agent-level request; only a
person can answer it), then streams the installer's output into the job.
"""

from __future__ import annotations

import glob
import os
from typing import Dict, List, Optional

from . import process
from .process import child_environment, find_executable, stream_lines
from .serve import AgentContext, Job, option

# An installer still running after this long is stuck; its tree is ended.
INSTALL_TIMEOUT = 15 * 60.0


async def confirm(ctx: AgentContext, job: Job, title: str, command: List[str], source: str, note: Optional[str] = None) -> bool:
    detail = f"将执行：\n\n    {' '.join(command)}\n\n来源：{source}"
    if note:
        detail += f"\n\n{note}"
    outcome = await ctx.ask(job, "install.confirm", title, detail=detail, options=[option("run", "开始"), option("cancel", "取消")])
    return not outcome.canceled and outcome.option_id == "run"


def npm_prefix(ctx: AgentContext) -> str:
    """Where GeneHub installs npm packages: a prefix of its own under the
    Agent's state directory, so no global npm directory needs to be writable
    and nothing has to be on the daemon's PATH."""
    return os.path.join(ctx.state_dir, "npm")


def npm_bin(ctx: AgentContext, name: str) -> Optional[str]:
    prefix = npm_prefix(ctx)
    directory = prefix if os.name == "nt" else os.path.join(prefix, "bin")
    return find_executable(name, [directory]) if os.path.isdir(directory) else None


NO_NODE = (
    "需要 Node.js 和 npm。可以让任意一个能用的 Agent（比如内置的 Genet）帮你装好 Node.js，"
    "装完回来点「安装」即可，不用重启 GeneHub。"
)


def _node_dirs() -> List[str]:
    """Where Node.js usually lands when it is not on the daemon's PATH: the
    daemon may have started before Node was installed, or from a desktop
    launcher that never read the shell profile."""
    home = os.path.expanduser("~")
    if os.name == "nt":
        dirs = [os.environ.get("NVM_SYMLINK", "")]
        for var, sub in (("ProgramFiles", "nodejs"), ("LOCALAPPDATA", os.path.join("Volta", "bin")),
                         ("LOCALAPPDATA", os.path.join("Programs", "nodejs"))):
            base = os.environ.get(var)
            if base:
                dirs.append(os.path.join(base, sub))
        return [directory for directory in dirs if directory]
    newest = sorted(glob.glob(os.path.join(home, ".nvm", "versions", "node", "*", "bin")),
                    key=lambda path: [int(part) for part in os.path.basename(os.path.dirname(path)).lstrip("v").split(".") if part.isdigit()])
    return newest[::-1] + [
        os.path.join(home, ".volta", "bin"),
        os.path.join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
        os.path.join(home, ".fnm", "aliases", "default", "bin"),
        os.path.join(home, ".asdf", "shims"),
        os.path.join(home, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]


async def _login_shell_npm() -> Optional[str]:
    """Asks the user's login shell, which reads the profile an installer
    (nvm, fnm, Homebrew, ...) edited. Bounded, and only an absolute path to
    an existing file is accepted from its output."""
    shell = os.environ.get("SHELL")
    if os.name == "nt" or not shell or not os.path.isfile(shell):
        return None
    try:
        result = await process.run([shell, "-ilc", "command -v npm"], env=child_environment(), timeout=5)
    except (OSError, TimeoutError):
        return None
    for line in reversed((result.stdout or "").splitlines()):
        line = line.strip()
        if os.path.isabs(line) and os.path.isfile(line):
            return line
    return None


async def find_npm() -> Optional[str]:
    """``npm`` on PATH, else in a usual Node.js location, else where the
    login shell would find it. Looked up afresh each time, so Node installed
    while GeneHub runs is picked up."""
    return find_executable("npm") or find_executable("npm", _node_dirs()) or await _login_shell_npm()


def node_env(npm: str, env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """``env`` with npm's directory first on PATH: npm and npm-installed
    launchers start with ``#!/usr/bin/env node``, and ``node`` sits beside npm."""
    env = dict(env if env is not None else child_environment())
    env["PATH"] = os.path.dirname(npm) + os.pathsep + env.get("PATH", "")
    return env


async def npm_install(ctx: AgentContext, job: Job, package: str, timeout: float = INSTALL_TIMEOUT) -> None:
    npm = await find_npm()
    if npm is None:
        raise RuntimeError(NO_NODE)
    command = [npm, "install", "-g", "--prefix", npm_prefix(ctx), package]
    job.progress(phase="install", message=f"npm install {package}")
    code = await _stream(command, job, timeout, env=node_env(npm))
    if code != 0:
        raise RuntimeError(f"npm 安装失败（退出码 {code}），详情见日志")


async def run_logged(job: Job, command: List[str], phase: str, timeout: float = INSTALL_TIMEOUT) -> None:
    job.progress(phase=phase, message=" ".join(command))
    code = await _stream(command, job, timeout)
    if code != 0:
        raise RuntimeError(f"{os.path.basename(command[0])} 退出码 {code}，详情见日志")


async def _stream(command: List[str], job: Job, timeout: float, env: Optional[Dict[str, str]] = None) -> int:
    try:
        return await stream_lines(command, job.log, env=env, timeout=timeout)
    except TimeoutError:
        raise RuntimeError(f"{os.path.basename(command[0])} 在 {int(timeout // 60)} 分钟内没有完成，已停止")
