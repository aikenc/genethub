//! Restricted analysis tools: no shell, file mutation, or arbitrary CLI command.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use super::{ToolResult, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct Scope {
    root: PathBuf,
    sessions: BTreeMap<String, Option<String>>,
}

pub fn enabled() -> bool {
    std::env::var_os("GENEHUB_EVIDENCE_SCOPE").is_some()
}

fn scope() -> Result<Scope, String> {
    serde_json::from_str(&std::env::var("GENEHUB_EVIDENCE_SCOPE").map_err(|e| e.to_string())?)
        .map_err(|e| format!("invalid evidence scope: {e}"))
}

pub fn definition() -> Value {
    json!({
        "name": "genet",
        "description": "Read bounded GeneHub session evidence or current project workflow facts, and submit your own managed completion report. Pass argv directly, without a shell or executable. Session reads automatically use the granted historical boundary. Supported: session inspect/context/narrative/rounds/flow, workflow get/history/complete, capabilities and schema. Other commands and target overrides are denied.",
        "parameters": {"type":"object", "properties":{"args":{"type":"array","items":{"type":"string"}}},"required":["args"]}
    })
}

pub fn check_path(args: &Value, cwd: &Path) -> Result<(), String> {
    let scope = scope()?;
    let requested = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let path = super::resolve_path(cwd, requested)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = scope.root.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&root) {
        return Err("evidence file is outside the granted project".into());
    }
    // Agent-private storage is not a deliverable; use the bounded session API.
    let parts = path
        .strip_prefix(&root)
        .unwrap()
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if parts.iter().any(|part| part == ".git")
        || parts.windows(2).any(|parts| {
            parts[0] == ".genethub" && matches!(parts[1].as_str(), "sessions" | "components")
        })
    {
        return Err("read private session/runtime evidence through genet instead".into());
    }
    Ok(())
}

pub async fn run(args: &Value, cwd: &Path) -> ToolResult {
    match run_inner(args, cwd).await {
        Ok(value) => value,
        Err(error) => ToolResult::error(error),
    }
}

async fn run_inner(args: &Value, cwd: &Path) -> Result<ToolResult, String> {
    let scope = scope()?;
    let mut argv: Vec<String> =
        serde_json::from_value(args.get("args").cloned().unwrap_or(Value::Null))
            .map_err(|_| "genet requires a string args array".to_string())?;
    if argv.len() > 40
        || argv
            .iter()
            .any(|arg| arg.len() > 64 * 1024 || arg.contains('\0'))
    {
        return Err("evidence command exceeds its argument budget".into());
    }
    let mut boundary = None;
    let (start, flags): (usize, &[&str]) = match argv.first().map(String::as_str) {
        Some("capabilities") if argv.len() == 1 => (1, &[]),
        Some("schema") if argv.len() == 2 && !argv[1].starts_with('-') => (2, &[]),
        Some("session") if argv.len() >= 3 => {
            let round = scope
                .sessions
                .get(&argv[2])
                .ok_or("Session is outside the granted evidence set")?;
            match argv[1].as_str() {
                "inspect" | "context" | "narrative" | "rounds" => {
                    boundary = Some(
                        round
                            .clone()
                            .ok_or("Session has no bounded evidence; report unavailable")?,
                    );
                    (3, &["--budget-tokens", "--limit", "--cursor", "--item"])
                }
                "flow" => (3, &[]),
                _ => {
                    return Err("session command is not available to evidence-only analysis".into())
                }
            }
        }
        Some("workflow") if argv.len() >= 2 => match argv[1].as_str() {
            "get" => (2, &[]),
            "history" => (2, &["--limit"]),
            "complete" => (2, &["--revision", "--evidence"]),
            _ => return Err("workflow mutation is not available to evidence-only analysis".into()),
        },
        _ => return Err("command is not available to evidence-only analysis".into()),
    };
    let rest = &argv[start..];
    if rest.len() % 2 != 0
        || rest
            .chunks(2)
            .any(|pair| !flags.contains(&pair[0].as_str()) || pair[1].starts_with('-'))
    {
        return Err("unsupported evidence command arguments or target override".into());
    }
    if let Some(round) = boundary {
        argv.extend(["--through-round".into(), round]);
    }
    let cli = std::env::var("GENEHUB_CLI").map_err(|_| "GENEHUB_CLI is unavailable")?;
    if !Path::new(&cli).is_absolute() {
        return Err("GENEHUB_CLI is not an absolute path".into());
    }
    let mut command = crate::os_process::Command::new(cli);
    command
        .args(&argv)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "evidence command timed out")?
        .map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let truncated = super::truncate_head(&text, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
    let result = if output.status.success() {
        ToolResult::ok(truncated.content.clone())
    } else {
        ToolResult::error(truncated.content.clone())
    };
    Ok(result.with_truncation(&truncated))
}
