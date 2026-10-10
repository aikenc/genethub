import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { WorkflowRunStatus } from "@genehub/proto";
import { ProtocolError_ } from "@genehub/workbench/client";

export function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export function fileEquals(root: string, relative: string, expected: string): void {
  const full = path.join(root, relative);
  assert(existsSync(full), `missing file ${relative}`);
  assert(readFileSync(full, "utf8") === expected, `file ${relative} did not match`);
}

export async function expectProtocolCode(
  run: () => Promise<unknown>,
  code: string,
): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProtocolError_) {
      const actual = String(error.detail.code);
      assert(
        actual.toLowerCase() === code.toLowerCase() || error.message.toLowerCase().includes(code.toLowerCase()),
        `expected protocol ${code}, got ${actual}: ${error.message}`,
      );
      return error.message;
    }
    throw error;
  }
  throw new Error(`expected protocol ${code}, but the call succeeded`);
}

export function completedAfterToolResult(events: Array<{ type?: string }>): void {
  const types = events.map((event) => event.type ?? "");
  const tool = types.findIndex((type) => type.includes("tool"));
  const completed = types.findIndex((type) => type.includes("completed") || type.includes("turn.completed"));
  assert(tool >= 0, "no tool result in events");
  assert(completed > tool, "completion arrived before the tool result");
}

/**
 * The business Runs in a `workflow.history` page. A blocked Run may be handed
 * to the built-in recovery flow, a separate Run naming it in `handles`; that
 * Run is accounted for, not ignored: it must name a business Run on the same
 * page, and no business Run may be handled twice.
 */
export function businessRuns(runs: WorkflowRunStatus[]): WorkflowRunStatus[] {
  const business = runs.filter((run) => run.handles.length === 0);
  const ids = new Set(business.map((run) => run.id));
  const handled = new Map<string, string>();
  for (const run of runs) {
    for (const handle of run.handles) {
      assert(ids.has(handle.runId), `Run ${run.id} handles ${handle.runId}, which is no business Run here`);
      const earlier = handled.get(handle.runId);
      assert(earlier === undefined || earlier === run.id,
        `business Run ${handle.runId} is handled by both ${earlier} and ${run.id}`);
      handled.set(handle.runId, run.id);
    }
  }
  return business;
}

export const assertions: {
  assert: typeof assert;
  fileEquals: typeof fileEquals;
  completedAfterToolResult: typeof completedAfterToolResult;
  expectProtocolCode: typeof expectProtocolCode;
  businessRuns: typeof businessRuns;
} = {
  assert,
  fileEquals,
  completedAfterToolResult,
  expectProtocolCode,
  businessRuns,
};
