#!/usr/bin/env python3
"""Write one immutable package-owned dependency/wait event from JSON stdin.
WM can extend this schema for scripts/queues/substeps without kernel changes.
"""
import json
import pathlib
import sys
sys.dont_write_bytecode = True
from records import write_record

data = json.load(sys.stdin)
if not data.get("id") or not isinstance(data.get("dependsOn", []), list):
    raise ValueError("observation needs id and dependsOn[]")
if data.get("endMs", data.get("startMs", 0)) < data.get("startMs", 0):
    raise ValueError("endMs precedes startMs")
content = json.dumps(data, ensure_ascii=False, sort_keys=True) + "\n"
target, digest = write_record(".genethub/temp/observations", content, 16)
print(json.dumps({"ok": True, "evidence": {"observation": str(target)}, "revision": digest}))
