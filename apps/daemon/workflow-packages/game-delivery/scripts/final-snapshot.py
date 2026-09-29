#!/usr/bin/env python3
"""Freeze the actual clean mainline after all asynchronous integrations settle."""
import json
import subprocess
import sys

json.load(sys.stdin)
if subprocess.check_output(["git", "status", "--porcelain"], text=True).strip():
    raise ValueError("final mainline has uncommitted changes; no delivery snapshot")
commit = subprocess.check_output(["git", "rev-parse", "--verify", "HEAD^{commit}"], text=True).strip()
print(json.dumps({"ok": True, "evidence": {"commit": commit},
                  "revision": commit, "message": "Final immutable delivery snapshot"}))
