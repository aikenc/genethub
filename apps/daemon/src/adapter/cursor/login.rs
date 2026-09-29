//! Installation login probes are separate from the ACP session protocol.
use super::*;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) async fn logged_in(program: &Path) -> Option<bool> {
    if let Some(answer) = run_status(program, &["status", "--format", "json"]).await {
        return Some(answer);
    }
    run_status(program, &["status"]).await
}

async fn run_status(program: &Path, args: &[&str]) -> Option<bool> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    super::super::owned_child(&mut command);

    let output = tokio::time::timeout(LOGIN_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    login_from_status_output(&output.stdout, &output.stderr)
}

/// Phrased as "is it logged in", because that is the only sentence worth
/// acting on. Unknown wording — which account, which method, a new JSON
/// shape — means the CLI is usable, and a check that guessed at those would
/// hide working installs.
pub(super) fn login_from_status_output(stdout: &[u8], stderr: &[u8]) -> Option<bool> {
    let mut said = String::from_utf8_lossy(stdout).to_string();
    said.push_str(&String::from_utf8_lossy(stderr));
    if let Some(value) = json_object_in(&said) {
        if let Some(flag) = json_logged_in(&value) {
            return Some(flag);
        }
    }
    let lower = said.to_ascii_lowercase();
    if lower.contains("not authenticated") || lower.contains("not logged in") {
        return Some(false);
    }
    if lower.contains("logged in") {
        return Some(true);
    }
    None
}

fn json_object_in(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

fn json_logged_in(value: &Value) -> Option<bool> {
    for key in [
        "loggedIn",
        "logged_in",
        "authenticated",
        "isAuthenticated",
        "is_authenticated",
    ] {
        if let Some(flag) = value.get(key).and_then(Value::as_bool) {
            return Some(flag);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_json_and_text_agree_on_login() {
        assert_eq!(
            login_from_status_output(br#"{"loggedIn":false}"#, b""),
            Some(false)
        );
        assert_eq!(
            login_from_status_output(br#"{"authenticated":true}"#, b""),
            Some(true)
        );
        assert_eq!(
            login_from_status_output(b"Not authenticated", b""),
            Some(false)
        );
        assert_eq!(login_from_status_output(b"Not logged in", b""), Some(false));
        assert_eq!(
            login_from_status_output(b"Logged in as user@example.com", b""),
            Some(true)
        );
        assert_eq!(login_from_status_output(b"usage: cursor-agent", b""), None);
    }
}
