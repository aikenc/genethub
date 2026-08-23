//! The daemon control plane (`genethub-cli.md` §4.0).
//!
//! These commands answer and act without a websocket: liveness comes from
//! `daemon.lock` plus a pid probe, connection facts come from `endpoint.json`.
//! That is what makes them usable when the daemon itself is the thing that is
//! broken — `daemon stop` must not need the daemon's cooperation.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde::Deserialize;

use genet_daemon::channel;
use genet_daemon::config::Paths;
use genet_daemon::lifecycle;

use crate::{fail, ok, EXIT_FAILED, EXIT_UNREACHABLE};

/// How long `start` waits for the fresh daemon to publish its endpoint.
const START_TIMEOUT: Duration = Duration::from_secs(45);
/// How long `stop` lets a SIGTERM'd daemon end its sessions before insisting.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// What the daemon writes to `endpoint.json` once it is listening.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    port: u16,
    token: String,
    machine_id: String,
    fingerprint: String,
    pid: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    pid: u32,
    machine_id: String,
    fingerprint: String,
    proof: String,
}

impl Endpoint {
    fn websocket_admission(&self) -> genet_daemon::transport::local::LocalWebSocketAdmission {
        genet_daemon::transport::local::websocket_admission(
            self.port,
            &self.token,
            self.pid,
            &self.machine_id,
            &self.fingerprint,
        )
    }
}

pub async fn daemon(args: &[String]) -> i32 {
    let Some(verb) = args.first().map(String::as_str) else {
        return crate::usage();
    };
    let rest = &args[1..];
    match verb {
        "run" => {
            if !rest.is_empty() {
                return crate::usage();
            }
            crate::wasm::become_daemon()
        }
        "status" => no_extra(rest, daemon_report),
        "endpoint" => no_extra(rest, endpoint),
        "start" => no_extra(rest, start),
        "stop" => no_extra(rest, stop),
        "restart" => no_extra(rest, restart),
        _ => crate::usage(),
    }
}

pub async fn status(args: &[String]) -> i32 {
    if !args.is_empty() {
        return crate::usage();
    }
    overview().await
}

fn no_extra(args: &[String], command: impl FnOnce() -> i32) -> i32 {
    if !args.is_empty() {
        return crate::usage();
    }
    command()
}

fn paths() -> Paths {
    match Paths::discover() {
        Ok(paths) => paths,
        Err(error) => fail(
            "internal",
            &format!("could not locate the data directory: {error:#}"),
            EXIT_FAILED,
        ),
    }
}

fn read_endpoint(paths: &Paths) -> Option<Endpoint> {
    let raw = std::fs::read_to_string(paths.endpoint_file()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The pid of the running daemon, proven alive — or nothing.
///
/// The lock file is checked first because it names the process precisely; a
/// stale lock from a hard kill must not read as "running".
fn live_pid(paths: &Paths) -> Option<u32> {
    let pid = lifecycle::lock_pid(paths)?;
    lifecycle::pid_alive(pid).then_some(pid)
}

/// The facts every "where is the daemon" answer is built from.
fn facts(paths: &Paths) -> serde_json::Value {
    let pid = live_pid(paths);
    let endpoint = read_endpoint(paths);
    let instance_locked = lifecycle::instance_locked(paths).unwrap_or(false);
    // Both halves, the way the shell adopts: a live pid with a dead listener
    // is no use to anyone, and a fresh endpoint with a dead pid is a leftover.
    let running = match (pid, &endpoint) {
        (Some(lock), Some(endpoint)) => instance_locked && lock == endpoint.pid && health(endpoint),
        (Some(_), None) => instance_locked, // up but not listening yet
        _ => false,
    };
    serde_json::json!({
        "running": running,
        "pid": pid,
        "port": endpoint.as_ref().map(|endpoint| endpoint.port),
        "endpointFile": paths.endpoint_file(),
        "dataDir": paths.root,
        "version": env!("CARGO_PKG_VERSION"),
        "channel": channel::CHANNEL,
    })
}

/// `genet daemon status` — process facts only; no WebSocket.
fn daemon_report() -> i32 {
    ok(facts(&paths()))
}

/// `genet status` — daemon facts plus a hub summary when the daemon answers.
/// Daemon down → `hub: null`, exit 0: looking up status itself succeeded
/// (`genethub-cli.md` §4.0).
async fn overview() -> i32 {
    let paths = paths();
    let mut value = facts(&paths);
    value["hub"] = if value["running"].as_bool() == Some(true) {
        crate::invoke::hub_status()
            .await
            .unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Null
    };
    ok(value)
}

/// `genet daemon endpoint` — how to connect, for a browser, an SSH tunnel or
/// another agent. The reusable token stays in the owner-only file; the answer
/// contains a short-lived, single-use admission URL.
fn endpoint() -> i32 {
    let paths = paths();
    let mut value = facts(&paths);
    if value["running"].as_bool() == Some(true) {
        let Some(endpoint) = read_endpoint(&paths) else {
            value["wsUrl"] = serde_json::Value::Null;
            return ok(value);
        };
        let admission = endpoint.websocket_admission();
        value["wsUrl"] = serde_json::json!(admission.url);
        value["serverProof"] = serde_json::json!(admission.server_proof);
        value["admission"] = serde_json::json!({
            "challenge": admission.challenge,
            "pid": admission.pid,
            "machineId": admission.machine_id,
            "fingerprint": admission.fingerprint,
            "expiresAt": admission.expires_at,
        });
    } else {
        value["wsUrl"] = serde_json::Value::Null;
        value["serverProof"] = serde_json::Value::Null;
        value["admission"] = serde_json::Value::Null;
    }
    ok(value)
}

/// `genet daemon start` — idempotent on purpose: a script that runs it twice
/// gets the same daemon twice, not a race (`genethub-cli.md` §4.0).
fn start() -> i32 {
    let paths = paths();
    if let Err(error) = paths.ensure() {
        fail(
            "internal",
            &format!("could not create the data directory: {error:#}"),
            EXIT_FAILED,
        );
    }

    if lifecycle::instance_locked(&paths).unwrap_or(false) {
        let mut value = facts(&paths);
        value["started"] = serde_json::json!(false);
        value["alreadyRunning"] = serde_json::json!(true);
        return ok(value);
    }

    if let Err(error) = lifecycle::reap_stale_runtime(&paths) {
        fail(
            "internal",
            &format!("could not reclaim leftover runtime files: {error}"),
            EXIT_FAILED,
        );
    }

    // The daemon is the wasm guest under genehub-host-local. stdout and stderr
    // go to a log beside the daemon's own: the listening line is how the shell
    // learns the endpoint when it spawns, but the CLI learns it from
    // `endpoint.json`, and a pipe nobody drains is a future hang.
    let log = start_log(&paths);
    let (out, err) = match log {
        Ok((out, err)) => (out, err),
        Err(error) => fail(
            "internal",
            &format!("could not open the startup log: {error:#}"),
            EXIT_FAILED,
        ),
    };
    let mut command = match crate::wasm::spawn_command() {
        Ok(command) => command,
        Err(error) => fail("internal", &error, EXIT_FAILED),
    };
    command
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => fail(
            "internal",
            &format!("could not spawn the daemon: {error}"),
            EXIT_FAILED,
        ),
    };

    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => fail(
                "daemon_unreachable",
                &format!(
                    "the daemon host exited {status} before publishing an endpoint; see {}",
                    paths.logs_dir().join("cli-start.log").display()
                ),
                EXIT_UNREACHABLE,
            ),
            Ok(None) => {}
            Err(error) => fail(
                "internal",
                &format!("could not wait for the daemon host: {error}"),
                EXIT_FAILED,
            ),
        }
        if let Some(endpoint) = read_endpoint(&paths) {
            if lifecycle::pid_alive(endpoint.pid) && health(&endpoint) {
                let mut value = facts(&paths);
                value["started"] = serde_json::json!(true);
                value["alreadyRunning"] = serde_json::json!(false);
                value["port"] = serde_json::json!(endpoint.port);
                return ok(value);
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let pid = child.id();
    let _ = child.kill();
    let _ = child.wait();
    fail(
        "daemon_unreachable",
        &format!(
            "the daemon (pid {pid}) did not publish an endpoint within {}s; see {}",
            START_TIMEOUT.as_secs(),
            paths.logs_dir().join("cli-start.log").display()
        ),
        EXIT_UNREACHABLE,
    )
}

/// Where a CLI-started daemon's early words go: the pre-logging failures the
/// shell keeps in `startup.log` need a home here too.
fn start_log(paths: &Paths) -> std::io::Result<(std::fs::File, std::fs::File)> {
    let dir = paths.logs_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("cli-start.log");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path)?;
    genet_daemon::config::restrict_to_owner(&path)
        .map_err(|error| std::io::Error::other(format!("restricting startup log: {error:#}")))?;
    Ok((file.try_clone()?, file))
}

/// `genet daemon stop` — by the lock file's pid, never by binary name: the
/// name is `genet`, shared with every running client (`genethub-cli.md` §2).
///
/// Idempotent, frozen: nothing to stop is a success that says so
/// (`{"stopped": false, "running": false}`), not an error.
fn stop() -> i32 {
    let paths = paths();
    if !lifecycle::instance_locked(&paths).unwrap_or(false) {
        return ok(serde_json::json!({"stopped": false, "running": false}));
    }
    match stop_verified(&paths) {
        Ok(forced) => ok(serde_json::json!({
            "stopped": true,
            "running": false,
            "forced": forced,
        })),
        Err(error) => fail("internal", &error, EXIT_FAILED),
    }
}

fn restart() -> i32 {
    let paths = paths();
    if lifecycle::instance_locked(&paths).unwrap_or(false) {
        if let Err(error) = stop_verified(&paths) {
            fail("internal", &error, EXIT_FAILED);
        }
    }
    start()
}

/// Stops only the daemon which proves it owns the private endpoint bearer.
///
/// A pid from a stale lock can have been reused. Never signal it merely because
/// some unrelated listener now answers 200 on the stale port.
fn stop_verified(paths: &Paths) -> Result<bool, String> {
    let lock = live_pid(paths).ok_or_else(|| "the daemon is no longer running".to_string())?;
    let endpoint = read_endpoint(paths).ok_or_else(|| {
        "refusing to stop an unverified pid: endpoint.json is missing or unreadable".to_string()
    })?;
    if endpoint.pid != lock || !health(&endpoint) {
        return Err(format!(
            "refusing to stop pid {lock}: its private endpoint identity could not be verified"
        ));
    }

    ask_to_stop(&endpoint);
    if wait_unhealthy(&endpoint, STOP_TIMEOUT) {
        return wait_stopped(paths, lock);
    }

    // Re-prove the identity immediately before every signal. Once the daemon's
    // listener is gone we deliberately stop touching the pid: it may already
    // have exited and been reused by an unrelated process.
    if !health(&endpoint) {
        return wait_stopped(paths, lock);
    }
    lifecycle::terminate(endpoint.pid);
    if wait_unhealthy(&endpoint, Duration::from_secs(3)) {
        return wait_stopped(paths, lock);
    }
    if !health(&endpoint) {
        return wait_stopped(paths, lock);
    }
    lifecycle::force_kill(endpoint.pid);
    if wait_unhealthy(&endpoint, Duration::from_secs(3)) {
        wait_stopped(paths, lock)?;
        return Ok(true);
    }
    Err(format!("the daemon (pid {}) would not stop", endpoint.pid))
}

/// `/shutdown` can drop the listener while the process still holds `daemon.lock`
/// while it drains sessions. `start` would then adopt that dying process.
/// Waits until the daemon has both let go of the lock and left.
///
/// Those are one event when the daemon is a process; they are two when it is a
/// guest inside one. The guest releases the lock as it shuts down and the shell
/// around it exits a moment later, so a `stop` that returned on the lock alone
/// would be followed by a `status` that still finds a live pid — true, and not
/// what "stopped" is supposed to mean.
fn wait_stopped(paths: &Paths, pid: u32) -> Result<bool, String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match lifecycle::instance_locked(paths) {
            Ok(false) if !lifecycle::pid_alive(pid) => return Ok(false),
            Ok(_) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("could not inspect daemon.lock: {error}")),
        }
    }
    if lifecycle::instance_locked(paths).unwrap_or(true) {
        Err("the daemon listener is gone but it still holds daemon.lock".into())
    } else if lifecycle::pid_alive(pid) {
        Err(format!(
            "the daemon released daemon.lock but pid {pid} is still running"
        ))
    } else {
        Ok(false)
    }
}

fn wait_unhealthy(endpoint: &Endpoint, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if !health(endpoint) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !health(endpoint)
}

/// Whether the exact daemon described by endpoint.json owns this listener.
fn health(endpoint: &Endpoint) -> bool {
    let challenge = health_challenge();
    let Ok(address) = format!("127.0.0.1:{}", endpoint.port).parse() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    let request = format!(
        "GET /health?challenge={challenge} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut answer = Vec::new();
    if stream.read_to_end(&mut answer).is_err() && answer.is_empty() {
        return false;
    }
    let Some(body) = http_ok_body(&answer) else {
        return false;
    };
    let Ok(found) = serde_json::from_slice::<Health>(body) else {
        return false;
    };
    let expected = genet_daemon::transport::local::health_proof(
        &endpoint.token,
        &challenge,
        endpoint.pid,
        &endpoint.machine_id,
        &endpoint.fingerprint,
    );
    found.pid == endpoint.pid
        && found.machine_id == endpoint.machine_id
        && found.fingerprint == endpoint.fingerprint
        && genet_daemon::transport::auth::token_matches(&expected, &found.proof)
}

fn health_challenge() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        nanos,
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn http_ok_body(answer: &[u8]) -> Option<&[u8]> {
    if !answer.starts_with(b"HTTP/1.1 200") {
        return None;
    }
    answer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|at| &answer[at + 4..])
}

fn ask_to_stop(endpoint: &Endpoint) {
    let challenge = health_challenge();
    let expires_at = unix_seconds().saturating_add(15);
    let proof = genet_daemon::transport::local::shutdown_proof(
        &endpoint.token,
        &challenge,
        endpoint.pid,
        &endpoint.machine_id,
        &endpoint.fingerprint,
        expires_at,
    );
    let request = format!(
        "POST /shutdown?challenge={challenge}&pid={}&expiresAt={expires_at}&proof={proof} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        endpoint.pid,
    );
    let Ok(address) = format!("127.0.0.1:{}", endpoint.port).parse() else {
        return;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.write_all(request.as_bytes());
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer);
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unrelated_health_listener() -> (u16, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let _ = socket.read(&mut request);
            let body = r#"{"pid":1,"machineId":"wrong","fingerprint":"wrong","proof":"wrong"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).unwrap();
        });
        (port, task)
    }

    #[test]
    fn stop_refuses_a_live_but_reused_pid_behind_an_unrelated_200_listener() {
        let (port, server) = unrelated_health_listener();
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        std::fs::write(paths.lock_file(), std::process::id().to_string()).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(paths.lock_file())
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&lock).unwrap();
        std::fs::write(
            paths.endpoint_file(),
            serde_json::json!({
                "port": port,
                "token": "private-token",
                "machineId": "expected-machine",
                "fingerprint": "expected-fingerprint",
                "pid": std::process::id(),
            })
            .to_string(),
        )
        .unwrap();

        let error = stop_verified(&paths).unwrap_err();
        assert!(error.contains("refusing to stop"));
        server.join().unwrap();
        // Reaching this line proves the stale pid (the test runner itself) was
        // never signalled merely because something answered 200.
        assert!(lifecycle::pid_alive(std::process::id()));
    }

    #[test]
    fn shutdown_sends_only_a_one_use_action_proof_never_the_endpoint_bearer() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen, received) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let count = socket.read(&mut request).unwrap();
            seen.send(String::from_utf8_lossy(&request[..count]).to_string())
                .unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 202 Accepted\r\nContent-Length: 8\r\nConnection: close\r\n\r\nstopping",
                )
                .unwrap();
        });
        let endpoint = Endpoint {
            port,
            token: "never-send-this-bearer".into(),
            machine_id: "machine".into(),
            fingerprint: "fingerprint".into(),
            pid: std::process::id(),
        };

        ask_to_stop(&endpoint);
        let request = received.recv().unwrap();
        assert!(request.starts_with("POST /shutdown?challenge="));
        assert!(request.contains("&expiresAt="));
        assert!(request.contains("&proof="));
        assert!(!request.contains(&endpoint.token));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        server.join().unwrap();
    }
}
