#!/usr/bin/env python3
"""Package-owned delivery feedback; the platform does not judge standards."""
import json
import pathlib
import sys
sys.dont_write_bytecode = True
from records import write_record

request = json.load(sys.stdin)
units = request["features"]
reports = []
final_reviews = request.get("finalReviews", {})
final_commit = request.get("finalCommit")
approved = bool(units) and all(unit.get("integrated") for unit in units.values())
approved = approved and set(final_reviews) == {unit["featureId"] for unit in units.values()}
for unit in units.values():
    final = final_reviews.get(unit["featureId"])
    path = final.get("finding") if final else unit.get("integrationFinding") or unit.get("finding")
    if not isinstance(path, str):
        raise ValueError("delivery unit has no final quality report")
    report = json.loads(pathlib.Path(path).read_text(encoding="utf8"))
    if report["feature"]["id"] != unit["featureId"]:
        raise ValueError("quality report belongs to another delivery unit")
    approved = approved and bool(final) and report["approved"] and report["commit"] == final_commit
    reports.append({"path": path, "report": report})
items = {}
for entry in reports:
    for row in entry["report"]["checklist"]:
        key = (row["group"], row["id"], row["scope"] if row["group"] == "requirements" else "")
        items.setdefault(key, []).append(row)
counts = dict.fromkeys(("passed", "failed", "unverified", "disputed", "na"), 0)
feedback = []
for rows in items.values():
    statuses = {row["status"] for row in rows}
    status = next((kind for kind in ("failed", "unverified", "disputed", "passed", "na") if kind in statuses), "unverified")
    counts[status] += 1
    feedback.extend(row for row in rows if row["status"] == "disputed")
summary = (f"质量结论：{counts['passed']} 项通过，{counts['failed']} 项未通过，"
           f"{counts['na']} 项无需验证，{counts['disputed']} 项规范异议，"
           f"{counts['unverified']} 项尚未完成验证。")
if feedback:
    summary += " 有异议交付：PM 请将报告中的理由和修改建议转交 WM，不能声称所有规范通过。"
content = json.dumps({"summary": summary, "approved": approved, "finalCommit": final_commit,
                     "counts": counts, "feedback": feedback, "reports": reports}, ensure_ascii=False, sort_keys=True) + "\n"
path, digest = write_record(".genethub/temp/quality-summaries", content, 16)
print(json.dumps({"ok": True, "evidence": {"summary": summary, "report": str(path), "approved": str(approved).lower()}, "revision": digest, "message": summary}))
