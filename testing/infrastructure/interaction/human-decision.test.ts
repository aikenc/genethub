import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listHumanDecisions,
  publishHumanDecisionRequest,
  readHumanDecisionResponse,
  recordHumanDecision,
  type HumanDecisionRequest,
} from "./human-decision.ts";

test("human decision requests expose only offered edges and persist one operator response", () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "genehub-human-decision-"));
  const previous = process.env.TESTCTL_INTERACTION_DIR;
  process.env.TESTCTL_INTERACTION_DIR = path.join(runDir, "interactions");
  try {
    const request: HumanDecisionRequest = {
      schema: "genehub.test-human-decision-request.v1",
      requestId: "run-1-revision-7",
      createdAt: "2026-08-30T00:00:00.000Z",
      caseId: "journey.pm-agent-mvp.test",
      projectWorkspaceId: "w_project",
      sessionId: "s_pm",
      workflowRunId: "run-s_pm",
      workflowRevision: 7,
      graphId: "feature",
      activeNodes: ["recover"],
      edges: [
        {
          id: "retry",
          label: "Retry",
          from: "recover",
          to: "implement",
          condition: '"decision.ready"',
        },
      ],
      evidence: {
        packages: [
          {
            id: "wp-failed",
            title: "Failed package",
            status: "blocked",
            agentSpace: "implementation-1",
            blockReason: "candidate tests failed",
          },
        ],
        quarantinedSpaces: [],
      },
    };

    publishHumanDecisionRequest(request);
    const pending = listHumanDecisions(runDir);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]?.request, request);
    assert.equal(pending[0]?.response, undefined);
    assert.throws(
      () => recordHumanDecision(runDir, request.requestId, "cancel"),
      /was not offered/,
    );
    const decided = recordHumanDecision(runDir, request.requestId, "retry");
    assert.equal(decided.response?.edgeId, "retry");
    assert.equal(readHumanDecisionResponse(request.requestId)?.edgeId, "retry");
    assert.equal(
      recordHumanDecision(runDir, request.requestId, "retry").response?.edgeId,
      "retry",
    );
    assert.throws(
      () => recordHumanDecision(runDir, request.requestId, "cancel"),
      /was not offered|already answered/,
    );
  } finally {
    if (previous === undefined) delete process.env.TESTCTL_INTERACTION_DIR;
    else process.env.TESTCTL_INTERACTION_DIR = previous;
    rmSync(runDir, { recursive: true, force: true });
  }
});
