//! A typed, shell-free fast path for the GeneHub front-door CLI.
//!
//! This does not grant an Agent a new capability: the same process already has
//! `bash` and the same `GENEHUB_CLI` binding.  It removes quoting and discovery
//! overhead while preserving the CLI and daemon's authorization boundary.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};

use super::{arg_usize, truncate_tail, ToolResult, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES};

const DEFAULT_TIMEOUT_SECONDS: usize = 30;
const MAX_TIMEOUT_SECONDS: usize = 120;
const MAX_COMMANDS: usize = 32;
const MAX_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 16 * 1024;

pub async fn run(args: &Value, cwd: &Path) -> ToolResult {
    let Some(cli) = std::env::var_os("GENEHUB_CLI").map(PathBuf::from) else {
        return ToolResult::error("genehub: GENEHUB_CLI is unavailable");
    };
    if !cli.is_absolute() {
        return ToolResult::error("genehub: GENEHUB_CLI must be an absolute path");
    }
    run_with_cli(args, cwd, &cli).await
}

async fn run_with_cli(args: &Value, cwd: &Path, cli: &Path) -> ToolResult {
    let timeout_seconds = arg_usize(args, "timeoutSeconds").unwrap_or(DEFAULT_TIMEOUT_SECONDS);
    if timeout_seconds == 0 || timeout_seconds > MAX_TIMEOUT_SECONDS {
        return ToolResult::error(format!(
            "genehub: timeoutSeconds must be 1-{MAX_TIMEOUT_SECONDS}"
        ));
    }
    let Some(commands) = args.get("commands").and_then(Value::as_array) else {
        return ToolResult::error("genehub: 'commands' is required");
    };
    if commands.is_empty() || commands.len() > MAX_COMMANDS {
        return ToolResult::error(format!(
            "genehub: commands must contain 1-{MAX_COMMANDS} items"
        ));
    }

    let mut validated = Vec::with_capacity(commands.len());
    for (index, command) in commands.iter().enumerate() {
        let Some(raw_argv) = command.get("argv").and_then(Value::as_array) else {
            return ToolResult::error(format!("genehub: commands[{index}].argv is required"));
        };
        if raw_argv.is_empty() || raw_argv.len() > MAX_ARGS {
            return ToolResult::error(format!(
                "genehub: commands[{index}].argv must contain 1-{MAX_ARGS} strings"
            ));
        }
        let mut argv = Vec::with_capacity(raw_argv.len());
        for (argument_index, argument) in raw_argv.iter().enumerate() {
            let Some(argument) = argument.as_str() else {
                return ToolResult::error(format!(
                    "genehub: commands[{index}].argv[{argument_index}] must be a string"
                ));
            };
            if argument.len() > MAX_ARG_BYTES || argument.contains('\0') {
                return ToolResult::error(format!(
                    "genehub: commands[{index}].argv[{argument_index}] is invalid"
                ));
            }
            argv.push(argument.to_string());
        }
        validated.push(argv);
    }

    let mut completed = Vec::with_capacity(validated.len());
    for (index, argv) in validated.into_iter().enumerate() {
        let mut child = crate::os_process::Command::new(cli);
        child
            .args(&argv)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output =
            match tokio::time::timeout(Duration::from_secs(timeout_seconds as u64), child.output())
                .await
            {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => {
                    return ToolResult::error(format!(
                        "genehub: command {index} could not start: {error}"
                    ))
                }
                Err(_) => {
                    return ToolResult::error(format!(
                        "genehub: command {index} timed out after {timeout_seconds} seconds"
                    ))
                }
            };
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&stderr);
        }
        let command_output = truncate_tail(&text, 400, 16 * 1024).content;
        let exit_code = output.status.code();
        completed.push(json!({
            "index": index,
            "argv": argv,
            "exitCode": exit_code,
            "output": command_output,
        }));
        if !output.status.success() {
            return ToolResult::error(
                serde_json::to_string(&json!({
                    "completed": completed,
                    "failedAt": index,
                }))
                .unwrap_or_else(|_| "genehub command failed".into()),
            );
        }
    }

    let serialized = serde_json::to_string(&json!({ "completed": completed }))
        .unwrap_or_else(|_| "genehub batch completed".into());
    let truncation = truncate_tail(&serialized, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
    ToolResult::ok(truncation.content.clone()).with_truncation(&truncation)
}
