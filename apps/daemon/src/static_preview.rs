//! Control plane for independent static previews. The native worker owns the
//! TLS private key, browser connections and a dedicated Fabric uplink.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use genehub_proto::StaticPreviewGrant;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;
use uuid::Uuid;

use crate::config::Enrollment;
use crate::dataplane::endpoint::PeerAccess;
use crate::hub;
use crate::os_process::{Child, ChildStdin, ChildStdout, Command};
use crate::state::Shared;
use crate::workspace::ResolvedWorkspacePath;

const START_TIMEOUT: Duration = Duration::from_secs(12);
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(5);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
const VIEW_SECONDS: u64 = 900;

struct LocalConfig {
    cli: PathBuf,
    cert: PathBuf,
    key: PathBuf,
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
        Some(Self {
            // The native host injects the verified front door into the guest
            // as GENEHUB_CLI. Its own startup override is host-only.
            cli: file("GENEHUB_CLI")?,
            cert: file("GENEHUB_PREVIEW_TLS_CERT")?,
            key: file("GENEHUB_PREVIEW_TLS_KEY")?,
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
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    suffix: String,
    workbench_origin: String,
    port: u16,
    enrollment: Enrollment,
    views: HashMap<String, Lease>,
    usable: bool,
}

struct Lease {
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
        let mut child = command.spawn().context("启动独立预览进程失败")?;
        let input = child.stdin.take().context("missing preview worker input")?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .context("missing preview worker output")?,
        );
        let mut worker = Self {
            child,
            input,
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
            bail!("独立预览进程未就绪");
        }
        worker.join(uplink).await?;
        Ok(worker)
    }

    async fn read(&mut self) -> Result<Value> {
        let mut line = String::new();
        if tokio::time::timeout(START_TIMEOUT, self.output.read_line(&mut line)).await?? == 0 {
            bail!("独立预览进程已退出");
        }
        Ok(serde_json::from_str(&line)?)
    }

    async fn command(&mut self, command: Value) -> Result<bool> {
        self.usable = false;
        tokio::time::timeout(
            START_TIMEOUT,
            crate::adapter::stdio::write_json_line(&mut self.input, &command),
        )
        .await??;
        let reply = self.read().await?;
        let ok = reply
            .get("ok")
            .and_then(Value::as_bool)
            .context("invalid preview worker response")?;
        self.usable = true;
        Ok(ok)
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
        if !self.command(json!({"op":"close","host":host})).await? {
            self.usable = false;
            bail!("独立预览进程无法关闭视图");
        }
        self.views.remove(host);
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
                || enrollment.as_ref().is_none_or(|enrollment| !worker.belongs_to(enrollment))
                || !matches!(worker.child.try_wait(), Ok(None))
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
            let now = Instant::now();
            let expired_or_revoked: Vec<_> = worker
                .views
                .iter()
                .filter_map(|(host, lease)| {
                    let expired = lease.expires <= now;
                    (expired || lease.peer.as_ref().is_some_and(|peer| revoked(peer, state)))
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
            let online = worker.command(json!({"op":"relay_status"})).await;
            drop(slot);
            remove_routes(&enrollment, revoked_routes).await;
            if online? {
                return Ok(());
            }
        } else {
            drop(slot);
        }

        let uplink = hub::Client::new(&enrollment.hub_url).preview_uplink(&enrollment).await?;
        let mut slot = self.worker.lock().await;
        if let Some(worker) = slot.as_mut() {
            if worker.usable {
                return worker.join(&uplink).await;
            }
            // A concurrent open or revoke lost the worker while we fetched the ticket.
            return Ok(());
        }
        // Keep control requests free to report readiness while the child starts.
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
        let host = format!("{}.{}", Uuid::new_v4().simple(), worker.suffix);
        let code = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let digest = format!("{:x}", Sha256::digest(code.as_bytes()));
        let expires_at = now + ttl as i64 * 1000;
        let scope = match allowed {
            Some(paths) => json!({"kind":"files","paths":paths}),
            None => json!({"kind":"site"}),
        };
        let expires = Instant::now() + Duration::from_secs(ttl);
        if !worker
            .command(json!({
                "op":"open","host":host,"workspace":crate::guest_paths::host_path(&site.workspace),
                "root":site.root,"entry":site.entry,"workbench_origin":worker.workbench_origin,
                "ttl_seconds":ttl,"expires_at_ms":expires_at,"scope":scope,"bootstrap_digest":digest,
                "https_port":worker.port,"service":service,"review":review,
            }))
            .await?
        {
            bail!("独立预览进程拒绝了文件或租约");
        }
        worker.views.insert(
            host.clone(),
            Lease {
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
