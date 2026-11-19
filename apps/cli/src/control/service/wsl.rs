//! Windows owns the WSL distribution lifetime. systemd owns the daemon
//! process inside it, with one shared Windows task per distribution.

use std::process::{Command, Stdio};

use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use genet_frontdoor::{channel, Paths};

const WINDOWS_TASK: &str = include_str!("wsl-task.ps1");

pub(super) fn update(paths: &Paths, operation: &str) -> Option<Value> {
    if !super::is_wsl() {
        return None;
    }
    Some(match powershell(paths, operation) {
        Ok(status) => status,
        Err(error) => json!({"configured": null, "warning": error.to_string()}),
    })
}

fn powershell(paths: &Paths, operation: &str) -> Result<Value> {
    let identity = paths.root.join("wsl-distribution");
    let distro = std::env::var("WSL_DISTRO_NAME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::fs::read_to_string(&identity).ok())
        .context("Windows autostart is unverified because the WSL distribution is unavailable")?;
    ensure!(!distro.is_empty(), "WSL distribution name is empty");
    let user = Command::new("/usr/bin/id").arg("-un").output()?;
    ensure!(
        user.status.success(),
        "could not identify the WSL service user"
    );
    let user = String::from_utf8(user.stdout)?;
    let user = user.trim();
    ensure!(
        user != "root" && !user.is_empty(),
        "Windows autostart requires a non-root WSL service user"
    );
    let literal = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let script = format!(
        "$operation={}\n$distro={}\n$linuxUser={}\n$channel={}\n{WINDOWS_TASK}",
        literal(operation),
        literal(&distro),
        literal(user),
        literal(channel::CHANNEL),
    );
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
        .arg(STANDARD.encode(bytes))
        .stdin(Stdio::null())
        .output()
        .context("Windows autostart is unverified because PowerShell interop is unavailable")?;
    ensure!(
        output.status.success(),
        "Windows could not {} the WSL scheduled task: {}",
        operation,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    let status: Value =
        serde_json::from_slice(&output.stdout).context("Windows WSL task status was unreadable")?;
    if operation == "start" && status["configured"] == true {
        if std::fs::read_to_string(&identity).as_deref().ok() != Some(distro.as_str()) {
            super::write_atomic(&identity, distro.as_bytes())?;
        }
    }
    Ok(status)
}
