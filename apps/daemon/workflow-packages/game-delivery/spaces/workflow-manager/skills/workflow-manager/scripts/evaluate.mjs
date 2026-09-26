import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const nativePath = (value) => process.platform === "win32" && /^\/[a-z](?:\/|$)/i.test(value)
  ? `${value[1]}:${value.slice(2) || "/"}` : value;
const cli = nativePath(process.env.GENEHUB_CLI ?? "");
const sessionId = process.env.GENEHUB_SESSION_ID;
if (!cli || !path.isAbsolute(cli)) throw new Error("GENEHUB_CLI must be an absolute product command");
if (!sessionId) throw new Error("evaluation must run inside a WorkflowManager Session");

function genet(args) {
  const result = spawnSync(cli, args, { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${result.stdout || result.stderr}`);
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
const proposal = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : {};

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
const slowestNode = [...nodeDurations].sort((left, right) => right.durationMs - left.durationMs)[0];

const draft = genet(["workflow", "check", "--draft"]).draft;
if (!draft?.valid || !draft.candidateDigest || !Array.isArray(draft.workflows)) {
  throw new Error("Current daemon did not provide a validated draft; update it rather than substituting the Active catalog");
}
const project = genet(["workflow", "inspect"]);
project.root = nativePath(project.root);
if (project.candidateDigest !== draft.candidateDigest) throw new Error("Candidate changed during evaluation; rerun draft validation");

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
const allChangedFiles = [...new Set(
  `${changedResult.stdout}\n${untrackedResult.stdout}`.split("\n").filter(Boolean),
)].sort();
const changedFiles = allChangedFiles.filter((file) => file.startsWith(".genethub/workflows/"));

// Compiled catalog only: quoted/inline YAML is valid, uncataloged files are not dependencies.
const candidateRoles = [...new Set(draft.workflows.flatMap((workflow) => workflow.roles))].sort();
const executorPath = draft.execution?.executorPath;
const workspaces = (genet(["workspace", "list"]).workspaces ?? [])
  .map((space) => ({ ...space, root: nativePath(space.root) }));
const selectedExecutor = executorPath && workspaces.find((space) => path.resolve(space.root) === path.resolve(projectRoot, executorPath));
const children = selectedExecutor ? genet(["space", "children", "--workspace", selectedExecutor.id]).children ?? [] : [];
const availableRoles = children.flatMap((child) =>
    (child.agentSpace?.components ?? [])
      .filter((component) => component.componentId === "worker" && component.enabled && component.role)
      .map((component) => component.role)
);
const unavailableRoles = candidateRoles.filter((role) => availableRoles.filter((available) => available === role).length !== 1);
const carrierRolesReady = Boolean(selectedExecutor) && unavailableRoles.length === 0;

const report = {
  schema: "genehub.workflow-evaluation.v1",
  status: "passed",
  scope: "structure",
  improvementVerdict: "unproven",
  carrierRolesReady,
  trialReadiness: "unverified",
  executorWorkspaceId: selectedExecutor?.id ?? null,
  unavailableRoles,
  missingEvidence: [
    ...(completed.length ? [] : ["completed baseline Run"]),
    ...(nodeDurations.length ? [] : ["measured node durations"]),
    ...(carrierRolesReady ? [] : ["Candidate roles have no enabled direct Worker on the selected Executor"]),
    "Builder verification, task resources and authorized trial budget",
    "comparable candidate trial and independent WR assessment",
  ],
  activeDigest: project.activeDigest,
  candidateDigest: project.candidateDigest,
  activationRevision: project.activationRevision,
  analyzedRuns: completed.map((run) => run.id),
  analyzedMessages: messages,
  candidateWorkerRoles: candidateRoles,
  nodeDurations,
  finding: slowestNode ? {
    code: "longest-node",
    runId: slowestNode.runId,
    nodeId: slowestNode.nodeId,
    durationMs: slowestNode.durationMs,
  } : null,
  hypothesis: proposal.hypothesis ?? (slowestNode
    ? `Investigate ${slowestNode.nodeId} (${slowestNode.durationMs} ms); duration alone does not identify its cause or prove a proposed improvement.`
    : null),
  comparisonPlan: proposal.comparisonPlan ?? "Keep the Candidate inactive; fix input, acceptance, budget and environment, run the candidate, and ask WR to compare actual coverage, rework and cost. This plan has not been executed.",
  changedFiles,
  unrelatedChangedFiles: allChangedFiles.filter((file) => !changedFiles.includes(file)),
  checks: [
    "candidate.compiles",
    ...(project.sourceChanged ? ["candidate.remainsInactive"] : []),
    ...(completed.length ? ["completedRuns.haveStructuredTimeline"] : []),
    ...(nodeDurations.length ? ["completedRuns.haveMeasuredNodeDurations"] : []),
    "changes.workflowAssetsEnumerated",
    ...(carrierRolesReady ? ["candidate.rolesHaveAttachedWorkers"] : []),
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
