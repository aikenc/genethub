use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use genet_daemon_logic_api::{
    CapabilityEvent, CapabilityFailure, CapabilityFailureKind, CapabilityValue, PtyRequest,
    MAX_CAPABILITY_CHUNK_BYTES,
};
use portable_pty::{ChildKiller, CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tokio::sync::{mpsc, Mutex, OwnedSemaphorePermit, Semaphore};

use crate::failure;
use crate::filesystem::SystemRoots;

const MAX_TERMINALS: usize = 32;
const MAX_DIMENSION: u16 = 1000;

#[derive(Clone)]
pub struct Ptys {
    inner: Arc<Inner>,
}

struct Inner {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, Arc<Terminal>>>,
    permits: Arc<Semaphore>,
    events: mpsc::Sender<CapabilityEvent>,
}

struct Terminal {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    closed: Arc<AtomicBool>,
    _permit: OwnedSemaphorePermit,
}

impl Ptys {
    pub fn new(events: mpsc::Sender<CapabilityEvent>) -> Self {
        Self {
            inner: Arc::new(Inner {
                next_id: AtomicU64::new(1),
                sessions: Mutex::new(HashMap::new()),
                permits: Arc::new(Semaphore::new(MAX_TERMINALS)),
                events,
            }),
        }
    }

    pub async fn execute(
        &self,
        roots: &Arc<tokio::sync::RwLock<SystemRoots>>,
        request: PtyRequest,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        match request {
            PtyRequest::Open {
                cwd,
                cols,
                rows,
                env,
            } => {
                let cwd = crate::filesystem::resolve_locator(roots, &cwd).await?;
                self.open(&cwd, cols, rows, env).await
            }
            PtyRequest::Write { resource_id, bytes } => {
                if bytes.len() > MAX_CAPABILITY_CHUNK_BYTES {
                    return Err(failure(
                        CapabilityFailureKind::TooLarge,
                        "PTY input exceeds the capability chunk limit",
                    ));
                }
                let terminal = self.get(resource_id).await?;
                let mut writer = terminal.writer.lock().await;
                writer.write_all(&bytes).map_err(pty_failure)?;
                writer.flush().map_err(pty_failure)?;
                Ok(CapabilityValue::Unit)
            }
            PtyRequest::Resize {
                resource_id,
                cols,
                rows,
            } => {
                validate_dimensions(cols, rows)?;
                let terminal = self.get(resource_id).await?;
                terminal
                    .master
                    .lock()
                    .await
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|error| {
                        failure(CapabilityFailureKind::Unavailable, error.to_string())
                    })?;
                Ok(CapabilityValue::Unit)
            }
            PtyRequest::Close { resource_id } => {
                if let Some(terminal) = self.inner.sessions.lock().await.remove(&resource_id) {
                    terminal.killer.lock().await.kill().map_err(pty_failure)?;
                }
                Ok(CapabilityValue::Unit)
            }
        }
    }

    async fn open(
        &self,
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
        env: std::collections::BTreeMap<String, String>,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        validate_dimensions(cols, rows)?;
        let cwd = cwd.canonicalize().map_err(pty_failure)?;
        if !cwd.is_dir() {
            return Err(failure(
                CapabilityFailureKind::Invalid,
                format!("PTY cwd is not a directory: {}", cwd.display()),
            ));
        }
        self.inner
            .sessions
            .lock()
            .await
            .retain(|_, terminal| !terminal.closed.load(Ordering::Acquire));
        let permit = self
            .inner
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                failure(
                    CapabilityFailureKind::Unavailable,
                    "too many terminals are already open",
                )
            })?;
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| failure(CapabilityFailureKind::Unavailable, error.to_string()))?;
        let mut command = CommandBuilder::new(default_shell());
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        for (key, value) in env {
            if key.contains('\0') || value.contains('\0') {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    "PTY environment contains NUL",
                ));
            }
            command.env(key, value);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| failure(CapabilityFailureKind::Unavailable, error.to_string()))?;
        let killer = child.clone_killer();
        drop(pair.slave);

        let resource_id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| failure(CapabilityFailureKind::Unavailable, error.to_string()))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| failure(CapabilityFailureKind::Unavailable, error.to_string()))?;
        let closed = Arc::new(AtomicBool::new(false));
        self.inner.sessions.lock().await.insert(
            resource_id,
            Arc::new(Terminal {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
                killer: Mutex::new(killer),
                closed: closed.clone(),
                _permit: permit,
            }),
        );

        let output = self.inner.events.clone();
        std::thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if output
                            .blocking_send(CapabilityEvent::PtyOutput {
                                resource_id,
                                bytes: buffer[..count].to_vec(),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });

        let events = self.inner.events.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            closed.store(true, Ordering::Release);
            let _ = events.blocking_send(CapabilityEvent::PtyClosed { resource_id, code });
        });
        Ok(CapabilityValue::Resource { resource_id })
    }

    async fn get(&self, resource_id: u64) -> Result<Arc<Terminal>, CapabilityFailure> {
        let mut sessions = self.inner.sessions.lock().await;
        let terminal = sessions.get(&resource_id).cloned();
        if terminal
            .as_ref()
            .is_some_and(|terminal| terminal.closed.load(Ordering::Acquire))
        {
            sessions.remove(&resource_id);
            return Err(failure(
                CapabilityFailureKind::NotFound,
                format!("no PTY resource {resource_id}"),
            ));
        }
        terminal.ok_or_else(|| {
            failure(
                CapabilityFailureKind::NotFound,
                format!("no PTY resource {resource_id}"),
            )
        })
    }

    pub async fn close_all(&self) {
        let terminals = self
            .inner
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, terminal)| terminal)
            .collect::<Vec<_>>();
        for terminal in terminals {
            let _ = terminal.killer.lock().await.kill();
        }
    }
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), CapabilityFailure> {
    if cols == 0 || rows == 0 || cols > MAX_DIMENSION || rows > MAX_DIMENSION {
        return Err(failure(
            CapabilityFailureKind::Invalid,
            format!("terminal dimensions must be between 1 and {MAX_DIMENSION}"),
        ));
    }
    Ok(())
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

fn pty_failure(error: std::io::Error) -> CapabilityFailure {
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
