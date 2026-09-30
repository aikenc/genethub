//! bash — runs with the agent's permissions and keeps background children
//! visible to the platform. Both native and WASI use the same bounded capture.

use std::collections::VecDeque;
use std::future::{pending, Future};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::os_process::{Child, Command};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::time::Instant;

use super::{arg_str, arg_usize, truncate_tail, ToolResult, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES};

const DRAIN: Duration = Duration::from_millis(200);

pub async fn run(args: &Value, cwd: &Path) -> ToolResult {
    run_with_cancel(args, cwd, pending()).await
}

pub(crate) async fn run_with_cancel(
    args: &Value,
    cwd: &Path,
    cancel: impl Future<Output = ()>,
) -> ToolResult {
    let Some(command_text) = arg_str(args, "command") else {
        return ToolResult::error("bash: 'command' is required");
    };
    let mut command = Command::new(shell());
    command
        .arg(shell_flag())
        .arg(&command_text)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_family = "wasm")]
    command.independent_session(false);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return ToolResult::error(format!("Failed to run command: {err}")),
    };
    let mut guard = ProcessGroup { child, armed: true };
    let mut stdout = guard.child.stdout.take();
    let mut stderr = guard.child.stderr.take();
    let mut out = [0; 8192];
    let mut err = [0; 8192];
    let mut capture = Capture::default();
    let timeout_secs = arg_usize(args, "timeout");
    let deadline =
        timeout_secs.and_then(|n| Instant::now().checked_add(Duration::from_secs(n as u64)));
    let mut drain = None;
    let mut status = None;
    let mut failure = None;
    tokio::pin!(cancel);
    let collected: io::Result<()> = async {
        loop {
            if status.is_some() && stdout.is_none() && stderr.is_none() { break; }
            tokio::select! {
                () = &mut cancel, if failure.is_none() && status.is_none() => {
                    failure = Some("Operation aborted".to_string());
                    drain = Some(Instant::now() + DRAIN);
                    guard.stop()?;
                }
                () = wait_deadline(deadline), if failure.is_none() && status.is_none() => {
                    failure = Some(format!("Command timed out after {} seconds", timeout_secs.unwrap()));
                    drain = Some(Instant::now() + DRAIN);
                    guard.stop()?;
                }
                () = wait_deadline(drain) => break,
                read = async { stdout.as_mut().unwrap().read(&mut out).await }, if stdout.is_some() => {
                    let n = read?;
                    if n == 0 { stdout = None; } else { capture.push(&out[..n])?; }
                }
                read = async { stderr.as_mut().unwrap().read(&mut err).await }, if stderr.is_some() => {
                    let n = read?;
                    if n == 0 { stderr = None; } else { capture.push(&err[..n])?; }
                }
                ended = guard.child.wait(), if status.is_none() => {
                    status = Some(ended?);
                    drain.get_or_insert(Instant::now() + DRAIN);
                    // A normal shell exit leaves its background children alive.
                    guard.armed = failure.is_some();
                }
            }
        }
        Ok(())
    }.await;
    if let Err(error) = collected {
        failure = Some(append_status(
            failure.as_deref().unwrap_or(""),
            &format!("Failed to collect command output: {error}"),
        ));
    }
    let exit_code = status.and_then(|status| status.code());
    let failure = failure.or_else(|| match exit_code {
        Some(0) => None,
        Some(code) => Some(format!("Command exited with code {code}")),
        None => Some("Command terminated by signal".into()),
    });
    capture.finish(failure, exit_code)
}

async fn wait_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending().await,
    }
}

struct ProcessGroup {
    child: Child,
    armed: bool,
}

impl ProcessGroup {
    fn stop(&mut self) -> io::Result<()> {
        #[cfg(not(target_family = "wasm"))]
        if let Some(pid) = self.child.id() {
            kill_process_tree(pid);
        }
        self.child.start_kill()
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.stop();
        }
    }
}

#[cfg(all(unix, not(target_family = "wasm")))]
fn kill_process_tree(pid: u32) {
    genet_native::process_tree::kill_descendants(pid);
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[derive(Default)]
struct Capture {
    tail: VecDeque<u8>,
    bytes: usize,
    newlines: usize,
    last: Option<u8>,
    full: Option<(std::fs::File, PathBuf)>,
}

impl Capture {
    fn push(&mut self, bytes: &[u8]) -> io::Result<()> {
        let total = self.bytes.saturating_add(bytes.len());
        let newlines = self.newlines + bytes.iter().filter(|&&c| c == b'\n').count();
        let lines = newlines + usize::from(bytes.last().is_some_and(|&c| c != b'\n'));
        if self.full.is_none() && (total > DEFAULT_MAX_BYTES || lines > DEFAULT_MAX_LINES) {
            let path =
                crate::os::temp_dir().join(format!("genet-bash-{}.log", uuid::Uuid::new_v4()));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&path)?;
            let (a, b) = self.tail.as_slices();
            file.write_all(a)?;
            file.write_all(b)?;
            self.full = Some((file, path));
        }
        if let Some((file, _)) = &mut self.full {
            file.write_all(bytes)?;
        }
        self.bytes = total;
        self.newlines = newlines;
        self.last = bytes.last().copied().or(self.last);
        self.tail.extend(bytes);
        if self.tail.len() > DEFAULT_MAX_BYTES {
            self.tail.drain(..self.tail.len() - DEFAULT_MAX_BYTES);
        }
        Ok(())
    }

    fn finish(mut self, failure: Option<String>, exit_code: Option<i32>) -> ToolResult {
        let decoded = decode_output(self.tail.make_contiguous());
        let mut start = decoded.len().saturating_sub(DEFAULT_MAX_BYTES);
        while !decoded.is_char_boundary(start) {
            start += 1;
        }
        let mut truncation = truncate_tail(&decoded[start..], DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
        truncation.total_bytes = self.bytes;
        truncation.total_lines = self.newlines + usize::from(self.last.is_some_and(|c| c != b'\n'));
        if self.full.is_some() || start > 0 {
            truncation.truncated = true;
            truncation
                .truncated_by
                .get_or_insert(if self.bytes > DEFAULT_MAX_BYTES || start > 0 {
                    "bytes"
                } else {
                    "lines"
                });
            truncation.first_line_exceeds_limit =
                self.bytes > DEFAULT_MAX_BYTES && truncation.total_lines == 1;
        }
        let mut result = match failure {
            Some(failure) => ToolResult::error(append_status(&truncation.content, &failure)),
            None => ToolResult::ok(truncation.content.clone()),
        };
        let mut details = result.details.take().unwrap_or_else(|| json!({}));
        if result.is_error {
            details["exitCode"] = json!(exit_code);
        }
        if truncation.truncated {
            details["truncation"] = json!(truncation);
        }
        if let Some((file, path)) = self.full {
            drop(file);
            details["fullOutputPath"] = json!(path.to_string_lossy());
        }
        if details
            .as_object()
            .is_some_and(|details| !details.is_empty())
        {
            result.details = Some(details);
        }
        result
    }
}

fn append_status(text: &str, status: &str) -> String {
    if text.is_empty() {
        status.into()
    } else {
        format!("{text}\n\n{status}")
    }
}

#[cfg(unix)]
fn shell() -> &'static str {
    "bash"
}

#[cfg(unix)]
fn shell_flag() -> &'static str {
    "-c"
}

// The command runs on the host, not in here, and WASI reports nothing about
// which host that is. Dev shells are unix.
#[cfg(target_family = "wasm")]
fn shell() -> &'static str {
    "bash"
}

#[cfg(target_family = "wasm")]
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
        assert_eq!(
            decode_output(b"FINDSTR: Cannot open versionCode"),
            "FINDSTR: Cannot open versionCode"
        );
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
        let dir = crate::os::temp_dir().join(format!("genet-bash-{}", uuid::Uuid::new_v4()));
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

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_returns_output_produced_before_it() {
        let result = run(
            &json!({"command": "printf 'partial-before-timeout'; sleep 30", "timeout": 1}),
            Path::new("."),
        )
        .await;
        assert!(result.is_error);
        assert!(result.text.starts_with("partial-before-timeout"));
        assert!(result.text.ends_with("Command timed out after 1 seconds"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_long_single_line_keeps_its_tail_and_full_output_even_on_failure() {
        let result = run(&json!({"command": "printf 'prefix'; head -c 200000 /dev/zero | tr '\\0' x; printf 'TAIL'; exit 7"}), Path::new(".")).await;
        assert!(result.is_error);
        assert!(result.text.ends_with("TAIL\n\nCommand exited with code 7"));
        assert!(result.text.len() <= DEFAULT_MAX_BYTES + 40);
        let details = result.details.unwrap();
        assert_eq!(details["exitCode"], 7);
        assert_eq!(details["truncation"]["totalBytes"], 200010);
        let path = details["fullOutputPath"].as_str().unwrap();
        let full = std::fs::read(path).unwrap();
        assert_eq!(full.len(), 200010);
        assert!(full.starts_with(b"prefix") && full.ends_with(b"TAIL"));
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_exit_returns_without_killing_a_child_that_holds_the_pipes() {
        let dir =
            crate::os::temp_dir().join(format!("genet-bash-background-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            run(
                &json!({"command": "sleep 30 & echo $! > pid; echo background-ready"}),
                &dir,
            ),
        )
        .await;
        let pid = std::fs::read_to_string(dir.join("pid"))
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        std::fs::remove_dir_all(dir).unwrap();
        let result = result.expect("shell exit must not wait for background pipe EOF");
        assert!(!result.is_error, "{}", result.text);
        assert_eq!(result.text, "background-ready");
        assert!(
            alive,
            "normal tool return must leave background processes alive"
        );
    }

    #[tokio::test]
    async fn streamed_capture_keeps_memory_bounded_and_preserves_every_spooled_byte() {
        let mut capture = Capture::default();
        let chunk = vec![b'x'; 8192];
        for _ in 0..1024 {
            capture.push(&chunk).unwrap();
            assert!(capture.tail.len() <= DEFAULT_MAX_BYTES);
        }
        let result = capture.finish(None, Some(0));
        let details = result.details.unwrap();
        let path = details["fullOutputPath"].as_str().unwrap();
        assert_eq!(std::fs::metadata(path).unwrap().len(), 8 * 1024 * 1024);
        assert_eq!(result.text.len(), DEFAULT_MAX_BYTES);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_a_command_stops_its_descendants() {
        let dir = crate::os::temp_dir().join(format!("genet-bash-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("pid");
        let args = json!({
            "command": format!("sleep 30 & echo $! > '{}'; wait", pid_file.display())
        });
        let cwd = dir.clone();
        let task = tokio::spawn(async move { run(&args, &cwd).await });

        let pid = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&pid_file) {
                    break text.trim().parse::<i32>().unwrap();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the shell started its child");

        task.abort();
        let _ = task.await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if unsafe { libc::kill(pid, 0) } == -1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dropping the tool future kills the whole process group");
        let _ = std::fs::remove_dir_all(dir);
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
