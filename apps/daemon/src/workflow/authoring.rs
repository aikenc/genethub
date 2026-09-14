//! Read-only authoring facade over the production loader/compiler, not a second validator.
use super::*;
use genehub_proto::{
    WorkflowDiagnostic, WorkflowDraftEntry, WorkflowDraftExecution, WorkflowDraftReport,
};
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
        "capabilities": ["agent.session", "result.publish"],
        "verifiers": ["value.nonEmpty", "value.equals", "git.commitOnTarget"],
        "workerOutcomes": ["completed", "changesRequested", "failed", "blocked"],
        "referenceSyntax": "RFC 6901 JSON Pointer, not JSONPath or jq",
        "typeChecking": "known expression kinds at compile time; references and output values at runtime; no coercion",
        "outputObjects": "Prefer explicit required + additionalProperties:false. Omit both only for legacy all-required/closed shorthand.",
        "limits": {"sourceBytes": MAX_SOURCE_BYTES, "workflows": MAX_WORKFLOWS, "nodes": MAX_NODES},
        "scope": "Syntax schema is generated from the parser types. Compiler checks control flow, bounds and references; valid does not prove carrier readiness, actual check execution or business quality."
    });
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

/// One causal diagnostic per failing catalog entry (deduplicated), bounded at 64.
/// Positive metadata is derived ONLY from the final consistent compiled snapshot.
pub(super) fn check_draft(root: &Path) -> WorkflowDraftReport {
    let mut report = WorkflowDraftReport {
        schema: "genehub.workflow.draft-check.v1".into(),
        root: root.join(SOURCE_DIR).display().to_string(),
        valid: false,
        truncated: false,
        diagnostics: Vec::new(),
        candidate_digest: None,
        default_workflow: None,
        execution: None,
        workflows: Vec::new(),
    };
    let source = match source_root(root) {
        Ok(source) => source,
        Err(error) => {
            push(&mut report, diagnostic(PROJECT_FILE, &error));
            return report;
        }
    };
    report.root = source.display().to_string();
    let (_, catalog, _) = match load_project_files(&source) {
        Ok(files) => files,
        Err(error) => {
            push(&mut report, diagnostic(PROJECT_FILE, &error));
            return report;
        }
    };
    for entry in &catalog.workflows {
        if let Err(error) = load_bundle_from(&source, entry) {
            push(
                &mut report,
                diagnostic(&format!("workflows/{}", entry.path), &error),
            );
        }
    }
    if !report.diagnostics.is_empty() {
        return report;
    }
    match compile_candidate(&source) {
        Err(error) => push(&mut report, diagnostic(PROJECT_FILE, &error)),
        Ok(candidate) => {
            report.valid = true;
            report.candidate_digest = Some(candidate.digest);
            report.default_workflow = Some(candidate.project.default_workflow);
            report.execution = candidate.project.execution.map(|e| WorkflowDraftExecution {
                executor_path: e.executor_path,
                root: e.root,
            });
            report.workflows = candidate
                .catalog
                .workflows
                .iter()
                .map(|entry| WorkflowDraftEntry {
                    id: entry.id.clone(),
                    path: entry.path.clone(),
                    roles: candidate.workflows[&entry.id]
                        .roles
                        .keys()
                        .cloned()
                        .collect(),
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
