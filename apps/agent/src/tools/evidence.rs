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
        "description": "Read bounded GeneHub session evidence or current project workflow facts, and submit your own managed completion report. Pass argv directly, without a shell or executable. Session reads automatically use the granted historical boundary. Supported: session inspect/context/narrative/rounds/flow, workflow get/history/check/complete, capabilities and schema. Other commands and target overrides are denied.",
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
        // WASI canonicalization does not promise the on-disk casing. Reserve
        // private names case-insensitively on every host; do not lowercase the
        // scope containment comparison (Unix paths remain case-sensitive).
        .map(|part| part.as_os_str().to_string_lossy().to_ascii_lowercase())
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
    // Headroom for the largest payload the CLI itself accepts (`--output`,
    // 256 KiB). A tighter budget here would refuse submissions the contract
    // asks a reviewer to make.
    if argv.len() > 40
        || argv
            .iter()
            .any(|arg| arg.len() > 256 * 1024 || arg.contains('\0'))
    {
        return Err("evidence command exceeds its argument budget".into());
    }
    let mut boundary = None;
    let start: usize = match argv.first().map(String::as_str) {
        Some("capabilities") if argv.len() == 1 => 1,
        Some("schema") if argv.len() == 2 && !argv[1].starts_with('-') => 2,
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
                    3
                }
                "flow" => 3,
                _ => {
                    return Err("session command is not available to evidence-only analysis".into())
                }
            }
        }
        Some("workflow") if argv.len() >= 2 => match argv[1].as_str() {
            "get" | "check" | "history" | "complete" => 2,
            _ => return Err("workflow mutation is not available to evidence-only analysis".into()),
        },
        _ => return Err("command is not available to evidence-only analysis".into()),
    };
    // Only the target and the granted boundary are this tool's to enforce.
    // Which options a reachable command takes is the CLI's own contract: it
    // rejects unknown options, malformed JSON and oversized payloads itself,
    // and the daemon independently authorises every mutation against the
    // calling managed Session. Re-declaring the option set here drifted from
    // that contract and silently refused legitimate submissions, so the
    // allowlist covers commands, not argument shapes.
    if let Some(flag) = argv[start..]
        .iter()
        .find(|arg| matches!(arg.as_str(), "--workspace" | "--through-round"))
    {
        return Err(format!(
            "evidence commands cannot redirect their target or boundary: {flag}"
        ));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises the tests that share the process-wide scope variable.
    static SCOPE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_scope<T>(scope: &str, body: impl FnOnce() -> T) -> T {
        let guard = SCOPE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("GENEHUB_EVIDENCE_SCOPE", scope);
        let result = body();
        std::env::remove_var("GENEHUB_EVIDENCE_SCOPE");
        drop(guard);
        result
    }

    fn refusal(argv: &[&str]) -> Option<String> {
        with_scope(r#"{"root":"/tmp","sessions":{"s_1":"r_9"}}"#, || {
            let args = json!({"args": argv});
            // Only the pre-spawn validation is under test; reaching the CLI
            // means the arguments were accepted.
            std::env::remove_var("GENEHUB_CLI");
            let runtime = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            match runtime.block_on(run_inner(&args, Path::new("/tmp"))) {
                Err(error) if error == "GENEHUB_CLI is unavailable" => None,
                Err(error) => Some(error),
                Ok(_) => None,
            }
        })
    }

    #[test]
    fn a_structured_completion_report_is_accepted() {
        // The role contract requires `--output <JSON>`; an allowlist that
        // omitted it forced reviewers to downgrade to a negative outcome.
        assert_eq!(
            refusal(&[
                "workflow",
                "complete",
                "--revision",
                "7",
                "--evidence",
                "checks=four actions reviewed",
                "--output",
                r#"{"verdict":"pass","observed":"spin: T-pose at 1.03s"}"#,
            ]),
            None
        );
    }

    #[test]
    fn options_the_cli_owns_are_not_second_guessed() {
        // `--node`/`--run` disambiguate the caller's own node, and `--draft`
        // is a flag with no value: the old pair-shaped allowlist refused both.
        assert_eq!(
            refusal(&["workflow", "complete", "--node", "review", "--run", "wr_1"]),
            None
        );
        assert_eq!(refusal(&["workflow", "check", "--draft"]), None);
    }

    #[test]
    fn unreachable_commands_are_still_refused() {
        assert!(refusal(&["workflow", "dispatch", "--run", "wr_1"]).is_some());
        assert!(refusal(&["session", "send", "s_1", "hello"]).is_some());
        assert!(refusal(&["bash", "-c", "echo"]).is_some());
    }

    #[test]
    fn the_granted_session_boundary_still_holds() {
        assert_eq!(
            refusal(&["session", "inspect", "s_other"]).as_deref(),
            Some("Session is outside the granted evidence set")
        );
        let redirect = refusal(&["workflow", "get", "--workspace", "w_other"]);
        assert!(
            redirect.is_some_and(|error| error.contains("cannot redirect")),
            "a target override must stay refused"
        );
        let boundary = refusal(&["session", "narrative", "s_1", "--through-round", "r_1"]);
        assert!(
            boundary.is_some_and(|error| error.contains("cannot redirect")),
            "the granted boundary must not be overridable"
        );
    }
}
