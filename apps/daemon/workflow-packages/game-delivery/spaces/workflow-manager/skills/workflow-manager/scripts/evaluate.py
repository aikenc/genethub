#!/usr/bin/env python3
"""Optional structural report using public CLI facts; never proves improvement."""
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys

def native_path(value):
    # Managed environments may publish Git Bash's /c/... form on Windows.
    if os.name == "nt" and re.match(r"^/[a-z](?:/|$)", value, re.IGNORECASE):
        return value[1] + ":" + (value[2:] or "/")
    return value

cli = native_path(os.environ.get("GENEHUB_CLI", ""))
session = os.environ.get("GENEHUB_SESSION_ID", "")
if not pathlib.Path(cli).is_absolute() or not session:
    raise ValueError("Run inside a managed WM session with an absolute GENEHUB_CLI")

def genet(*args):
    result = subprocess.run([cli, *args], text=True, capture_output=True, check=True)
    envelopes = []
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and "data" in value:
                envelopes.append(value["data"])
        except json.JSONDecodeError:
            pass
    if not envelopes:
        raise ValueError("CLI returned no data: " + " ".join(args))
    return envelopes[-1]

def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).splitlines()

runs = [r for r in genet("workflow", "history", "--limit", "20").get("runs", []) if r["status"] == "completed"]
durations, messages = [], 0
profiles = []
for run in runs:
    flow = genet("session", "flow", run["executorSessionId"])["flow"]
    if flow["run"]["id"] != run["id"] or not any(m["kind"] == "run.completed" for m in flow["messages"]):
        raise ValueError("Baseline Run has no completed structured timeline")
    messages += len(flow["messages"])
    profiles.append(genet("workflow", "profile", "--run", run["id"]))
    for assigned in flow["messages"]:
        if assigned["kind"] != "node.assigned":
            continue
        finished = next((m for m in flow["messages"] if m["kind"] == "node.completed" and m.get("nodeId") == assigned.get("nodeId") and m.get("attempt") == assigned.get("attempt") and m["createdAtMs"] >= assigned["createdAtMs"]), None)
        if finished:
            durations.append(dict(runId=run["id"], nodeId=assigned["nodeId"], attempt=assigned.get("attempt"), durationMs=finished["createdAtMs"]-assigned["createdAtMs"]))
draft = genet("workflow", "check", "--draft")["draft"]
if not draft.get("valid") or not draft.get("candidateDigest"):
    raise ValueError("Current draft is invalid")
project = genet("workflow", "inspect")
if project["candidateDigest"] != draft["candidateDigest"]:
    raise ValueError("Build changed during evaluation")
source = pathlib.Path(native_path(project["root"]))
root = next((p.parent for p in [source, *source.parents] if p.name == ".genethub"), None)
if root is None:
    raise ValueError("Workflow source has no project root")
changed = sorted(set(git(root, "diff", "--name-only", "HEAD") + git(root, "ls-files", "--others", "--exclude-standard")))
roles = sorted({role for flow in draft["workflows"] for role in flow.get("roles", [])})
executor = draft.get("execution", {}).get("executorPath")
spaces = genet("workspace", "list").get("workspaces", [])
carrier = next((s for s in spaces if executor and pathlib.Path(native_path(s["root"])).resolve() == (root/executor).resolve()), None)
children = genet("space", "children", "--workspace", carrier["id"]).get("children", []) if carrier else []
available = [c["role"] for child in children for c in child.get("agentSpace", {}).get("components", []) if c.get("componentId") == "worker" and c.get("enabled") and c.get("role")]
missing = [role for role in roles if available.count(role) != 1]
ready = bool(carrier) and not missing
slowest = max(durations, key=lambda d: d["durationMs"], default=None)
proposal = json.loads(pathlib.Path(sys.argv[1]).read_text()) if len(sys.argv)>1 else {}
report = dict(schema="genehub.workflow-evaluation.v1", status="passed", scope="structure", improvementVerdict="unproven", carrierRolesReady=ready, trialReadiness="unverified", executorWorkspaceId=carrier["id"] if carrier else None, unavailableRoles=missing,
    missingEvidence=(["completed baseline Run"] if not runs else []) + (["measured node durations"] if not durations else []) + (["build roles have no enabled direct Worker"] if not ready else []) + ["Builder verification, task resources and authorized trial budget", "comparable build trial and independent assessment"],
    activeDigest=project.get("activeDigest"), candidateDigest=project["candidateDigest"], activationRevision=project.get("activationRevision"), analyzedRuns=[r["id"] for r in runs], analyzedMessages=messages, candidateWorkerRoles=roles, nodeDurations=durations,
    finding=dict(code="longest-node", **{k:slowest[k] for k in ("runId","nodeId","durationMs")}) if slowest else None,
    hypothesis=proposal.get("hypothesis") or ("Investigate the longest operation; duration does not prove its cause or improvement" if slowest else None),
    comparisonPlan=proposal.get("comparisonPlan") or "Keep the build inactive; compare equal input, acceptance, budget and environment in real trials. This comparison has not run.",
    changedFiles=[f for f in changed if f.startswith(".genethub/workflows/")], unrelatedChangedFiles=[f for f in changed if not f.startswith(".genethub/workflows/")],
    checks=["candidate.compiles", "changes.workflowAssetsEnumerated"] + (["candidate.remainsInactive"] if project.get("sourceChanged") else []) + (["completedRuns.haveStructuredTimeline"] if runs else []) + (["completedRuns.haveMeasuredNodeDurations"] if durations else []) + (["candidate.rolesHaveAttachedWorkers"] if ready else []),
    createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), profiles=[dict(runId=p["runId"],cost=p["cost"],budget=p["budget"]) for p in profiles])
folder = pathlib.Path(".genethub/sessions")/session/"components/worker/evaluations"
folder.mkdir(parents=True, exist_ok=True, mode=0o700)
# A current report pointer is one value, not an accumulating event list.
output = folder / "latest.json"
with open(output, "w", encoding="utf-8", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
    if os.name != "nt":
        os.fchmod(stream.fileno(), 0o600)
    stream.write(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
print(json.dumps(report, ensure_ascii=False))
