import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const cli = process.env.GENEHUB_CLI;
const sessionId = process.env.GENEHUB_SESSION_ID;
if (!cli || !path.isAbsolute(cli)) throw new Error("GENEHUB_CLI must be an absolute product command");
if (!sessionId) throw new Error("evaluation must run inside a WorkflowManager Session");

function genet(args) {
  const result = spawnSync(cli, args, { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  let envelope;
  for (const line of result.stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      envelope = JSON.parse(line);
    } catch {
      // Product diagnostics may surround the one JSON result.
    }
  }
  if (!envelope?.data) throw new Error(`${args.join(" ")} returned no data envelope`);
  return envelope.data;
}

const history = genet(["workflow", "history", "--limit", "20"]);
const completed = (history.runs ?? []).filter((run) => run.status === "completed");
if (completed.length === 0) throw new Error("evaluation needs at least one completed Workflow Run");

let messages = 0;
const nodeDurations = [];
for (const run of completed) {
  if (!run.executorSessionId) throw new Error(`Run ${run.id} has no Executor Session`);
  const flow = genet(["session", "flow", run.executorSessionId]).flow;
  if (flow.run.id !== run.id || !flow.messages.some((message) => message.kind === "run.completed")) {
    throw new Error(`Run ${run.id} has no complete structured timeline`);
  }
  messages += flow.messages.length;
  for (const assigned of flow.messages.filter((message) => message.kind === "node.assigned")) {
    const finished = flow.messages.find(
      (message) =>
        message.kind === "node.completed" &&
        message.nodeId === assigned.nodeId &&
        message.attempt === assigned.attempt &&
        message.createdAtMs >= assigned.createdAtMs,
    );
    if (!finished) continue;
    nodeDurations.push({
      runId: run.id,
      nodeId: assigned.nodeId,
      attempt: assigned.attempt,
      durationMs: finished.createdAtMs - assigned.createdAtMs,
    });
  }
}
if (nodeDurations.length === 0) throw new Error("completed Runs expose no measurable node durations");
const slowestNode = [...nodeDurations].sort((left, right) => right.durationMs - left.durationMs)[0];

const project = genet(["workflow", "inspect"]);
if (!project.candidateDigest || !project.activeDigest || !project.sourceChanged) {
  throw new Error("evaluation expects a compilable Candidate distinct from the active DCG");
}
if (project.candidateDigest === project.activeDigest) {
  throw new Error("Candidate digest did not change");
}

// `workflow inspect.root` deliberately names the versioned Workflow source,
// not the repository. Walk from `<project>/.genethub/workflow` to the Git
// project before asking Git for project-relative changed paths.
const projectRoot = path.resolve(project.root, "..", "..");
const changedResult = spawnSync("git", ["diff", "--name-only", "HEAD"], {
  cwd: projectRoot,
  encoding: "utf8",
});
if (changedResult.status !== 0) throw new Error(changedResult.stderr || "git diff failed");
const untrackedResult = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
  cwd: projectRoot,
  encoding: "utf8",
});
if (untrackedResult.status !== 0) {
  throw new Error(untrackedResult.stderr || "git untracked-file scan failed");
}
const changedFiles = [...new Set(
  `${changedResult.stdout}\n${untrackedResult.stdout}`.split("\n").filter(Boolean),
)].sort();
if (
  changedFiles.length === 0 ||
  changedFiles.some((file) => !file.startsWith(".genethub/workflow/"))
) {
  throw new Error(`evaluation changes must be limited to project Workflow assets: ${changedFiles.join(",")}`);
}

const workflowFiles = readdirSync(path.join(project.root, "workflows"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
  .map((entry) => path.join(project.root, "workflows", entry.name));
const candidateRoles = [...new Set(workflowFiles.flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^\s+role:\s*([A-Za-z0-9._-]+)\s*$/gm)].map((match) => match[1]);
}))].sort();
if (candidateRoles.length === 0) throw new Error("Candidate references no agent.session roles");
const executorWorkspaceIds = [...new Set(completed.map((run) => run.executorWorkspaceId).filter(Boolean))];
if (executorWorkspaceIds.length === 0) throw new Error("completed Runs expose no Executor AgentSpace");
for (const executorWorkspaceId of executorWorkspaceIds) {
  const children = genet(["space", "children", "--workspace", executorWorkspaceId]).children ?? [];
  const availableRoles = new Set(children.flatMap((child) =>
    (child.agentSpace?.components ?? [])
      .filter((component) => component.componentId === "worker" && component.enabled && component.role)
      .map((component) => component.role)
  ));
  const unavailable = candidateRoles.filter((role) => !availableRoles.has(role));
  if (unavailable.length > 0) {
    throw new Error(
      `Candidate roles have no enabled direct Worker on Executor ${executorWorkspaceId}: ${unavailable.join(",")}`,
    );
  }
}

const report = {
  schema: "genehub.workflow-evaluation.v1",
  status: "passed",
  activeDigest: project.activeDigest,
  candidateDigest: project.candidateDigest,
  activationRevision: project.activationRevision,
  analyzedRuns: completed.map((run) => run.id),
  analyzedMessages: messages,
  candidateWorkerRoles: candidateRoles,
  nodeDurations,
  finding: {
    code: "longest-node",
    runId: slowestNode.runId,
    nodeId: slowestNode.nodeId,
    durationMs: slowestNode.durationMs,
  },
  hypothesis:
    "Move the smallest relevant static and playability checks into the implementation handoff so Reviewer feedback is less likely to trigger avoidable rework.",
  comparisonPlan:
    "Keep this Candidate inactive, run the same journey with it explicitly selected, then compare node duration, retry count, evidence completeness, and total delivery time before activation.",
  changedFiles,
  checks: [
    "candidate.compiles",
    "candidate.remainsInactive",
    "completedRuns.haveStructuredTimeline",
    "completedRuns.haveMeasuredNodeDurations",
    "changes.workflowAssetsOnly",
    "candidate.rolesHaveAttachedWorkers",
  ],
  createdAt: new Date().toISOString(),
};
const outputDir = path.join(
  process.cwd(),
  ".genethub",
  "sessions",
  sessionId,
  "components",
  "worker",
  "evaluations",
);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const output = path.join(outputDir, "latest.json");
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report)}\n`);
