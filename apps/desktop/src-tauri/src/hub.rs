use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::sidecar::Sidecar;

/// Where the user code appears in `paseo hub connect` output, e.g.
/// "Open https://hub.genethub.com/activate and enter code VCL9-47CG".
fn extract_user_code(line: &str) -> Option<String> {
    let candidate: String = line
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .to_string();

    let looks_like_code = candidate.len() == 9
        && candidate.chars().nth(4) == Some('-')
        && candidate
            .chars()
            .enumerate()
            .all(|(i, c)| if i == 4 { c == '-' } else { c.is_ascii_uppercase() || c.is_ascii_digit() });

    looks_like_code.then_some(candidate)
}

#[derive(Debug, Serialize, Clone)]
pub struct PairingStarted {
    pub user_code: String,
    pub activation_url: String,
}

/// Starts `paseo hub connect`, which runs the device authorization flow. The
/// process keeps polling in the background until the user approves in a browser,
/// so we only wait long enough to read back the code to display.
pub fn start_pairing(sidecar: &Sidecar, hub_url: &str) -> Result<PairingStarted, String> {
    let mut child = Command::new(sidecar.paseo_bin())
        .arg("hub")
        .arg("connect")
        .arg(hub_url)
        .arg("--host")
        .arg(sidecar.daemon_host())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动配对流程: {error}"))?;

    let stdout = child.stdout.take().ok_or("配对流程没有输出")?;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(user_code) = extract_user_code(&line) {
            return Ok(PairingStarted {
                user_code,
                activation_url: format!("{}/activate", hub_url.trim_end_matches('/')),
            });
        }
    }

    Err("配对流程没有返回配对码".to_string())
}

pub fn relationship_state(sidecar: &Sidecar, hub_url: &str) -> String {
    let _ = hub_url;
    let output = Command::new(sidecar.paseo_bin())
        .arg("hub")
        .arg("status")
        .arg("--host")
        .arg(sidecar.daemon_host())
        .arg("--json")
        .output();

    let Ok(output) = output else {
        return "unknown".to_string();
    };

    serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .ok()
        .and_then(|value| {
            value
                .get(0)
                .and_then(|row| row.get("state"))
                .and_then(|state| state.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::extract_user_code;

    #[test]
    fn reads_the_code_out_of_the_cli_line() {
        assert_eq!(
            extract_user_code("Open https://hub.genethub.com/activate and enter code VCL9-47CG"),
            Some("VCL9-47CG".to_string())
        );
        assert_eq!(extract_user_code("Waiting for approval..."), None);
    }
}
