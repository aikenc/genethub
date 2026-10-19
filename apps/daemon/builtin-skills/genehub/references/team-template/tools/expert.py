#!/usr/bin/env python3
"""旧名兼容壳：单人专家形态已经废弃，这个工具现在只服务团队，正本改名 team.py。

新写的脚本、文档和钩子请用 team.py。已经建好的团队目录里可能还有指向 tools/expert.py 的钩子
与 SKILL，升级后靠这层壳继续工作，不必逐个改写。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# A shim only imports, and importing would drop a new `tools/__pycache__` into the
# Space: that shows up as drift next to the team's own files.
sys.dont_write_bytecode = True

# Re-export everything: old scripts `import expert` and call into it directly,
# not just through `main`.
from team import *  # noqa: F401,F403
from team import main  # noqa: F401

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
