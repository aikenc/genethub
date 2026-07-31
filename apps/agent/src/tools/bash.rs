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

    let mut combined = decode_output(&output.stdout);
    let stderr = decode_output(&output.stderr);
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

/// Decode process output for the model and UI.
///
/// Prefer UTF-8 (modern CLIs). On Windows, fall back to the active ANSI code
/// page (ACP) so `findstr` / `cmd` messages in GBK, Shift_JIS, etc. stay
/// readable instead of turning into U+FFFD replacement characters.
fn decode_output(bytes: &[u8]) -> String {
    #[cfg(windows)]
    {
        decode_windows(bytes)
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(windows)]
fn decode_windows(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    decode_acp(bytes).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

#[cfg(windows)]
fn decode_acp(bytes: &[u8]) -> Option<String> {
    use std::ptr;

    // CP_ACP: decode with the process ANSI code page (e.g. 936 on zh-CN).
    const CP_ACP: u32 = 0;

    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            multi_byte_str: *const u8,
            cb_multi_byte: i32,
            wide_char_str: *mut u16,
            cch_wide_char: i32,
        ) -> i32;
    }

    let needed = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return None;
    }
    let mut wide = vec![0u16; needed as usize];
    let written = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            wide.as_mut_ptr(),
            needed,
        )
    };
    if written <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&wide[..written as usize]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_output_keeps_utf8() {
        assert_eq!(decode_output("hello 无法打开".as_bytes()), "hello 无法打开");
    }

    #[test]
    fn decode_output_keeps_ascii() {
        assert_eq!(decode_output(b"FINDSTR: Cannot open versionCode"), "FINDSTR: Cannot open versionCode");
    }

    #[cfg(windows)]
    #[test]
    fn decode_output_roundtrips_system_ansi() {
        let text = "无法打开";
        let Some(bytes) = encode_acp(text) else {
            return;
        };
        // On UTF-8 system locale (ACP 65001) the bytes are already UTF-8;
        // the preference path still returns the same string.
        assert_eq!(decode_output(&bytes), text);
        if std::str::from_utf8(&bytes).is_err() {
            // The ACP path is what fixes GBK/Shift_JIS console tools.
            assert_eq!(decode_acp(&bytes).as_deref(), Some(text));
        }
    }

    #[cfg(windows)]
    fn encode_acp(text: &str) -> Option<Vec<u8>> {
        use std::ptr;

        const CP_ACP: u32 = 0;

        #[link(name = "kernel32")]
        extern "system" {
            fn WideCharToMultiByte(
                code_page: u32,
                flags: u32,
                wide_char_str: *const u16,
                cch_wide_char: i32,
                multi_byte_str: *mut u8,
                cb_multi_byte: i32,
                default_char: *const u8,
                used_default_char: *mut i32,
            ) -> i32;
        }

        let wide: Vec<u16> = text.encode_utf16().collect();
        let needed = unsafe {
            WideCharToMultiByte(
                CP_ACP,
                0,
                wide.as_ptr(),
                wide.len() as i32,
                ptr::null_mut(),
                0,
                ptr::null(),
                ptr::null_mut(),
            )
        };
        if needed <= 0 {
            return None;
        }
        let mut bytes = vec![0u8; needed as usize];
        let written = unsafe {
            WideCharToMultiByte(
                CP_ACP,
                0,
                wide.as_ptr(),
                wide.len() as i32,
                bytes.as_mut_ptr(),
                needed,
                ptr::null(),
                ptr::null_mut(),
            )
        };
        if written <= 0 {
            return None;
        }
        bytes.truncate(written as usize);
        Some(bytes)
    }

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
