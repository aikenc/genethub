#!/usr/bin/env python3
"""Package policy, not a platform quality primitive. Standard-library only.
Reject missing/duplicate coverage and stale baselines; keep disputes visible.
"""
import json
import pathlib
import re
import sys
sys.dont_write_bytecode = True
from records import write_record


def judge(data):
    errors, checks = [], []
    commit = data.get("commit", "")
    if not isinstance(commit, str) or not commit.strip():
        errors.append("missing immutable commit")
    for group in ("requirements", "product", "engineering"):
        expected = data.get(group, [])
        ids = [item["id"] for item in expected]
        if len(ids) != len(set(ids)):
            errors.append(f"{group}: duplicated contract ID")
        result = data.get("reviews", {}).get(group, {}).get("output", {})
        if result.get("commit") != commit:
            errors.append(f"{group}: reviewed a different commit")
        rows = result.get("checklist", [])
        returned = [row.get("id") for row in rows]
        if sorted(returned, key=str) != sorted(ids):
            errors.append(f"{group}: missing, extra or duplicated review rows")
        titles = {item["id"]: item for item in expected}
        for row in rows:
            status = row.get("status")
            if status not in ("passed", "failed", "na", "disputed", "unverified"):
                errors.append(f"{group}: unknown verdict")
            if group == "requirements" and status in ("na", "disputed"):
                errors.append("requirement acceptance cannot be waived; return invalid requirements to the owner")
            if not row.get("reason", "").strip():
                errors.append(f"{group}: verdict needs a reason")
            if status == "passed" and not row.get("evidence", "").strip():
                errors.append(f"{group}: passing verdict needs verification evidence")
            if status == "disputed" and not row.get("suggestion", "").strip():
                errors.append(f"{group}: disputed standard needs a suggested correction")
            if status in ("failed", "unverified"):
                errors.append(f"{group}/{row.get('id')}: {row.get('reason')}")
            checks.append({**titles.get(row.get("id"), {}), **row, "group": group,
                           "scope": data.get("feature", {}).get("id"), "commit": commit})
    return {"approved": not errors, "errors": errors, "checklist": checks,
            "commit": commit, "feature": data.get("feature")}


def main():
    data = json.load(sys.stdin)
    feature = data.get("feature", {}).get("id", "")
    if not isinstance(feature, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,96}", feature):
        raise ValueError("feature ID must be a safe filename")
    report = judge(data)
    content = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    file, digest = write_record(pathlib.Path(".genethub/temp/quality-reports") / feature, content)
    print(json.dumps({"ok": True, "evidence": {"approved": str(report["approved"]).lower(), "report": str(file)},
                      "revision": digest, "message": "; ".join(report["errors"][:12]) or "All required checks covered"}))


if __name__ == "__main__":
    main()
