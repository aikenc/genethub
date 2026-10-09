"""Starts one GeneHub script Agent.

The daemon runs exactly this, with its own interpreter and in isolated mode:

    <python> -I -X utf8 <sdk>/boot.py <agent-dir> serve

and an Agent author can run the same thing by hand:

    <python> -I <sdk>/boot.py <agent-dir> test [--live]

Before any Agent code is imported this file does three things:

1. Takes the protocol pipes away from file descriptors 0 and 1. Anything the
   Agent or a child it starts prints to stdout lands on stderr (the log),
   and no child can read the daemon's requests from stdin.
2. Builds ``sys.path`` from exactly: ``<agent>/lib``, ``<agent>``, the SDK,
   and the interpreter's own standard library. Nothing from the user's
   environment, site-packages or current directory.
3. Points the bytecode cache at the Agent's state directory, so neither the
   built-in tree nor a user's directory is written to.
"""

import os
import runpy
import sys


def _isolate_descriptors():
    if sys.argv[2:3] != ["serve"]:
        return None
    proto_in = os.dup(0)
    proto_out = os.dup(1)
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(2, 1)
    os.close(devnull)
    sys.stdin = open(os.devnull, "r")
    sys.stdout = sys.stderr
    return proto_in, proto_out


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: boot.py <agent-dir> [serve|test [--live]]\n")
        return 2
    fds = _isolate_descriptors()
    agent_dir = os.path.abspath(sys.argv[1])
    command = sys.argv[2:] or ["serve"]
    sdk_dir = os.path.dirname(os.path.abspath(__file__))

    # `-I` already drops the script directory, the user site and PYTHON*
    # variables. Global site-packages stays on a system interpreter, so it is
    # removed here: an Agent sees only what ships with it.
    stdlib = [
        entry
        for entry in sys.path
        if entry
        and os.path.basename(os.path.normpath(entry)) not in ("site-packages", "dist-packages")
    ]
    sys.path[:] = [os.path.join(agent_dir, "lib"), agent_dir, sdk_dir] + stdlib

    state_dir = os.environ.get("GENEHUB_AGENT_STATE")
    if state_dir:
        sys.pycache_prefix = os.path.join(state_dir, "pycache")
    else:
        sys.dont_write_bytecode = True

    from genehub_agent import _boot
    from genehub_agent.manifest import read_manifest

    manifest = read_manifest(agent_dir)
    _boot.PROTOCOL_FDS = fds
    _boot.COMMAND = command
    _boot.AGENT_DIR = agent_dir
    _boot.SDK_DIR = sdk_dir
    _boot.MANIFEST = manifest

    entry = os.path.join(agent_dir, manifest.entry)
    sys.argv = [entry] + command
    runpy.run_path(entry, run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main())
