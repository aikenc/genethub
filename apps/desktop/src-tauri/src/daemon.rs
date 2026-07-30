//! The daemon process this app exists to host.
//!
//! The window is a convenience; the daemon is the product. So it starts before
//! anything is shown, survives the window being closed, and is stopped only
//! when the user quits from the tray — a background agent host with no visible
//! owner is exactly what we are trying not to leave behind.
//!
//! Two consequences of taking that seriously:
//!
//! - A daemon left behind by a crashed shell is *adopted*, not fought with. It
//!   publishes where it is listening, and the alternative — spawning a second
//!   one that loses the lock file race — showed the user "no machine found"
//!   while their machine was in fact running.
//! - While the app is up it keeps watching. A daemon that dies at 3am should be
//!   back before the user notices, and the workbench needs to hear about the
//!   new port because it is not the one it is connected to.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// What the daemon prints once it is listening. The port is chosen by the OS,
/// so reading it back is the only way to know where to connect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub machine_id: String,
    pub fingerprint: String,
}

impl Endpoint {
    pub fn websocket_url(&self) -> String {
        format!("ws://127.0.0.1:{}/ws?token={}", self.port, self.token)
    }
}

/// The same thing as `Endpoint`, plus the pid, as written to `endpoint.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Published {
    port: u16,
    token: String,
    machine_id: String,
    fingerprint: String,
    pid: u32,
}

/// How the daemon we are talking to came to exist. Only `stop` cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// We spawned it and hold its handle.
    Spawned,
    /// It was already running when we started.
    Adopted,
}

pub struct Daemon {
    binary: PathBuf,
    data_dir: PathBuf,
    child: Mutex<Option<Child>>,
    endpoint: Mutex<Option<Endpoint>>,
    origin: Mutex<Option<Origin>>,
    /// pid of an adopted daemon, which we have no `Child` for.
    adopted_pid: Mutex<Option<u32>>,
    /// Whether the daemon is supposed to be up. Cleared by `stop`, so the
    /// watchdog does not restart something the user asked to end.
    wanted: AtomicBool,
    /// Why the last start failed, for the window to show. A GUI app writes its
    /// diagnostics to a stream nobody is reading, so without this the only
    /// symptom of a daemon that cannot start is an app that looks idle.
    problem: Mutex<Option<String>>,
}

impl Daemon {
    pub fn new(binary: PathBuf, data_dir: PathBuf) -> Self {
        Daemon {
            binary,
            data_dir,
            child: Mutex::new(None),
            endpoint: Mutex::new(None),
            origin: Mutex::new(None),
            adopted_pid: Mutex::new(None),
            wanted: AtomicBool::new(false),
            problem: Mutex::new(None),
        }
    }

    pub fn endpoint(&self) -> Option<Endpoint> {
        self.endpoint.lock().expect("endpoint lock").clone()
    }

    /// Why there is no daemon, in words a user can pass on.
    pub fn problem(&self) -> Option<String> {
        self.problem.lock().expect("problem lock").clone()
    }

    fn remember_problem(&self, problem: Option<String>) {
        *self.problem.lock().expect("problem lock") = problem;
    }

    pub fn origin(&self) -> Option<Origin> {
        *self.origin.lock().expect("origin lock")
    }

    /// Connects to the daemon for this data directory, starting one if needed.
    ///
    /// Waiting for it to say where it is listening matters: the window loads
    /// immediately after, and a window that opens before the endpoint exists
    /// shows "no machine found" on every cold start, which reads as a broken
    /// install.
    pub fn start(&self) -> Result<Endpoint, String> {
        let started = self.try_start();
        self.remember_problem(started.as_ref().err().cloned());
        started
    }

    fn try_start(&self) -> Result<Endpoint, String> {
        self.wanted.store(true, Ordering::SeqCst);
        if let Some(endpoint) = self.endpoint() {
            if self.responding() {
                return Ok(endpoint);
            }
        }

        std::fs::create_dir_all(&self.data_dir)
            .map_err(|error| format!("无法创建数据目录: {error}"))?;

        if let Some((endpoint, pid)) = self.published() {
            *self.child.lock().expect("daemon lock") = None;
            *self.adopted_pid.lock().expect("pid lock") = Some(pid);
            *self.origin.lock().expect("origin lock") = Some(Origin::Adopted);
            *self.endpoint.lock().expect("endpoint lock") = Some(endpoint.clone());
            return Ok(endpoint);
        }

        self.spawn()
    }

    fn spawn(&self) -> Result<Endpoint, String> {
        let mut command = Command::new(&self.binary);
        command
            .env("GENEHUB_DATA_DIR", &self.data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            // Kept rather than discarded: when a start times out, the reason the
            // daemon gives is the only thing that explains it, and on a windowless
            // child there is nowhere else for it to go. Truncated each start, so
            // it describes this run and not a year of them.
            .stderr(match self.log() {
                Some(file) => Stdio::from(file),
                None => Stdio::null(),
            });

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 daemon: {error}"))?;
        let stdout = child.stdout.take().ok_or("daemon 没有输出")?;

        // Read on a thread so a daemon that never prints cannot hang startup.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(endpoint) = parse_endpoint(&line) {
                    let _ = tx.send(endpoint);
                    return;
                }
            }
        });

        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(endpoint) => {
                *self.child.lock().expect("daemon lock") = Some(child);
                *self.adopted_pid.lock().expect("pid lock") = None;
                *self.origin.lock().expect("origin lock") = Some(Origin::Spawned);
                *self.endpoint.lock().expect("endpoint lock") = Some(endpoint.clone());
                Ok(endpoint)
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(match self.last_words() {
                    Some(said) => format!("daemon 启动超时（{}）：{said}", self.binary.display()),
                    None => format!(
                        "daemon 启动超时，而且它什么都没说：{}",
                        self.binary.display()
                    ),
                })
            }
        }
    }

    /// Where the daemon's own complaints go. Missing is not worth failing over:
    /// no log is better than no daemon.
    fn log(&self) -> Option<std::fs::File> {
        std::fs::File::create(self.data_dir.join("daemon.log")).ok()
    }

    /// The last thing the daemon said before it gave up, if it said anything.
    fn last_words(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.data_dir.join("daemon.log")).ok()?;
        let tail: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
        let tail = tail[tail.len().saturating_sub(3)..].join("; ");
        (!tail.is_empty()).then_some(tail)
    }

    /// An endpoint published by a daemon that is still alive and answering.
    ///
    /// Both halves are needed: the file outlives a hard kill, and a live pid
    /// with a dead listener is no use to anyone.
    fn published(&self) -> Option<(Endpoint, u32)> {
        let raw = std::fs::read_to_string(self.data_dir.join("endpoint.json")).ok()?;
        let found: Published = serde_json::from_str(&raw).ok()?;
        if !pid_alive(found.pid) || !health(found.port) {
            return None;
        }
        Some((
            Endpoint {
                port: found.port,
                token: found.token,
                machine_id: found.machine_id,
                fingerprint: found.fingerprint,
            },
            found.pid,
        ))
    }

    /// Whether the daemon we think we have is actually there.
    ///
    /// The listener is the thing clients need, so the listener is what gets
    /// asked — a process that is alive but wedged is not "running" in any sense
    /// the user cares about.
    pub fn is_running(&self) -> bool {
        let exited = {
            let mut guard = self.child.lock().expect("daemon lock");
            match guard.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => false,
            }
        };
        if exited {
            self.forget();
            return false;
        }
        if self.endpoint().is_none() {
            return false;
        }
        if self.responding() {
            return true;
        }
        self.forget();
        false
    }

    fn responding(&self) -> bool {
        self.endpoint().is_some_and(|endpoint| health(endpoint.port))
    }

    fn forget(&self) {
        *self.child.lock().expect("daemon lock") = None;
        *self.endpoint.lock().expect("endpoint lock") = None;
        *self.origin.lock().expect("origin lock") = None;
        *self.adopted_pid.lock().expect("pid lock") = None;
    }

    /// Brings the daemon back after a crash, returning the new endpoint.
    ///
    /// The port and token both change, so whoever calls this has to tell the
    /// workbench: its old connection will never come back.
    pub fn restart(&self) -> Result<Endpoint, String> {
        self.stop();
        self.start()
    }

    /// Asks the daemon to shut down, then insists.
    ///
    /// The polite request gives it time to end sessions and let agents exit;
    /// killing straight away would orphan whatever they had spawned. It goes
    /// over loopback rather than as a signal because Windows has no signal that
    /// reaches a windowless child, and that platform needs the cleanup most —
    /// it is the one where a leftover agent has no parent to notice it.
    pub fn stop(&self) {
        self.wanted.store(false, Ordering::SeqCst);
        let endpoint = self.endpoint();
        let mut child = self.child.lock().expect("daemon lock").take();
        let adopted = self.adopted_pid.lock().expect("pid lock").take();
        *self.endpoint.lock().expect("endpoint lock") = None;
        *self.origin.lock().expect("origin lock") = None;

        if endpoint.is_none() && child.is_none() && adopted.is_none() {
            return;
        }

        if let Some(endpoint) = endpoint.as_ref() {
            ask_to_stop(endpoint);
        }

        for _ in 0..40 {
            let gone = match (child.as_mut(), adopted) {
                (Some(child), _) => matches!(child.try_wait(), Ok(Some(_))),
                (None, Some(pid)) => !pid_alive(pid),
                (None, None) => endpoint.as_ref().is_none_or(|e| !health(e.port)),
            };
            if gone {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        // It did not go quietly.
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        } else if let Some(pid) = adopted {
            terminate(pid);
        }
    }

    /// Restarts the daemon whenever it stops answering, with a widening gap.
    ///
    /// Backoff, because the two reasons a daemon fails to start — a broken
    /// install and a port it cannot bind — do not get better by trying harder,
    /// and a tight respawn loop turns either into a busy machine.
    pub fn watch(self: &Arc<Self>, mut on_change: impl FnMut(Watch) + Send + 'static) {
        let daemon = Arc::clone(self);
        std::thread::spawn(move || {
            let mut backoff = Duration::from_secs(1);
            loop {
                std::thread::sleep(Duration::from_secs(1));
                if !daemon.wanted.load(Ordering::SeqCst) {
                    return;
                }
                if daemon.is_running() {
                    backoff = Duration::from_secs(1);
                    continue;
                }

                on_change(Watch::Lost);
                std::thread::sleep(backoff);
                if !daemon.wanted.load(Ordering::SeqCst) {
                    return;
                }
                match daemon.start() {
                    Ok(endpoint) => {
                        backoff = Duration::from_secs(1);
                        on_change(Watch::Restarted(endpoint));
                    }
                    Err(error) => {
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                        on_change(Watch::Failed(error));
                    }
                }
            }
        });
    }
}

/// What the watchdog saw, for the tray and the workbench.
#[derive(Debug, Clone)]
pub enum Watch {
    Lost,
    Restarted(Endpoint),
    Failed(String),
}

/// `POST /shutdown` on the daemon's own listener.
///
/// Hand-rolled rather than pulling in an HTTP client: one request, to loopback,
/// whose only interesting answer is "it arrived".
fn ask_to_stop(endpoint: &Endpoint) {
    let request = format!(
        "POST /shutdown?token={} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        endpoint.token
    );
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", endpoint.port).parse().unwrap(),
        Duration::from_millis(500),
    ) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.write_all(request.as_bytes());
    let mut sink = Vec::new();
    let _ = stream.read_to_end(&mut sink);
}

/// Whether something is answering `/health` on this port.
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

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists() || unsafe { kill_(pid as i32, 0) == 0 }
}

#[cfg(unix)]
fn terminate(pid: u32) {
    const SIGKILL: i32 = 9;
    unsafe {
        kill_(pid as i32, SIGKILL);
    }
}

#[cfg(unix)]
unsafe fn kill_(pid: i32, signal: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, signal)
}

#[cfg(not(unix))]
fn pid_alive(pid: u32) -> bool {
    // Without a cheap probe, let the health check decide: a published endpoint
    // nobody answers is treated as stale either way.
    let _ = pid;
    true
}

#[cfg(not(unix))]
fn terminate(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

fn parse_endpoint(line: &str) -> Option<Endpoint> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("event")?.as_str()? != "listening" {
        return None;
    }
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listening_line_carries_everything_needed_to_connect() {
        let endpoint = parse_endpoint(
            r#"{"event":"listening","port":42123,"token":"abc","machineId":"m_1","fingerprint":"AB-CD"}"#,
        )
        .expect("a listening line should parse");
        assert_eq!(endpoint.port, 42123);
        assert_eq!(
            endpoint.websocket_url(),
            "ws://127.0.0.1:42123/ws?token=abc"
        );
    }

    #[test]
    fn other_output_is_ignored_rather_than_mistaken_for_an_endpoint() {
        assert!(parse_endpoint("starting up").is_none());
        assert!(parse_endpoint(r#"{"event":"something-else","port":1}"#).is_none());
    }

    #[test]
    fn a_published_endpoint_from_a_dead_daemon_is_not_adopted() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A pid that cannot be running: the file outlives the process, and
        // adopting it would leave the shell talking to nothing.
        std::fs::write(
            dir.path().join("endpoint.json"),
            r#"{"port":1,"token":"t","machineId":"m","fingerprint":"f","pid":4294967290}"#,
        )
        .expect("write");
        let daemon = Daemon::new(PathBuf::from("/nonexistent"), dir.path().to_path_buf());
        assert!(daemon.published().is_none());
    }

    #[test]
    fn nothing_answers_on_a_port_nobody_is_listening_on() {
        let free = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = free.local_addr().unwrap().port();
        drop(free);
        assert!(!health(port));
    }
}
