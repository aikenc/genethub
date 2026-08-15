//! Native resource drivers behind the daemon's portable application.
//!
//! This crate intentionally has no GeneHub request router, session manager,
//! provider catalogue or update policy. It validates capability-shaped values,
//! owns opaque OS handles and moves bounded bytes. Product decisions remain in
//! the signed Wasm application.

mod filesystem;
mod http;
mod process;
mod pty;
mod rtc;
mod socket;

use std::path::PathBuf;
use std::sync::Arc;

use genet_daemon_logic_api::{
    CapabilityBatch, CapabilityCall, CapabilityEvent, CapabilityFailure, CapabilityFailureKind,
    CapabilityRequest, CapabilityResult, CapabilityResults, CapabilityValue, LogicArtifactRequest,
    MAX_CAPABILITY_BATCH,
};
use tokio::sync::{mpsc, RwLock};

pub use filesystem::SystemRoots;

/// Process-wide native resources for one daemon application instance.
/// Resources survive guest hot replacement; a restored guest keeps using the
/// same opaque ids from its snapshot.
pub struct SystemHost {
    roots: Arc<RwLock<SystemRoots>>,
    file_locks: filesystem::FileLocks,
    processes: process::Processes,
    terminals: pty::Ptys,
    rtc: rtc::RtcPeers,
    sockets: socket::Sockets,
    events: std::sync::Mutex<Option<mpsc::Receiver<CapabilityEvent>>>,
}

impl SystemHost {
    pub fn new(private: impl Into<PathBuf>, logs: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let roots = SystemRoots::new(private.into(), logs.into())?;
        let (event_tx, events) = mpsc::channel(2048);
        Ok(Self {
            roots: Arc::new(RwLock::new(roots)),
            file_locks: filesystem::FileLocks::default(),
            processes: process::Processes::new(event_tx.clone()),
            terminals: pty::Ptys::new(event_tx.clone()),
            sockets: socket::Sockets::new(event_tx.clone()),
            rtc: rtc::RtcPeers::new(event_tx),
            events: std::sync::Mutex::new(Some(events)),
        })
    }

    /// The VM driver is the sole ordered consumer. A second consumer would
    /// create nondeterministic ownership of process/PTY bytes, so it is
    /// rejected instead of silently splitting the stream.
    pub fn take_events(&self) -> anyhow::Result<mpsc::Receiver<CapabilityEvent>> {
        self.events
            .lock()
            .map_err(|_| anyhow::anyhow!("capability event lock poisoned"))?
            .take()
            .ok_or_else(|| anyhow::anyhow!("capability event receiver was already taken"))
    }

    pub async fn execute(&self, batch: CapabilityBatch) -> CapabilityResults {
        if batch.calls.len() > MAX_CAPABILITY_BATCH {
            return CapabilityResults {
                batch_id: batch.batch_id,
                results: batch
                    .calls
                    .into_iter()
                    .map(|call| CapabilityResult {
                        call_id: call.call_id,
                        result: Err(failure(
                            CapabilityFailureKind::TooLarge,
                            format!("capability batch has more than {MAX_CAPABILITY_BATCH} calls"),
                        )),
                    })
                    .collect(),
            };
        }
        let mut results = Vec::with_capacity(batch.calls.len());
        for call in batch.calls {
            results.push(self.execute_call(call).await);
        }
        CapabilityResults {
            batch_id: batch.batch_id,
            results,
        }
    }

    async fn execute_call(&self, call: CapabilityCall) -> CapabilityResult {
        let result = match call.request {
            CapabilityRequest::SecureRead { key, max_bytes } => {
                filesystem::secure_read(&self.roots, &key, max_bytes).await
            }
            CapabilityRequest::SecureWrite { key, bytes } => {
                filesystem::secure_write(&self.roots, &key, &bytes).await
            }
            CapabilityRequest::SecureRemove { key } => {
                filesystem::secure_remove(&self.roots, &key).await
            }
            CapabilityRequest::File(request @ genet_daemon_logic_api::FileRequest::Lock { .. })
            | CapabilityRequest::File(
                request @ genet_daemon_logic_api::FileRequest::Unlock { .. },
            ) => self.file_locks.execute(&self.roots, request).await,
            CapabilityRequest::File(request) => filesystem::execute(&self.roots, request).await,
            CapabilityRequest::Process(request) => {
                self.processes.execute(&self.roots, request).await
            }
            CapabilityRequest::Pty(request) => self.terminals.execute(&self.roots, request).await,
            CapabilityRequest::Http(request) => http::execute(request).await,
            CapabilityRequest::Clock => Ok(CapabilityValue::Clock {
                unix_millis: chrono::Utc::now().timestamp_millis(),
                monotonic_millis: process::monotonic_millis(),
            }),
            CapabilityRequest::Random { bytes } => random(bytes),
            CapabilityRequest::Socket(request) => self.sockets.execute(request).await,
            CapabilityRequest::Rtc(request) => self.rtc.execute(request).await,
            CapabilityRequest::Connectivity(_) => Err(failure(
                CapabilityFailureKind::Unavailable,
                "connectivity control is handled by the daemon transport owner",
            )),
            CapabilityRequest::LogicArtifact(request) => {
                let operation = match request {
                    LogicArtifactRequest::Status => "status",
                    LogicArtifactRequest::Install { .. } => "install",
                    LogicArtifactRequest::Rollback => "rollback",
                };
                Err(failure(
                    CapabilityFailureKind::Unavailable,
                    format!("logic artifact {operation} is handled by the VM owner"),
                ))
            }
        };
        CapabilityResult {
            call_id: call.call_id,
            result,
        }
    }

    pub async fn shutdown(&self) {
        self.file_locks.close_all();
        self.terminals.close_all().await;
        self.processes.close_all().await;
        self.sockets.close_all().await;
        self.rtc.close_all().await;
    }
}

fn random(bytes: u32) -> Result<CapabilityValue, CapabilityFailure> {
    if bytes == 0 || bytes as usize > genet_daemon_logic_api::MAX_CAPABILITY_CHUNK_BYTES {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "random request is empty or exceeds the capability chunk limit",
        ));
    }
    let mut output = vec![0_u8; bytes as usize];
    getrandom::fill(&mut output).map_err(|error| {
        failure(
            CapabilityFailureKind::Unavailable,
            format!("getting system randomness: {error}"),
        )
    })?;
    Ok(CapabilityValue::Bytes(output))
}

pub(crate) fn failure(
    kind: CapabilityFailureKind,
    message: impl Into<String>,
) -> CapabilityFailure {
    CapabilityFailure {
        kind,
        message: message.into(),
    }
}
