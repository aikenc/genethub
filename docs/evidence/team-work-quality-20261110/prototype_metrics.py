#!/usr/bin/env python3
"""Read-only prototype: what team work-quality facts can be computed today from the on-disk team ledger.

Reads <team root>/.genethub/team/{tasks,task-dispatch,pending,done,events}; calls no CLI, no model, writes nothing
unless --out is given. Every figure carries its denominator; anything not recorded stays unknown rather than zero.

Usage: prototype_metrics.py --root <team root> [--root ...] --since <ISO UTC> --until <ISO UTC> [--out file.json]
"""
import argparse
import collections
import datetime
import glob
import json
import os
import re
import statistics

REDO = re.compile(r"重派|重做|再修|返工|复检|复核|重采|补拍|重跑|重评|二次|再次|v\d+\b")
ATTRIBUTION = [
    ("remote-or-credential", re.compile(r"429|credential|凭据|凭证|握手|unreachable|不可达|offline|离线|protocolIncompatible", re.I)),
    ("resource-or-gpu", re.compile(r"GPU|显卡|浏览器|Chrome|lease|租约|锁|占用|内存|磁盘", re.I)),
    ("upstream-model", re.compile(r"finish_reason|provider|上游|模型错误|500|rate.?limit|context|上下文", re.I)),
    ("dependency-or-input", re.compile(r"依赖|等待|缺少|未提供|待.*交付|前置|上游成果|未合入", re.I)),
]


def ms(text):
    return int(datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


def load(pattern):
    out = []
    for path in glob.glob(pattern):
        try:
            with open(path, encoding="utf-8") as handle:
                out.append(json.load(handle))
        except (OSError, ValueError):
            continue
    return out


def dist(values, unit=60000.0):
    values = sorted(v / unit for v in values if v is not None)
    if not values:
        return {"n": 0}
    pick = lambda q: round(values[min(len(values) - 1, int(q * len(values)))], 1)
    return {"n": len(values), "p50": round(statistics.median(values), 1), "p90": pick(0.9), "max": round(values[-1], 1)}


def pct(part, whole):
    return None if not whole else round(100.0 * part / whole, 1)


def measure(root, start, end):
    base = os.path.join(root, ".genethub", "team")
    ops = [o for o in load(os.path.join(base, "task-dispatch", "*.json")) if (o.get("request") or {}).get("requester")]
    undated = sum(1 for o in ops if not o.get("createdAtMs"))
    ops = [o for o in ops if o.get("createdAtMs")]
    records = {}
    for folder in ("pending", "done"):
        for rec in load(os.path.join(base, folder, "*.json")):
            if rec.get("sessionId") and rec.get("taskId"):
                rec["_folder"] = folder
                records[rec["sessionId"]] = rec
    events = []
    for path in glob.glob(os.path.join(base, "events", "*.jsonl")):
        for line in open(path, encoding="utf-8"):
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
    events.sort(key=lambda e: e.get("atMs", 0))
    window_ops = [o for o in ops if start <= o["createdAtMs"] < end]
    out = {"root": root, "dispatches": len(window_ops), "dispatchesWithoutTimestampAllTime": undated}

    # 1. Dispatch confirmation: an intent without a session receipt is unknown, not executed.
    unconfirmed = [o for o in window_ops if not o.get("sessionId")]
    out["dispatchConfirmation"] = {
        "withSession": len(window_ops) - len(unconfirmed), "withoutSession": len(unconfirmed),
        "withoutSessionPct": pct(len(unconfirmed), len(window_ops)),
        "oldestUnconfirmedAgeMin": round((end - min(o["createdAtMs"] for o in unconfirmed)) / 60000.0, 1) if unconfirmed else None}

    # 2. Conclusion mix and cycle time (dispatch -> explicit task finish), by role.
    rows = []
    for o in window_ops:
        rec = records.get(o.get("sessionId")) or {}
        concl = rec.get("taskConclusion") or {}
        delivery = rec.get("resultDelivery") or {}
        rows.append(dict(op=o["operationId"], role=o["request"].get("role"), desc=o["request"].get("desc") or "",
                         requester=o["request"]["requester"], created=o["createdAtMs"], session=o.get("sessionId"),
                         outcome=concl.get("outcome"), concludedAt=concl.get("atMs"), evidence=concl.get("evidence") or "",
                         reconcile=(rec.get("done") or {}).get("outcome"), folder=rec.get("_folder"),
                         deliveredAt=delivery.get("atMs"), deliveredTo=delivery.get("to"), remote=bool(rec.get("machine"))))
    concluded = [r for r in rows if r["outcome"] and r["concludedAt"] and r["concludedAt"] <= end]
    out["conclusions"] = dict(collections.Counter(r["outcome"] for r in concluded))
    out["conclusions"]["noExplicitConclusion"] = len(rows) - len(concluded)
    out["noConclusionBreakdown"] = dict(collections.Counter(
        ("in-flight" if r["folder"] == "pending" else "ended-without-finish:" + str(r["reconcile"]) if r["folder"] == "done" else "no-ledger-record")
        for r in rows if r not in concluded))
    out["cycleMin"] = dist([r["concludedAt"] - r["created"] for r in concluded])
    by_role = collections.defaultdict(list)
    for r in concluded:
        by_role[r["role"]].append(r)
    out["byRole"] = {role: dict(n=len(rs), cycleMin=dist([r["concludedAt"] - r["created"] for r in rs]),
                               blockedOrFailedPct=pct(sum(r["outcome"] != "success" for r in rs), len(rs)))
                     for role, rs in sorted(by_role.items(), key=lambda kv: -len(kv[1]))}

    # 3. Handoff: conclusion -> delivery to the requester (team-local resultDelivery field).
    delivered = [r for r in concluded if r["deliveredAt"]]
    out["conclusionToDeliveryMin"] = dist([r["deliveredAt"] - r["concludedAt"] for r in delivered])
    out["deliveryTimestampRecorded"] = any(rec.get("resultDelivery") for rec in records.values())
    out["concludedNotDelivered"] = (len(concluded) - len(delivered)) if out["deliveryTimestampRecorded"] else None
    out["deliveredToOtherThanRequester"] = sum(1 for r in delivered if r["deliveredTo"] and r["deliveredTo"] != r["requester"])

    # 4. Requester follow-through PROXY: delivery -> requester's next new dispatch. Not adoption.
    by_requester = collections.defaultdict(list)
    for o in ops:
        by_requester[o["request"]["requester"]].append(o["createdAtMs"])
    gaps, silent = [], 0
    for r in delivered:
        later = [t for t in by_requester[r["requester"]] if t >= r["deliveredAt"]]
        if later:
            gaps.append(min(later) - r["deliveredAt"])
        if not later or min(later) - r["deliveredAt"] > 30 * 60000:
            silent += 1
    out["deliveryToRequesterNextDispatchMin"] = dist(gaps)
    out["deliveriesWithNoRequesterDispatchWithin30Min"] = {"n": silent, "pct": pct(silent, len(delivered))}

    # 5. Redo signals. No stable work identity exists, so these are text heuristics only.
    marked = [r for r in rows if REDO.search(r["desc"])]
    out["explicitRedoMarkerInDesc"] = {"n": len(marked), "pct": pct(len(marked), len(rows)), "samples": [r["desc"][:40] for r in marked[:5]]}
    seen, dupes = {}, []
    for r in sorted(rows, key=lambda r: r["created"]):
        key = (r["requester"], r["role"], re.sub(r"\s+", "", r["desc"]))
        if key in seen and r["created"] - seen[key] <= 10 * 60000:
            dupes.append(r["desc"][:40])
        seen[key] = r["created"]
    out["identicalDispatchWithin10Min"] = {"n": len(dupes), "samples": dupes[:5]}

    # 6. Non-success conclusions: attribution is free text; keyword buckets are unverified.
    buckets = collections.Counter()
    for r in concluded:
        if r["outcome"] != "success":
            buckets[next((name for name, rx in ATTRIBUTION if rx.search(r["evidence"])), "unclassified")] += 1
    out["nonSuccessKeywordBuckets"] = dict(buckets)

    # 7. Concurrency of work that later concluded (lower bound), and unsettled obligations still on the ledger.
    marks = []
    for o in ops:
        concl = ((records.get(o.get("sessionId")) or {}).get("taskConclusion") or {}).get("atMs")
        if not concl:
            continue
        s, e = max(o["createdAtMs"], start), min(concl, end)
        if e > s:
            marks += [(s, 1), (e, -1)]
    marks.sort()
    level, last, area, zero, peak = 0, start, 0, 0, 0
    for t, delta in marks:
        area += level * (t - last)
        zero += (t - last) if level == 0 else 0
        level, last = level + delta, t
        peak = max(peak, level)
    zero += (end - last) if level == 0 else 0
    area += level * (end - last)
    out["concludedWorkInFlight"] = {"timeWeightedAvg": round(area / (end - start), 2), "peak": peak, "zeroPct": pct(zero, end - start),
                                    "note": "dispatch -> explicit conclusion intervals only; still-open work excluded"}
    open_records = [r for r in records.values() if r["_folder"] == "pending" and not r.get("taskConclusion") and (r.get("createdAtMs") or end) < end]
    idle_open = [r for r in open_records if r.get("observedStatus") == "idle"]
    ages = sorted(((end - r["createdAtMs"]) / 3600000.0 for r in idle_open), reverse=True)
    out["unsettledObligations"] = {"openOnLedger": len(open_records), "idleWithoutConclusion": len(idle_open),
                                   "idleOlderThan6h": sum(a > 6 for a in ages), "oldestIdleAgeHours": round(ages[0], 1) if ages else None}

    # 8. Events (team-local patch): human touches and wake -> action conversion.
    win = [e for e in events if start <= e.get("atMs", 0) < end]
    kinds = collections.Counter(e.get("kind") for e in win)
    out["eventKinds"] = dict(kinds)
    out["eventsAvailable"] = bool(events)
    inputs = [e for e in win if e.get("kind") == "input"]
    out["inputs"] = {"fromFront": sum(bool(e.get("fromFront")) for e in inputs), "fromOthers": sum(not e.get("fromFront") for e in inputs)}
    tells = [e for e in win if e.get("kind") == "tell-user"]
    out["tellUser"] = {"n": len(tells), "questions": sum(bool(e.get("question")) for e in tells)}
    wakes = [e for e in win if e.get("kind") == "parallelism-wake"]
    acted = 0
    for w in wakes:
        if any(w["atMs"] <= t <= w["atMs"] + 10 * 60000 for t in by_requester.get(w.get("sessionId"), [])):
            acted += 1
    out["capacityWakes"] = {"n": len(wakes), "followedByDispatchWithin10Min": acted, "pct": pct(acted, len(wakes))}
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", action="append", required=True)
    parser.add_argument("--since", required=True)
    parser.add_argument("--until", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()
    start, end = ms(args.since), ms(args.until)
    result = {"schema": "team-work-facts-prototype/1", "window": {"since": args.since, "until": args.until},
              "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
              "limits": ["ledger and team-local events only; no native session history, so execution time, tokens and cost are absent",
                         "delivery -> requester's next dispatch is a proxy and does not prove adoption",
                         "redo and attribution figures are text heuristics because no work identity or reason code is recorded",
                         "concurrency covers dispatch -> conclusion intervals, not verified execution; open records are listed as unsettled obligations"],
              "teams": [measure(os.path.abspath(r), start, end) for r in args.root]}
    text = json.dumps(result, ensure_ascii=False, indent=1)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
