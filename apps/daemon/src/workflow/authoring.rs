//! Read-only authoring facade over the production loader/compiler, not a second validator.
use super::*;
use genehub_proto::{WorkflowDiagnostic, WorkflowDraftEntry, WorkflowDraftReport};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

pub(crate) fn schema() -> Value {
    let mut schema = serde_json::to_value(
        schemars::generate::SchemaSettings::draft2020_12()
            .for_deserialize()
            .into_generator()
            .into_root_schema_for::<WorkflowDefinition>(),
    )
    .expect("schema serializes");
    schema["$id"] = json!("urn:genehub:workflow:definition:authoring:v1");
    schema["properties"]["schema"] =
        json!({"enum": [DEFINITION_SCHEMA, "genehub.workflow.definition.v2"]});
    schema["properties"]["version"]["minimum"] = json!(1);
    schema["properties"]["nodes"]["minItems"] = json!(1);
    schema["properties"]["nodes"]["maxItems"] = json!(MAX_NODES);
    schema["x-genehub"] = json!({
        "dialect": "genehub.workflow.definition.v2", "legacyDialect": DEFINITION_SCHEMA,
        "validationCommand": "workflow check --draft", "maxDiagnostics": 64,
        "capabilities": ["agent.session", "result.publish", "request.budget"],
        "role": {
            "schema": ROLE_SCHEMA,
            "binding": "built-in tags only",
            "tags": ["Max", "Pro", "Flush", "视频理解", "图片理解"],
            "resolution": "At each dispatch, freshly read machine-global costs and choose the lowest-cost available Agent + model matching every tag; block for human action when none are usable.",
            "forbiddenExactFields": ["agentId", "modelId", "modeId", "runtimeValues"],
            "legacyReadOnlySchema": LEGACY_ROLE_SCHEMA,
        },
        "requestBudget": {
            "inputs": "none; current Run's shared request only",
            "output": ["requestRunId", "observedAtMs", "budget", "usedRuns", "observedLlmRounds", "executionMs", "remainingRuns", "remainingLlmRounds", "remainingExecutionMs"],
            "budget": ["revision", "maxRuns", "deadlineMs", "maxLlmRounds"],
            "semantics": "Immutable observation, not reservation or permission. Query again to observe changes. Only PM control can adjust limits."
        },
        "include": {
            "file": "procedures/<id>.yaml beside the package's flows/, schema genehub.workflow.procedures.v1",
            "resolution": "Merged into this definition while loading, before any validation; the pinned program is identical to the same content written inline.",
            "rules": ["library declares procedures plus the nodes they use, no entry and no include of its own", "procedure names, node IDs and block IDs must not collide with the including Workflow or another library", "call a merged procedure with {type:call, procedure:<name>}"],
            "limits": {"includes": MAX_INCLUDES},
        },
        "entries": "{op:entries,value:<object expression>} returns at most 4096 {key,value} pairs in ascending key order; use serial forEach initial/update to aggregate parallel results",
        // Derived from the registry so the contract cannot drift from what
        // the daemon will actually accept.
        "verifiers": super::VERIFIERS.iter().map(|entry| serde_json::json!({
            "id": entry.id,
            "expected": if entry.expects_value { "required" } else { "not accepted" },
        })).collect::<Vec<_>>(),
        "workerOutcomes": {
            "builtin": ["completed", "changesRequested", "failed", "blocked"],
            "custom": "declare in this Workflow's outcomes map (name -> {success: bool}); on edges and structured accept lists may use any declared name, and only agent.session may emit non-completed outcomes; the kernel consumes just the success bit",
        },
        "referenceSyntax": "RFC 6901 JSON Pointer, not JSONPath or jq",
        "typeChecking": "known expression kinds at compile time; references and output values at runtime; no coercion",
        "outputObjects": "Prefer explicit required + additionalProperties:false. Omit both only for legacy all-required/closed shorthand.",
        "limits": {"sourceBytes": MAX_SOURCE_BYTES, "workflows": MAX_WORKFLOWS, "nodes": MAX_NODES, "includes": MAX_INCLUDES, "outcomes": MAX_OUTCOMES},
        "scope": "Syntax schema is generated from the parser types. Compiler checks control flow, bounds and references; valid does not prove carrier readiness, actual check execution or business quality."
    });
    schema
}

/// Same generator as the definition schema: a library is a fragment of the one
/// dialect, not a second one.
pub(crate) fn procedures_schema() -> Value {
    let mut schema = serde_json::to_value(
        schemars::generate::SchemaSettings::draft2020_12()
            .for_deserialize()
            .into_generator()
            .into_root_schema_for::<ProcedureLibrary>(),
    )
    .expect("schema serializes");
    schema["$id"] = json!("urn:genehub:workflow:procedures:authoring:v1");
    schema["properties"]["schema"] = json!({"const": PROCEDURES_SCHEMA});
    schema["properties"]["version"]["minimum"] = json!(1);
    schema["properties"]["nodes"]["maxItems"] = json!(MAX_NODES);
    schema
}

#[derive(Debug)]
struct SourceError(WorkflowDiagnostic);
impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {}{}: {}. {}",
            self.0.code, self.0.file, self.0.path, self.0.message, self.0.hint
        )
    }
}
impl std::error::Error for SourceError {}

pub(super) fn definition_error(
    code: &str,
    path: &str,
    message: String,
    hint: &str,
) -> anyhow::Error {
    workflow_engine::Error::Invalid(Box::new(workflow_engine::Diagnostic {
        code: code.into(),
        path: path.into(),
        message,
        hint: hint.into(),
        expected: None,
        actual: None,
    }))
    .into()
}

/// Used by normal dispatch/activation too. Invalid YAML cannot bypass this path.
pub(super) fn parse<T: DeserializeOwned>(bytes: &[u8], file: &str) -> Result<T> {
    serde_path_to_error::deserialize(serde_yaml::Deserializer::from_slice(bytes)).map_err(|error| {
        let mut path = String::new();
        for segment in error.path().iter() {
            use serde_path_to_error::Segment;
            match segment {
                Segment::Seq { index } => path.push_str(&format!("/{index}")),
                Segment::Map { key } => path.push_str(&format!("/{}", workflow_engine::pointer_token(key))),
                // Enum variant names are not fields in internally tagged YAML.
                Segment::Enum { .. } | Segment::Unknown => {}
            }
        }
        let location = error.inner().location();
        SourceError(WorkflowDiagnostic {
            phase: "parse".into(), code: "WF_SOURCE_PARSE".into(), severity: "error".into(),
            file: file.into(), path, message: error.inner().to_string(),
            hint: "Correct the YAML field/type at this location; use `schema workflow.definition` for supported syntax. Unknown fields are errors, not ignored options.".into(),
            expected: None, actual: None,
            line: location.as_ref().map(|l| l.line() as u32), column: location.as_ref().map(|l| l.column() as u32),
        }).into()
    })
}

fn diagnostic(file: &str, error: &anyhow::Error) -> WorkflowDiagnostic {
    if let Some(source) = error.downcast_ref::<SourceError>() {
        return source.0.clone();
    }
    if let Some(workflow_engine::Error::Invalid(d)) = error.downcast_ref::<workflow_engine::Error>()
    {
        return WorkflowDiagnostic {
            phase: "compile".into(),
            code: d.code.clone(),
            severity: "error".into(),
            file: file.into(),
            path: format!("/structure{}", d.path),
            message: d.message.clone(),
            hint: d.hint.clone(),
            expected: d.expected.clone(),
            actual: d.actual.clone(),
            line: None,
            column: None,
        };
    }
    WorkflowDiagnostic {
        phase: "compile".into(), code: "WF_SOURCE_INVALID".into(), severity: "error".into(),
        file: file.into(), path: "".into(), message: format!("{error:#}"),
        hint: "Fix this source/dependency using the reported constraint, then rerun `workflow check --draft`. Do not activate a stale Candidate or weaken budgets/permissions to bypass validation.".into(),
        expected: None, actual: None, line: None, column: None,
    }
}

/// One causal diagnostic per failing flow (deduplicated), bounded at 64.
/// Positive metadata is derived ONLY from the final consistent compiled snapshot.
pub(super) fn check_draft(
    root: &Path,
    package_id: Option<&str>,
    registry: &crate::adapter::registry::Registry,
) -> WorkflowDraftReport {
    let mut report = WorkflowDraftReport {
        schema: "genehub.workflow.draft-check.v1".into(),
        root: package::packages_root(root).display().to_string(),
        valid: false,
        truncated: false,
        diagnostics: Vec::new(),
        candidate_digest: None,
        package_id: None,
        executor_path: None,
        workflows: Vec::new(),
    };
    let package_id = match super::resolve_package_id(root, package_id) {
        Ok(id) => id,
        Err(error) => {
            push(&mut report, diagnostic(package::MANIFEST_FILE, &error));
            return report;
        }
    };
    let package = match package::load(root, &package_id) {
        Ok(package) => package,
        Err(error) => {
            push(&mut report, diagnostic(package::MANIFEST_FILE, &error));
            return report;
        }
    };
    report.root = package.root.display().to_string();
    report.package_id = Some(package_id);
    // Per-flow diagnostics first: one broken flow should name itself rather
    // than surfacing as a single opaque package-level compile failure.
    for flow_id in &package.flow_ids {
        if let Err(error) = load_bundle_from(&package.root, flow_id) {
            push(
                &mut report,
                diagnostic(&format!("flows/{flow_id}.yaml"), &error),
            );
        }
    }
    if !report.diagnostics.is_empty() {
        return report;
    }
    match compile_candidate(&package) {
        Err(error) => push(&mut report, diagnostic(package::MANIFEST_FILE, &error)),
        Ok(candidate) => {
            for role in candidate
                .workflows
                .values()
                .flat_map(|bundle| bundle.roles.values())
            {
                // Legacy role.v1 pins an exact adapter, so draft checking can
                // still prove its evidence boundary. Current roles resolve a
                // live tag route only when dispatched and filter every
                // candidate by this same requirement then.
                if role.evidence_only && role.schema == LEGACY_ROLE_SCHEMA {
                    let agent_id = role.agent_id.as_deref().unwrap_or_default();
                    if let Err(error) = registry.require_evidence_scope(agent_id) {
                        push(&mut report, WorkflowDiagnostic {
                            phase: "capability".into(), code: "WF_ROLE_CAPABILITY".into(), severity: "error".into(),
                            file: format!("roles/{}.yaml", role.id), path: "/agentId".into(),
                            message: format!("{error:#}"),
                            hint: "Choose an Agent supporting evidenceOnly and a compatible model, then rerun `workflow check --draft`. Read-only interaction or a prompt alone cannot enforce the evidence boundary.".into(),
                            expected: Some("adapter with bounded read-only evidence scope".into()), actual: Some(agent_id.chars().take(256).collect()),
                            line: None, column: None,
                        });
                    }
                }
            }
            if !report.diagnostics.is_empty() {
                return report;
            }
            report.valid = true;
            report.candidate_digest = Some(candidate.digest);
            report.executor_path = candidate.package.executor_path;
            report.workflows = candidate
                .workflows
                .iter()
                .map(|(id, bundle)| WorkflowDraftEntry {
                    id: id.clone(),
                    path: format!("flows/{id}.yaml"),
                    roles: bundle.roles.keys().cloned().collect(),
                })
                .collect();
        }
    }
    report
}

fn push(report: &mut WorkflowDraftReport, mut diagnostic: WorkflowDiagnostic) {
    diagnostic.message = diagnostic.message.chars().take(2048).collect();
    if report.diagnostics.contains(&diagnostic) {
        return;
    }
    if report.diagnostics.len() == 64 {
        report.truncated = true;
        return;
    }
    report.diagnostics.push(diagnostic);
}
