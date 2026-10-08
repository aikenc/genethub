"""Starting and ending the CLI processes an Agent drives.

Every child gets its own process group (a new session on POSIX, a new
process group without a console window on Windows), so ending an Agent ends
what it started instead of orphaning a language server. Children never
inherit the protocol pipes: ``boot.py`` moved those off fds 0 and 1, and the
helpers here default stdin to ``/dev/null``.
"""

from __future__ import annotations

import asyncio
import contextvars
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from typing import Dict, Iterable, List, Optional, Set

WINDOWS = sys.platform.startswith("win")

# Variables GeneHub sets for its own processes. A CLI the Agent starts must
# not inherit them unless the Agent passes them on deliberately (see
# ``SessionConfig.session_environment``).
GENEHUB_PRIVATE = (
    "GENEHUB_AGENT_ID",
    "GENEHUB_AGENT_STATE",
    "GENEHUB_SESSION_ID",
    "GENEHUB_CONTROLLER_TOKEN",
)


# Which session a process belongs to, so closing the session (or this process
# going away) ends what was started for it. Set by the serve loop around every
# session request; inherited by tasks those requests create.
OWNER: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar("genehub_owner", default=None)
_LIVE: Dict[Optional[str], Set[asyncio.subprocess.Process]] = {}


def _track(process: asyncio.subprocess.Process) -> None:
    process._genehub_birth = _birth(process.pid)
    _LIVE.setdefault(OWNER.get(), set()).add(process)


def _alive(owner: Optional[str]) -> List[asyncio.subprocess.Process]:
    live = [process for process in _LIVE.get(owner, set()) if process.returncode is None]
    _LIVE[owner] = set(live)
    return live


async def end_owned(owner: Optional[str], verify: bool = False) -> None:
    """Ends every process started on behalf of ``owner`` that is still running."""
    targets = list(_LIVE.get(owner, set())) if verify else _alive(owner)
    for process in targets:
        await kill_tree(process, grace=1.0, verify=verify)
    _LIVE.pop(owner, None)


def end_all_now() -> None:
    """Last resort when this process is about to exit: no event loop, no grace."""
    targets = [proc for children in _LIVE.values() for proc in children]
    groups = None
    if sys.platform == "linux":
        try:
            groups = set()
            for entry in Path("/proc").iterdir():
                if entry.name.isdigit():
                    try:
                        raw = (entry / "stat").read_text()
                        fields = raw[raw.rfind(")") + 2:].split()
                        if fields[0] != "Z":
                            groups.add(int(fields[2]))
                    except FileNotFoundError:
                        continue
        except OSError:
            groups = None
    # Active leaders first. Completed leaders can still have living group
    # members; do not prune their ownership before the shutdown signal.
    for proc in sorted(targets, key=lambda p: p.returncode is not None):
        try:
            if WINDOWS:
                if proc.returncode is None:
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                current, original = _birth(proc.pid), getattr(proc, "_genehub_birth", None)
                if current is not None and original is not None and current != original:
                    continue
                if proc.returncode is None or (groups is not None and proc.pid in groups) or (groups is None and _group_running(proc)):
                    os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    _LIVE.clear()


def child_environment(extra: Optional[Dict[str, str]] = None, remove: Iterable[str] = ()) -> Dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key not in GENEHUB_PRIVATE}
    for key in remove:
        env.pop(key, None)
    if extra:
        env.update({key: value for key, value in extra.items() if value is not None})
    return env


def find_executable(name: str, extra_dirs: Iterable[str] = ()) -> Optional[str]:
    """``PATH`` first, then ``extra_dirs``; honours ``PATHEXT`` on Windows."""
    if os.path.isabs(name):
        return name if os.path.isfile(name) else None
    found = shutil.which(name)
    if found:
        return found
    extra = os.pathsep.join(os.path.expanduser(directory) for directory in extra_dirs)
    return shutil.which(name, path=extra) if extra else None


def _group_kwargs() -> dict:
    if WINDOWS:
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        return {"creationflags": flags}
    return {"start_new_session": True}


def _is_batch(argv: List[str]) -> bool:
    # npm installs `.cmd` shims; CreateProcess cannot start those directly.
    return WINDOWS and bool(argv) and argv[0].lower().endswith((".cmd", ".bat"))


async def spawn(
    argv: List[str],
    cwd: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    stdin: int = subprocess.DEVNULL,
    stdout: int = subprocess.PIPE,
    stderr: int = subprocess.PIPE,
    limit: int = 64 * 1024 * 1024,
) -> asyncio.subprocess.Process:
    """Starts ``argv`` in a process group of its own. It is ended with the
    session it was started for, and with this process."""
    options = dict(
        cwd=cwd,
        env=env if env is not None else child_environment(),
        stdin=stdin,
        stdout=stdout,
        stderr=stderr,
        limit=limit,
        **_group_kwargs(),
    )
    if _is_batch(argv):
        # `cmd /c "<line>"`, exactly as `subprocess` builds it for
        # `shell=True`: cmd drops the outer pair of quotes and runs the line
        # as written, so a shim path with spaces and arguments that carry
        # quotes both survive. (`cmd /s /c <line>` strips the first and the
        # last quote of the line instead, which breaks either.)
        process = await asyncio.create_subprocess_shell(subprocess.list2cmdline(argv), **options)
    else:
        process = await asyncio.create_subprocess_exec(*argv, **options)
    _track(process)
    return process


async def _taskkill(pid: int) -> None:
    killer = await asyncio.create_subprocess_exec(
        "taskkill",
        "/T",
        "/F",
        "/PID",
        str(pid),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        await asyncio.wait_for(killer.wait(), timeout=10.0)
    except asyncio.TimeoutError:
        killer.kill()


def _birth(pid: int) -> Optional[str]:
    if sys.platform != "linux":
        return None
    try:
        raw = Path("/proc/%d/stat" % pid).read_text()
        return raw[raw.rfind(")") + 2:].split()[19]
    except OSError:
        return None


def _group_running(proc: asyncio.subprocess.Process) -> bool:
    if WINDOWS:
        return proc.returncode is None
    if sys.platform == "linux":
        current = _birth(proc.pid)
        original = getattr(proc, "_genehub_birth", None)
        if current is not None and original is not None and current != original:
            return False  # The original group has gone; PID was reused.
        try:
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    raw = (entry / "stat").read_text()
                    fields = raw[raw.rfind(")") + 2:].split()
                    if fields[0] != "Z" and int(fields[2]) == proc.pid:
                        return True
                except FileNotFoundError:
                    continue
            return False
        except OSError:
            pass  # Without a complete census, require the kernel group to vanish.
    try:
        os.killpg(proc.pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


async def kill_tree(process: asyncio.subprocess.Process, grace: float = 2.0, verify: bool = False) -> None:
    """Ends the owned group; a durable pause also confirms descendants exited."""
    if process.returncode is not None and (not verify or not _group_running(process)):
        return
    try:
        if WINDOWS:
            await _taskkill(process.pid)
        else:
            os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        await asyncio.wait_for(process.wait(), timeout=grace)
        if not verify or not _group_running(process):
            return
    except asyncio.TimeoutError:
        pass
    try:
        if WINDOWS:
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        await asyncio.wait_for(process.wait(), timeout=grace)
    except asyncio.TimeoutError:
        pass
    if verify:
        deadline = asyncio.get_event_loop().time() + grace
        while _group_running(process) and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.05)
        if _group_running(process):
            raise RuntimeError("owned process group did not stop")


async def run(
    argv: List[str],
    cwd: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    timeout: float = 30.0,
    input_text: Optional[str] = None,
) -> "Completed":
    """Runs a short command to completion, bounded by ``timeout``."""
    process = await spawn(
        argv,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
    )
    try:
        out, err = await asyncio.wait_for(
            process.communicate(input_text.encode("utf-8") if input_text is not None else None),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        await kill_tree(process)
        raise TimeoutError(f"{os.path.basename(argv[0])} did not finish within {timeout:.0f}s")
    return Completed(process.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace"))


class Completed:
    def __init__(self, code: int, stdout: str, stderr: str) -> None:
        self.code = code
        self.stdout = stdout
        self.stderr = stderr

    @property
    def ok(self) -> bool:
        return self.code == 0


async def stream_lines(
    argv: List[str],
    on_line,
    cwd: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    timeout: Optional[float] = None,
) -> int:
    """Runs a long command (an installer) and hands each output line to
    ``on_line`` as it appears. Returns the exit code. Past ``timeout`` (or
    when cancelled) the whole process tree is ended."""
    process = await spawn(argv, cwd=cwd, env=env, stderr=subprocess.STDOUT)

    async def pump() -> int:
        assert process.stdout is not None
        while True:
            raw = await process.stdout.readline()
            if not raw:
                break
            on_line(raw.decode("utf-8", "replace").rstrip("\r\n"))
        return await process.wait()

    try:
        return await asyncio.wait_for(pump(), timeout)
    except asyncio.TimeoutError:
        await kill_tree(process)
        raise TimeoutError(f"{os.path.basename(argv[0])} did not finish within {timeout:.0f}s")
    except asyncio.CancelledError:
        await kill_tree(process)
        raise


# The Job Object every child of this process lands in; kept open for the
# life of the process, and its last handle closing ends them all.
_JOB = None


def end_children_with_this_process() -> None:
    """Windows has no SIGTERM to catch, and the daemon ends this process with
    TerminateProcess, which would orphan every CLI it started (they live in
    process groups of their own). Putting this process in a Job Object with
    KILL_ON_JOB_CLOSE makes Windows end them when it goes. Best effort: on
    failure the explicit ``kill_tree`` paths are all there is."""
    global _JOB
    if not WINDOWS or _JOB is not None:
        return
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

        class _Basic(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _Io(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_uint64)
                for name in ("Read", "Write", "Other", "ReadBytes", "WriteBytes", "OtherBytes")
            ]

        class _Extended(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _Basic),
                ("IoInfo", _Io),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return
        info = _Extended()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        extended_limit_information = 9
        limited = kernel32.SetInformationJobObject(job, extended_limit_information, ctypes.byref(info), ctypes.sizeof(info))
        if not limited or not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
            kernel32.CloseHandle(job)
            return
        _JOB = job
    except (AttributeError, OSError, ValueError):
        return
