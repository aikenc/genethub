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

const MAX_LOOPBACK_HTTP_RESPONSE_BYTES: usize = 64 * 1024;
/// Cold `Component::from_binary` of the iterate guest on a hosted Windows
/// runner regularly exceeds one minute. 20s then 60s both lost that race
/// while the process was still healthy (CI #205).
const LISTEN_TIMEOUT: Duration = Duration::from_secs(120);

/// What the daemon prints once it is listening. The port is chosen by the OS,
/// so reading it back is the only way to know where to connect.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub machine_id: String,
    pub fingerprint: String,
}

impl Endpoint {
    fn admission(&self, pid: u32) -> DialEndpoint {
        let challenge = health_challenge(&self.token);
        let expires_at = unix_seconds().saturating_add(15);
        let proof = websocket_proof(
            &self.token,
            &challenge,
            pid,
            &self.machine_id,
            &self.fingerprint,
            expires_at,
        );
        DialEndpoint {
            port: self.port,
            url: format!(
                "ws://127.0.0.1:{}/ws?challenge={challenge}&pid={pid}&expiresAt={expires_at}&proof={proof}",
                self.port
            ),
            machine_id: self.machine_id.clone(),
            fingerprint: self.fingerprint.clone(),
            pid,
            challenge: challenge.clone(),
            expires_at,
            server_proof: websocket_server_proof(
                &self.token,
                &challenge,
                pid,
                &self.machine_id,
                &self.fingerprint,
                expires_at,
            ),
        }
    }
}

/// What may cross the Tauri IPC boundary. The long-lived endpoint token never
/// does; every call mints a fresh, one-use WS admission instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialEndpoint {
    pub port: u16,
    pub url: String,
    pub machine_id: String,
    pub fingerprint: String,
    pub pid: u32,
    pub challenge: String,
    pub expires_at: u64,
    /// Domain-separated listener proof delivered through Tauri IPC, never URL.
    pub server_proof: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    pid: u32,
    machine_id: String,
    fingerprint: String,
    proof: String,
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

    pub fn dial_endpoint(&self) -> Option<DialEndpoint> {
        let pid = self
            .child
            .lock()
            .expect("daemon lock")
            .as_ref()
            .map(std::process::Child::id)
            .or_else(|| *self.adopted_pid.lock().expect("pid lock"))?;
        let endpoint = self.endpoint()?;
        health(&endpoint, pid).then(|| endpoint.admission(pid))
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
        // The daemon is the wasm component under the native shell. When the
        // pair sits beside the CLI (the install layout), spawn the shell
        // directly: the pid we then hold is the pid that holds the listener,
        // with no `daemon run` exec in between. A CLI without the pair still
        // goes through `daemon run`, which either finds them or fails closed.
        let sibling = |name: &str| {
            self.binary
                .parent()
                .map(|dir| dir.join(name))
                .filter(|path| path.is_file())
        };
        let host_name = if cfg!(windows) {
            format!("{}.exe", crate::channel::HOST_BINARY)
        } else {
            crate::channel::HOST_BINARY.to_string()
        };
        let mut command = match (sibling(&host_name), sibling("genehub_guest.wasm")) {
            (Some(host), Some(component)) => {
                let mut command = Command::new(host);
                command.args(["run", "--component"]).arg(component);
                // The shell hands this to the guest as GENEHUB_CLI, the front
                // door the agent entry is reached through.
                command.env(crate::channel::ENV_CLI, &self.binary);
                command
            }
            _ => {
                let mut command = Command::new(&self.binary);
                command.args(["daemon", "run"]);
                command
            }
        };
        command
            .env(crate::channel::ENV_DATA_DIR, &self.data_dir)
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
        // The listening line deliberately has no bearer; after it arrives the
        // shell reads the owner-only endpoint file and verifies its identity.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if is_listening(&line) {
                    let _ = tx.send(());
                    return;
                }
            }
        });

        // The resident shell compiles the component in memory on every cold
        // start. Constrained Windows runners can spend more than a minute
        // here even though the process is healthy.
        match rx.recv_timeout(LISTEN_TIMEOUT) {
            Ok(()) => {
                let (endpoint, published_pid) = self
                    .published()
                    .ok_or_else(|| "daemon 发布的私有 endpoint 无法验证".to_string())?;
                if published_pid != child.id() {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("daemon 发布了另一个进程的 endpoint".to_string());
                }
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

    /// Where anything the daemon says outside its own log goes.
    ///
    /// The daemon writes `logs/daemon.log` itself, and does not also write to a
    /// piped stderr, so this file holds only the things that happen before or
    /// outside logging: a panic, a loader error, a data directory it cannot
    /// create. Those are precisely the failures where the log is empty.
    ///
    /// Truncated per start, because it is about this launch. Missing is not worth
    /// failing over: no log is better than no daemon.
    fn log(&self) -> Option<std::fs::File> {
        let dir = self.data_dir.join("logs");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("startup.log");
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok()?;
        }
        Some(file)
    }

    /// The last thing the daemon said before it gave up, if it said anything.
    ///
    /// Both files: a process that died before logging left its reason on stderr,
    /// and one that died after left it in the log.
    fn last_words(&self) -> Option<String> {
        let dir = self.data_dir.join("logs");
        let text = [dir.join("startup.log"), dir.join("daemon.log")]
            .iter()
            .filter_map(|path| std::fs::read_to_string(path).ok())
            .collect::<Vec<_>>()
            .join("\n");
        let tail: Vec<&str> = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
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
        let endpoint = Endpoint {
            port: found.port,
            token: found.token,
            machine_id: found.machine_id,
            fingerprint: found.fingerprint,
        };
        (pid_alive(found.pid) && health(&endpoint, found.pid)).then_some((endpoint, found.pid))
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
        let pid = self
            .child
            .lock()
            .expect("daemon lock")
            .as_ref()
            .map(std::process::Child::id)
            .or_else(|| *self.adopted_pid.lock().expect("pid lock"));
        self.endpoint()
            .zip(pid)
            .is_some_and(|(endpoint, pid)| health(&endpoint, pid))
    }

    fn forget(&self) {
        *self.child.lock().expect("daemon lock") = None;
        *self.endpoint.lock().expect("endpoint lock") = None;
        *self.origin.lock().expect("origin lock") = None;
        *self.adopted_pid.lock().expect("pid lock") = None;
    }

    /// Brings the daemon back after a crash, returning the new endpoint.
    ///
    /// The port and private key both change, so whoever calls this has to tell
    /// the workbench to request a new one-use admission.
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

        let expected_pid = child.as_ref().map(std::process::Child::id).or(adopted);
        if let (Some(endpoint), Some(pid)) = (endpoint.as_ref(), expected_pid) {
            // Do not send the private bearer to whatever happened to inherit a
            // stale loopback port. The listener first proves it already knows
            // that bearer, bound to this pid and machine identity.
            if !health(endpoint, pid) {
                if child.is_none() {
                    return;
                }
            } else {
                ask_to_stop(endpoint, pid);
            }
        }

        for _ in 0..40 {
            let gone = match (child.as_mut(), adopted) {
                (Some(child), _) => matches!(child.try_wait(), Ok(Some(_))),
                (None, Some(pid)) => endpoint.as_ref().is_none_or(|e| !health(e, pid)),
                (None, None) => true,
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
        } else if let (Some(pid), Some(endpoint)) = (adopted, endpoint.as_ref()) {
            // Re-check immediately before the destructive fallback. If the
            // daemon exited and the pid was reused during the grace period,
            // the new process cannot answer this bearer-bound challenge.
            if health(endpoint, pid) {
                terminate(pid);
            }
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
fn ask_to_stop(endpoint: &Endpoint, pid: u32) {
    let challenge = health_challenge(&endpoint.token);
    let expires_at = unix_seconds().saturating_add(15);
    let proof = shutdown_proof(
        &endpoint.token,
        &challenge,
        pid,
        &endpoint.machine_id,
        &endpoint.fingerprint,
        expires_at,
    );
    let request = format!(
        "POST /shutdown?challenge={challenge}&pid={pid}&expiresAt={expires_at}&proof={proof} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
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
    let _ = read_loopback_response(&mut stream);
}

/// Whether the exact private endpoint owns this listener.
fn health(endpoint: &Endpoint, pid: u32) -> bool {
    let challenge = health_challenge(&endpoint.token);
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
    let Ok(answer) = read_loopback_response(&mut stream) else {
        return false;
    };
    let Some(body) = http_ok_body(&answer) else {
        return false;
    };
    let Ok(found) = serde_json::from_slice::<Health>(body) else {
        return false;
    };
    let expected = health_proof(
        &endpoint.token,
        &challenge,
        pid,
        &endpoint.machine_id,
        &endpoint.fingerprint,
    );
    found.pid == pid
        && found.machine_id == endpoint.machine_id
        && found.fingerprint == endpoint.fingerprint
        && constant_time_eq(&expected, &found.proof)
}

/// Reads a complete supervision response without trusting a loopback process
/// to respect either Content-Length or the connection deadline. A different
/// same-user process can own the stale port, so timeout alone is not a memory
/// bound: a fast writer can send far more than expected before it expires.
fn read_loopback_response(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut answer = Vec::new();
    reader
        .take((MAX_LOOPBACK_HTTP_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut answer)?;
    if answer.len() > MAX_LOOPBACK_HTTP_RESPONSE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "loopback supervision response exceeds 64 KiB",
        ));
    }
    Ok(answer)
}

fn health_challenge(token: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes())
        .expect("HMAC accepts every bearer length");
    mac.update(b"genehub-loopback-challenge-v1");
    mac.update(&std::process::id().to_be_bytes());
    mac.update(&nanos.to_be_bytes());
    mac.update(&sequence.to_be_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn health_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> String {
    control_proof(token, b"health", challenge, pid, machine_id, fingerprint)
}

fn shutdown_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"shutdown",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

fn websocket_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"websocket",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

fn websocket_server_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"websocket-server",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

fn expiring_control_proof(
    token: &str,
    action: &[u8],
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes())
        .expect("HMAC accepts every bearer length");
    for field in [
        b"genehub-loopback-control-v1".as_slice(),
        action,
        challenge.as_bytes(),
        &pid.to_be_bytes(),
        machine_id.as_bytes(),
        fingerprint.as_bytes(),
        &expires_at.to_be_bytes(),
    ] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field);
    }
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn control_proof(
    token: &str,
    action: &[u8],
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes())
        .expect("HMAC accepts every bearer length");
    for field in [
        b"genehub-loopback-control-v1".as_slice(),
        action,
        challenge.as_bytes(),
        &pid.to_be_bytes(),
        machine_id.as_bytes(),
        fingerprint.as_bytes(),
    ] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field);
    }
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn constant_time_eq(expected: &str, presented: &str) -> bool {
    expected.len() == presented.len()
        && expected
            .bytes()
            .zip(presented.bytes())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
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

fn is_listening(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("event").cloned())
        .and_then(|event| event.as_str().map(str::to_owned))
        .as_deref()
        == Some("listening")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(port: u16) -> Endpoint {
        Endpoint {
            port,
            token: "private-token".into(),
            machine_id: "machine-expected".into(),
            fingerprint: "fingerprint-expected".into(),
        }
    }

    fn serve_fake_health(body: &'static str) -> (u16, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let _ = socket.read(&mut request);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).unwrap();
        });
        (port, task)
    }

    #[test]
    fn the_listening_line_is_only_a_readiness_signal() {
        assert!(is_listening(
            r#"{"event":"listening","port":42123,"url":"ws://127.0.0.1:42123/ws?proof=one-use","machineId":"m_1","fingerprint":"AB-CD"}"#,
        ));
    }

    #[test]
    fn other_output_is_ignored_rather_than_mistaken_for_an_endpoint() {
        assert!(!is_listening("starting up"));
        assert!(!is_listening(r#"{"event":"something-else","port":1}"#));
    }

    #[test]
    fn a_desktop_admission_never_exposes_the_private_token() {
        let endpoint = endpoint(42123);
        let dial = endpoint.admission(99);
        assert_eq!(dial.port, 42123);
        assert!(dial.url.contains("/ws?challenge="));
        assert!(dial.url.contains("&pid=99&expiresAt="));
        assert!(dial.url.contains("&proof="));
        assert!(!dial.url.contains(&endpoint.token));
        assert!(!dial.url.contains("token="));
        assert!(!dial.url.contains(&dial.server_proof));
        assert_eq!(dial.pid, 99);
        assert_eq!(dial.machine_id, "machine-expected");
        assert_eq!(dial.fingerprint, "fingerprint-expected");
        assert!(dial.expires_at > unix_seconds());
        assert_eq!(dial.challenge.len(), 64);
        assert_eq!(dial.server_proof.len(), 64);
        let ipc = serde_json::to_string(&dial).unwrap();
        assert!(!ipc.contains(&endpoint.token));
        assert!(!ipc.contains("\"token\""));
    }

    #[test]
    fn websocket_proof_matches_the_daemon_contract() {
        assert_eq!(
            websocket_proof(
                "token-1",
                "challenge-1",
                42,
                "machine-1",
                "fingerprint-1",
                1_234_567_890,
            ),
            "cb10c4c41a54062a453ddd359fd970815064e19ac5a5e2c511103a924129c3c7"
        );
        assert_eq!(
            websocket_server_proof(
                "token-1",
                "challenge-1",
                42,
                "machine-1",
                "fingerprint-1",
                1_234_567_890,
            ),
            "6b02a83a6c67e128a762565b92b7184874e9eb806269581b35c8c05f13e3e5c2",
        );
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
        assert!(!health(&endpoint(port), std::process::id()));
    }

    #[test]
    fn an_unrelated_200_listener_is_not_adopted_even_if_the_stale_pid_is_live() {
        let (port, server) = serve_fake_health(
            r#"{"pid":1,"machineId":"wrong","fingerprint":"wrong","proof":"wrong"}"#,
        );
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("endpoint.json"),
            serde_json::json!({
                "port": port,
                "token": "private-token",
                "machineId": "machine-expected",
                "fingerprint": "fingerprint-expected",
                "pid": std::process::id(),
            })
            .to_string(),
        )
        .unwrap();
        let daemon = Daemon::new(PathBuf::from("/nonexistent"), dir.path().to_path_buf());
        assert!(daemon.published().is_none());
        server.join().unwrap();
    }

    #[test]
    fn stop_never_terminates_a_reused_adopted_pid_without_endpoint_proof() {
        let (port, server) = serve_fake_health(
            r#"{"pid":1,"machineId":"wrong","fingerprint":"wrong","proof":"wrong"}"#,
        );
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(PathBuf::from("/nonexistent"), dir.path().to_path_buf());
        *daemon.endpoint.lock().unwrap() = Some(endpoint(port));
        // If stop trusted liveness alone, this would terminate the test runner
        // itself (and on Windows taskkill its whole process tree).
        *daemon.adopted_pid.lock().unwrap() = Some(std::process::id());
        daemon.stop();
        server.join().unwrap();
        assert!(!daemon.is_running());
    }

    #[test]
    fn shutdown_never_sends_the_private_endpoint_bearer() {
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
        let endpoint = endpoint(port);
        ask_to_stop(&endpoint, std::process::id());
        let request = received.recv().unwrap();
        assert!(request.starts_with("POST /shutdown?challenge="));
        assert!(request.contains("&expiresAt="));
        assert!(request.contains("&proof="));
        assert!(!request.contains(&endpoint.token));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        server.join().unwrap();
    }

    #[test]
    fn loopback_supervision_responses_have_a_hard_memory_limit() {
        let mut exact = std::io::Cursor::new(vec![b'x'; MAX_LOOPBACK_HTTP_RESPONSE_BYTES]);
        assert_eq!(
            read_loopback_response(&mut exact).unwrap().len(),
            MAX_LOOPBACK_HTTP_RESPONSE_BYTES
        );

        let mut oversized = std::io::Cursor::new(vec![b'x'; MAX_LOOPBACK_HTTP_RESPONSE_BYTES + 1]);
        let error = read_loopback_response(&mut oversized).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
