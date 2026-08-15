//! Thin product integration for the hot-updatable daemon Wasm application.
//!
//! The native side knows artifact trust, VM lifecycle and one byte-batch call.
//! It does not inspect request fields or split strings into host functions.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{SigningKey, VerifyingKey};
use genehub_proto::{Request, TransportKind};
use genet_daemon_logic_api::{
    CapabilityBatch, CapabilityCall, CapabilityFailure, CapabilityFailureKind, CapabilityRequest,
    CapabilityResult, CapabilityResults, CapabilityValue, LogicArtifactRequest, LogicArtifactState,
    LogicBoot, LogicInput, LogicOutcome, LogicOutput, LogicRequest,
};
use genet_daemon_platform::{
    ActiveLogic, ArtifactVerifier, PlatformRuntime, SignedArtifact, VmPolicy, LOGIC_ABI_VERSION,
};
use genet_daemon_system::SystemHost;

use crate::config::{MachineState, Paths};

const MODULE_ID: &str = "genehub:daemon/logic";
const DEVELOPMENT_KEY_ID: &str = "dev-local";
const DEVELOPMENT_SEED: [u8; 32] = [7; 32];
const MAX_ARTIFACT_BYTES: usize = 32 * 1024 * 1024;
pub const ARTIFACT_FILE_NAME: &str = "daemon-logic.wasm";
pub const ARTIFACT_PATH_ENV: &str = "GENET_DAEMON_LOGIC_WASM";

pub struct LogicHost {
    runtime: PlatformRuntime,
    system: Arc<SystemHost>,
    next_call_id: AtomicU64,
}

impl LogicHost {
    /// Loads the one shipped signed artifact. A source-tree dev build remains
    /// usable before the developer builds the guest; every released channel
    /// fails closed when its mandatory artifact or pinned key is missing.
    pub fn discover(
        paths: &Paths,
        machine: &MachineState,
        version: &str,
    ) -> Result<Option<Arc<Self>>> {
        let Some(artifact_path) = artifact_path()? else {
            if crate::channel::CHANNEL == "dev" {
                tracing::warn!(
                    "no {ARTIFACT_FILE_NAME}; daemon logic remains native until the dev guest is built"
                );
                return Ok(None);
            }
            anyhow::bail!("released daemon is missing {ARTIFACT_FILE_NAME}");
        };
        let artifact = read_artifact(&artifact_path)?;
        let (key_id, key) = trusted_key()?;
        let verifier = ArtifactVerifier::new(
            MODULE_ID,
            LOGIC_ABI_VERSION,
            MAX_ARTIFACT_BYTES,
            [(key_id, key)],
        )?;
        // Verify before constructing boot data or compiling. A runtime path
        // override may select bytes, never a trust root.
        verifier.verify(&artifact)?;
        let boot = serde_json::to_vec(&LogicBoot {
            daemon_version: version.to_string(),
            protocol_version: genehub_proto::PROTOCOL_VERSION,
            machine_id: machine.machine_id.clone(),
            fingerprint: machine.fingerprint(),
            machine_name: crate::link::default_display_name(),
            rtc_supported: true,
            log_directory: "/genehub-logs".to_string(),
            log_display_directory: paths.logs_dir().display().to_string(),
        })?;
        let runtime = PlatformRuntime::open_application(
            paths.logic_dir(),
            verifier,
            // WASIp1 gives the guest one cross-platform clock/random ABI. It
            // inherits no ambient files, env, stdio or sockets; workspace
            // directories are added later as explicit root capabilities.
            VmPolicy::application(LOGIC_ABI_VERSION).with_wasi_preopen(
                paths.logs_dir(),
                "/genehub-logs",
                false,
            ),
            artifact,
            boot,
        )?;
        let system = Arc::new(SystemHost::new(
            paths.root.join("portable"),
            paths.logs_dir(),
        )?);
        tracing::info!(
            path = %artifact_path.display(),
            version = %runtime.active()?.version,
            "daemon Wasm logic active"
        );
        Ok(Some(Arc::new(Self {
            runtime,
            system,
            next_call_id: AtomicU64::new(1),
        })))
    }

    pub async fn route(&self, transport: TransportKind, request: Request) -> Result<LogicOutcome> {
        let call_id = self.next_call_id.fetch_add(1, Ordering::Relaxed);
        let input = LogicInput::Request(LogicRequest {
            call_id,
            transport,
            request,
        });
        let mut inputs = VecDeque::from([input]);
        let mut completion = None;
        let mut turns = 0_usize;
        while let Some(input) = inputs.pop_front() {
            turns += 1;
            if turns > 128 {
                anyhow::bail!("portable logic exceeded the capability continuation limit");
            }
            let mut output = self.dispatch(&input)?;
            if !output.publications.is_empty() {
                anyhow::bail!("portable logic published before the event bridge was ready");
            }
            for finished in output.completions.drain(..) {
                if finished.call_id != call_id {
                    anyhow::bail!(
                        "portable logic completed call {} while driving {call_id}",
                        finished.call_id
                    );
                }
                if !matches!(
                    finished.connection,
                    genet_daemon_logic_api::ConnectionDirective::None
                ) {
                    anyhow::bail!(
                        "portable logic emitted a connection directive before routing support was ready"
                    );
                }
                if completion.replace(finished.outcome).is_some() {
                    anyhow::bail!("portable logic completed call {call_id} more than once");
                }
            }
            for batch in output.capability_batches {
                let results = self.execute_batch(batch).await;
                inputs.push_back(LogicInput::CapabilityResults(results));
            }
        }
        completion.context("portable logic did not complete the routed request")
    }

    fn dispatch(&self, input: &LogicInput) -> Result<LogicOutput> {
        let input = serde_json::to_vec(input)?;
        let output = self.runtime.handle(&input)?;
        serde_json::from_slice::<std::result::Result<LogicOutput, String>>(&output)?
            .map_err(anyhow::Error::msg)
    }

    async fn execute_batch(&self, batch: CapabilityBatch) -> CapabilityResults {
        let mut results = Vec::with_capacity(batch.calls.len());
        for call in batch.calls {
            results.push(match call.request {
                CapabilityRequest::LogicArtifact(request) => {
                    self.execute_artifact(call.call_id, request)
                }
                request => {
                    let mut result = self
                        .system
                        .execute(CapabilityBatch {
                            batch_id: batch.batch_id,
                            calls: vec![CapabilityCall {
                                call_id: call.call_id,
                                request,
                            }],
                        })
                        .await
                        .results;
                    result.pop().unwrap_or_else(|| CapabilityResult {
                        call_id: call.call_id,
                        result: Err(capability_failure(
                            CapabilityFailureKind::Internal,
                            "system capability returned no result",
                        )),
                    })
                }
            });
        }
        CapabilityResults {
            batch_id: batch.batch_id,
            results,
        }
    }

    fn execute_artifact(&self, call_id: u64, request: LogicArtifactRequest) -> CapabilityResult {
        let result = match request {
            LogicArtifactRequest::Status => self.runtime.active(),
            LogicArtifactRequest::Install { native_path } => read_artifact(Path::new(&native_path))
                .map_err(|error| genet_daemon_platform::PlatformError::State(format!("{error:#}")))
                .and_then(|artifact| self.runtime.install(artifact)),
            LogicArtifactRequest::Rollback => self.runtime.rollback(),
        }
        .map(|active| {
            CapabilityValue::LogicArtifact(LogicArtifactState {
                version: active.version,
                digest: active.digest,
                origin: format!("{:?}", active.origin).to_ascii_lowercase(),
                generation: active.generation,
            })
        })
        .map_err(|error| capability_failure(CapabilityFailureKind::Unavailable, error.to_string()));
        CapabilityResult { call_id, result }
    }

    pub fn active(&self) -> Result<ActiveLogic> {
        Ok(self.runtime.active()?)
    }

    pub fn status(&self) -> Result<genehub_proto::LogicModuleStatus> {
        let active = self.active()?;
        Ok(genehub_proto::LogicModuleStatus {
            loaded: true,
            version: Some(active.version),
            digest: Some(active.digest),
            origin: Some(format!("{:?}", active.origin).to_ascii_lowercase()),
            generation: active.generation,
        })
    }

    pub fn install_file(&self, path: &Path) -> Result<ActiveLogic> {
        Ok(self.runtime.install(read_artifact(path)?)?)
    }

    pub fn rollback(&self) -> Result<ActiveLogic> {
        Ok(self.runtime.rollback()?)
    }

    pub async fn shutdown(&self) {
        self.system.shutdown().await;
    }
}

fn capability_failure(
    kind: CapabilityFailureKind,
    message: impl Into<String>,
) -> CapabilityFailure {
    CapabilityFailure {
        kind,
        message: message.into(),
    }
}

fn artifact_path() -> Result<Option<PathBuf>> {
    if let Some(path) = std::env::var_os(ARTIFACT_PATH_ENV) {
        let path = PathBuf::from(path);
        if !path.is_file() {
            anyhow::bail!(
                "{ARTIFACT_PATH_ENV} does not name a regular file: {}",
                path.display()
            );
        }
        return Ok(Some(path));
    }
    let path = std::env::current_exe()
        .context("locating the native daemon executable")?
        .parent()
        .context("daemon executable has no parent directory")?
        .join(ARTIFACT_FILE_NAME);
    Ok(path.is_file().then_some(path))
}

fn read_artifact(path: &Path) -> Result<SignedArtifact> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("inspecting logic artifact {}", path.display()))?;
    if metadata.len() > MAX_ARTIFACT_BYTES as u64 + 16 * 1024 {
        anyhow::bail!("logic artifact exceeds its size limit");
    }
    let bytes = std::fs::read(path)
        .with_context(|| format!("reading logic artifact {}", path.display()))?;
    SignedArtifact::from_single_file(&bytes).map_err(Into::into)
}

fn trusted_key() -> Result<(String, VerifyingKey)> {
    if crate::channel::CHANNEL == "dev" {
        return Ok((
            DEVELOPMENT_KEY_ID.to_string(),
            SigningKey::from_bytes(&DEVELOPMENT_SEED).verifying_key(),
        ));
    }
    let key_id = option_env!("GENET_DAEMON_LOGIC_KEY_ID")
        .filter(|value| !value.is_empty())
        .context("release build has no pinned daemon logic key id")?;
    let encoded = option_env!("GENET_DAEMON_LOGIC_PUBLIC_KEY")
        .filter(|value| !value.is_empty())
        .context("release build has no pinned daemon logic public key")?;
    let bytes = STANDARD_NO_PAD
        .decode(encoded)
        .context("decoding pinned daemon logic public key")?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("daemon logic public key must be 32 bytes"))?;
    let key = VerifyingKey::from_bytes(&bytes).context("reading daemon logic public key")?;
    Ok((key_id.to_string(), key))
}
