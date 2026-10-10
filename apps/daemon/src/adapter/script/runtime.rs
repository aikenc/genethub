//! Finding the Python every script Agent runs on.
//!
//! The daemon never decides which Python that is. It runs this platform's
//! install script from `agents/runtime/` before every start; the script is
//! idempotent, installs the pinned build if it is missing, and prints the
//! interpreter's absolute path last (`docs/agent-serve-protocol.md` §6).

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use crate::os_process::Command;

/// A first install downloads tens of megabytes; nothing else takes long.
const INSTALL_BUDGET: Duration = Duration::from_secs(15 * 60);

pub struct Runtime {
    dir: PathBuf,
    /// One install at a time: every Agent starting at once would otherwise
    /// download the same archive in parallel.
    lock: Mutex<()>,
}

/// One line of progress the script reported.
pub struct Progress {
    pub phase: Option<String>,
    pub message: Option<String>,
}

impl Runtime {
    pub fn new(dir: PathBuf) -> Self {
        Runtime {
            dir,
            lock: Mutex::new(()),
        }
    }

    /// The interpreter path, in the form the host spawns.
    pub async fn python(&self, report: &(dyn Fn(Progress) + Send + Sync)) -> Result<PathBuf> {
        let _one_at_a_time = self.lock.lock().await;
        let mut command = self.command()?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        crate::adapter::owned_child(&mut command);
        let mut child = command
            .spawn()
            .context("starting the Python install script")?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let drain = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(target: "agent", "python-runtime: {line}");
            }
        });

        let outcome = tokio::time::timeout(INSTALL_BUDGET, async {
            let mut lines = BufReader::new(stdout).lines();
            let mut python = None;
            let mut error = None;
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                    tracing::info!(target: "agent", "python-runtime: {line}");
                    continue;
                };
                if let Some(path) = value.get("python").and_then(Value::as_str) {
                    python = Some(PathBuf::from(path));
                } else if let Some(message) = value.get("error").and_then(Value::as_str) {
                    error = Some(message.to_string());
                } else {
                    report(Progress {
                        phase: value
                            .get("phase")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        message: value
                            .get("message")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    });
                }
            }
            (python, error)
        })
        .await;
        if outcome.is_err() {
            // A stalled download must not hold the lock every Agent start
            // waits on.
            let _ = child.start_kill();
        }
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .ok()
            .and_then(Result::ok);
        drain.abort();

        let (python, error) = outcome.map_err(|_| anyhow!("安装 Python 运行时超时"))?;
        if let Some(error) = error {
            return Err(anyhow!("Python 运行时不可用：{error}"));
        }
        let python = python.ok_or_else(|| {
            anyhow!(
                "Python 安装脚本没有给出解释器路径（退出码 {}）",
                status
                    .and_then(|status| status.code())
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "未知".into())
            )
        })?;

        Ok(python)
    }

    fn command(&self) -> Result<Command> {
        let dir = crate::guest_paths::host_path(&self.dir);
        if crate::guest_paths::windows_host() {
            let shell = crate::adapter::find_executable("powershell")
                .ok_or_else(|| anyhow!("找不到 PowerShell，无法安装 Python 运行时"))?;
            let mut command = Command::new(shell);
            command
                .arg("-NoProfile")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(crate::guest_paths::host_path(
                    &self.dir.join("install-windows.ps1"),
                ))
                .arg(dir);
            Ok(command)
        } else {
            let shell = crate::adapter::find_executable("sh")
                .ok_or_else(|| anyhow!("找不到 sh，无法安装 Python 运行时"))?;
            let mut command = Command::new(shell);
            command
                .arg(crate::guest_paths::host_path(&self.dir.join("install.sh")))
                .arg(dir);
            Ok(command)
        }
    }
}
