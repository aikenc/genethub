use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use genet_daemon_logic_api::{
    CapabilityEvent, CapabilityFailure, CapabilityFailureKind, CapabilityValue, ConfinementMode,
    ProcessCensusRow, ProcessDialogueStep, ProcessRequest, ProcessSignal, ProcessSpec,
    ProcessStream, MAX_CAPABILITY_CHUNK_BYTES,
};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
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
            ProcessRequest::ResolveProgram { program } => resolve_program(&program)
                .map(|path| CapabilityValue::Text(path.display().to_string()))
                .ok_or_else(|| {
                    failure(
                        CapabilityFailureKind::NotFound,
                        format!("executable is not installed: {program}"),
                    )
                }),
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
            ProcessRequest::Dialogue {
                spec,
                steps,
                timeout_millis,
                max_stdout_bytes,
                max_stderr_bytes,
            } => {
                self.dialogue(
                    roots,
                    spec,
                    steps,
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
            ProcessRequest::Census => census()
                .await
                .map(CapabilityValue::ProcessCensus)
                .ok_or_else(|| {
                    failure(
                        CapabilityFailureKind::Unavailable,
                        "the operating system did not return a process census",
                    )
                }),
            ProcessRequest::EndTree { pid } => {
                end_pid_tree(pid).await?;
                Ok(CapabilityValue::Unit)
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
        let argv = launch_argv(roots, &spec).await?;
        let (program, wrapper_args) = argv.split_first().ok_or_else(|| {
            failure(
                CapabilityFailureKind::Internal,
                "process confinement produced an empty command",
            )
        })?;
        let mut command = Command::new(program);
        command
            .args(wrapper_args)
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
        prepare_child(&mut command);
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
                let _ = kill_tree(&mut child).await;
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
        let argv = launch_argv(roots, &spec).await?;
        let (program, wrapper_args) = argv.split_first().ok_or_else(|| {
            failure(
                CapabilityFailureKind::Internal,
                "process confinement produced an empty command",
            )
        })?;
        let mut command = Command::new(program);
        command
            .args(wrapper_args)
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
        prepare_child(&mut command);
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

    #[allow(clippy::too_many_arguments)]
    async fn dialogue(
        &self,
        roots: &Arc<RwLock<SystemRoots>>,
        spec: ProcessSpec,
        steps: Vec<ProcessDialogueStep>,
        timeout_millis: u32,
        max_stdout_bytes: u32,
        max_stderr_bytes: u32,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        validate_spec(&spec)?;
        if steps.is_empty() || steps.len() > 32 {
            return Err(failure(
                CapabilityFailureKind::Invalid,
                "process dialogue requires 1 through 32 steps",
            ));
        }
        let mut input_bytes = 0usize;
        for step in &steps {
            checked_bytes(&step.stdin)?;
            if step.wait_for_line.is_empty() || step.wait_for_line.len() > 4096 {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    "process dialogue markers must contain 1 through 4096 bytes",
                ));
            }
            input_bytes = input_bytes.saturating_add(step.stdin.len());
        }
        if input_bytes > MAX_CAPABILITY_CHUNK_BYTES {
            return Err(failure(
                CapabilityFailureKind::TooLarge,
                "process dialogue input exceeds the capability chunk limit",
            ));
        }
        let stdout_limit = checked_output_limit(max_stdout_bytes)?;
        let stderr_limit = checked_output_limit(max_stderr_bytes)?;
        if timeout_millis == 0 || timeout_millis > 300_000 {
            return Err(failure(
                CapabilityFailureKind::Invalid,
                "process timeout must be between 1 ms and 5 minutes",
            ));
        }

        let argv = launch_argv(roots, &spec).await?;
        let (program, wrapper_args) = argv.split_first().ok_or_else(|| {
            failure(
                CapabilityFailureKind::Internal,
                "process confinement produced an empty command",
            )
        })?;
        let mut command = Command::new(program);
        command
            .args(wrapper_args)
            .args(&spec.args)
            .envs(&spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
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
        prepare_child(&mut command);
        let mut child = command.spawn().map_err(process_io_failure)?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            failure(
                CapabilityFailureKind::Internal,
                "process stdin was not captured",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            failure(
                CapabilityFailureKind::Internal,
                "process stdout was not captured",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            failure(
                CapabilityFailureKind::Internal,
                "process stderr was not captured",
            )
        })?;
        let stderr_task = tokio::spawn(read_optional_bounded(Some(stderr), stderr_limit));
        let operation = async {
            let mut reader = BufReader::new(stdout);
            let mut output = Vec::new();
            let mut line = Vec::new();
            for step in steps {
                stdin
                    .write_all(&step.stdin)
                    .await
                    .map_err(process_io_failure)?;
                stdin.flush().await.map_err(process_io_failure)?;
                loop {
                    line.clear();
                    let count = reader
                        .read_until(b'\n', &mut line)
                        .await
                        .map_err(process_io_failure)?;
                    if count == 0 {
                        return Err(failure(
                            CapabilityFailureKind::Unavailable,
                            "process dialogue ended before its completion marker",
                        ));
                    }
                    if output.len().saturating_add(count) > stdout_limit {
                        return Err(failure(
                            CapabilityFailureKind::TooLarge,
                            format!("process output exceeds {stdout_limit} bytes"),
                        ));
                    }
                    let complete = line
                        .windows(step.wait_for_line.len())
                        .any(|window| window == step.wait_for_line);
                    output.extend_from_slice(&line);
                    if complete {
                        break;
                    }
                }
            }
            Ok::<_, CapabilityFailure>(output)
        };
        let result =
            tokio::time::timeout(Duration::from_millis(timeout_millis as u64), operation).await;
        drop(stdin);
        let _ = kill_tree(&mut child).await;
        let code = child.wait().await.ok().and_then(|status| status.code());
        let stderr = stderr_task
            .await
            .map_err(|error| failure(CapabilityFailureKind::Internal, error.to_string()))??;
        match result {
            Ok(Ok(stdout)) => Ok(CapabilityValue::ProcessCompleted {
                code,
                stdout,
                stderr,
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(failure(
                CapabilityFailureKind::Unavailable,
                format!("process dialogue timed out after {timeout_millis} ms"),
            )),
        }
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

    pub async fn count(&self) -> usize {
        self.inner.resources.read().await.len()
    }
}

async fn launch_argv(
    roots: &Arc<RwLock<SystemRoots>>,
    spec: &ProcessSpec,
) -> Result<Vec<std::path::PathBuf>, CapabilityFailure> {
    match &spec.confinement {
        ConfinementMode::None => Ok(vec![std::path::PathBuf::from(&spec.program)]),
        ConfinementMode::Workspace { roots: locators } => {
            if locators.is_empty() || locators.len() > 64 {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    "workspace confinement requires 1 through 64 roots",
                ));
            }
            let mut paths = Vec::with_capacity(locators.len());
            for locator in locators {
                paths.push(crate::filesystem::resolve_locator(roots, locator).await?);
            }
            crate::isolation::Policy::for_workspace(&paths)
                .wrap(std::path::Path::new(&spec.program))
                .map_err(|error| failure(CapabilityFailureKind::Unavailable, error.to_string()))
        }
    }
}

const CENSUS_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(unix)]
async fn census() -> Option<Vec<ProcessCensusRow>> {
    let mut command = Command::new("ps");
    command
        .args(["-eo", "pid=,ppid=,pgid=,etime=,args="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(CENSUS_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    output
        .status
        .success()
        .then(|| parse_census(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(not(unix))]
async fn census() -> Option<Vec<ProcessCensusRow>> {
    // Windows has no process groups equivalent to the Unix ownership rule.
    // Returning an honest empty census is safer than guessing from pids.
    Some(Vec::new())
}

fn parse_census(text: &str) -> Vec<ProcessCensusRow> {
    text.lines().filter_map(parse_census_row).collect()
}

fn take_field<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let end = rest.find(char::is_whitespace)?;
    let field = &rest[..end];
    *rest = rest[end..].trim_start();
    Some(field)
}

fn parse_census_row(line: &str) -> Option<ProcessCensusRow> {
    let mut rest = line.trim_start();
    let pid = take_field(&mut rest)?.parse().ok()?;
    let parent_pid = take_field(&mut rest)?.parse().ok()?;
    let group_id = take_field(&mut rest)?.parse().ok()?;
    let running_for_seconds = parse_elapsed(take_field(&mut rest)?)?;
    let command = rest.trim().to_string();
    (!command.is_empty()).then_some(ProcessCensusRow {
        pid,
        parent_pid,
        group_id,
        running_for_seconds,
        command,
    })
}

fn parse_elapsed(field: &str) -> Option<u64> {
    let (days, clock) = match field.split_once('-') {
        Some((days, rest)) => (days.parse::<u64>().ok()?, rest),
        None => (0, field),
    };
    let parts = clock.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds): (u64, u64, u64) = match parts.as_slice() {
        [minutes, seconds] => (0, minutes.parse().ok()?, seconds.parse().ok()?),
        [hours, minutes, seconds] => (
            hours.parse().ok()?,
            minutes.parse().ok()?,
            seconds.parse().ok()?,
        ),
        _ => return None,
    };
    Some(
        days.saturating_mul(86_400)
            .saturating_add(hours.saturating_mul(3_600))
            .saturating_add(minutes.saturating_mul(60))
            .saturating_add(seconds),
    )
}

#[cfg(unix)]
async fn end_pid_tree(pid: u32) -> Result<(), CapabilityFailure> {
    if pid == 0 || pid == std::process::id() {
        return Err(failure(
            CapabilityFailureKind::Invalid,
            "invalid process tree root",
        ));
    }
    let initial_census = census().await.ok_or_else(|| {
        failure(
            CapabilityFailureKind::Unavailable,
            "cannot enumerate the process tree before ending it",
        )
    })?;
    let mut selected = std::collections::HashSet::from([pid]);
    loop {
        let before = selected.len();
        for row in &initial_census {
            if selected.contains(&row.parent_pid) {
                selected.insert(row.pid);
            }
        }
        if selected.len() == before {
            break;
        }
    }
    let mut targets = initial_census
        .iter()
        .filter(|row| selected.contains(&row.pid))
        .map(|row| row.pid)
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Ok(());
    }
    // Descendants first keeps the root alive long enough to retain ownership
    // while its children receive the graceful signal.
    targets.sort_unstable_by(|left, right| right.cmp(left));
    signal_pids("-TERM", &targets).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        let alive = census()
            .await
            .unwrap_or_default()
            .into_iter()
            .any(|row| selected.contains(&row.pid));
        if !alive {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    signal_pids("-KILL", &targets).await;
    Ok(())
}

#[cfg(unix)]
async fn signal_pids(signal: &str, pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    let mut command = Command::new("kill");
    command.arg(signal).arg("--");
    for pid in pids {
        command.arg(pid.to_string());
    }
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let _ = command.status().await;
}

#[cfg(windows)]
async fn end_pid_tree(pid: u32) -> Result<(), CapabilityFailure> {
    let status = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(process_io_failure)?;
    if status.success() {
        Ok(())
    } else {
        Err(failure(
            CapabilityFailureKind::Unavailable,
            format!("could not end process tree {pid}"),
        ))
    }
}

#[cfg(not(any(unix, windows)))]
async fn end_pid_tree(_pid: u32) -> Result<(), CapabilityFailure> {
    Err(failure(
        CapabilityFailureKind::Unavailable,
        "process tree termination is unavailable on this platform",
    ))
}

fn resolve_program(program: &str) -> Option<std::path::PathBuf> {
    if program.is_empty() || program.contains('\0') {
        return None;
    }
    let direct = std::path::PathBuf::from(program);
    if direct.components().count() > 1 || direct.is_absolute() {
        return direct.is_file().then_some(direct);
    }
    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
        .split(';')
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    #[cfg(not(windows))]
    let extensions = vec![String::new()];
    for directory in std::env::split_paths(&path) {
        for extension in &extensions {
            let candidate = if extension.is_empty()
                || program.to_ascii_lowercase().ends_with(extension.as_str())
            {
                directory.join(program)
            } else {
                directory.join(format!("{program}{extension}"))
            };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
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
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let group = format!("-{pid}");
        let status = Command::new("kill")
            .args(["-KILL", "--", &group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(process_io_failure)?;
        if status.success() {
            return Ok(());
        }
    }
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
fn prepare_child(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn prepare_child(command: &mut Command) {
    // Every raw process resource owns one process group. That makes a later
    // KillTree reach descendants even if the direct child has forked them.
    command.process_group(0);
}

#[cfg(not(any(unix, windows)))]
fn prepare_child(_command: &mut Command) {}

pub fn monotonic_millis() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn census_parser_preserves_commands_with_spaces_and_all_elapsed_shapes() {
        let rows = parse_census(
            "  100     1   100    01:02 bash -lc 'npm run dev -- --port 3000'\n\
             101     1   101 3-02:01:30 cargo watch\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].command, "bash -lc 'npm run dev -- --port 3000'");
        assert_eq!(rows[0].running_for_seconds, 62);
        assert_eq!(rows[1].running_for_seconds, 266_490);
        assert_eq!(parse_elapsed("05"), None);
        assert_eq!(parse_elapsed("02:01:30"), Some(7_290));
    }

    #[test]
    fn malformed_census_rows_are_dropped_instead_of_guessed() {
        let rows = parse_census("nonsense\n\n  100 1 100 01:00 sh\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 100);
    }
}
