//! bash — runs with the permissions of the agent process. Isolation is the
//! deployment's job, not this tool's.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::Command;

use super::{
    arg_str, arg_usize, truncate_tail, ToolResult, TruncationResult, DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
};

pub async fn run(args: &Value, cwd: &Path) -> ToolResult {
    let Some(command) = arg_str(args, "command") else {
        return ToolResult::error("bash: 'command' is required");
    };

    let mut child = Command::new(shell());
    child
        .arg(shell_flag())
        .arg(&command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let started = child.output();
    let timeout_secs = arg_usize(args, "timeout");
    let output = match timeout_secs {
        Some(seconds) => {
            match tokio::time::timeout(Duration::from_secs(seconds as u64), started).await {
                Ok(result) => result,
                Err(_) => {
                    return ToolResult::error(append_status(
                        "",
                        &format!("Command timed out after {seconds} seconds"),
                    ))
                }
            }
        }
        None => started.await,
    };

    let output = match output {
        Ok(output) => output,
        Err(err) => return ToolResult::error(format!("Failed to run command: {err}")),
    };

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }

    let truncation = truncate_tail(&combined, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
    let text = truncation.content.clone();
    let full_output_path = if truncation.truncated {
        save_full_output(&combined)
    } else {
        None
    };

    match output.status.code() {
        Some(0) => finish(text, &truncation, full_output_path),
        Some(code) => ToolResult::error(append_status(
            &text,
            &format!("Command exited with code {code}"),
        )),
        // Killed by a signal: no exit code to report.
        None => ToolResult::error(append_status(&text, "Command terminated by signal")),
    }
}

fn finish(
    text: String,
    truncation: &TruncationResult,
    full_output_path: Option<String>,
) -> ToolResult {
    let result = ToolResult::ok(text);
    if !truncation.truncated && full_output_path.is_none() {
        return result;
    }
    let mut details = json!({
        "truncation": serde_json::to_value(truncation).unwrap_or(Value::Null),
    });
    if let Some(path) = full_output_path {
        details["fullOutputPath"] = json!(path);
    }
    result.with_details(details)
}

/// Keep the output, then the status on its own paragraph.
fn append_status(text: &str, status: &str) -> String {
    if text.is_empty() {
        status.to_string()
    } else {
        format!("{text}\n\n{status}")
    }
}

fn save_full_output(content: &str) -> Option<String> {
    let path = std::env::temp_dir().join(format!("genet-bash-{}.log", uuid::Uuid::new_v4()));
    std::fs::write(&path, content).ok()?;
    Some(path.to_string_lossy().to_string())
}

#[cfg(unix)]
fn shell() -> &'static str {
    "bash"
}

#[cfg(unix)]
fn shell_flag() -> &'static str {
    "-c"
}

#[cfg(windows)]
fn shell() -> &'static str {
    "cmd"
}

#[cfg(windows)]
fn shell_flag() -> &'static str {
    "/C"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captures_stdout_without_details_when_short() {
        let result = run(&json!({"command": "echo hello"}), Path::new(".")).await;
        assert!(!result.is_error);
        assert_eq!(result.text, "hello");
        assert!(result.details.is_none());
    }

    #[tokio::test]
    async fn non_zero_exit_reports_the_code_after_the_output() {
        let result = run(&json!({"command": "echo out; exit 3"}), Path::new(".")).await;
        assert!(result.is_error);
        assert_eq!(result.text, "out\n\nCommand exited with code 3");
    }

    #[tokio::test]
    async fn stderr_is_merged_into_the_output() {
        let result = run(&json!({"command": "echo oops >&2"}), Path::new(".")).await;
        assert!(result.text.contains("oops"));
    }

    #[tokio::test]
    async fn runs_in_the_requested_directory() {
        let dir = std::env::temp_dir().join(format!("genet-bash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker.txt"), "").unwrap();
        assert!(run(&json!({"command": "ls"}), &dir)
            .await
            .text
            .contains("marker.txt"));
    }

    #[tokio::test]
    async fn timeout_is_reported_rather_than_hanging() {
        let result = run(&json!({"command": "sleep 5", "timeout": 1}), Path::new(".")).await;
        assert!(result.is_error);
        assert_eq!(result.text, "Command timed out after 1 seconds");
    }

    #[tokio::test]
    async fn truncated_output_is_saved_to_a_file() {
        let result = run(&json!({"command": "seq 1 5000"}), Path::new(".")).await;
        let details = result.details.expect("truncated runs carry details");
        assert_eq!(details["truncation"]["truncatedBy"], "lines");
        let saved = details["fullOutputPath"].as_str().unwrap();
        assert!(std::fs::read_to_string(saved).unwrap().contains("5000"));
        // The tail is what the model sees.
        assert!(result.text.ends_with("5000"));
    }

    #[test]
    fn status_lines_follow_pi_formatting() {
        assert_eq!(append_status("", "Command aborted"), "Command aborted");
        assert_eq!(
            append_status("out", "Command aborted"),
            "out\n\nCommand aborted"
        );
    }
}
