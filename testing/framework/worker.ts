import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { BlockedError, UnstableError, getRegisteredCase, type CaseStatus, type UnitResult } from "../infrastructure/public.ts";
import { createCaseContext } from "./context.ts";

const startedAt = new Date().toISOString();
const startedMs = Date.now();

function finish(status: CaseStatus, message?: string, blockedReason?: string): void {
  const result: UnitResult = {
    id: process.env.TESTCTL_UNIT_ID ?? "unknown",
    caseId: process.env.TESTCTL_CASE_ID ?? "unknown",
    variant: process.env.TESTCTL_VARIANT ?? "default",
    status,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    message,
    blockedReason,
  };
  const out = process.env.TESTCTL_RESULT_PATH;
  if (!out) {
    console.log(JSON.stringify(result));
    return;
  }
  writeFileSync(out, `${JSON.stringify(result)}\n`);
}

const file = process.env.TESTCTL_CASE_FILE;
const caseId = process.env.TESTCTL_CASE_ID;
if (!file || !caseId) {
  finish("blocked", "worker missing case identity", "missing worker environment");
  process.exit(2);
}

try {
  await import(pathToFileURL(file).href);
  const definition = getRegisteredCase(caseId);
  if (!definition) {
    finish("blocked", `case ${caseId} was not registered by ${file}`, "case not registered");
    process.exit(2);
  }
  if (definition.requiredArtifacts?.includes("missing-on-purpose")) {
    finish("blocked", "required artifact is missing", "required artifact missing");
    process.exit(0);
  }
  const ctx = await createCaseContext(definition);
  try {
    await definition.run(ctx);
    finish("passed", ctx.takeNote());
  } finally {
    await ctx.dispose();
  }
} catch (error) {
  if (error instanceof BlockedError) {
    finish("blocked", error.message, error.blockedReason);
    process.exit(0);
  }
  if (error instanceof UnstableError) {
    finish("unstable", error.message);
    process.exit(0);
  }
  finish("failed", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
