use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use genet_daemon_logic_api::{
    CapabilityEvent, CapabilityFailure, CapabilityFailureKind, CapabilityValue, ProcessRequest,
    ProcessSignal, ProcessSpec, ProcessStream, MAX_CAPABILITY_CHUNK_BYTES,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::failure;
use crate::filesystem::SystemRoots;

#[derive(Clone)]
pub struct Processes {
    inner: Arc<Inner>,
}

struct Inner {
    next_id: AtomicU64,
    resources: RwLock<HashMap<u64, Arc<Resource>>>,
    events: mpsc::Sender<CapabilityEvent>,
}

struct Resource {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    readers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl Processes {
    pub fn new(events: mpsc::Sender<CapabilityEvent>) -> Self {
        Self {
            inner: Arc::new(Inner {
                next_id: AtomicU64::new(1),
                resources: RwLock::new(HashMap::new()),
                events,
            }),
        }
    }

    pub async fn execute(
        &self,
        roots: &Arc<RwLock<SystemRoots>>,
        request: ProcessRequest,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        match request {
            ProcessRequest::Run {
                spec,
                stdin,
                timeout_millis,
                max_stdout_bytes,
                max_stderr_bytes,
            } => {
                self.run(
                    roots,
                    spec,
                    stdin,
                    timeout_millis,
                    max_stdout_bytes,
                    max_stderr_bytes,
                )
                .await
            }
            ProcessRequest::Spawn(spec) => self.spawn(roots, spec).await,
            ProcessRequest::Write { resource_id, bytes } => {
                checked_bytes(&bytes)?;
                let resource = self.resource(resource_id).await?;
                let mut stdin = resource.stdin.lock().await;
                let stdin = stdin.as_mut().ok_or_else(|| {
                    failure(
                        CapabilityFailureKind::Conflict,
                        format!("process {resource_id} stdin is closed"),
                    )
                })?;
                stdin.write_all(&bytes).await.map_err(process_io_failure)?;
                stdin.flush().await.map_err(process_io_failure)?;
                Ok(CapabilityValue::Unit)
            }
            ProcessRequest::CloseInput { resource_id } => {
                let resource = self.resource(resource_id).await?;
                resource.stdin.lock().await.take();
                Ok(CapabilityValue::Unit)
            }
            ProcessRequest::Signal {
                resource_id,
                signal,
            } => {
                let resource = self.resource(resource_id).await?;
                signal_process(&resource, signal).await?;
                Ok(CapabilityValue::Unit)
            }
            ProcessRequest::Poll { resource_id } => {
                let resource = self.resource(resource_id).await?;
                let mut child = resource.child.lock().await;
                match child.try_wait().map_err(process_io_failure)? {
                    Some(status) => Ok(CapabilityValue::ProcessExit {
                        code: status.code(),
                    }),
                    None => Ok(CapabilityValue::Unit),
                }
            }
        }
    }

    async fn run(
        &self,
        roots: &Arc<RwLock<SystemRoots>>,
        spec: ProcessSpec,
        stdin: Vec<u8>,
        timeout_millis: u32,
        max_stdout_bytes: u32,
        max_stderr_bytes: u32,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        validate_spec(&spec)?;
        checked_bytes(&stdin)?;
        let stdout_limit = checked_output_limit(max_stdout_bytes)?;
        let stderr_limit = checked_output_limit(max_stderr_bytes)?;
        if timeout_millis == 0 || timeout_millis > 300_000 {
            return Err(failure(
                CapabilityFailureKind::Invalid,
                "process timeout must be between 1 ms and 5 minutes",
            ));
        }
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .envs(&spec.env)
            .stdin(if stdin.is_empty() {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .stdout(if spec.capture_stdout {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(if spec.capture_stderr {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .kill_on_drop(true);
        if let Some(cwd) = &spec.cwd {
            let cwd = crate::filesystem::resolve_locator(roots, cwd).await?;
            if !std::fs::metadata(&cwd)
                .map_err(process_io_failure)?
                .is_dir()
            {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    format!("process cwd is not a directory: {}", cwd.display()),
                ));
            }
            command.current_dir(cwd);
        }
        without_window(&mut command);
        let mut child = command.spawn().map_err(process_io_failure)?;
        let mut child_stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let operation = async {
            let write = async move {
                if let Some(mut writer) = child_stdin.take() {
                    writer.write_all(&stdin).await.map_err(process_io_failure)?;
                    writer.shutdown().await.map_err(process_io_failure)?;
                }
                Ok::<(), CapabilityFailure>(())
            };
            let stdout = read_optional_bounded(stdout, stdout_limit);
            let stderr = read_optional_bounded(stderr, stderr_limit);
            let wait = async {
                child
                    .wait()
                    .await
                    .map_err(process_io_failure)
                    .map(|status| status.code())
            };
            let (_, stdout, stderr, code) = tokio::try_join!(write, stdout, stderr, wait)?;
            Ok::<_, CapabilityFailure>((stdout, stderr, code))
        };
        match tokio::time::timeout(Duration::from_millis(timeout_millis as u64), operation).await {
            Ok(Ok((stdout, stderr, code))) => Ok(CapabilityValue::ProcessCompleted {
                code,
                stdout,
                stderr,
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => {
                let _ = child.start_kill();
                Err(failure(
                    CapabilityFailureKind::Unavailable,
                    format!("process timed out after {timeout_millis} ms"),
                ))
            }
        }
    }

    async fn spawn(
        &self,
        roots: &Arc<RwLock<SystemRoots>>,
        spec: ProcessSpec,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        validate_spec(&spec)?;
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .envs(&spec.env)
            .stdin(Stdio::piped())
            .stdout(if spec.capture_stdout {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(if spec.capture_stderr {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .kill_on_drop(true);
        if let Some(cwd) = &spec.cwd {
            let cwd = crate::filesystem::resolve_locator(roots, cwd).await?;
            let metadata = std::fs::metadata(&cwd).map_err(process_io_failure)?;
            if !metadata.is_dir() {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    format!("process cwd is not a directory: {}", cwd.display()),
                ));
            }
            command.current_dir(cwd);
        }
        without_window(&mut command);
        let mut child = command.spawn().map_err(process_io_failure)?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let resource_id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let resource = Arc::new(Resource {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            readers: Mutex::new(Vec::new()),
        });
        self.inner
            .resources
            .write()
            .await
            .insert(resource_id, resource.clone());

        let mut readers = Vec::new();
        if let Some(stdout) = stdout {
            readers.push(tokio::spawn(read_output(
                self.inner.events.clone(),
                resource_id,
                ProcessStream::Stdout,
                stdout,
            )));
        }
        if let Some(stderr) = stderr {
            readers.push(tokio::spawn(read_output(
                self.inner.events.clone(),
                resource_id,
                ProcessStream::Stderr,
                stderr,
            )));
        }
        *resource.readers.lock().await = readers;
        tokio::spawn(watch_exit(self.inner.clone(), resource_id));
        Ok(CapabilityValue::ProcessStarted { resource_id, pid })
    }

    async fn resource(&self, resource_id: u64) -> Result<Arc<Resource>, CapabilityFailure> {
        self.inner
            .resources
            .read()
            .await
            .get(&resource_id)
            .cloned()
            .ok_or_else(|| {
                failure(
                    CapabilityFailureKind::NotFound,
                    format!("no process resource {resource_id}"),
                )
            })
    }

    pub async fn close_all(&self) {
        let resources = self
            .inner
            .resources
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for resource in resources {
            let _ = signal_process(&resource, ProcessSignal::KillTree).await;
        }
        self.inner.resources.write().await.clear();
    }
}

async fn read_output(
    events: mpsc::Sender<CapabilityEvent>,
    resource_id: u64,
    stream: ProcessStream,
    mut input: impl AsyncRead + Unpin,
) {
    let mut buffer = vec![0_u8; 32 * 1024];
    loop {
        match input.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                if events
                    .send(CapabilityEvent::ProcessOutput {
                        resource_id,
                        stream,
                        bytes: buffer[..read].to_vec(),
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

async fn watch_exit(inner: Arc<Inner>, resource_id: u64) {
    loop {
        let resource = match inner.resources.read().await.get(&resource_id).cloned() {
            Some(resource) => resource,
            None => return,
        };
        let status = resource.child.lock().await.try_wait();
        match status {
            Ok(Some(status)) => {
                resource.stdin.lock().await.take();
                for reader in std::mem::take(&mut *resource.readers.lock().await) {
                    let _ = reader.await;
                }
                inner.resources.write().await.remove(&resource_id);
                let _ = inner
                    .events
                    .send(CapabilityEvent::ProcessExited {
                        resource_id,
                        code: status.code(),
                    })
                    .await;
                return;
            }
            Ok(None) => tokio::time::sleep(Duration::from_millis(25)).await,
            Err(_) => {
                inner.resources.write().await.remove(&resource_id);
                let _ = inner
                    .events
                    .send(CapabilityEvent::ProcessExited {
                        resource_id,
                        code: None,
                    })
                    .await;
                return;
            }
        }
    }
}

async fn signal_process(
    resource: &Arc<Resource>,
    signal: ProcessSignal,
) -> Result<(), CapabilityFailure> {
    let mut child = resource.child.lock().await;
    match signal {
        ProcessSignal::Interrupt => interrupt(&mut child).await,
        ProcessSignal::Terminate => child.start_kill().map_err(process_io_failure),
        ProcessSignal::KillTree => kill_tree(&mut child).await,
    }
}

#[cfg(unix)]
async fn interrupt(child: &mut Child) -> Result<(), CapabilityFailure> {
    let pid = child.id().ok_or_else(|| {
        failure(
            CapabilityFailureKind::NotFound,
            "process has already exited",
        )
    })?;
    // Tokio exposes no portable interrupt operation. Sending SIGINT to the
    // exact pid is a raw OS capability, not guest policy.
    let status = tokio::process::Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status()
        .await
        .map_err(process_io_failure)?;
    if !status.success() {
        return Err(failure(
            CapabilityFailureKind::Unavailable,
            format!("could not interrupt process {pid}"),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
async fn interrupt(child: &mut Child) -> Result<(), CapabilityFailure> {
    child.start_kill().map_err(process_io_failure)
}

async fn kill_tree(child: &mut Child) -> Result<(), CapabilityFailure> {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    child.start_kill().map_err(process_io_failure)
}

fn validate_spec(spec: &ProcessSpec) -> Result<(), CapabilityFailure> {
    if spec.program.trim().is_empty() || spec.program.contains('\0') {
        return Err(failure(
            CapabilityFailureKind::Invalid,
            "process program is empty or contains NUL",
        ));
    }
    if spec.args.len() > 4096 || spec.env.len() > 1024 {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "process argument or environment count exceeds its limit",
        ));
    }
    let bytes = spec.program.len()
        + spec.args.iter().map(String::len).sum::<usize>()
        + spec
            .env
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>();
    if bytes > MAX_CAPABILITY_CHUNK_BYTES {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "process specification exceeds the capability chunk limit",
        ));
    }
    if spec
        .args
        .iter()
        .chain(spec.env.keys())
        .chain(spec.env.values())
        .any(|value| value.contains('\0'))
    {
        return Err(failure(
            CapabilityFailureKind::Invalid,
            "process arguments and environment may not contain NUL",
        ));
    }
    Ok(())
}

fn checked_bytes(bytes: &[u8]) -> Result<(), CapabilityFailure> {
    if bytes.len() > MAX_CAPABILITY_CHUNK_BYTES {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "process write exceeds the capability chunk limit",
        ));
    }
    Ok(())
}

fn checked_output_limit(limit: u32) -> Result<usize, CapabilityFailure> {
    let limit = limit as usize;
    if limit == 0 || limit > MAX_CAPABILITY_CHUNK_BYTES {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "process output limit is empty or exceeds the capability chunk limit",
        ));
    }
    Ok(limit)
}

async fn read_optional_bounded(
    input: Option<impl AsyncRead + Unpin>,
    limit: usize,
) -> Result<Vec<u8>, CapabilityFailure> {
    let Some(mut input) = input else {
        return Ok(Vec::new());
    };
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = input.read(&mut buffer).await.map_err(process_io_failure)?;
        if count == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(count) > limit {
            return Err(failure(
                CapabilityFailureKind::TooLarge,
                format!("process output exceeds {limit} bytes"),
            ));
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

fn process_io_failure(error: std::io::Error) -> CapabilityFailure {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound => CapabilityFailureKind::NotFound,
        std::io::ErrorKind::PermissionDenied => CapabilityFailureKind::Denied,
        std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData => {
            CapabilityFailureKind::Invalid
        }
        _ => CapabilityFailureKind::Unavailable,
    };
    failure(kind, error.to_string())
}

#[cfg(windows)]
fn without_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn without_window(_command: &mut Command) {}

pub fn monotonic_millis() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
