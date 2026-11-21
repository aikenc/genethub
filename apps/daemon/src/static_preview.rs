//! Control plane for independent static previews. The native worker owns the
//! TLS private key, browser connections and a dedicated Fabric uplink.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use genehub_proto::StaticPreviewGrant;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;
use tokio::time::Instant;
use uuid::Uuid;

use crate::config::Enrollment;
use crate::dataplane::endpoint::PeerAccess;
use crate::hub;
use crate::os_process::{Child, ChildStdin, ChildStdout, Command};
use crate::state::Shared;
use crate::workspace::ResolvedWorkspacePath;

const START_TIMEOUT: Duration = Duration::from_secs(12);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
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
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    suffix: String,
    workbench_origin: String,
    port: u16,
    enrollment: Enrollment,
    views: HashMap<String, Lease>,
    idle_since: Instant,
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
    async fn start(config: LocalConfig, enrollment: Enrollment, uplink: &Uplink) -> Result<Self> {
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
            _child: child,
            input,
            output,
            suffix: uplink.suffix.clone(),
            workbench_origin: uplink.workbench_origin.clone(),
            port: uplink.port,
            enrollment,
            views: HashMap::new(),
            idle_since: Instant::now(),
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

    fn prune(&mut self) -> bool {
        let now = Instant::now();
        let had_views = !self.views.is_empty();
        self.views.retain(|_, lease| lease.expires > now);
        if had_views && self.views.is_empty() {
            self.idle_since = now;
        }
        self.views.is_empty() && now.duration_since(self.idle_since) >= IDLE_TIMEOUT
    }
}

#[derive(Default)]
pub(crate) struct Manager {
    worker: Mutex<Option<Worker>>,
}

impl Manager {
    async fn open_inner(
        self: &Arc<Self>,
        state: &Shared,
        slot: &mut Option<Worker>,
        enrollment: Enrollment,
        site: Site,
        allowed: Option<Vec<String>>,
        share: Option<(String, i64)>,
        peer: Option<PeerAccess>,
        service: Option<serde_json::Value>,
    ) -> Result<StaticPreviewGrant> {
        let hub = hub::Client::new(&enrollment.hub_url);
        if let Some(worker) = slot {
            if !worker.usable
                || worker.enrollment.daemon_id != enrollment.daemon_id
                || worker.enrollment.hub_url != enrollment.hub_url
                || worker.enrollment.secret != enrollment.secret
                || worker.prune()
            {
                *slot = None;
            }
        }
        if slot.is_none() {
            let config = LocalConfig::read().context("此设备未启用独立预览")?;
            let uplink = hub.preview_uplink(&enrollment).await?;
            *slot = Some(Worker::start(config, enrollment.clone(), &uplink).await?);
            self.watch_authority(state);
        }
        let worker = slot.as_mut().context("独立预览进程不可用")?;
        if !worker.command(json!({"op":"relay_status"})).await? {
            worker.join(&hub.preview_uplink(&enrollment).await?).await?;
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
                "https_port":worker.port,"service":service,
            }))
            .await?
        {
            bail!("独立预览进程拒绝了文件或租约");
        }
        worker.views.insert(
            host.clone(),
            Lease {
                share: share.map(|(id, _)| id),
                expires,
                peer,
            },
        );
        if let Err(error) = hub
            .register_preview_view(&enrollment, &host, expires_at)
            .await
        {
            let _ = worker.command(json!({"op":"close","host":host})).await;
            worker.views.remove(&host);
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

    pub(crate) async fn open(
        self: &Arc<Self>,
        state: &Shared,
        enrollment: Enrollment,
        site: Site,
        share: Option<(&str, i64, Vec<String>)>,
        peer: Option<PeerAccess>,
        service: Option<serde_json::Value>,
    ) -> Result<StaticPreviewGrant> {
        let (share, allowed) = match share {
            Some((id, deadline, files)) => (Some((id.to_owned(), deadline)), Some(files)),
            None => (None, None),
        };
        let mut slot = self.worker.lock().await;
        self.open_inner(state, &mut slot, enrollment, site, allowed, share, peer, service)
            .await
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
            if !matches!(
                worker.command(json!({"op":"close","host":host})).await,
                Ok(true)
            ) {
                *slot = None;
                break;
            }
            worker.views.remove(host);
        }
        drop(slot);
        let hub = hub::Client::new(&enrollment.hub_url);
        for host in hosts {
            let _ = hub.remove_preview_view(&enrollment, &host).await;
        }
    }

    fn watch_authority(self: &Arc<Self>, state: &Shared) {
        let manager = Arc::downgrade(self);
        let state = Arc::downgrade(state);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let (Some(manager), Some(state)) = (manager.upgrade(), state.upgrade()) else {
                    break;
                };
                let mut slot = manager.worker.lock().await;
                let Some(worker) = slot.as_mut() else {
                    break;
                };
                if worker.prune() {
                    *slot = None;
                    break;
                }
                let hosts: Vec<_> = worker
                    .views
                    .iter()
                    .filter(|(_, lease)| {
                        lease
                            .peer
                            .as_ref()
                            .is_some_and(|peer| revoked(peer, &state))
                    })
                    .map(|(host, _)| host.clone())
                    .collect();
                let enrollment = worker.enrollment.clone();
                for host in &hosts {
                    if !matches!(
                        worker.command(json!({"op":"close","host":host})).await,
                        Ok(true)
                    ) {
                        *slot = None;
                        break;
                    }
                    worker.views.remove(host);
                }
                drop(slot);
                let hub = hub::Client::new(&enrollment.hub_url);
                for host in hosts {
                    let _ = hub.remove_preview_view(&enrollment, &host).await;
                }
            }
        });
    }
}
