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
  throw new Error(`human decision ${request.requestId} was not answered before the journey deadline`);
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
