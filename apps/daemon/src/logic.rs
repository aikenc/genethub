//! Thin product integration for the replaceable daemon Wasm application.
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
use genehub_proto::TransportKind;
use genet_daemon_logic_api::{
    decode_message, encode_message, CallerContext, CapabilityBatch, CapabilityCall,
    CapabilityFailure, CapabilityFailureKind, CapabilityRequest, CapabilityResult,
    CapabilityResults, CapabilityValue, CarrierInput, CarrierOutput, CarrierPublication,
    CarrierRequest, CarrierResponse, ConnectionDirective, ConnectivityRequest, LogicBoot,
    PlatformCall, PlatformReply, PlatformRequest, PublicationSecurity, RequestRoute,
    StreamAuthorization, StreamMethod,
};
use genet_daemon_platform::{
    ActiveLogic, ArtifactVerifier, PlatformRuntime, PreparedLogic, SignedArtifact, VmPolicy,
    LOGIC_ABI_VERSION,
};
use genet_daemon_system::SystemHost;
use tokio::sync::{broadcast, Mutex};

use crate::config::{MachineState, Paths};

const MODULE_ID: &str = "genehub:daemon/logic";
const DEVELOPMENT_KEY_ID: &str = "dev-local";
const DEVELOPMENT_SEED: [u8; 32] = [7; 32];
const MAX_ARTIFACT_BYTES: usize = 32 * 1024 * 1024;
pub const ARTIFACT_FILE_NAME: &str = "daemon-logic.wasm";
pub const ARTIFACT_PATH_ENV: &str = "GENET_DAEMON_LOGIC_WASM";

pub struct LogicHost {
    runtime: Arc<PlatformRuntime>,
    system: CapabilityBroker,
    next_call_id: AtomicU64,
    execution: Mutex<()>,
    events: std::sync::Mutex<
        Option<tokio::sync::mpsc::Receiver<genet_daemon_logic_api::CapabilityEvent>>,
    >,
    event_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    subscriptions: std::sync::Mutex<std::collections::HashMap<String, broadcast::Sender<Vec<u8>>>>,
    device_revocations: broadcast::Sender<String>,
    fanout: std::sync::OnceLock<broadcast::Sender<RoutedEvent>>,
}

#[derive(Clone)]
struct CapabilityBroker {
    commands: tokio::sync::mpsc::Sender<BrokerCommand>,
    thread: Arc<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>>,
    services: Arc<std::sync::OnceLock<std::sync::Weak<crate::state::AppState>>>,
    system: Arc<SystemHost>,
}

enum BrokerCommand {
    Execute {
        batch: CapabilityBatch,
        reply: BrokerReply,
    },
    Shutdown {
        reply: std::sync::mpsc::SyncSender<()>,
    },
}

enum BrokerReply {
    Blocking(std::sync::mpsc::SyncSender<CapabilityResults>),
    Async(tokio::sync::oneshot::Sender<CapabilityResults>),
}

pub struct LogicRoute {
    pub response: CarrierResponse,
    pub connection: LogicConnection,
}

#[derive(Clone, Debug)]
pub struct RoutedEvent {
    pub security: PublicationSecurity,
    pub bytes: Vec<u8>,
}

pub enum ApplyArtifact {
    Busy {
        readiness: genet_daemon_logic_api::UpdateReadiness,
        native_resources: u32,
    },
    Installed(ActiveLogic),
}

pub enum LogicConnection {
    None,
    Subscribe {
        session_id: String,
        receiver: broadcast::Receiver<Vec<u8>>,
    },
    Unsubscribe {
        session_id: String,
    },
}

impl LogicHost {
    /// Loads the one shipped signed artifact. Unit-test scaffolding may build
    /// state without it, but every real daemon start fails closed when its
    /// mandatory artifact or pinned key is missing.
    pub fn discover(
        paths: &Paths,
        machine: &MachineState,
        version: &str,
    ) -> Result<Option<Arc<Self>>> {
        let Some(artifact_path) = artifact_path()? else {
            if crate::channel::CHANNEL == "dev" {
                tracing::warn!(
                    "no {ARTIFACT_FILE_NAME}; build the signed dev guest before starting the daemon"
                );
                return Ok(None);
            }
            anyhow::bail!("released daemon is missing {ARTIFACT_FILE_NAME}");
        };
        let artifact = read_artifact(&artifact_path)?;
        let (key_id, key) = trusted_key()?;
        let verifier = ArtifactVerifier::new(
            MODULE_ID,
            crate::channel::CHANNEL,
            LOGIC_ABI_VERSION,
            MAX_ARTIFACT_BYTES,
            [(key_id, key)],
        )?;
        // Verify before constructing boot data or compiling. A runtime path
        // override may select bytes, never a trust root.
        verifier.verify(&artifact)?;
        let boot = encode_message(
            "logic boot",
            &LogicBoot {
                daemon_version: version.to_string(),
                protocol_version: genehub_proto::PROTOCOL_VERSION,
                machine_id: machine.machine_id.clone(),
                fingerprint: machine.fingerprint(),
                machine_name: crate::link::default_display_name(),
                rtc_supported: true,
                features: vec![
                    genehub_proto::SPEECH_FEATURE_TRANSCRIBE.to_string(),
                    genehub_proto::SPEECH_FEATURE_PARTIAL.to_string(),
                    genehub_proto::SPEECH_FEATURE_CONTEXT_PREVIEW.to_string(),
                    genehub_proto::SPEECH_FEATURE_FEEDBACK.to_string(),
                ],
                isolation: Some(crate::isolation::report()),
                log_directory: "/genehub-logs".to_string(),
                log_display_directory: paths.logs_dir().display().to_string(),
                default_workspace: paths
                    .default_workspace
                    .as_ref()
                    .map(|path| path.display().to_string()),
                home_directory: dirs::home_dir().map(|path| path.display().to_string()),
                builtin_agent_binary: builtin_agent_binary(),
                builtin_agent_home_env: Some(crate::channel::ENV_AGENT_HOME.to_string()),
            },
        )
        .map_err(anyhow::Error::msg)?;
        migrate_legacy_secure_file(
            &paths.devices_file(),
            &paths.portable_dir().join("devices.json"),
        )?;
        let system = Arc::new(SystemHost::new(paths.portable_dir(), paths.logs_dir())?);
        let events = system.take_events()?;
        let broker = CapabilityBroker::start(system);
        let capability = broker.clone();
        let runtime = Arc::new(PlatformRuntime::open_application(
            paths.logic_dir(),
            verifier,
            // WASIp1 gives the guest one cross-platform clock/random ABI. It
            // inherits no ambient files, env, stdio or sockets; workspace
            // directories are added later as explicit root capabilities.
            VmPolicy::application(LOGIC_ABI_VERSION)
                .with_wasi_preopen(paths.logs_dir(), "/genehub-logs", false)
                .with_capability_handler(move |request: &[u8]| capability.handle_bytes(request)),
            artifact,
            boot,
        )?);
        tracing::info!(
            path = %artifact_path.display(),
            revision = runtime.active()?.revision,
            "daemon Wasm logic active"
        );
        let (device_revocations, _) = broadcast::channel(64);
        Ok(Some(Arc::new(Self {
            runtime,
            system: broker,
            next_call_id: AtomicU64::new(1),
            execution: Mutex::new(()),
            events: std::sync::Mutex::new(Some(events)),
            event_task: Mutex::new(None),
            subscriptions: std::sync::Mutex::new(std::collections::HashMap::new()),
            device_revocations,
            fanout: std::sync::OnceLock::new(),
        })))
    }

    pub async fn route(
        self: &Arc<Self>,
        transport: TransportKind,
        caller: CallerContext,
        route: RequestRoute,
        body: Vec<u8>,
    ) -> Result<LogicRoute> {
        let _execution = self.execution.lock().await;
        let call_id = self.next_call_id.fetch_add(1, Ordering::Relaxed);
        let input = CarrierInput::Request(CarrierRequest {
            call_id,
            transport,
            caller,
            route,
            body,
        });
        let mut inputs = VecDeque::from([input]);
        let mut completion = None;
        let mut connection = LogicConnection::None;
        let mut turns = 0_usize;
        while let Some(input) = inputs.pop_front() {
            turns += 1;
            if turns > 128 {
                anyhow::bail!("portable logic exceeded the capability continuation limit");
            }
            let mut output = self.dispatch_blocking(input).await?;
            if !output.platform_completions.is_empty() {
                anyhow::bail!("portable logic completed a platform call while routing RPC");
            }
            self.publish(output.publications.drain(..), None)?;
            for finished in output.completions.drain(..) {
                if finished.call_id != call_id {
                    anyhow::bail!(
                        "portable logic completed call {} while driving {call_id}",
                        finished.call_id
                    );
                }
                connection = self.connection(finished.connection)?;
                if completion.replace(finished.response).is_some() {
                    anyhow::bail!("portable logic completed call {call_id} more than once");
                }
            }
            for batch in output.capability_batches {
                let results = self.execute_batch(batch).await;
                inputs.push_back(CarrierInput::CapabilityResults(results));
            }
        }
        Ok(LogicRoute {
            response: completion.context("portable logic did not complete the routed request")?,
            connection,
        })
    }

    pub fn attach_state(&self, state: &Arc<crate::state::AppState>) -> Result<()> {
        self.system
            .services
            .set(Arc::downgrade(state))
            .map_err(|_| anyhow::anyhow!("portable connectivity state was already attached"))
    }

    /// Starts the sole native-resource event pump. Resource bytes re-enter the
    /// same guest instance as request events; native code never interprets an
    /// agent protocol or session event.
    pub async fn start_event_pump(
        self: &Arc<Self>,
        fanout: broadcast::Sender<RoutedEvent>,
    ) -> Result<()> {
        let mut task = self.event_task.lock().await;
        if task.is_some() {
            return Ok(());
        }
        self.fanout
            .set(fanout.clone())
            .map_err(|_| anyhow::anyhow!("portable logic fanout was already installed"))?;
        let mut events = self
            .events
            .lock()
            .map_err(|_| anyhow::anyhow!("capability event receiver lock poisoned"))?
            .take()
            .context("capability event pump was already started")?;
        let host = Arc::clone(self);
        *task = Some(tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if let Err(error) = host.drive_event(event, &fanout).await {
                    tracing::error!(%error, "portable logic rejected a native resource event");
                }
            }
        }));
        Ok(())
    }

    async fn drive_event(
        &self,
        event: genet_daemon_logic_api::CapabilityEvent,
        fanout: &broadcast::Sender<RoutedEvent>,
    ) -> Result<()> {
        let _execution = self.execution.lock().await;
        let mut inputs = VecDeque::from([CarrierInput::CapabilityEvent(event)]);
        let mut turns = 0_usize;
        while let Some(input) = inputs.pop_front() {
            turns += 1;
            if turns > 128 {
                anyhow::bail!("portable event handling exceeded the capability continuation limit");
            }
            let mut output = self.dispatch_blocking(input).await?;
            if !output.completions.is_empty() || !output.platform_completions.is_empty() {
                anyhow::bail!("a resource event unexpectedly completed a client request");
            }
            self.publish(output.publications.drain(..), Some(fanout))?;
            for batch in output.capability_batches {
                inputs.push_back(CarrierInput::CapabilityResults(
                    self.execute_batch(batch).await,
                ));
            }
        }
        Ok(())
    }

    fn publish(
        &self,
        publications: impl IntoIterator<Item = CarrierPublication>,
        fanout: Option<&broadcast::Sender<RoutedEvent>>,
    ) -> Result<()> {
        for publication in publications {
            match publication {
                CarrierPublication::Session { session_id, event } => {
                    let sender = self.session_sender(&session_id)?;
                    let _ = sender.send(event);
                }
                CarrierPublication::Fanout { security, frame } => {
                    let fanout = fanout.or_else(|| self.fanout.get()).context(
                        "portable logic emitted a fanout frame before the event pump started",
                    )?;
                    let _ = fanout.send(RoutedEvent {
                        security,
                        bytes: frame,
                    });
                }
                CarrierPublication::DeviceRevoked { device_id } => {
                    let _ = self.device_revocations.send(device_id);
                }
            }
        }
        Ok(())
    }

    async fn platform_request(&self, request: PlatformRequest) -> Result<PlatformReply> {
        let _execution = self.execution.lock().await;
        self.platform_request_locked(request).await
    }

    async fn platform_request_locked(&self, request: PlatformRequest) -> Result<PlatformReply> {
        let call_id = self.next_call_id.fetch_add(1, Ordering::Relaxed);
        let mut inputs =
            VecDeque::from([CarrierInput::Platform(PlatformCall { call_id, request })]);
        let mut completion = None;
        let mut turns = 0_usize;
        while let Some(input) = inputs.pop_front() {
            turns += 1;
            if turns > 128 {
                anyhow::bail!("portable platform call exceeded the capability continuation limit");
            }
            let mut output = self.dispatch_blocking(input).await?;
            if !output.completions.is_empty() {
                anyhow::bail!("portable logic completed an RPC while handling platform security");
            }
            self.publish(output.publications.drain(..), None)?;
            for finished in output.platform_completions.drain(..) {
                if finished.call_id != call_id {
                    anyhow::bail!(
                        "portable logic completed platform call {} while driving {call_id}",
                        finished.call_id
                    );
                }
                if completion.replace(finished.result).is_some() {
                    anyhow::bail!(
                        "portable logic completed platform call {call_id} more than once"
                    );
                }
            }
            for batch in output.capability_batches {
                inputs.push_back(CarrierInput::CapabilityResults(
                    self.execute_batch(batch).await,
                ));
            }
        }
        completion
            .context("portable logic did not complete the platform call")?
            .map_err(|error| anyhow::anyhow!(error.message))
    }

    pub async fn authenticate_device(
        &self,
        auth: genehub_proto::DeviceAuth,
        server_nonce: String,
    ) -> Result<PlatformReply> {
        self.platform_request(PlatformRequest::AuthenticateDevice { auth, server_nonce })
            .await
    }

    pub async fn authenticate_invite(
        &self,
        auth: genehub_proto::InviteAuth,
        server_nonce: String,
    ) -> Result<PlatformReply> {
        self.platform_request(PlatformRequest::AuthenticateInvite { auth, server_nonce })
            .await
    }

    pub async fn claim_authenticated_invite(
        &self,
        invite_id: String,
        device_name: String,
    ) -> Result<PlatformReply> {
        self.platform_request(PlatformRequest::ClaimAuthenticatedInvite {
            invite_id,
            device_name,
        })
        .await
    }

    pub async fn device_connection(&self, device_id: String, connected: bool) -> Result<()> {
        match self
            .platform_request(PlatformRequest::DeviceConnection {
                device_id,
                connected,
            })
            .await?
        {
            PlatformReply::Ack => Ok(()),
            _ => anyhow::bail!("portable device connection returned the wrong value"),
        }
    }

    pub async fn workspace_catalog(&self) -> Result<genet_daemon_logic_api::WorkspaceCatalog> {
        match self
            .platform_request(PlatformRequest::WorkspaceCatalog)
            .await?
        {
            PlatformReply::WorkspaceCatalog(catalog) => Ok(catalog),
            _ => anyhow::bail!("portable workspace catalog returned the wrong value"),
        }
    }

    pub async fn resolve_workspace_file(
        &self,
        workspace_id: String,
        path: String,
    ) -> Result<PathBuf> {
        let locator = match self
            .platform_request(PlatformRequest::ResolveWorkspaceFile { workspace_id, path })
            .await?
        {
            PlatformReply::WorkspaceFile(locator) => locator,
            _ => anyhow::bail!("portable workspace resolver returned the wrong value"),
        };
        self.system.system.workspace_path(&locator).await
    }

    pub async fn authorize_stream(
        &self,
        caller: CallerContext,
        stream: StreamMethod,
    ) -> Result<StreamAuthorization> {
        match self
            .platform_request(PlatformRequest::AuthorizeStream { caller, stream })
            .await?
        {
            PlatformReply::StreamAuthorization(authorization) => Ok(authorization),
            _ => anyhow::bail!("portable stream authorization returned the wrong value"),
        }
    }

    pub async fn resolve_workspace_execution(
        &self,
        workspace_id: String,
        cwd: Option<String>,
    ) -> Result<(PathBuf, Vec<PathBuf>)> {
        let execution = match self
            .platform_request(PlatformRequest::ResolveWorkspaceExecution { workspace_id, cwd })
            .await?
        {
            PlatformReply::WorkspaceExecution(execution) => execution,
            _ => anyhow::bail!("portable workspace execution resolver returned the wrong value"),
        };
        let cwd = self.system.system.workspace_path(&execution.cwd).await?;
        let mut roots = Vec::with_capacity(execution.roots.len());
        for locator in execution.roots {
            roots.push(self.system.system.workspace_path(&locator).await?);
        }
        Ok((cwd, roots))
    }

    pub async fn prepare_speech(
        &self,
        route_workspace_id: Option<String>,
        start: genehub_proto::SpeechStart,
    ) -> Result<genet_daemon_logic_api::SpeechConfig> {
        match self
            .platform_request(PlatformRequest::PrepareSpeech {
                route_workspace_id,
                start,
            })
            .await?
        {
            PlatformReply::SpeechPrepared(config) => Ok(config),
            _ => anyhow::bail!("portable speech preparation returned the wrong value"),
        }
    }

    pub async fn remember_speech_completion(
        &self,
        evidence: genet_daemon_logic_api::SpeechCompletionEvidence,
    ) -> Result<()> {
        match self
            .platform_request(PlatformRequest::RememberSpeechCompletion { evidence })
            .await?
        {
            PlatformReply::Ack => Ok(()),
            _ => anyhow::bail!("portable speech evidence handler returned the wrong value"),
        }
    }

    pub fn subscribe_device_revocations(&self) -> broadcast::Receiver<String> {
        self.device_revocations.subscribe()
    }

    fn connection(&self, directive: ConnectionDirective) -> Result<LogicConnection> {
        Ok(match directive {
            ConnectionDirective::None => LogicConnection::None,
            ConnectionDirective::Subscribe { session_id } => LogicConnection::Subscribe {
                receiver: self.session_sender(&session_id)?.subscribe(),
                session_id,
            },
            ConnectionDirective::Unsubscribe { session_id } => {
                LogicConnection::Unsubscribe { session_id }
            }
        })
    }

    fn session_sender(&self, session_id: &str) -> Result<broadcast::Sender<Vec<u8>>> {
        let mut subscriptions = self
            .subscriptions
            .lock()
            .map_err(|_| anyhow::anyhow!("logic subscription lock poisoned"))?;
        Ok(subscriptions
            .entry(session_id.to_string())
            .or_insert_with(|| broadcast::channel(1024).0)
            .clone())
    }

    fn dispatch_with(runtime: &PlatformRuntime, input: &CarrierInput) -> Result<CarrierOutput> {
        let input = encode_message("logic input", input).map_err(anyhow::Error::msg)?;
        let output = runtime.handle(&input)?;
        decode_message::<std::result::Result<CarrierOutput, String>>(
            "logic output",
            &output,
            4 * 1024 * 1024,
        )
        .map_err(anyhow::Error::msg)?
        .map_err(anyhow::Error::msg)
    }

    async fn dispatch_blocking(&self, input: CarrierInput) -> Result<CarrierOutput> {
        let runtime = Arc::clone(&self.runtime);
        tokio::task::spawn_blocking(move || Self::dispatch_with(&runtime, &input))
            .await
            .context("portable Wasm worker stopped")?
    }

    async fn execute_batch(&self, batch: CapabilityBatch) -> CapabilityResults {
        self.system.execute(batch).await
    }

    pub fn active(&self) -> Result<ActiveLogic> {
        Ok(self.runtime.active()?)
    }

    pub fn highest_accepted_revision(&self) -> Result<u64> {
        Ok(self.runtime.highest_accepted_revision()?)
    }

    pub async fn native_resource_count(&self) -> u32 {
        self.system.system.resource_count().await
    }

    pub async fn apply_artifact(
        &self,
        artifact: SignedArtifact,
        terminate_activities: bool,
    ) -> Result<ApplyArtifact> {
        let runtime = Arc::clone(&self.runtime);
        let prepared = tokio::task::spawn_blocking(move || runtime.prepare(artifact))
            .await
            .context("portable candidate preparation worker stopped")??;
        self.apply_prepared(prepared, terminate_activities).await
    }

    async fn apply_prepared(
        &self,
        prepared: PreparedLogic,
        terminate_activities: bool,
    ) -> Result<ApplyArtifact> {
        let _execution = self.execution.lock().await;
        let readiness = match self
            .platform_request_locked(PlatformRequest::PrepareUpdate {
                terminate_activities,
            })
            .await?
        {
            PlatformReply::UpdateReadiness(readiness) => readiness,
            _ => anyhow::bail!("portable update gate returned the wrong value"),
        };
        let native_resources = self.system.system.resource_count().await;
        if readiness.busy || (!terminate_activities && native_resources > 0) {
            return Ok(ApplyArtifact::Busy {
                readiness,
                native_resources,
            });
        }

        // The guest has stopped its product activities. Close every native
        // handle before the new cold instance becomes routable.
        self.system.system.quiesce().await;
        let runtime = Arc::clone(&self.runtime);
        let active = tokio::task::spawn_blocking(move || runtime.activate(prepared))
            .await
            .context("portable update worker stopped")??;
        Ok(ApplyArtifact::Installed(active))
    }

    pub async fn shutdown(&self) {
        if let Err(error) = self.platform_request(PlatformRequest::Shutdown).await {
            tracing::warn!(%error, "portable application could not finish graceful shutdown");
        }
        if let Some(task) = self.event_task.lock().await.take() {
            task.abort();
        }
        self.system.shutdown().await;
    }
}

/// Copies legacy durable bytes into the guest's private capability root once.
/// Native bootstrap resolves paths and preserves file permissions but does not
/// deserialize or otherwise interpret the business schema.
fn migrate_legacy_secure_file(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() || !source.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(source)
        .with_context(|| format!("reading legacy state {}", source.display()))?;
    crate::config::save_private(destination, &bytes)
        .with_context(|| format!("migrating legacy state to {}", destination.display()))
}

impl CapabilityBroker {
    fn start(system: Arc<SystemHost>) -> Self {
        let (commands, mut receiver) = tokio::sync::mpsc::channel::<BrokerCommand>(16);
        // The bridge has its own OS thread because Wasm imports are
        // synchronous, but capability futures must stay on the daemon's
        // runtime. A private Tokio runtime here would make every long-lived
        // task spawned by a capability (Fabric uplinks in particular) belong
        // to the bridge thread. If such a task re-entered the guest it would
        // wait for the same bridge thread to service its next import.
        let runtime = tokio::runtime::Handle::current();
        let services = Arc::new(std::sync::OnceLock::new());
        let thread_services = services.clone();
        let thread_system = Arc::clone(&system);
        let thread = std::thread::Builder::new()
            .name("genehub-system-capabilities".to_string())
            .spawn(move || {
                while let Some(command) = receiver.blocking_recv() {
                    match command {
                        BrokerCommand::Execute { batch, reply } => {
                            let results = runtime.block_on(execute_capability_batch(
                                &thread_system,
                                &thread_services,
                                batch,
                            ));
                            match reply {
                                BrokerReply::Blocking(reply) => {
                                    let _ = reply.send(results);
                                }
                                BrokerReply::Async(reply) => {
                                    let _ = reply.send(results);
                                }
                            }
                        }
                        BrokerCommand::Shutdown { reply } => {
                            runtime.block_on(thread_system.shutdown());
                            let _ = reply.send(());
                            break;
                        }
                    }
                }
            })
            .expect("starting capability runtime");
        Self {
            commands,
            thread: Arc::new(std::sync::Mutex::new(Some(thread))),
            services,
            system,
        }
    }

    fn handle_bytes(&self, request: &[u8]) -> std::result::Result<Vec<u8>, String> {
        let batch: CapabilityBatch = decode_message("capability batch", request, 4 * 1024 * 1024)?;
        let (reply, answer) = std::sync::mpsc::sync_channel(1);
        self.commands
            .try_send(BrokerCommand::Execute {
                batch,
                reply: BrokerReply::Blocking(reply),
            })
            .map_err(|error| format!("queuing capability batch: {error}"))?;
        let results = answer
            .recv()
            .map_err(|_| "capability runtime stopped before replying".to_string())?;
        encode_message("capability results", &results)
    }

    async fn execute(&self, batch: CapabilityBatch) -> CapabilityResults {
        let batch_id = batch.batch_id;
        let calls = batch.calls.clone();
        let (reply, answer) = tokio::sync::oneshot::channel();
        if self
            .commands
            .send(BrokerCommand::Execute {
                batch,
                reply: BrokerReply::Async(reply),
            })
            .await
            .is_err()
        {
            return unavailable_results(batch_id, calls, "capability runtime is stopped");
        }
        answer.await.unwrap_or_else(|_| {
            unavailable_results(
                batch_id,
                calls,
                "capability runtime stopped before replying",
            )
        })
    }

    async fn shutdown(&self) {
        let (reply, answer) = std::sync::mpsc::sync_channel(1);
        if self
            .commands
            .send(BrokerCommand::Shutdown { reply })
            .await
            .is_ok()
        {
            let _ = tokio::task::spawn_blocking(move || answer.recv()).await;
        }
        let thread = self.thread.lock().ok().and_then(|mut thread| thread.take());
        if let Some(thread) = thread {
            let _ = tokio::task::spawn_blocking(move || thread.join()).await;
        }
    }
}

async fn execute_capability_batch(
    system: &SystemHost,
    services: &std::sync::OnceLock<std::sync::Weak<crate::state::AppState>>,
    batch: CapabilityBatch,
) -> CapabilityResults {
    let batch_id = batch.batch_id;
    // Calls inside one batch are independent by contract. Preserve their
    // declared result order while allowing cold CLI probes and unrelated file
    // reads to overlap; otherwise one AgentList would add every optional
    // executable's timeout together.
    let results = futures_util::future::join_all(batch.calls.into_iter().map(|call| async move {
        let call_id = call.call_id;
        let result = match call.request {
            CapabilityRequest::Connectivity(request) => {
                execute_connectivity(services, request).await
            }
            CapabilityRequest::Diagnostics => execute_diagnostics(services).await,
            CapabilityRequest::SpeechRuntime(request) => {
                execute_speech_runtime(services, request).await
            }
            request => {
                let mut result = system
                    .execute(CapabilityBatch {
                        batch_id,
                        calls: vec![CapabilityCall { call_id, request }],
                    })
                    .await
                    .results;
                result.pop().map(|result| result.result).unwrap_or_else(|| {
                    Err(capability_failure(
                        CapabilityFailureKind::Internal,
                        "system capability returned no result",
                    ))
                })
            }
        };
        CapabilityResult { call_id, result }
    }))
    .await;
    CapabilityResults { batch_id, results }
}

async fn execute_speech_runtime(
    services: &std::sync::OnceLock<std::sync::Weak<crate::state::AppState>>,
    request: genet_daemon_logic_api::SpeechRuntimeRequest,
) -> std::result::Result<CapabilityValue, CapabilityFailure> {
    let state = services
        .get()
        .and_then(std::sync::Weak::upgrade)
        .ok_or_else(|| {
            capability_failure(
                CapabilityFailureKind::Unavailable,
                "speech runtime is not attached",
            )
        })?;
    match request {
        genet_daemon_logic_api::SpeechRuntimeRequest::Capabilities { config } => Ok(
            CapabilityValue::SpeechCapabilities(state.speech.capabilities(&config).await),
        ),
        genet_daemon_logic_api::SpeechRuntimeRequest::Probe { config } => Ok(
            CapabilityValue::SpeechRuntimeStatus(state.speech.probe(&config).await),
        ),
        genet_daemon_logic_api::SpeechRuntimeRequest::ValidateRegistration { command, args } => {
            state
                .speech
                .validate_registration(command, args)
                .await
                .map(CapabilityValue::SpeechRuntimeConfig)
                .map_err(|error| {
                    capability_failure(CapabilityFailureKind::Invalid, format!("{error:#}"))
                })
        }
    }
}

async fn execute_diagnostics(
    services: &std::sync::OnceLock<std::sync::Weak<crate::state::AppState>>,
) -> std::result::Result<CapabilityValue, CapabilityFailure> {
    let state = services
        .get()
        .and_then(std::sync::Weak::upgrade)
        .ok_or_else(|| {
            capability_failure(
                CapabilityFailureKind::Unavailable,
                "daemon diagnostics are not attached",
            )
        })?;
    let hub = match state.link.get() {
        Some(link) => link.status().await,
        None => genehub_proto::HubStatus::Unpaired,
    };
    let remote = match state.remote.get() {
        Some(remote) => remote.status().await,
        None => genehub_proto::RemoteAccess {
            relay_url: None,
            rendezvous_url: None,
            online: false,
        },
    };
    Ok(CapabilityValue::Diagnostics(state.diagnostics.snapshot(
        &state.version,
        &hub,
        &remote,
    )))
}

async fn execute_connectivity(
    services: &std::sync::OnceLock<std::sync::Weak<crate::state::AppState>>,
    request: ConnectivityRequest,
) -> std::result::Result<CapabilityValue, CapabilityFailure> {
    let state = services
        .get()
        .and_then(std::sync::Weak::upgrade)
        .ok_or_else(|| {
            capability_failure(
                CapabilityFailureKind::Unavailable,
                "daemon connectivity is not attached",
            )
        })?;
    let failed = |error: anyhow::Error| {
        capability_failure(CapabilityFailureKind::Unavailable, format!("{error:#}"))
    };
    match request {
        ConnectivityRequest::HubStatus => {
            let status = match state.link.get() {
                Some(link) => link.status().await,
                None => genehub_proto::HubStatus::Unpaired,
            };
            Ok(CapabilityValue::HubStatus(status))
        }
        ConnectivityRequest::HubPair {
            hub_url,
            display_name,
        } => {
            let link = state.link.get().ok_or_else(|| {
                capability_failure(
                    CapabilityFailureKind::Unavailable,
                    "Hub connectivity is still starting",
                )
            })?;
            link.pair(&hub_url, display_name)
                .await
                .map(CapabilityValue::HubStatus)
                .map_err(failed)
        }
        ConnectivityRequest::HubTrial {
            hub_url,
            display_name,
        } => {
            let link = state.link.get().ok_or_else(|| {
                capability_failure(
                    CapabilityFailureKind::Unavailable,
                    "Hub connectivity is still starting",
                )
            })?;
            link.trial(&hub_url, display_name)
                .await
                .map(|(status, claim)| CapabilityValue::HubClaim { status, claim })
                .map_err(failed)
        }
        ConnectivityRequest::HubClaimLink => {
            let link = state.link.get().ok_or_else(|| {
                capability_failure(
                    CapabilityFailureKind::Unavailable,
                    "Hub connectivity is still starting",
                )
            })?;
            let claim = link.claim_link().await.map_err(failed)?;
            Ok(CapabilityValue::HubClaim {
                status: link.status().await,
                claim,
            })
        }
        ConnectivityRequest::HubMachines => match state.link.get() {
            Some(link) => link
                .machines()
                .await
                .map(CapabilityValue::HubMachines)
                .map_err(failed),
            None => Ok(CapabilityValue::HubMachines(Vec::new())),
        },
        ConnectivityRequest::HubConnect { machine_id } => {
            let link = state.link.get().ok_or_else(|| {
                capability_failure(
                    CapabilityFailureKind::Unavailable,
                    "Hub connectivity is still starting",
                )
            })?;
            link.connect(&machine_id)
                .await
                .map(CapabilityValue::HubTicket)
                .map_err(failed)
        }
        ConnectivityRequest::HubUnpair => match state.link.get() {
            Some(link) => link
                .unpair()
                .await
                .map(|()| CapabilityValue::HubStatus(genehub_proto::HubStatus::Unpaired))
                .map_err(failed),
            None => Ok(CapabilityValue::HubStatus(
                genehub_proto::HubStatus::Unpaired,
            )),
        },
        ConnectivityRequest::RemoteStatus => match state.remote.get() {
            Some(remote) => Ok(CapabilityValue::RemoteAccess(remote.status().await)),
            None => Ok(CapabilityValue::RemoteAccess(genehub_proto::RemoteAccess {
                relay_url: None,
                rendezvous_url: None,
                online: false,
            })),
        },
        ConnectivityRequest::RemoteAttach {
            relay_url,
            join_token,
        } => {
            let remote = state.remote.get().ok_or_else(|| {
                capability_failure(
                    CapabilityFailureKind::Unavailable,
                    "remote connectivity is still starting",
                )
            })?;
            remote
                .set(&relay_url, join_token)
                .await
                .map(CapabilityValue::RemoteAccess)
                .map_err(|error| {
                    capability_failure(CapabilityFailureKind::Invalid, format!("{error:#}"))
                })
        }
        ConnectivityRequest::RemoteDetach => match state.remote.get() {
            Some(remote) => remote
                .clear()
                .await
                .map(CapabilityValue::RemoteAccess)
                .map_err(failed),
            None => Ok(CapabilityValue::RemoteAccess(genehub_proto::RemoteAccess {
                relay_url: None,
                rendezvous_url: None,
                online: false,
            })),
        },
    }
}

fn unavailable_results(
    batch_id: u64,
    calls: Vec<CapabilityCall>,
    message: &str,
) -> CapabilityResults {
    CapabilityResults {
        batch_id,
        results: calls
            .into_iter()
            .map(|call| CapabilityResult {
                call_id: call.call_id,
                result: Err(capability_failure(
                    CapabilityFailureKind::Unavailable,
                    message,
                )),
            })
            .collect(),
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

fn builtin_agent_binary() -> Option<String> {
    if let Some(configured) = std::env::var_os(crate::channel::ENV_AGENT_COMMAND) {
        if !configured.is_empty() {
            return Some(PathBuf::from(configured).display().to_string());
        }
    }
    let name = if cfg!(windows) {
        format!("{}.exe", crate::channel::AGENT_BINARY)
    } else {
        crate::channel::AGENT_BINARY.to_string()
    };
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(name)))
        .filter(|path| path.is_file())
        .map(|path| path.display().to_string())
}
