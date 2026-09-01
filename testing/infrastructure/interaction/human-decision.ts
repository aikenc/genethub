import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const REQUEST_SUFFIX = ".request.json";
const RESPONSE_SUFFIX = ".response.json";

export interface HumanDecisionEdge {
  id: string;
  label?: string;
  description?: string;
  from: string;
  to: string;
  condition: string;
}

export interface HumanDecisionRequest {
  schema: "genehub.test-human-decision-request.v1";
  requestId: string;
  createdAt: string;
  responseDeadlineAt?: string;
  runDeadlineAt?: string;
  caseId: string;
  projectWorkspaceId: string;
  sessionId: string;
  workflowRunId: string;
  workflowRevision: number;
  graphId?: string;
  activeNodes: string[];
  edges: HumanDecisionEdge[];
  evidence: {
    packages: Array<{
      id: string;
      title: string;
      status: string;
      agentSpace: string;
      workSessionId?: string;
      candidateCommit?: string;
      candidateTree?: string;
      reviewSessionId?: string;
      blockReason?: string;
      reviewVerdict?: string;
      reviewFindings?: Array<{
        severity: string;
        title: string;
        acceptanceImpact: string;
        recommendedAction: string;
        estimatedRequests?: number;
      }>;
    }>;
    quarantinedSpaces: Array<{ name: string; purpose: string; resourceState: string }>;
  };
}

export interface HumanDecisionResponse {
  schema: "genehub.test-human-decision-response.v1";
  requestId: string;
  edgeId: string;
  decidedAt: string;
  decidedBy: "test-operator";
}

export interface HumanDecisionRecord {
  request: HumanDecisionRequest;
  response?: HumanDecisionResponse;
}

export interface HumanDecisionRunState {
  id: string;
  revision: number;
  nodeInstances: Array<{
    id: string;
    nodeId: string;
    status: string;
  }>;
  availableEdges: Array<{
    id: string;
    from: string;
    to: string;
    chooseBy?: string;
    satisfied: boolean;
  }>;
}

function validateRequestId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new Error("human decision request id must be a safe 1-200 character identifier");
  }
}

function interactionDir(runDir: string): string {
  return path.join(path.resolve(runDir), "interactions");
}

function requestPath(dir: string, requestId: string): string {
  validateRequestId(requestId);
  return path.join(dir, `${requestId}${REQUEST_SUFFIX}`);
}

function responsePath(dir: string, requestId: string): string {
  validateRequestId(requestId);
  return path.join(dir, `${requestId}${RESPONSE_SUFFIX}`);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function writeJsonAtomically(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, file);
}

function validateRequest(request: HumanDecisionRequest): void {
  validateRequestId(request.requestId);
  if (request.schema !== "genehub.test-human-decision-request.v1") {
    throw new Error("unsupported human decision request schema");
  }
  if (request.edges.length === 0) {
    throw new Error("human decision request must expose at least one eligible edge");
  }
  const ids = new Set(request.edges.map((edge) => edge.id));
  if (ids.size !== request.edges.length) {
    throw new Error("human decision request edge ids must be unique");
  }
  const responseDeadline = request.responseDeadlineAt
    ? Date.parse(request.responseDeadlineAt)
    : undefined;
  const runDeadline = request.runDeadlineAt ? Date.parse(request.runDeadlineAt) : undefined;
  if (responseDeadline !== undefined && !Number.isFinite(responseDeadline)) {
    throw new Error("human decision response deadline must be RFC3339");
  }
  if (runDeadline !== undefined && !Number.isFinite(runDeadline)) {
    throw new Error("human decision Run deadline must be RFC3339");
  }
  if (
    responseDeadline !== undefined &&
    runDeadline !== undefined &&
    responseDeadline > runDeadline
  ) {
    throw new Error("human decision response deadline cannot exceed its Run deadline");
  }
}

/**
 * Carves a bounded operator response window out of an existing hard Run
 * deadline. It never extends that deadline and returns undefined when there is
 * not enough time left for both a response and post-decision execution.
 */
export function humanDecisionResponseDeadline(input: {
  nowMs: number;
  runDeadlineMs: number;
  responseBudgetMs: number;
  postDecisionReserveMs: number;
}): number | undefined {
  if (
    !Number.isFinite(input.nowMs) ||
    !Number.isFinite(input.runDeadlineMs) ||
    !Number.isFinite(input.responseBudgetMs) ||
    !Number.isFinite(input.postDecisionReserveMs) ||
    input.responseBudgetMs <= 0 ||
    input.postDecisionReserveMs < 0
  ) {
    throw new Error("human decision budgets must be finite and non-negative");
  }
  const deadline = Math.min(
    input.nowMs + input.responseBudgetMs,
    input.runDeadlineMs - input.postDecisionReserveMs,
  );
  return deadline > input.nowMs ? deadline : undefined;
}

/**
 * A Run revision also changes for orthogonal observations such as request
 * budget accounting. A pending operator choice is stale only when its exact
 * user edge or the source node instance that offered it has changed.
 */
export function humanDecisionStillApplicable(
  requested: HumanDecisionRunState,
  current: HumanDecisionRunState | undefined,
  edgeId: string,
): boolean {
  if (!current || current.id !== requested.id) return false;
  const offered = requested.availableEdges.find(
    (edge) => edge.id === edgeId && edge.chooseBy === "user" && edge.satisfied,
  );
  const eligible = current.availableEdges.find(
    (edge) => edge.id === edgeId && edge.chooseBy === "user" && edge.satisfied,
  );
  if (!offered || !eligible || offered.from !== eligible.from || offered.to !== eligible.to) {
    return false;
  }
  const requestedSources = requested.nodeInstances
    .filter((instance) => instance.nodeId === offered.from && instance.status === "active")
    .map((instance) => instance.id)
    .sort();
  const currentSources = current.nodeInstances
    .filter((instance) => instance.nodeId === eligible.from && instance.status === "active")
    .map((instance) => instance.id)
    .sort();
  return (
    requestedSources.length > 0 &&
    requestedSources.length === currentSources.length &&
    requestedSources.every((id, index) => id === currentSources[index])
  );
}

function validateResponse(response: HumanDecisionResponse, requestId: string): void {
  if (
    response.schema !== "genehub.test-human-decision-response.v1" ||
    response.requestId !== requestId ||
    response.decidedBy !== "test-operator"
  ) {
    throw new Error(`invalid human decision response for ${requestId}`);
  }
}

export function publishHumanDecisionRequest(request: HumanDecisionRequest): string {
  validateRequest(request);
  const dir = process.env.TESTCTL_INTERACTION_DIR;
  if (!dir) {
    throw new Error("TESTCTL_INTERACTION_DIR is required for an interactive real journey");
  }
  mkdirSync(dir, { recursive: true });
  const file = requestPath(dir, request.requestId);
  if (existsSync(file)) {
    const existing = readJson<HumanDecisionRequest>(file);
    if (JSON.stringify(existing) !== JSON.stringify(request)) {
      throw new Error(`human decision request ${request.requestId} changed after publication`);
    }
    return file;
  }
  writeJsonAtomically(file, request);
  return file;
}

export function readHumanDecisionResponse(requestId: string): HumanDecisionResponse | undefined {
  const dir = process.env.TESTCTL_INTERACTION_DIR;
  if (!dir) return undefined;
  const file = responsePath(dir, requestId);
  if (!existsSync(file)) return undefined;
  const response = readJson<HumanDecisionResponse>(file);
  validateResponse(response, requestId);
  return response;
}

export async function awaitHumanDecision(
  request: HumanDecisionRequest,
  deadlineMs: number,
): Promise<HumanDecisionResponse> {
  publishHumanDecisionRequest(request);
  while (Date.now() < deadlineMs) {
    const response = readHumanDecisionResponse(request.requestId);
    if (response) {
      if (!request.edges.some((edge) => edge.id === response.edgeId)) {
        throw new Error(
          `human decision ${response.edgeId} was not offered by request ${request.requestId}`,
        );
      }
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `human decision ${request.requestId} was not answered before its operator response deadline`,
  );
}

export function listHumanDecisions(runDir: string): HumanDecisionRecord[] {
  const dir = interactionDir(runDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(REQUEST_SUFFIX))
    .sort()
    .map((name) => {
      const request = readJson<HumanDecisionRequest>(path.join(dir, name));
      validateRequest(request);
      const responseFile = responsePath(dir, request.requestId);
      const response = existsSync(responseFile)
        ? readJson<HumanDecisionResponse>(responseFile)
        : undefined;
      if (response) validateResponse(response, request.requestId);
      return {
        request,
        response,
      };
    });
}

export function recordHumanDecision(
  runDir: string,
  requestId: string,
  edgeId: string,
): HumanDecisionRecord {
  const dir = interactionDir(runDir);
  const requestFile = requestPath(dir, requestId);
  if (!existsSync(requestFile)) {
    throw new Error(`no pending human decision request ${requestId}`);
  }
  const request = readJson<HumanDecisionRequest>(requestFile);
  validateRequest(request);
  if (!request.edges.some((edge) => edge.id === edgeId)) {
    throw new Error(`edge ${edgeId} was not offered by request ${requestId}`);
  }
  const file = responsePath(dir, requestId);
  if (existsSync(file)) {
    const response = readJson<HumanDecisionResponse>(file);
    validateResponse(response, requestId);
    if (response.edgeId !== edgeId) {
      throw new Error(`human decision ${requestId} was already answered with ${response.edgeId}`);
    }
    return { request, response };
  }
  const response: HumanDecisionResponse = {
    schema: "genehub.test-human-decision-response.v1",
    requestId,
    edgeId,
    decidedAt: new Date().toISOString(),
    decidedBy: "test-operator",
  };
  mkdirSync(dir, { recursive: true });
  writeJsonAtomically(file, response);
  return { request, response };
}
