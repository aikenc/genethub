import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createLease, releaseLease } from "../environment/lease.ts";
import type { UnitResult, WorkUnit } from "../types.ts";
import { collectFailureArtifacts, type FailureArtifactIndex } from "./failure-artifacts.ts";
import { createRunStore } from "./run-store.ts";

const unit: WorkUnit = {
  id: "journey.failure-bundle#default",
  caseId: "journey.failure-bundle",
  variant: "default",
  meta: {
    id: "journey.failure-bundle",
    title: "failure bundle",
    kind: "journey",
    oracle: "failure evidence survives lease cleanup",
    catches: ["missing session history"],
    tags: ["testctl"],
    runner: "node",
    llm: { default: "none" },
    resources: { environments: 1, cpu: 1, memoryMb: 64, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 1,
    timeoutMs: 1_000,
    surfaces: ["testctl"],
    file: import.meta.filename,
  },
};

function allTextFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) out.push(file);
    }
  };
  visit(root);
  return out;
}

test("failure artifacts retain PM and worker session stores without leaking credentials", () => {
  const lease = createLease("genehub-evidence-test-");
  const staging = mkdtempSync(path.join(tmpdir(), "genehub-evidence-stage-"));
  const secret = "sk-do-not-persist";
  try {
    mkdirSync(path.join(lease.logs), { recursive: true });
    writeFileSync(path.join(lease.logs, "daemon.log"), `first line\nALIYUN_TOKENPLAN_KEY=${secret}\nlast line\n`);
    mkdirSync(path.join(lease.data, "logs"), { recursive: true });
    writeFileSync(
      path.join(lease.data, "logs", "cli-start.log"),
      `${JSON.stringify({ event: "listening", challenge: secret, machineId: "machine-private", fingerprint: "private-print", url: `ws://127.0.0.1/?proof=${secret}` })}\n`,
    );
    writeFileSync(path.join(lease.data, "logs", "daemon.log"), "product daemon event\n");

    const pm = path.join(lease.workspace, "project", "spaces", "pm", ".genethub", "sessions", "s_pm");
    const worker = path.join(lease.workspace, "project", "spaces", "implementation", ".genethub", "sessions", "s_work");
    const reviewer = path.join(lease.workspace, "project", "spaces", "review", ".genethub", "sessions", "s_review");
    mkdirSync(path.join(pm, "rounds", "r-000"), { recursive: true });
    mkdirSync(path.join(worker, "rounds", "r-000"), { recursive: true });
    mkdirSync(path.join(reviewer, "rounds", "r-000"), { recursive: true });
    // SessionKind uses camelCase serialization and the real PM wire value is
    // exactly `pm`; keep this fixture aligned with the daemon store.
    writeFileSync(path.join(pm, "meta.json"), `${JSON.stringify({ id: "s_pm", kind: "pm", agentId: "builtin" })}\n`);
    writeFileSync(path.join(pm, "chat.jsonl"), `${JSON.stringify({ role: "assistant", text: `used ${secret}` })}\n`);
    writeFileSync(
      path.join(worker, "meta.json"),
      `${JSON.stringify({
        id: "s_work",
        kind: "work",
        agentId: "opencode",
        work: { controllerSessionId: "s_pm", workPackageId: "wp_1" },
      })}\n`,
    );
    writeFileSync(path.join(worker, "rounds", "r-000", "t-0000.jsonl"), `${JSON.stringify({ event: "tool", authorization: secret })}\n`);
    writeFileSync(
      path.join(reviewer, "meta.json"),
      `${JSON.stringify({
        id: "s_review",
        kind: "work",
        agentId: "opencode",
        work: { controllerSessionId: "s_pm", workPackageId: "wp_1" },
      })}\n`,
    );
    writeFileSync(path.join(reviewer, "rounds", "r-000", "t-0000.jsonl"), "{\"event\":\"review\"}\n");
    const pmControl = path.join(lease.workspace, "spaces", "pm", ".genethub");
    mkdirSync(pmControl, { recursive: true });
    writeFileSync(path.join(pmControl, "topology-bootstrap.log"), "topology ready\n");

    mkdirSync(path.join(lease.data, "pm-projects"), { recursive: true });
    writeFileSync(
      path.join(lease.data, "pm-projects", "w_project.json"),
      `${JSON.stringify({
        projectWorkspaceId: "w_project",
        sessionDcgRuns: { s_pm: { status: "running" } },
        workPackages: [{
          id: "wp_1",
          controllerSessionId: "s_pm",
          workSessionId: "s_work",
          review: { sessionId: "s_review", verdict: "pass" },
        }],
      })}\n`,
    );

    const bundle = collectFailureArtifacts({
      lease,
      unit,
      stagingRoot: staging,
      effectiveEnv: { ...lease.env, ALIYUN_TOKENPLAN_KEY: secret, TESTCTL_CASE_ID: unit.caseId },
      runnerOutput: {
        stdout: `runner started with ${secret}\n`,
        stderr: "runner warning\n",
        stdoutBytes: 32,
        stderrBytes: 15,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    });
    const index = JSON.parse(readFileSync(path.join(bundle, "artifact-index.json"), "utf8")) as FailureArtifactIndex;
    assert.equal(index.sessions.length, 3);
    assert.deepEqual(index.sessions.map((session) => session.role).sort(), ["pm", "reviewer", "worker"]);
    assert(index.sessions.every((session) => session.sourcePath.startsWith("<lease-root>/workspace/")));
    assert(index.files.some((file) => file.kind === "project-state"));
    assert(index.files.some((file) => file.sourcePath.endsWith("/logs/daemon.log")));
    assert(index.files.some((file) => file.artifactPath === "logs/pm-control/topology-bootstrap.log"));
    assert(index.files.some((file) => file.sourcePath === "<test-worker>/stdout"));
    assert.equal(
      index.storageMap.agentSpaceSessions,
      "<lease-root>/workspace/spaces/<agent-space>/.genethub/sessions/<session-id>/",
    );
    for (const file of allTextFiles(bundle)) {
      const contents = readFileSync(file, "utf8");
      assert(!contents.includes(secret), `${path.relative(bundle, file)} leaked a credential`);
      assert(!contents.includes("machine-private"), `${path.relative(bundle, file)} leaked a machine id`);
      assert(!contents.includes("private-print"), `${path.relative(bundle, file)} leaked a fingerprint`);
      assert(!contents.includes(lease.root), `${path.relative(bundle, file)} leaked the temporary absolute path`);
    }
    const environment = JSON.parse(readFileSync(path.join(bundle, "system", "environment.json"), "utf8"));
    assert.deepEqual(environment.ALIYUN_TOKENPLAN_KEY, { present: true });
  } finally {
    releaseLease(lease);
    rmSync(staging, { recursive: true, force: true });
  }
});

test("run store consumes only sanitized bundles inside its own internal directory", () => {
  const space = mkdtempSync(path.join(tmpdir(), "genehub-run-store-test-"));
  try {
    const store = createRunStore(space, "failure-artifacts");
    const staging = path.join(store.dir, ".internal", "failure-evidence", "bundle");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "artifact-index.json"), "{}\n");
    const result: UnitResult = {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: "failed",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString(),
      durationMs: 1,
      message: "failed",
      failureArtifacts: staging,
    };
    store.writeResult(result);
    store.writeFailure(result, "authorization: Bearer never-persist-this");
    const failure = path.join(store.dir, "failures", unit.caseId, "evidence", "journey.failure-bundle_default", "artifact-index.json");
    assert.equal(readFileSync(failure, "utf8"), "{}\n");
    assert(!readFileSync(path.join(store.dir, "results.ndjson"), "utf8").includes("failureArtifacts"));
    assert(!readFileSync(path.join(store.dir, "failures", unit.caseId, "diagnostic.md"), "utf8").includes("never-persist-this"));
  } finally {
    rmSync(space, { recursive: true, force: true });
  }
});

test("run store preserves retained passing evidence outside its internal staging directory", () => {
  const space = mkdtempSync(path.join(tmpdir(), "genehub-run-retention-test-"));
  try {
    const store = createRunStore(space, "retained-artifacts");
    const staging = path.join(store.dir, ".internal", "failure-evidence", "passing-bundle");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "artifact-index.json"), "{\"schema\":\"retained\"}\n");
    const result: UnitResult = {
      id: unit.id,
      caseId: unit.caseId,
      variant: unit.variant,
      status: "passed",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString(),
      durationMs: 1,
      message: "qualified",
      retentionArtifacts: staging,
    };
    store.writeResult(result);
    store.writeReport(result);
    store.writeRetentionArtifacts(result);
    const retained = path.join(
      store.dir,
      "reports",
      unit.caseId,
      "evidence",
      "journey.failure-bundle_default",
      "artifact-index.json",
    );
    assert.equal(readFileSync(retained, "utf8"), "{\"schema\":\"retained\"}\n");
    assert(!readFileSync(path.join(store.dir, "results.ndjson"), "utf8").includes("retentionArtifacts"));
  } finally {
    rmSync(space, { recursive: true, force: true });
  }
});
