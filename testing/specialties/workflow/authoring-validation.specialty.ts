import { writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowDiagnostic, WorkflowDraftReport } from "@genehub/proto";
import { defineSpecialty, parseJson, runGenetAsync } from "../../framework/public.ts";

type CliEnvelope = {
  type?: string;
  data?: { definition?: Record<string, unknown>; draft?: WorkflowDraftReport };
  error?: {
    code?: string;
    details?: { draft?: WorkflowDraftReport };
  };
};

const validSource = `schema: genehub.workflow.definition.v2
id: direct-change
version: 2
nodes:
  - id: deliver
    uses: agent.session
    with:
      role: "worker"
    completion:
      output:
        type: object
        properties:
          decision:
            type: string
            enum: [go, noGo]
          rationale:
            type: string
            minLength: 1
        required: [decision]
        additionalProperties: false
structure:
  body:
    id: gate
    type: if
    condition:
      op: literal
      value: true
    then:
      id: deliver-step
      type: task
      activity: deliver
      input:
        op: object
        fields:
          goal:
            op: ref
            path: /input/prompt
`;

const sourceWithUnexpectedField = validSource.replace(
  "    uses: agent.session\n",
  "    uses: agent.session\n    unexpectedAgentOption: true\n",
);

const sourceWithWrongConditionType = validSource.replace(
  "      value: true\n",
  '      value: "true"\n',
);

function diagnosticFrom(envelope: CliEnvelope): WorkflowDiagnostic {
  const draft = envelope.error?.details?.draft;
  const diagnostic = draft?.diagnostics[0];
  if (!diagnostic) throw new Error(`missing draft diagnostic: ${JSON.stringify(envelope)}`);
  return diagnostic;
}

defineSpecialty(
  {
    id: "specialty.workflow.authoring-validation.contract",
    title: "Workflow authors receive one authoritative schema and actionable draft diagnostics",
    oracle:
      "The public CLI exposes the parser schema, validates only catalog-referenced source through the production compiler, returns file/path/type guidance, and does not activate or execute the draft",
    catches: [
      "documented schema command is rejected",
      "WM derives roles by scanning YAML text",
      "unknown YAML fields are silently ignored",
      "string booleans are coerced",
      "draft checking changes Active or launches a Run",
    ],
    tags: ["core", "workflow", "workflow-authoring"],
    llm: { default: "mock" },
    expectedDurationMs: 8_000,
    timeoutMs: 60_000,
    resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "genet-cli", "workbench-client", "git"],
    productInterfaces: [
      "genet schema workflow.definition",
      "genet workflow check --draft",
      "workflow.inspect",
      "workflow.history",
    ],
  },
  async (t) => {
    t.data.git.init(t.env.workspace);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const cli = async (args: string[]) =>
      runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    try {
      const initialized = await cli(["workflow", "init", "--agent", "genet"]);
      t.assertions.assert(initialized.code === 0, initialized.stderr || initialized.stdout);

      const schemaResult = await cli(["schema", "workflow.definition"]);
      t.assertions.assert(schemaResult.code === 0, schemaResult.stderr || schemaResult.stdout);
      const schemaEnvelope = parseJson(schemaResult.stdout) as CliEnvelope;
      const definitionSchema = schemaEnvelope.data?.definition;
      const extension = definitionSchema?.["x-genehub"] as Record<string, unknown> | undefined;
      t.assertions.assert(
        schemaEnvelope.type === "schema" &&
          definitionSchema?.["$schema"] === "https://json-schema.org/draft/2020-12/schema" &&
          extension?.validationCommand === "workflow check --draft" &&
          extension?.referenceSyntax === "RFC 6901 JSON Pointer, not JSONPath or jq",
        `definition schema is not the documented authoring contract: ${schemaResult.stdout}`,
      );

      const before = await opened.client.call({
        type: "workflow.inspect",
        payload: { workspaceId: opened.workspaceId },
      });
      if (before?.type !== "workflowProject") throw new Error("initial workflow inspection failed");
      const workflowFile = path.join(
        opened.workspaceRoot,
        ".genethub/workflow/workflows/direct-change.yaml",
      );
      writeFileSync(workflowFile, validSource);
      // An authoring tool must consume compiler metadata, not grep every YAML file in the directory.
      writeFileSync(
        path.join(opened.workspaceRoot, ".genethub/workflow/workflows/not-in-catalog.yaml"),
        "this: file is deliberately not a catalog entry\n",
      );

      const validResult = await cli(["workflow", "check", "--draft"]);
      t.assertions.assert(validResult.code === 0, validResult.stderr || validResult.stdout);
      const validEnvelope = parseJson(validResult.stdout) as CliEnvelope;
      const draft = validEnvelope.data?.draft;
      const afterValid = await opened.client.call({
        type: "workflow.inspect",
        payload: { workspaceId: opened.workspaceId },
      });
      t.assertions.assert(
        draft?.valid === true &&
          draft.diagnostics.length === 0 &&
          draft.defaultWorkflow === "direct-change" &&
          draft.workflows.length === 1 &&
          draft.workflows[0]?.path === "direct-change.yaml" &&
          JSON.stringify(draft.workflows[0]?.roles) === JSON.stringify(["worker"]) &&
          afterValid?.type === "workflowProject" &&
          draft.candidateDigest === afterValid.data.candidateDigest &&
          afterValid.data.activeDigest === before.data.activeDigest &&
          afterValid.data.activationRevision === before.data.activationRevision,
        `valid draft metadata or non-mutation contract failed: ${JSON.stringify({ draft, before, afterValid })}`,
      );

      writeFileSync(workflowFile, sourceWithUnexpectedField);
      const parseFailure = await cli(["workflow", "check", "--draft"]);
      const parseEnvelope = parseJson(parseFailure.stdout) as CliEnvelope;
      const parseDiagnostic = diagnosticFrom(parseEnvelope);
      t.assertions.assert(
        parseFailure.code !== 0 &&
          parseEnvelope.error?.code === "workflowValidationFailed" &&
          parseDiagnostic.phase === "parse" &&
          parseDiagnostic.code === "WF_SOURCE_PARSE" &&
          parseDiagnostic.file === "workflows/direct-change.yaml" &&
          parseDiagnostic.path.startsWith("/nodes/0") &&
          parseDiagnostic.line !== null &&
          parseDiagnostic.column !== null &&
          parseDiagnostic.hint.includes("schema workflow.definition"),
        `parse diagnostic is not actionable: ${parseFailure.stdout}`,
      );

      writeFileSync(workflowFile, sourceWithWrongConditionType);
      const typeFailure = await cli(["workflow", "check", "--draft"]);
      const typeEnvelope = parseJson(typeFailure.stdout) as CliEnvelope;
      const typeDiagnostic = diagnosticFrom(typeEnvelope);
      t.assertions.assert(
        typeFailure.code !== 0 &&
          typeEnvelope.error?.code === "workflowValidationFailed" &&
          typeDiagnostic.phase === "compile" &&
          typeDiagnostic.code === "WF_EXPRESSION_TYPE" &&
          typeDiagnostic.path === "/structure/body/condition" &&
          typeDiagnostic.expected === "boolean" &&
          typeDiagnostic.actual === "string" &&
          typeDiagnostic.hint.includes("not coerced"),
        `type diagnostic is not actionable: ${typeFailure.stdout}`,
      );

      const afterFailure = await opened.client.call({
        type: "workflow.inspect",
        payload: { workspaceId: opened.workspaceId },
      });
      const history = await opened.client.call({
        type: "workflow.history",
        payload: { workspaceId: opened.workspaceId, limit: 10 },
      });
      t.assertions.assert(
        afterFailure?.type === "workflowProject" &&
          afterFailure.data.activeDigest === before.data.activeDigest &&
          afterFailure.data.activationRevision === before.data.activationRevision &&
          history?.type === "workflowRuns" &&
          history.data.length === 0,
        "draft validation changed Active or launched a Run",
      );
    } finally {
      opened.client.close();
      await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
      await opened.mock.stop();
    }
  },
);
