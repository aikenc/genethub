import { writeFileSync } from "node:fs";
import path from "node:path";

/** Common on-disk package shapes, with scenario policy left in the case. */
export function writeWorkflowRole(source: string, file: string, role: { id: string; tags: string[]; userInteraction: string; prompt: string }): void {
  writeFileSync(path.join(source, "roles", file), JSON.stringify({ schema: "genehub.workflow.role.v3", ...role }));
}
export function writeWorkflowFlow(source: string, file: string, flow: Record<string, unknown>): void {
  writeFileSync(path.join(source, "flows", file), JSON.stringify({ schema: "genehub.workflow.definition.v2", version: 1, ...flow }));
}
export function workflowSequence(steps: { activity: string; accept?: string[] }[], id = "sequence-work") {
  return { body: { id, type: "sequence", steps: steps.map(step => ({ id: `step-${step.activity}`, type: "task", ...step })) } };
}
