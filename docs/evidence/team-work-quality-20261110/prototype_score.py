#!/usr/bin/env python3
"""Read-only prototype of the team work-quality score (model tq/1-draft) on top of prototype_metrics.py output.

score = max(0, base - 50 * triggered red-line kinds). base = weighted mean of indicator scores, each interpolated
between five anchors (floor 0, pass 60, meets 80, partly exceeds 90, fully exceeds 100). Indicators that cannot be
computed stay unknown; the score is then provisional and reported with its weight coverage and possible range.

Usage: prototype_score.py --facts facts.json [--facts ...] [--root <team root> ...] [--out score.json]
--root lets late deliveries (R3) be counted from the ledger for teams that record resultDelivery.
"""
import argparse
import datetime
import glob
import json
import os

WEIGHTS = {"M1": 25, "M2": 20, "M3": 20, "M4": 15, "M5": 10, "M6": 10}
# (metric, indicator, anchors floor/pass/meets/partly/fully, lower-is-better)
INDICATORS = [
    ("M1", "firstPassAdoptionPct", (30, 60, 75, 85, 92), False),
    ("M1", "reworkPct", (50, 30, 20, 12, 6), True),
    ("M2", "dispatchToStartP90Min", (60, 20, 10, 5, 2), True),
    ("M2", "conclusionToDeliveryP90Min", (60, 10, 3, 1.5, 0.5), True),
    ("M2", "deliveryToConsumeP90Min", (120, 30, 10, 5, 2), True),
    ("M3", "unsolicitedHumanInputsPerTaskDay", (10, 4, 2, 1, 0), True),
    ("M4", "costPerAdoptedVsBaseline", (2.0, 1.2, 1.0, 0.85, 0.7), True),
    ("M4", "coordinationSharePct", (60, 40, 30, 22, 15), True),
    ("M5", "idleWakePct", (50, 25, 12, 6, 2), True),
    ("M6", "failedTurnPct", (10, 4, 2, 1, 0.3), True),
    ("M6", "recoveryP90Min", (240, 60, 20, 10, 5), True),
]
LEVELS = (0, 60, 80, 90, 100)
RED_LINES = ("R1", "R2", "R3", "R4", "R5")


def interpolate(value, anchors, lower_better):
    pts = list(zip(anchors, LEVELS))
    if lower_better:
        pts = [(-a, s) for a, s in pts]
        value = -value
    if value <= pts[0][0]:
        return 0.0
    if value >= pts[-1][0]:
        return 100.0
    for (a0, s0), (a1, s1) in zip(pts, pts[1:]):
        if a0 <= value <= a1:
            return round(s0 + (s1 - s0) * (value - a0) / (a1 - a0), 1)
    return None


def grade(score):
    if score >= 100:
        return "全面超出预期"
    if score >= 90:
        return "部分超出预期"
    if score >= 80:
        return "比较符合预期"
    if score >= 60:
        return "及格"
    return "不及格"


def late_deliveries(root, start, end, limit_min=10):
    n = 0
    for path in glob.glob(os.path.join(root, ".genethub", "team", "*", "*.json")):
        if os.path.basename(os.path.dirname(path)) not in ("pending", "done"):
            continue
        try:
            rec = json.load(open(path, encoding="utf-8"))
        except (OSError, ValueError):
            continue
        concl = (rec.get("taskConclusion") or {}).get("atMs")
        delivered = (rec.get("resultDelivery") or {}).get("atMs")
        if concl and start <= concl <= end and delivered and delivered - concl > limit_min * 60000:
            n += 1
    return n


def score_team(team, window, root):
    facts = {}
    proxies = []
    c2d = team.get("conclusionToDeliveryMin") or {}
    if team.get("deliveryTimestampRecorded") and c2d.get("n", 0) >= 20:
        facts["conclusionToDeliveryP90Min"] = c2d["p90"]
    d2n = team.get("deliveryToRequesterNextDispatchMin") or {}
    if d2n.get("n", 0) >= 20:
        facts["deliveryToConsumeP90Min"] = d2n["p90"]
        proxies.append("deliveryToConsumeP90Min = delivery -> requester's next dispatch, not read-in")
    wakes = team.get("capacityWakes") or {}
    if wakes.get("n", 0) >= 20:
        facts["idleWakePct"] = round(100 - wakes["pct"], 1)
        proxies.append("idleWakePct = capacity wakes with no dispatch within 10 min, not 'no ledger delta'")

    red = {}
    dc = team.get("dispatchConfirmation") or {}
    red["R1"] = {"n": dc.get("withoutSession"), "of": team.get("dispatches")}
    red["R2"] = {"n": (team.get("unsettledObligations") or {}).get("idleWithoutConclusion"),
                 "note": "standing marker not available; long-lived services are included"}
    if team.get("deliveryTimestampRecorded") and root:
        late = late_deliveries(root, window[0], window[1])
        red["R3"] = {"n": late + (team.get("concludedNotDelivered") or 0) + (team.get("deliveredToOtherThanRequester") or 0),
                     "lateOver10Min": late, "notDelivered": team.get("concludedNotDelivered"),
                     "misdelivered": team.get("deliveredToOtherThanRequester")}
    else:
        red["R3"] = {"n": None, "reason": "no delivery timestamps"}
    red["R4"] = {"n": None, "reason": "no stall events in template"}
    red["R5"] = {"n": None, "reason": "release records not read"}
    for v in red.values():
        v["triggered"] = None if v["n"] is None else v["n"] > 0
    triggered = [k for k in RED_LINES if red[k]["triggered"]]
    unknown_red = [k for k in RED_LINES if red[k]["triggered"] is None]

    indicators, metrics = {}, {}
    for metric, name, anchors, lower in INDICATORS:
        value = facts.get(name)
        indicators[name] = {"metric": metric, "value": value,
                            "score": None if value is None else interpolate(value, anchors, lower)}
    for metric in WEIGHTS:
        known = [i["score"] for i in indicators.values() if i["metric"] == metric and i["score"] is not None]
        metrics[metric] = round(sum(known) / len(known), 1) if known else None
    known_w = sum(WEIGHTS[m] for m, s in metrics.items() if s is not None)
    base = round(sum(WEIGHTS[m] * s for m, s in metrics.items() if s is not None) / known_w, 1) if known_w else None
    penalty = 50 * len(triggered)
    floor_base = base * known_w / 100 if base is not None else 0
    ceil_base = (base * known_w + 100 * (100 - known_w)) / 100 if base is not None else 100
    low = max(0.0, round(floor_base - penalty - 50 * len(unknown_red), 1))
    high = max(0.0, round(ceil_base - penalty, 1))
    final = round(max(0.0, base - penalty), 1) if base is not None else None
    return {"team": team.get("root"), "model": "tq/1-draft",
            "redLines": red, "triggered": triggered, "unknownRedLines": unknown_red, "penalty": penalty,
            "indicators": indicators, "metrics": metrics,
            "coverage": {"weightKnownPct": known_w, "redLinesKnown": len(RED_LINES) - len(unknown_red)},
            "baseProvisional": base, "scoreProvisional": final, "possibleRange": [low, high],
            "grade": None if final is None else grade(final),
            "graded": known_w >= 80 and not unknown_red,
            "proxies": proxies}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--facts", action="append", required=True)
    ap.add_argument("--root", action="append", default=[])
    ap.add_argument("--out")
    args = ap.parse_args()
    roots = {os.path.realpath(r): r for r in args.root}
    out = []
    for path in args.facts:
        data = json.load(open(path, encoding="utf-8"))
        w = data["window"]
        window = tuple(int(datetime.datetime.fromisoformat(w[k].replace("Z", "+00:00")).timestamp() * 1000)
                       for k in ("since", "until"))
        for team in data["teams"]:
            root = team.get("root", "")
            local = roots.get(os.path.realpath(root)) if os.path.isdir(root) else None
            result = score_team(team, window, local)
            result["window"] = w
            result["facts"] = os.path.basename(path)
            out.append(result)
    text = json.dumps({"schema": "team-quality-score-prototype/1", "results": out}, ensure_ascii=False, indent=1)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
