//! Forwards product verbs to the running daemon over loopback `POST /cli`.

use std::io::{IsTerminal, Read};
use std::time::Duration;

use genet_frontdoor::lifecycle;
use genet_frontdoor::Paths;
use genet_http::Client;
use serde::Deserialize;
use serde_json::Value;

use genet_frontdoor::envelope::CliFailure;

use crate::{fail, EXIT_FAILED};

const MAX_STDIN_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    port: u16,
    token: String,
    machine_id: String,
    fingerprint: String,
    pid: u32,
}

#[derive(Deserialize)]
struct CliRecord {
    #[serde(default)]
    stream: Option<String>,
    #[serde(default)]
    line: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    exit: Option<i32>,
}

pub async fn forward(argv: Vec<String>) -> i32 {
    // Only `genet shell` owns stdin (`docs/cli-thin-forwarder.md` §3).
    // Agent tool runners commonly give every subprocess a long-lived pipe;
    // reading that pipe for control verbs makes an otherwise completed
    // `workflow`, `session`, or `workspace` command wait forever for EOF.
    let stdin = if accepts_stdin(&argv) {
        piped_stdin()
    } else {
        Vec::new()
    };
    match stream(argv, stdin, caller_cwd()).await {
        Ok(code) => code,
        Err(message) => crate::fail_envelope(CliFailure::daemon_unavailable(message)),
    }
}

fn accepts_stdin(argv: &[String]) -> bool {
    genet_frontdoor::selectors::split(argv)
        .ok()
        .and_then(|(_, rest)| rest.first().cloned())
        .is_some_and(|command| command == "shell")
}

/// `genet status` asks the daemon for a hub summary without knowing Hub types.
pub async fn hub_status() -> Option<Value> {
    let records = collect(vec!["hub".into(), "status".into()]).await.ok()?;
    records.into_iter().find_map(|record| {
        let line = record.line?;
        serde_json::from_str(&line).ok()
    })
}

async fn collect(argv: Vec<String>) -> Result<Vec<CliRecord>, String> {
    let (url, _) = admission()?;
    let cwd = caller_cwd();
    let mut body = serde_json::json!({
        "argv": argv,
        "cwd": cwd,
    });
    add_session_controller_identity(&mut body);
    let response = Client::new()
        .post(&url)
        .timeout(Duration::from_secs(15))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("the local daemon did not accept /cli: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "the local daemon refused /cli ({})",
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("read /cli: {error}"))?;
    let mut records = Vec::new();
    for line in body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        records.push(
            serde_json::from_str(line).map_err(|error| format!("decode /cli record: {error}"))?,
        );
    }
    Ok(records)
}

async fn stream(argv: Vec<String>, stdin: Vec<u8>, cwd: String) -> Result<i32, String> {
    let (url, _) = admission()?;
    let mut body = serde_json::json!({
        "argv": argv,
        "cwd": cwd,
    });
    if !stdin.is_empty() {
        use base64::Engine;
        body["stdin"] = serde_json::json!(base64::engine::general_purpose::STANDARD.encode(stdin));
    }
    add_session_controller_identity(&mut body);
    let response = Client::builder()
        .build()
        .map_err(|error| format!("build http client: {error}"))?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            format!(
                "{error}; run `{} daemon start`",
                genet_frontdoor::channel::CLI_BINARY
            )
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "the local daemon refused /cli ({}); run `{} daemon start`",
            response.status(),
            genet_frontdoor::channel::CLI_BINARY
        ));
    }

    let mut exit = None;
    let mut leftover = String::new();
    let mut bytes = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|error| format!("read /cli: {error}"))?;
        leftover.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(at) = leftover.find('\n') {
            let line = leftover[..at].to_string();
            leftover = leftover[at + 1..].to_string();
            if line.trim().is_empty() {
                continue;
            }
            let record: CliRecord = serde_json::from_str(&line)
                .map_err(|error| format!("decode /cli record: {error}"))?;
            apply(&record, &mut exit);
            if let Some(code) = exit {
                return Ok(code);
            }
        }
    }
    if !leftover.trim().is_empty() {
        let record: CliRecord = serde_json::from_str(&leftover)
            .map_err(|error| format!("decode /cli record: {error}"))?;
        apply(&record, &mut exit);
    }
    exit.ok_or_else(|| "the daemon closed /cli without an exit record".to_string())
}

/// Carries an Agent's own durable Session identity back to the daemon. Both
/// fields must be present: ordinary terminals do not gain a session identity
/// merely by setting one suggestive environment variable.
fn add_session_controller_identity(body: &mut Value) {
    add_session_controller_identity_from(
        body,
        std::env::var("GENEHUB_SESSION_ID").ok(),
        std::env::var("GENEHUB_CONTROLLER_TOKEN").ok(),
    );
}

fn add_session_controller_identity_from(
    body: &mut Value,
    session_id: Option<String>,
    token: Option<String>,
) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let Some((session_id, token)) = session_id
        .zip(token)
        .filter(|(session_id, token)| !session_id.trim().is_empty() && !token.trim().is_empty())
    else {
        return;
    };
    object.insert("callerSessionId".into(), Value::String(session_id));
    object.insert("controllerToken".into(), Value::String(token));
}

fn apply(record: &CliRecord, exit: &mut Option<i32>) {
    if let Some(code) = record.exit {
        *exit = Some(code);
        return;
    }
    match record.stream.as_deref() {
        Some("stdout") => {
            if let Some(line) = &record.line {
                println!("{line}");
            }
        }
        Some("stderr") => {
            if let Some(text) = &record.text {
                eprint!("{text}");
                if !text.ends_with('\n') {
                    eprintln!();
                }
            }
        }
        _ => {}
    }
}

fn admission() -> Result<(String, Endpoint), String> {
    let paths =
        Paths::discover().map_err(|error| format!("locate the data directory: {error:#}"))?;
    let endpoint = read_endpoint(&paths).ok_or_else(|| {
        format!(
            "the daemon is not running; run `{} daemon start`",
            genet_frontdoor::channel::CLI_BINARY
        )
    })?;
    if !lifecycle::pid_alive(endpoint.pid) {
        return Err(format!(
            "the daemon is not running; run `{} daemon start`",
            genet_frontdoor::channel::CLI_BINARY
        ));
    }
    let url = genet_frontdoor::proof::cli_url(
        endpoint.port,
        &endpoint.token,
        endpoint.pid,
        &endpoint.machine_id,
        &endpoint.fingerprint,
    );
    Ok((url, endpoint))
}

fn read_endpoint(paths: &Paths) -> Option<Endpoint> {
    let raw = std::fs::read_to_string(paths.endpoint_file()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn caller_cwd() -> String {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into())
}

fn piped_stdin() -> Vec<u8> {
    if std::io::stdin().is_terminal() {
        return Vec::new();
    }
    let mut buffer = Vec::new();
    if std::io::stdin().read_to_end(&mut buffer).is_err() {
        fail("invalid_args", "could not read standard input", EXIT_FAILED);
    }
    if buffer.len() > MAX_STDIN_BYTES {
        fail(
            "invalid_args",
            &format!(
                "too much standard input: at most {MAX_STDIN_BYTES} bytes can be sent with a command, \
                 so write it to a file in the workspace and have the command read that"
            ),
            EXIT_FAILED,
        );
    }
    buffer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_controller_identity_requires_both_non_empty_fields() {
        for (session, token) in [
            (Some("s1".into()), None),
            (None, Some("proof".into())),
            (Some("".into()), Some("proof".into())),
            (Some("s1".into()), Some("".into())),
        ] {
            let mut body = serde_json::json!({"argv": ["workflow", "inspect"]});
            add_session_controller_identity_from(&mut body, session, token);
            assert!(body.get("callerSessionId").is_none());
            assert!(body.get("controllerToken").is_none());
        }

        let mut body = serde_json::json!({"argv": ["workflow", "inspect"]});
        add_session_controller_identity_from(&mut body, Some("s1".into()), Some("proof".into()));
        assert_eq!(body["callerSessionId"], "s1");
        assert_eq!(body["controllerToken"], "proof");
    }

    #[test]
    fn only_the_canonical_shell_verb_reads_standard_input() {
        let argv = |items: &[&str]| {
            items
                .iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        };

        assert!(accepts_stdin(&argv(&["shell", "--", "cat"])));
        assert!(accepts_stdin(&argv(&[
            "--machine",
            "m_test",
            "shell",
            "--",
            "cat",
        ])));
        assert!(!accepts_stdin(&argv(&["workflow", "init"])));
        assert!(!accepts_stdin(&argv(&["session", "list"])));
    }
}
