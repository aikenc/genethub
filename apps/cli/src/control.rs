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

use crate::{fail, ok, EXIT_FAILED, EXIT_OK, EXIT_UNREACHABLE};

/// How long `start` waits for the fresh daemon to publish its endpoint.
const START_TIMEOUT: Duration = Duration::from_secs(20);
/// How long `stop` lets a SIGTERM'd daemon end its sessions before insisting.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// What the daemon writes to `endpoint.json` once it is listening.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    port: u16,
    token: String,
    pid: u32,
}

impl Endpoint {
    fn websocket_url(&self) -> String {
        format!("ws://127.0.0.1:{}/ws?token={}", self.port, self.token)
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
            match genet_daemon::run::run().await {
                Ok(()) => EXIT_OK,
                Err(error) => fail(
                    "internal",
                    &format!("the daemon stopped: {error:#}"),
                    EXIT_FAILED,
                ),
            }
        }
        "status" => no_extra(rest, || report(false)),
        "endpoint" => no_extra(rest, || endpoint()),
        "start" => no_extra(rest, || start()),
        "stop" => no_extra(rest, || stop()),
        "restart" => no_extra(rest, || restart()),
        _ => crate::usage(),
    }
}

pub fn status(args: &[String]) -> i32 {
    no_extra(args, || report(true))
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
    // Both halves, the way the shell adopts: a live pid with a dead listener
    // is no use to anyone, and a fresh endpoint with a dead pid is a leftover.
    let running = match (pid, &endpoint) {
        (Some(lock), Some(endpoint)) => lock == endpoint.pid && health(endpoint.port),
        (Some(_), None) => true, // up but not listening yet, or endpoint unreadable
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

/// `genet status` — the daemon facts, plus the hub summary once the hub
/// commands exist (`null` until then: answering "no idea yet" is honest, and
/// the field is frozen so scripts can rely on its presence).
fn report(overview: bool) -> i32 {
    let paths = paths();
    let mut value = facts(&paths);
    if overview {
        value["hub"] = serde_json::Value::Null;
    }
    ok(value)
}

/// `genet daemon endpoint` — how to connect, for a browser, an SSH tunnel or
/// another agent. The token is part of the answer on purpose: this file is
/// already restricted to the machine's owner, and the shell reads the same
/// facts today (`genethub-cli.md` §4.0).
fn endpoint() -> i32 {
    let paths = paths();
    let mut value = facts(&paths);
    if let Some(endpoint) = read_endpoint(&paths) {
        value["token"] = serde_json::json!(endpoint.token);
        value["wsUrl"] = serde_json::json!(endpoint.websocket_url());
    } else {
        value["token"] = serde_json::Value::Null;
        value["wsUrl"] = serde_json::Value::Null;
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

    if live_pid(&paths).is_some() {
        let mut value = facts(&paths);
        value["started"] = serde_json::json!(false);
        value["alreadyRunning"] = serde_json::json!(true);
        return ok(value);
    }

    // The daemon is this same file in its other shape. stdout and stderr go
    // to a log beside the daemon's own: the listening line is how the shell
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
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => fail(
            "internal",
            &format!("could not locate our own binary: {error}"),
            EXIT_FAILED,
        ),
    };
    let mut command = std::process::Command::new(exe);
    command
        .args(["daemon", "run"])
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
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => fail(
            "internal",
            &format!("could not spawn the daemon: {error}"),
            EXIT_FAILED,
        ),
    };

    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(endpoint) = read_endpoint(&paths) {
            if lifecycle::pid_alive(endpoint.pid) && health(endpoint.port) {
                let mut value = facts(&paths);
                value["started"] = serde_json::json!(true);
                value["alreadyRunning"] = serde_json::json!(false);
                value["port"] = serde_json::json!(endpoint.port);
                return ok(value);
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    fail(
        "daemon_unreachable",
        &format!(
            "the daemon (pid {}) did not publish an endpoint within {}s; see {}",
            child.id(),
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
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("cli-start.log"))?;
    Ok((file.try_clone()?, file))
}

/// `genet daemon stop` — by the lock file's pid, never by binary name: the
/// name is `genet`, shared with every running client (`genethub-cli.md` §2).
///
/// Idempotent, frozen: nothing to stop is a success that says so
/// (`{"stopped": false, "running": false}`), not an error.
fn stop() -> i32 {
    let paths = paths();
    let Some(pid) = live_pid(&paths) else {
        return ok(serde_json::json!({"stopped": false, "running": false}));
    };

    lifecycle::terminate(pid);
    if wait_gone(pid, STOP_TIMEOUT) {
        return ok(serde_json::json!({"stopped": true, "running": false, "forced": false}));
    }

    // It did not go quietly. Sessions get their graceful window first because
    // an agent mid-turn deserves the chance to end; past that, a stop that
    // does not stop is worse than a hard one.
    lifecycle::force_kill(pid);
    if wait_gone(pid, Duration::from_secs(3)) {
        return ok(serde_json::json!({"stopped": true, "running": false, "forced": true}));
    }
    fail(
        "internal",
        &format!("the daemon (pid {pid}) would not stop"),
        EXIT_FAILED,
    )
}

fn restart() -> i32 {
    let paths = paths();
    if let Some(pid) = live_pid(&paths) {
        lifecycle::terminate(pid);
        if !wait_gone(pid, STOP_TIMEOUT) {
            lifecycle::force_kill(pid);
            if !wait_gone(pid, Duration::from_secs(3)) {
                fail(
                    "internal",
                    &format!("the daemon (pid {pid}) would not stop"),
                    EXIT_FAILED,
                );
            }
        }
    }
    start()
}

fn wait_gone(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if !lifecycle::pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !lifecycle::pid_alive(pid)
}

/// Whether something is answering `/health` on this port — the same cheap
/// probe the shell adopts daemons with.
fn health(port: u16) -> bool {
    let Ok(address) = format!("127.0.0.1:{port}").parse() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut answer = Vec::new();
    if stream.read_to_end(&mut answer).is_err() && answer.is_empty() {
        return false;
    }
    answer.starts_with(b"HTTP/1.1 200")
}
