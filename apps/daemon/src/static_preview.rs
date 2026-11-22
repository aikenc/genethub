//! Control plane for independent static previews. The native worker owns the
//! TLS private key, browser connections and a dedicated Fabric uplink.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(not(target_family = "wasm"))]
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use genehub_proto::StaticPreviewGrant;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(not(target_family = "wasm"))]
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;
use uuid::Uuid;

use crate::config::Enrollment;
use crate::dataplane::endpoint::PeerAccess;
use crate::hub;
#[cfg(not(target_family = "wasm"))]
use crate::os_process::{Child, ChildStdin, ChildStdout, Command};
use crate::state::Shared;
use crate::workspace::ResolvedWorkspacePath;
#[cfg(target_family = "wasm")]
use genet_wasi::wit::genehub::host::worker as background;

const START_TIMEOUT: Duration = Duration::from_secs(12);
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(5);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
const VIEW_SECONDS: u64 = 900;
const MAX_VIEWS: usize = 64;

#[derive(Clone)]
struct LocalConfig {
    #[cfg(not(target_family = "wasm"))]
    cli: PathBuf,
    cert: PathBuf,
    key: PathBuf,
    #[cfg(target_family = "wasm")]
    static_threads: usize,
    #[cfg(target_family = "wasm")]
    run_threads: bool,
}

impl LocalConfig {
    fn read() -> Option<Self> {
        if std::env::var("GENEHUB_PREVIEW_ENABLED").as_deref() != Ok("1") {
            return None;
        }
        let file = |name| {
            let path = PathBuf::from(std::env::var_os(name)?);
            path.is_absolute().then_some(path)
        };
        #[cfg(target_family = "wasm")]
        let static_threads = std::env::var("GENEHUB_PREVIEW_THREADS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|&value| value <= 5)
            .unwrap_or(1);
        Some(Self {
            // The native host injects the verified front door into the guest
            // as GENEHUB_CLI. Its own startup override is host-only.
            #[cfg(not(target_family = "wasm"))]
            cli: file("GENEHUB_CLI")?,
            cert: file("GENEHUB_PREVIEW_TLS_CERT")?,
            key: file("GENEHUB_PREVIEW_TLS_KEY")?,
            #[cfg(target_family = "wasm")]
            static_threads,
            #[cfg(target_family = "wasm")]
            run_threads: match std::env::var("GENEHUB_PREVIEW_SERVICE_THREADS").as_deref() {
                Ok("0") => false,
                Ok("1") => true,
                _ => static_threads > 0,
            },
        })
    }
}

pub(crate) fn enabled() -> bool {
    LocalConfig::read().is_some()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Uplink {
    url: String,
    ticket: String,
    suffix: String,
    workbench_origin: String,
    port: u16,
}

pub(crate) struct Site {
    workspace: PathBuf,
    absolute_root: PathBuf,
    root: String,
    entry: String,
}

fn wire_path(path: &Path) -> Result<String> {
    let mut components = Vec::new();
    for piece in path.components() {
        let std::path::Component::Normal(name) = piece else {
            bail!("invalid preview path");
        };
        let name = name.to_str().context("preview path is not UTF-8")?;
        if name.starts_with('.') || name.contains('\\') {
            bail!("invalid preview path");
        }
        components.push(name);
    }
    Ok(components.join("/"))
}

impl Site {
    pub(crate) fn resolve(file: ResolvedWorkspacePath) -> Result<Self> {
        let parent = file
            .relative
            .parent()
            .context("preview entry is missing its parent")?;
        let entry = file
            .relative
            .file_name()
            .context("preview entry is missing a name")?;
        if !Path::new(entry)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                ["html", "htm"]
                    .iter()
                    .any(|value| extension.eq_ignore_ascii_case(value))
            })
        {
            bail!("独立预览需要 HTML 入口");
        }
        Ok(Self {
            absolute_root: file
                .absolute
                .parent()
                .context("preview site root unavailable")?
                .to_owned(),
            workspace: file.root,
            root: wire_path(parent)?,
            entry: wire_path(Path::new(entry))?,
        })
    }

    pub(crate) fn resource(&self, absolute: &Path) -> Result<String> {
        wire_path(
            absolute
                .strip_prefix(&self.absolute_root)
                .context("资源超出预览目录")?,
        )
    }
}

struct Worker {
    #[cfg(target_family = "wasm")]
    instance: Execution,
    #[cfg(target_family = "wasm")]
    extra_workers: HashMap<Executor, Execution>,
    #[cfg(target_family = "wasm")]
    config: LocalConfig,
    #[cfg(not(target_family = "wasm"))]
    child: Child,
    #[cfg(not(target_family = "wasm"))]
    input: ChildStdin,
    #[cfg(not(target_family = "wasm"))]
    output: BufReader<ChildStdout>,
    suffix: String,
    workbench_origin: String,
    port: u16,
    enrollment: Enrollment,
    views: HashMap<String, Lease>,
    usable: bool,
}

#[cfg(target_family = "wasm")]
enum Execution {
    Thread(background::Instance),
    Inline {
        outgoing: tokio::sync::mpsc::Sender<Vec<u8>>,
        incoming: tokio::sync::mpsc::Receiver<Vec<u8>>,
    },
}

#[cfg(target_family = "wasm")]
impl Execution {
    fn start(config: &LocalConfig, suffix: &str, role: &str) -> Result<Self> {
        let cert = config.cert.to_string_lossy().into_owned();
        let key = config.key.to_string_lossy().into_owned();
        if config.static_threads == 0 && role == "preview" {
            let (outgoing, commands) = tokio::sync::mpsc::channel(2);
            let (replies, incoming) = tokio::sync::mpsc::channel(2);
            let suffix = suffix.to_owned();
            tokio::spawn(async move {
                let _ = crate::preview_data::run_guest(
                    &cert,
                    &key,
                    &suffix,
                    crate::preview_data::guest_control::Port::Local {
                        incoming: commands,
                        outgoing: replies,
                    },
                    true,
                )
                .await;
            });
            return Ok(Self::Inline { outgoing, incoming });
        }
        background::start(role, &[cert, key, suffix.to_owned()])
            .map(Self::Thread)
            .map_err(anyhow::Error::msg)
    }

    fn closed(&self) -> bool {
        match self {
            Self::Thread(instance) => instance.closed(),
            Self::Inline { outgoing, .. } => outgoing.is_closed(),
        }
    }

    fn id(&self) -> Option<u64> {
        match self {
            Self::Thread(instance) => Some(instance.id()),
            Self::Inline { .. } => None,
        }
    }

    async fn command(&mut self, command: &Value) -> Result<bool> {
        self.send(serde_json::to_vec(command)?)?;
        let reply = tokio::time::timeout(START_TIMEOUT, self.receive()).await??;
        let reply: Value = serde_json::from_slice(&reply)?;
        reply
            .get("ok")
            .and_then(Value::as_bool)
            .context("invalid preview worker response")
    }

    fn send(&self, bytes: Vec<u8>) -> Result<()> {
        match self {
            Self::Thread(instance) => instance.send(&bytes).map_err(anyhow::Error::msg),
            Self::Inline { outgoing, .. } => outgoing
                .try_send(bytes)
                .map_err(|_| anyhow::anyhow!("inline preview mailbox closed or full")),
        }
    }

    async fn receive(&mut self) -> Result<Vec<u8>> {
        match self {
            Self::Thread(instance) => loop {
                if let Some(bytes) = instance.receive().map_err(anyhow::Error::msg)? {
                    return Ok(bytes);
                }
                genet_wasi::poll::idle().await;
            },
            Self::Inline { incoming, .. } => {
                incoming.recv().await.context("inline preview stopped")
            }
        }
    }
}

#[cfg(target_family = "wasm")]
#[derive(Clone, PartialEq, Eq, Hash)]
enum Executor {
    Static(usize),
    Service(String),
}

struct Lease {
    #[cfg(target_family = "wasm")]
    executor: Option<(Executor, u64)>,
    share: Option<String>,
    expires: Instant,
    peer: Option<PeerAccess>,
}

fn revoked(peer: &PeerAccess, state: &Shared) -> bool {
    peer.hosted_authority
        .as_ref()
        .is_some_and(|active| !active.load(Ordering::Acquire))
        || peer
            .device_id
            .as_deref()
            .is_some_and(|id| !state.devices.authorized(id))
        || peer
            .authorization_expires_at
            .is_some_and(|deadline| deadline <= std::time::Instant::now())
}

impl Worker {
    async fn start(config: &LocalConfig, enrollment: Enrollment, uplink: &Uplink) -> Result<Self> {
        #[cfg(target_family = "wasm")]
        let instance = Execution::start(config, &uplink.suffix, "preview")?;
        #[cfg(not(target_family = "wasm"))]
        let (child, input, output) = {
            let mut command = Command::new(crate::guest_paths::host_path(&config.cli));
            command
                .arg("static-preview-worker")
                .arg(crate::guest_paths::host_path(&config.cert))
                .arg(crate::guest_paths::host_path(&config.key))
                .arg(&uplink.suffix)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let mut child = command.spawn().context("启动独立预览服务失败")?;
            let input = child.stdin.take().context("missing preview worker input")?;
            let output = BufReader::new(
                child
                    .stdout
                    .take()
                    .context("missing preview worker output")?,
            );
            (child, input, output)
        };
        let mut worker = Self {
            #[cfg(target_family = "wasm")]
            instance,
            #[cfg(target_family = "wasm")]
            extra_workers: HashMap::new(),
            #[cfg(target_family = "wasm")]
            config: config.clone(),
            #[cfg(not(target_family = "wasm"))]
            child,
            #[cfg(not(target_family = "wasm"))]
            input,
            #[cfg(not(target_family = "wasm"))]
            output,
            suffix: uplink.suffix.clone(),
            workbench_origin: uplink.workbench_origin.clone(),
            port: uplink.port,
            enrollment,
            views: HashMap::new(),
            usable: true,
        };
        if worker
            .read()
            .await?
            .get("port")
            .and_then(Value::as_u64)
            .is_none_or(|port| port == 0 || port > 65535)
        {
            bail!("独立预览服务未就绪");
        }
        #[cfg(target_family = "wasm")]
        for index in 1..config.static_threads {
            worker.prepare_executor(&Executor::Static(index)).await?;
        }
        worker.join(uplink).await?;
        Ok(worker)
    }

    #[cfg(not(target_family = "wasm"))]
    async fn read(&mut self) -> Result<Value> {
        let mut line = String::new();
        if tokio::time::timeout(START_TIMEOUT, self.output.read_line(&mut line)).await?? == 0 {
            bail!("独立预览服务已退出");
        }
        Ok(serde_json::from_str(&line)?)
    }

    #[cfg(target_family = "wasm")]
    async fn read(&mut self) -> Result<Value> {
        let bytes = tokio::time::timeout(START_TIMEOUT, self.instance.receive()).await??;
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn exited(&mut self) -> bool {
        #[cfg(not(target_family = "wasm"))]
        return !matches!(self.child.try_wait(), Ok(None));
        #[cfg(target_family = "wasm")]
        return self.instance.closed();
    }

    async fn command(&mut self, command: Value) -> Result<bool> {
        self.usable = false;
        #[cfg(target_family = "wasm")]
        let ok = self.instance.command(&command).await?;
        #[cfg(not(target_family = "wasm"))]
        let ok = {
            tokio::time::timeout(
                START_TIMEOUT,
                crate::adapter::stdio::write_json_line(&mut self.input, &command),
            )
            .await??;
            self.read()
                .await?
                .get("ok")
                .and_then(Value::as_bool)
                .context("invalid preview worker response")?
        };
        self.usable = true;
        Ok(ok)
    }

    #[cfg(target_family = "wasm")]
    async fn prepare_executor(&mut self, executor: &Executor) -> Result<&mut Execution> {
        if !self.extra_workers.contains_key(executor) {
            let mut execution = Execution::start(&self.config, &self.suffix, "preview-executor")?;
            let ready = tokio::time::timeout(START_TIMEOUT, execution.receive()).await??;
            let ready: Value = serde_json::from_slice(&ready)?;
            if ready.get("port").and_then(Value::as_u64) != Some(0) {
                bail!("预览工作线程尚未就绪");
            }
            self.extra_workers.insert(executor.clone(), execution);
        }
        self.extra_workers
            .get_mut(executor)
            .context("预览工作线程尚未就绪")
    }

    #[cfg(target_family = "wasm")]
    fn executor_for(&self, site: &Site, service: Option<&Value>) -> Option<Executor> {
        use std::hash::{DefaultHasher, Hash, Hasher};
        if self.config.run_threads {
            if let Some(run) = service.and_then(|value| value["runId"].as_str()) {
                return Some(Executor::Service(run.to_owned()));
            }
        }
        if self.config.static_threads <= 1 {
            return None;
        }
        let mut hash = DefaultHasher::new();
        site.absolute_root.hash(&mut hash);
        let index = (hash.finish() % self.config.static_threads as u64) as usize;
        (index != 0).then_some(Executor::Static(index))
    }

    #[cfg(target_family = "wasm")]
    async fn open_routed(
        &mut self,
        executor: &Executor,
        host: &str,
        command: &Value,
    ) -> Result<u64> {
        let target = self.prepare_executor(executor).await?;
        match target.command(command).await {
            Ok(true) => {}
            result => {
                if result.is_err() {
                    self.extra_workers.remove(executor);
                }
                bail!("预览工作线程拒绝了视图");
            }
        }
        let id = target.id().context("预览工作线程没有路由句柄")?;
        if !self
            .command(json!({"op":"route","host":host,"target":id}))
            .await?
        {
            if let Some(target) = self.extra_workers.get_mut(executor) {
                let _ = target.command(&json!({"op":"close","host":host})).await;
            }
            bail!("独立预览无法路由到工作线程");
        }
        Ok(id)
    }

    fn serving_lease(&self, lease: &Lease) -> bool {
        #[cfg(target_family = "wasm")]
        return lease.executor.as_ref().is_none_or(|(executor, id)| {
            self.extra_workers
                .get(executor)
                .is_some_and(|worker| worker.id() == Some(*id) && !worker.closed())
        });
        #[cfg(not(target_family = "wasm"))]
        {
            let _ = lease;
            true
        }
    }

    fn collect_idle(&mut self) {
        #[cfg(target_family = "wasm")]
        self.extra_workers.retain(|executor, _| {
            matches!(executor, Executor::Static(_))
                || self.views.values().any(|lease| {
                    lease
                        .executor
                        .as_ref()
                        .is_some_and(|(key, _)| key == executor)
                })
        });
    }

    async fn join(&mut self, uplink: &Uplink) -> Result<()> {
        if uplink.suffix != self.suffix
            || uplink.workbench_origin != self.workbench_origin
            || uplink.port != self.port
        {
            self.usable = false;
            bail!("独立预览入口配置已经变更");
        }
        if !self
            .command(json!({"op":"join_relay","url":uplink.url,"ticket":uplink.ticket}))
            .await?
        {
            bail!("独立预览中转未接通");
        }
        Ok(())
    }

    fn belongs_to(&self, enrollment: &Enrollment) -> bool {
        self.enrollment.daemon_id == enrollment.daemon_id
            && self.enrollment.hub_url == enrollment.hub_url
            && self.enrollment.secret == enrollment.secret
    }

    async fn close_view(&mut self, host: &str) -> Result<()> {
        let command = json!({"op":"close","host":host});
        #[cfg(target_family = "wasm")]
        if let Some((executor, id)) = self
            .views
            .get(host)
            .and_then(|lease| lease.executor.clone())
        {
            if let Some(target) = self
                .extra_workers
                .get_mut(&executor)
                .filter(|target| target.id() == Some(id))
            {
                if !matches!(target.command(&command).await, Ok(true)) {
                    self.extra_workers.remove(&executor);
                }
            }
        }
        if !self.command(command).await? {
            self.usable = false;
            bail!("独立预览服务无法关闭视图");
        }
        self.views.remove(host);
        self.collect_idle();
        Ok(())
    }

    async fn retire(self) {
        let enrollment = self.enrollment.clone();
        let hosts = self.views.keys().cloned().collect();
        // Drop the IPC and kill the worker before waiting on Hub cleanup.
        drop(self);
        remove_routes(&enrollment, hosts).await;
    }
}

async fn remove_routes(enrollment: &Enrollment, hosts: Vec<String>) {
    use futures_util::StreamExt;
    if hosts.is_empty() {
        return;
    }
    let hub = hub::Client::new(&enrollment.hub_url);
    let requests = futures_util::stream::iter(hosts)
        .map(|host| {
            let hub = &hub;
            async move {
                let _ = hub.remove_preview_view(enrollment, &host).await;
            }
        })
        .buffer_unordered(8)
        .for_each(|_| std::future::ready(()));
    let _ = tokio::time::timeout(Duration::from_secs(3), requests).await;
}

async fn current_enrollment(state: &Shared) -> Option<Enrollment> {
    state.link.get()?.preview_enrollment().await.ok()
}

#[derive(Default)]
pub(crate) struct Manager {
    worker: Mutex<Option<Worker>>,
    enrollment_changed: Notify,
}

impl Manager {
    pub(crate) fn supervise(state: &Shared) -> Option<tokio::task::JoinHandle<()>> {
        let config = LocalConfig::read()?;
        let state = state.clone();
        Some(tokio::spawn(async move {
            let mut retry_delay = MAINTENANCE_INTERVAL;
            loop {
                let delay = match state.static_preview.maintain(&state, &config).await {
                    Ok(()) => {
                        retry_delay = MAINTENANCE_INTERVAL;
                        MAINTENANCE_INTERVAL
                    }
                    Err(error) => {
                        tracing::warn!(%error, "maintaining independent preview worker failed");
                        let delay = retry_delay;
                        retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
                        delay
                    }
                };
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = state.static_preview.enrollment_changed.notified() => {
                        retry_delay = MAINTENANCE_INTERVAL;
                    }
                }
            }
        }))
    }

    pub(crate) fn enrollment_changed(&self) {
        self.enrollment_changed.notify_one();
    }

    async fn maintain(&self, state: &Shared, config: &LocalConfig) -> Result<()> {
        let enrollment = current_enrollment(state).await;
        let mut slot = self.worker.lock().await;
        if slot.as_mut().is_some_and(|worker| {
            !worker.usable
                || enrollment
                    .as_ref()
                    .is_none_or(|enrollment| !worker.belongs_to(enrollment))
                || worker.exited()
        }) {
            let retired = slot.take();
            drop(slot);
            if let Some(worker) = retired {
                worker.retire().await;
            }
            slot = self.worker.lock().await;
        }
        let Some(enrollment) = enrollment else {
            return Ok(());
        };
        if let Some(worker) = slot.as_mut() {
            #[cfg(target_family = "wasm")]
            worker
                .extra_workers
                .retain(|_, executor| !executor.closed());
            let now = Instant::now();
            let expired_or_revoked: Vec<_> = worker
                .views
                .iter()
                .filter_map(|(host, lease)| {
                    let expired = lease.expires <= now;
                    (expired
                        || !worker.serving_lease(lease)
                        || lease.peer.as_ref().is_some_and(|peer| revoked(peer, state)))
                    .then(|| (host.clone(), !expired))
                })
                .collect();
            let mut revoked_routes = Vec::new();
            for (host, revoke_route) in expired_or_revoked {
                if let Err(error) = worker.close_view(&host).await {
                    let retired = slot.take();
                    drop(slot);
                    if let Some(worker) = retired {
                        worker.retire().await;
                    }
                    remove_routes(&enrollment, revoked_routes).await;
                    return Err(error);
                }
                if revoke_route {
                    revoked_routes.push(host);
                }
            }
            worker.collect_idle();
            #[cfg(target_family = "wasm")]
            for index in 1..worker.config.static_threads {
                worker.prepare_executor(&Executor::Static(index)).await?;
            }
            let online = worker.command(json!({"op":"relay_status"})).await;
            drop(slot);
            remove_routes(&enrollment, revoked_routes).await;
            if online? {
                return Ok(());
            }
        } else {
            drop(slot);
        }

        let uplink = hub::Client::new(&enrollment.hub_url)
            .preview_uplink(&enrollment)
            .await?;
        let mut slot = self.worker.lock().await;
        if let Some(worker) = slot.as_mut() {
            if worker.usable {
                return worker.join(&uplink).await;
            }
            // A concurrent open or revoke lost the worker while we fetched the ticket.
            return Ok(());
        }
        // Keep control requests free to report readiness while the worker starts.
        drop(slot);
        let worker = Worker::start(config, enrollment, &uplink).await?;
        let mut slot = self.worker.lock().await;
        if current_enrollment(state)
            .await
            .as_ref()
            .is_some_and(|current| worker.belongs_to(current))
        {
            *slot = Some(worker);
        }
        Ok(())
    }

    pub(crate) async fn stop(&self) {
        let worker = self.worker.lock().await.take();
        drop(worker);
    }

    pub(crate) async fn open(
        &self,
        state: &Shared,
        enrollment: Enrollment,
        site: Site,
        share: Option<(&str, i64, Vec<String>)>,
        peer: Option<PeerAccess>,
        service: Option<serde_json::Value>,
        review: bool,
    ) -> Result<StaticPreviewGrant> {
        let storage_scope = peer.as_ref().map(|peer| {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(peer.principal.as_bytes()))
        });
        let (share, allowed) = match share {
            Some((id, deadline, files)) => (Some((id, deadline)), Some(files)),
            None => (None, None),
        };
        let hub = hub::Client::new(&enrollment.hub_url);
        let mut slot = self.worker.lock().await;
        let worker = slot
            .as_mut()
            .filter(|worker| worker.usable && worker.belongs_to(&enrollment))
            .context("独立预览正在恢复，请稍后重试")?;
        if !worker.command(json!({"op":"relay_status"})).await? {
            bail!("独立预览中转暂未接通，请稍后重试");
        }
        let now = chrono::Utc::now().timestamp_millis();
        let mut ttl = if let Some((_, deadline)) = &share {
            let remaining = deadline.saturating_sub(now) / 1000;
            if remaining <= 0 {
                bail!("分享链接已到期");
            }
            VIEW_SECONDS.min(remaining as u64)
        } else {
            VIEW_SECONDS
        };
        if let Some(peer) = &peer {
            if revoked(peer, state) {
                bail!("预览授权已失效");
            }
            if let Some(deadline) = peer.authorization_expires_at {
                ttl = ttl.min(
                    deadline
                        .saturating_duration_since(std::time::Instant::now())
                        .as_secs(),
                );
            }
        }
        if ttl == 0 {
            bail!("预览授权已到期");
        }
        if worker.views.len() >= MAX_VIEWS {
            bail!("该机器的独立预览视图已满");
        }
        let host = format!("{}.{}", Uuid::new_v4().simple(), worker.suffix);
        let code = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let digest = format!("{:x}", Sha256::digest(code.as_bytes()));
        let expires_at = now + ttl as i64 * 1000;
        let scope = match allowed {
            Some(paths) => json!({"kind":"files","paths":paths}),
            None => json!({"kind":"site"}),
        };
        let expires = Instant::now() + Duration::from_secs(ttl);
        #[cfg(target_family = "wasm")]
        let workspace = &site.workspace;
        #[cfg(not(target_family = "wasm"))]
        let workspace = crate::guest_paths::host_path(&site.workspace);
        #[cfg(target_family = "wasm")]
        let executor = worker.executor_for(&site, service.as_ref());
        let command = json!({
            "op":"open","host":host,"workspace":workspace,
            "root":site.root,"entry":site.entry,"workbench_origin":worker.workbench_origin,
            "ttl_seconds":ttl,"expires_at_ms":expires_at,"scope":scope,"bootstrap_digest":digest,
            "https_port":worker.port,"service":service,"review":review,
        });
        #[cfg(target_family = "wasm")]
        let executor = if let Some(executor) = executor {
            let id = worker.open_routed(&executor, &host, &command).await?;
            Some((executor, id))
        } else {
            if !worker.command(command).await? {
                bail!("独立预览服务拒绝了文件或租约");
            }
            None
        };
        #[cfg(not(target_family = "wasm"))]
        if !worker.command(command).await? {
            bail!("独立预览服务拒绝了文件或租约");
        }
        worker.views.insert(
            host.clone(),
            Lease {
                #[cfg(target_family = "wasm")]
                executor,
                share: share.map(|(id, _)| id.to_owned()),
                expires,
                peer,
            },
        );
        if let Err(error) = hub
            .register_preview_view(&enrollment, &host, expires_at)
            .await
        {
            let _ = worker.close_view(&host).await;
            return Err(error);
        }
        let authority = if worker.port == 443 {
            host
        } else {
            format!("{host}:{}", worker.port)
        };
        Ok(StaticPreviewGrant {
            action: format!("https://{authority}/.well-known/genehub/preview-bootstrap"),
            code,
            storage_scope,
        })
    }

    pub(crate) async fn revoke_share(&self, share: &str) {
        let mut slot = self.worker.lock().await;
        let Some(worker) = slot.as_mut() else {
            return;
        };
        let hosts: Vec<_> = worker
            .views
            .iter()
            .filter(|(_, lease)| lease.share.as_deref() == Some(share))
            .map(|(host, _)| host.clone())
            .collect();
        let enrollment = worker.enrollment.clone();
        for host in &hosts {
            if worker.close_view(host).await.is_err() {
                let retired = slot.take();
                drop(slot);
                if let Some(worker) = retired {
                    worker.retire().await;
                }
                remove_routes(&enrollment, hosts).await;
                return;
            }
        }
        drop(slot);
        remove_routes(&enrollment, hosts).await;
    }
}
