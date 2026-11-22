//! Source-machine TLS and streaming file serving. The supervisor owns stdin
//! and writes view leases over a private pipe. TCP clients cannot register or
//! extend a lease, and closing the pipe shuts down the worker and all streams.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
#[cfg(not(target_family = "wasm"))]
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
#[cfg(not(target_family = "wasm"))]
use cap_std::fs::{Dir, OpenOptions};
use futures_util::{StreamExt, TryStreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Empty, Limited, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{self, HeaderValue};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto;
#[cfg(not(target_family = "wasm"))]
use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::io::AsyncReadExt;
#[cfg(not(target_family = "wasm"))]
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};
#[cfg(not(target_family = "wasm"))]
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, RwLock, Semaphore};
use tokio::time::Instant;
#[cfg(not(target_family = "wasm"))]
use tokio_rustls::TlsAcceptor;
use tokio_util::io::ReaderStream;

#[cfg(target_family = "wasm")]
#[path = "preview_data/guest_io.rs"]
mod guest_io;
#[path = "preview_data/relay.rs"]
mod relay;
#[path = "preview_data/review.rs"]
mod review;
#[path = "preview_data/service.rs"]
mod service;
#[cfg(target_family = "wasm")]
use guest_io::{open_file, open_site, Dir};

#[cfg(not(target_family = "wasm"))]
const MAX_COMMAND_BYTES: u64 = 1024 * 1024;
const MAX_ALLOWED_FILES: usize = 4096;
const MAX_VIEWS: usize = 64;
const MAX_CONNECTIONS: usize = 128;
const MAX_READS_PER_SITE: usize = 16;
const MAX_PENDING_PER_SITE: usize = 64;
const MAX_LEASE: Duration = Duration::from_secs(3600);
const BOOTSTRAP_LIFETIME: Duration = Duration::from_secs(60);
const TLS_TIMEOUT: Duration = Duration::from_secs(8);
const READ_QUEUE_TIMEOUT: Duration = Duration::from_secs(5);
const CHUNK_SIZE: usize = 64 * 1024;
const BOOTSTRAP_PATH: &str = "/.well-known/genehub/preview-bootstrap";
const COOKIE_NAME: &str = "__Host-genehub-preview";
const FORM_PREFIX: &[u8] = b"code=";
const SECRET_BYTES: usize = 64;
const FRAME_POLICY: HeaderValue = HeaderValue::from_static("frame-ancestors 'none'");

type Body = UnsyncBoxBody<Bytes, io::Error>;
type Views = Arc<RwLock<HashMap<String, Arc<View>>>>;

struct SiteBudget {
    reads: Arc<Semaphore>,
    pending: Semaphore,
    service: Arc<Semaphore>,
}

struct View {
    root: PathBuf,
    directory: Dir,
    budget: Arc<SiteBudget>,
    entry: PathBuf,
    location: HeaderValue,
    workbench_origin: HeaderValue,
    origin: HeaderValue,
    service: Option<service::Run>,
    review: bool,
    frame_policy: HeaderValue,
    bootstrap_digest: [u8; 32],
    bootstrap_deadline: Instant,
    bootstrap_redeemed: AtomicBool,
    cookie: String,
    scope: FileScope,
    deadline: Instant,
    revoked: watch::Sender<bool>,
}

enum FileScope {
    Site,
    Files(HashSet<PathBuf>),
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Scope {
    Site,
    Files { paths: Vec<String> },
}

impl FileScope {
    fn from_command(scope: Scope, entry: &Path) -> Result<Self> {
        let Scope::Files { paths } = scope else {
            return Ok(Self::Site);
        };
        if paths.len() > MAX_ALLOWED_FILES {
            bail!("too many files in preview grant");
        }
        let paths: HashSet<PathBuf> = paths
            .iter()
            .map(|path| local_path(path, false).context("invalid allowed preview file"))
            .collect::<Result<_>>()?;
        if !paths.contains(entry) {
            bail!("preview grant does not cover the entry");
        }
        Ok(Self::Files(paths))
    }

    fn permits(&self, path: &Path) -> bool {
        match self {
            Self::Site => true,
            Self::Files(paths) => paths.contains(path),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    Open {
        host: String,
        workspace: PathBuf,
        root: String,
        entry: String,
        workbench_origin: String,
        bootstrap_digest: String,
        scope: Scope,
        service: Option<service::Run>,
        https_port: Option<u16>,
        #[serde(default)]
        review: bool,
        ttl_seconds: u64,
        expires_at_ms: Option<u64>,
    },
    Close {
        host: String,
    },
    Route {
        host: String,
        target: u64,
    },
    JoinRelay {
        url: String,
        ticket: String,
    },
    RelayStatus,
}

#[cfg(not(target_family = "wasm"))]
pub fn run(cert: &str, key: &str, suffix: &str) -> Result<()> {
    if suffix.len() > 220 || !suffix.contains('.') || !suffix.split('.').all(valid_label) {
        bail!("invalid preview hostname suffix");
    }
    let chain = CertificateDer::pem_file_iter(cert)?.collect::<Result<Vec<_>, _>>()?;
    let key = PrivateKeyDer::from_pem_file(key)?;
    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(chain, key)?;
    tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?
        .block_on(serve(suffix, TlsAcceptor::from(Arc::new(tls))))
}

#[cfg(not(target_family = "wasm"))]
async fn serve(suffix: &str, tls: TlsAcceptor) -> Result<()> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let address = listener.local_addr()?;
    reply(serde_json::json!({ "port": address.port() }))?;
    let views = Views::default();
    tokio::select! {
        result = control_loop(suffix, &views, address) => result,
        result = accept_loop(listener, tls, &views) => result,
    }
}

#[cfg(not(target_family = "wasm"))]
async fn accept_loop(listener: TcpListener, tls: TlsAcceptor, views: &Views) -> Result<()> {
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (client, _) = listener.accept().await?;
        if let Ok(permit) = connections.clone().try_acquire_owned() {
            let tls = tls.clone();
            let views = views.clone();
            tokio::spawn(async move {
                let _permit = permit;
                serve_connection(client, tls, views).await;
            });
        }
    }
}

#[cfg(not(target_family = "wasm"))]
async fn control_loop(suffix: &str, views: &Views, address: std::net::SocketAddr) -> Result<()> {
    let mut control = BufReader::new(tokio::io::stdin());
    let mut command = Vec::new();
    let mut uplink: Option<tokio::task::JoinHandle<()>> = None;
    loop {
        let mut bounded = (&mut control).take(MAX_COMMAND_BYTES);
        if bounded.read_until(b'\n', &mut command).await? == 0 {
            return Ok(());
        }
        if !command.ends_with(b"\n") {
            bail!("incomplete or oversized worker command");
        }
        let result = handle_command(&command, suffix, views, address, &mut uplink).await;
        command.clear();
        reply(reply_value(result))?;
    }
}

fn reply_value(result: Result<()>) -> serde_json::Value {
    serde_json::json!({
        "ok": result.is_ok(),
        "error": result.err().map(|error| error.to_string()),
    })
}

async fn handle_command(
    command: &[u8],
    suffix: &str,
    views: &Views,
    address: std::net::SocketAddr,
    uplink: &mut Option<tokio::task::JoinHandle<()>>,
) -> Result<()> {
    match serde_json::from_slice::<Control>(command) {
        Ok(Control::JoinRelay { url, ticket }) => {
            if let Some(old) = uplink.take() {
                old.abort();
                let _ = old.await;
            }
            *uplink = Some(relay::connect(url, ticket, address).await?);
            Ok(())
        }
        Ok(Control::RelayStatus) => {
            if uplink
                .as_ref()
                .is_some_and(|connection| !connection.is_finished())
            {
                Ok(())
            } else {
                Err(anyhow::anyhow!("preview Relay is disconnected"))
            }
        }
        Ok(Control::Route { .. }) => Err(anyhow::anyhow!("invalid worker routing command")),
        Ok(command) => apply(command, views, suffix).await,
        Err(_) => Err(anyhow::anyhow!("invalid command")),
    }
}

#[cfg(not(target_family = "wasm"))]
fn reply(value: serde_json::Value) -> Result<()> {
    use std::io::Write;
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{value}")?;
    stdout.flush()?;
    Ok(())
}

#[cfg(target_family = "wasm")]
pub(crate) mod guest_control {
    use anyhow::{Context, Result};
    use genet_wasi::wit::genehub::host::worker;
    use tokio::sync::mpsc;

    pub(crate) enum Port {
        Thread,
        Local {
            incoming: mpsc::Receiver<Vec<u8>>,
            outgoing: mpsc::Sender<Vec<u8>>,
        },
    }

    impl Port {
        pub(super) async fn receive(&mut self) -> Result<Vec<u8>> {
            match self {
                Self::Thread => loop {
                    if let Some(message) = worker::receive().map_err(anyhow::Error::msg)? {
                        return Ok(message);
                    }
                    genet_wasi::poll::idle().await;
                },
                Self::Local { incoming, .. } => {
                    incoming.recv().await.context("preview manager stopped")
                }
            }
        }

        pub(super) fn reply(&self, value: serde_json::Value) -> Result<()> {
            let bytes = serde_json::to_vec(&value)?;
            match self {
                Self::Thread => worker::send(&bytes).map_err(anyhow::Error::msg),
                Self::Local { outgoing, .. } => outgoing
                    .try_send(bytes)
                    .map_err(|_| anyhow::anyhow!("preview manager stopped reading")),
            }
        }
    }
}

#[cfg(target_family = "wasm")]
pub(crate) async fn run_guest(
    cert: &str,
    key: &str,
    suffix: &str,
    mut port: guest_control::Port,
    accepts_inline: bool,
) -> Result<()> {
    use genet_wasi::wit::genehub::host::tls_server;
    if suffix.len() > 220 || !suffix.contains('.') || !suffix.split('.').all(valid_label) {
        bail!("invalid preview hostname suffix");
    }
    // Transport is negotiated once by the uplink owner. Other workers receive
    // a freshly granted Store-local handle to the negotiated TLS stream.
    let listener = accepts_inline
        .then(|| tls_server::listen_loopback(cert, key))
        .transpose()
        .map_err(anyhow::Error::msg)?;
    let address = std::net::SocketAddr::from((
        [127, 0, 0, 1],
        listener.as_ref().map_or(0, |value| value.port()),
    ));
    port.reply(serde_json::json!({ "port": address.port() }))?;
    let views = Views::default();
    let routes = Arc::new(RwLock::new(HashMap::<String, u64>::new()));
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let accept = async {
        let mut sessions = tokio::task::JoinSet::new();
        loop {
            while sessions.try_join_next().is_some() {}
            let connection = match &listener {
                Some(listener) => listener.accept(),
                None => tls_server::receive(),
            }
            .map_err(anyhow::Error::msg)?;
            if let Some(connection) = connection {
                if let Ok(permit) = connections.clone().try_acquire_owned() {
                    let views = views.clone();
                    let routes = routes.clone();
                    sessions.spawn(async move {
                        let _permit = permit;
                        let Ok((io, host)) = guest_io::Tls::open(connection).await else {
                            return;
                        };
                        let target = routes.read().await.get(&host).copied();
                        if let Some(target) = target {
                            let _ = tls_server::transfer(io.into_connection(), target);
                        } else {
                            serve_http(io, host, views).await;
                        }
                    });
                }
            } else {
                genet_wasi::poll::idle().await;
            }
        }
    };
    let control = async {
        let mut uplink = UplinkTask(None);
        loop {
            let message = port.receive().await?;
            let result = match serde_json::from_slice::<Control>(&message) {
                Ok(Control::Route { host, target }) if accepts_inline && target != 0 => {
                    if !host
                        .strip_suffix(suffix)
                        .is_some_and(|prefix| prefix.ends_with('.'))
                    {
                        Err(anyhow::anyhow!("invalid routed host"))
                    } else {
                        routes.write().await.insert(host, target);
                        Ok(())
                    }
                }
                Ok(Control::Close { host }) => {
                    routes.write().await.remove(&host);
                    apply(Control::Close { host }, &views, suffix).await
                }
                Ok(Control::JoinRelay { .. }) if !accepts_inline => {
                    Err(anyhow::anyhow!("executor has no uplink"))
                }
                _ => handle_command(&message, suffix, &views, address, &mut uplink.0).await,
            };
            port.reply(reply_value(result))?;
        }
    };
    let result = tokio::select! {
        result = accept => result,
        result = control => result,
    };
    for (_, view) in views.write().await.drain() {
        view.revoked.send_replace(true);
    }
    result
}

#[cfg(target_family = "wasm")]
struct UplinkTask(Option<tokio::task::JoinHandle<()>>);

#[cfg(target_family = "wasm")]
impl Drop for UplinkTask {
    fn drop(&mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
        }
    }
}

fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

async fn apply(command: Control, views: &Views, suffix: &str) -> Result<()> {
    match command {
        Control::Open {
            host,
            workspace,
            root,
            entry,
            workbench_origin,
            bootstrap_digest,
            scope,
            service,
            https_port,
            review,
            ttl_seconds,
            expires_at_ms,
        } => {
            if let Some(run) = &service {
                run.validate()?;
                if !matches!(&scope, Scope::Site) {
                    bail!("file grants cannot open a preview service");
                }
            }
            // The first label is a fresh 128-bit view identifier chosen by the
            // supervisor. Only the configured wildcard suffix is admissible.
            let view = host
                .strip_suffix(suffix)
                .and_then(|prefix| prefix.strip_suffix('.'))
                .context("invalid view hostname")?;
            if view.len() != 32
                || !view
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                bail!("invalid view hostname");
            }
            let ttl = Duration::from_secs(ttl_seconds);
            if ttl.is_zero() || ttl > MAX_LEASE || !workspace.is_absolute() {
                bail!("invalid workspace or lease");
            }
            let ttl = if let Some(expires_at_ms) = expires_at_ms {
                let deadline = std::time::UNIX_EPOCH
                    .checked_add(Duration::from_millis(expires_at_ms))
                    .context("invalid preview deadline")?;
                ttl.min(
                    deadline
                        .duration_since(std::time::SystemTime::now())
                        .context("preview lease expired")?,
                )
            } else {
                ttl
            };
            let deadline = Instant::now() + ttl;
            let origin: hyper::Uri = workbench_origin
                .parse()
                .context("invalid Workbench origin")?;
            if origin.scheme_str() != Some("https")
                || origin.authority().is_none_or(|authority| {
                    !authority.host().split('.').all(valid_label)
                        || authority.host() == host
                        || authority
                            .as_str()
                            .strip_prefix(authority.host())
                            .is_none_or(|port| !port.is_empty() && authority.port_u16().is_none())
                })
                || origin
                    .path_and_query()
                    .is_some_and(|path| path.as_str() != "/")
            {
                bail!("invalid Workbench origin");
            }
            let workbench_origin = HeaderValue::from_str(workbench_origin.trim_end_matches('/'))?;
            let frame_policy = if review {
                HeaderValue::from_str(&format!(
                    "frame-ancestors {}; frame-src 'none'",
                    workbench_origin.to_str()?
                ))?
            } else {
                FRAME_POLICY
            };
            let bootstrap_digest =
                decode_digest(&bootstrap_digest).context("invalid bootstrap digest")?;
            let location = entry_location(&entry)?;
            let root = local_path(&root, true).context("invalid preview root")?;
            let entry = local_path(&entry, false).context("invalid preview entry")?;
            let scope = FileScope::from_command(scope, &entry)?;
            let path = workspace.join(&root);
            #[cfg(not(target_family = "wasm"))]
            let (directory, entry) = tokio::task::spawn_blocking(move || {
                let directory = open_site(&workspace, &root).context("opening preview root")?;
                open_file(&directory, &entry).context("opening preview entry")?;
                Ok::<_, anyhow::Error>((directory, entry))
            })
            .await??;
            #[cfg(target_family = "wasm")]
            let directory = {
                let directory = open_site(&workspace, &root).context("opening preview root")?;
                open_file(&directory, &entry).context("opening preview entry")?;
                directory
            };
            let mut views = views.write().await;
            views.retain(|_, view| view.deadline > Instant::now());
            if views.contains_key(&host) || views.len() >= MAX_VIEWS {
                bail!("view already exists or view budget exhausted");
            }
            let budget = views
                .values()
                .find(|view| view.root == path)
                .map(|view| view.budget.clone())
                .unwrap_or_else(|| {
                    Arc::new(SiteBudget {
                        reads: Arc::new(Semaphore::new(MAX_READS_PER_SITE)),
                        pending: Semaphore::new(MAX_PENDING_PER_SITE),
                        service: Arc::new(Semaphore::new(16)),
                    })
                });
            let origin = match https_port {
                None | Some(443) => format!("https://{host}"),
                Some(port) => format!("https://{host}:{port}"),
            }
            .parse()?;
            views.insert(
                host,
                Arc::new(View {
                    root: path,
                    directory,
                    budget,
                    entry,
                    location,
                    workbench_origin,
                    origin,
                    service,
                    review,
                    frame_policy,
                    bootstrap_digest,
                    bootstrap_deadline: deadline.min(Instant::now() + BOOTSTRAP_LIFETIME),
                    bootstrap_redeemed: AtomicBool::new(false),
                    cookie: uuid::Uuid::new_v4().simple().to_string(),
                    scope,
                    deadline,
                    revoked: watch::channel(false).0,
                }),
            );
        }
        Control::Close { host } => {
            if let Some(view) = views.write().await.remove(&host) {
                view.revoked.send_replace(true);
            }
        }
        Control::JoinRelay { .. } | Control::RelayStatus | Control::Route { .. } => {
            unreachable!("handled by control loop")
        }
    }
    Ok(())
}

fn decode_digest(value: &str) -> Option<[u8; 32]> {
    if value.len() != SECRET_BYTES || !value.is_ascii() {
        return None;
    }
    let mut decoded = [0; 32];
    for (chunk, byte) in value.as_bytes().chunks_exact(2).zip(&mut decoded) {
        *byte = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(decoded)
}

fn entry_location(entry: &str) -> Result<HeaderValue> {
    let mut location = String::new();
    for segment in entry.split('/') {
        location.push('/');
        location.extend(percent_encoding::utf8_percent_encode(
            segment,
            percent_encoding::NON_ALPHANUMERIC,
        ));
    }
    Ok(HeaderValue::from_str(&location)?)
}

fn checked_component(part: &str) -> Option<&str> {
    if part.is_empty()
        || part.starts_with('.')
        || part.ends_with(['.', ' '])
        || part
            .bytes()
            .any(|byte| byte.is_ascii_control() || b"/\\:*?\"<>|".contains(&byte))
    {
        return None;
    }
    let stem = part.split('.').next()?.to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        return None;
    }
    Some(part)
}

fn local_path(path: &str, allow_empty: bool) -> Option<PathBuf> {
    if path.is_empty() && allow_empty {
        return Some(PathBuf::new());
    }
    path.split('/').map(checked_component).collect()
}

fn request_path(raw: &str, entry: &Path) -> Option<PathBuf> {
    if raw == "/" {
        return Some(entry.to_owned());
    }
    let raw = raw.strip_prefix('/')?;
    let raw = raw.strip_suffix('/').unwrap_or(raw);
    let mut path = PathBuf::new();
    for segment in raw.split('/') {
        let decoded = percent_encoding::percent_decode_str(segment)
            .decode_utf8()
            .ok()?;
        path.push(checked_component(&decoded)?);
    }
    Some(path)
}

#[cfg(not(target_family = "wasm"))]
fn open_site(workspace: &Path, root: &Path) -> io::Result<Dir> {
    let mut directory = match (workspace.parent(), workspace.file_name()) {
        (Some(parent), Some(name)) => {
            Dir::open_ambient_dir(parent, cap_std::ambient_authority())?.open_dir_nofollow(name)?
        }
        _ => return Err(io::ErrorKind::InvalidInput.into()),
    };
    for component in root {
        directory = directory.open_dir_nofollow(component)?;
    }
    Ok(directory)
}

#[cfg(not(target_family = "wasm"))]
fn open_file(root: &Dir, path: &Path) -> io::Result<(std::fs::File, u64)> {
    let mut directory = root.try_clone()?;
    for component in path.parent().into_iter().flat_map(Path::iter) {
        directory = directory.open_dir_nofollow(component)?;
    }
    let name = path.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = directory.open_with(name, &options)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::ErrorKind::NotFound.into());
    }
    Ok((file.into_std(), metadata.len()))
}

#[cfg(not(target_family = "wasm"))]
async fn serve_connection(client: TcpStream, tls: TlsAcceptor, views: Views) {
    let Ok(Ok(client)) = tokio::time::timeout(TLS_TIMEOUT, tls.accept(client)).await else {
        return;
    };
    let Some(host) = client
        .get_ref()
        .1
        .server_name()
        .map(str::to_ascii_lowercase)
    else {
        return;
    };
    serve_http(client, host, views).await;
}

async fn serve_http<I>(client: I, host: String, views: Views)
where
    I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    let view = views.read().await.get(&host).cloned();
    let Some(view) = view.filter(|view| view.deadline > Instant::now()) else {
        return;
    };
    let mut revoked = view.revoked.subscribe();
    let deadline = view.deadline;
    let service = service_fn(move |request| {
        let view = view.clone();
        let host = host.clone();
        async move { Ok::<_, Infallible>(respond(request, view, &host).await) }
    });
    let mut builder = auto::Builder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(TLS_TIMEOUT);
    builder.http2().max_concurrent_streams(32);
    tokio::select! {
        _ = revoked.wait_for(|revoked| *revoked) => {}
        _ = tokio::time::sleep_until(deadline) => {}
        _ = builder.serve_connection_with_upgrades(TokioIo::new(client), service) => {}
    }
}

async fn respond(request: Request<Incoming>, view: Arc<View>, host: &str) -> Response<Body> {
    let authority = request.uri().authority();
    let host_header = request.headers().get(header::HOST);
    let matches =
        |authority: &hyper::http::uri::Authority| authority.host().eq_ignore_ascii_case(host);
    if (authority.is_none() && host_header.is_none())
        || authority.is_some_and(|authority| !matches(authority))
        || host_header.is_some_and(|header| {
            !header
                .to_str()
                .ok()
                .and_then(|host| host.parse().ok())
                .as_ref()
                .is_some_and(matches)
        })
    {
        return empty(StatusCode::MISDIRECTED_REQUEST);
    }
    if request.uri().path() == BOOTSTRAP_PATH {
        return bootstrap(request, &view).await;
    }
    if view.review && request.uri().path() == review::FRAME_PATH && request.method() == Method::GET
    {
        return review::frame(&view);
    }
    if view.review && request.uri().path() == review::SCRIPT_PATH && request.method() == Method::GET
    {
        return if has_view_cookie(request.headers(), &view.cookie) {
            review::script(&view)
        } else {
            empty(StatusCode::FORBIDDEN)
        };
    }
    if let Some(run) = view
        .service
        .as_ref()
        .filter(|_| request.uri().path().starts_with("/api/"))
    {
        if !has_view_cookie(request.headers(), &view.cookie) {
            return empty(StatusCode::FORBIDDEN);
        }
        return service::respond(request, view.clone(), run, &view.budget.service).await;
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        let mut response = empty(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    if !has_view_cookie(request.headers(), &view.cookie) {
        return empty(StatusCode::FORBIDDEN);
    }
    let Some(path) = request_path(request.uri().path(), &view.entry) else {
        return empty(StatusCode::FORBIDDEN);
    };
    if !view.scope.permits(&path) {
        return empty(StatusCode::FORBIDDEN);
    }
    if request.uri().path() == "/" {
        let mut response = empty(StatusCode::TEMPORARY_REDIRECT);
        response
            .headers_mut()
            .insert(header::LOCATION, view.location.clone());
        return response;
    }
    let permit = match view.budget.reads.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            let Ok(_pending) = view.budget.pending.try_acquire() else {
                return empty(StatusCode::SERVICE_UNAVAILABLE);
            };
            let Ok(Ok(permit)) = tokio::time::timeout(
                READ_QUEUE_TIMEOUT,
                view.budget.reads.clone().acquire_owned(),
            )
            .await
            else {
                return empty(StatusCode::SERVICE_UNAVAILABLE);
            };
            permit
        }
    };
    #[cfg(not(target_family = "wasm"))]
    let opened = tokio::task::spawn_blocking({
        let view = view.clone();
        let path = path.clone();
        move || open_file(&view.directory, &path)
    })
    .await;
    #[cfg(target_family = "wasm")]
    let opened: Result<_, tokio::task::JoinError> = Ok(open_file(&view.directory, &path));
    let (file, size) = match opened {
        Ok(Ok(opened)) => opened,
        Ok(Err(error)) if error.kind() == io::ErrorKind::PermissionDenied => {
            return empty(StatusCode::FORBIDDEN)
        }
        Ok(Err(_)) => return empty(StatusCode::NOT_FOUND),
        Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let range = if request.method() == Method::GET {
        request.headers().get(header::RANGE)
    } else {
        None
    };
    let (start, length) = match range {
        Some(value) => match value
            .to_str()
            .ok()
            .and_then(|value| parse_range(value, size))
        {
            Some(bounds) => bounds,
            None => {
                let mut response = empty(StatusCode::RANGE_NOT_SATISFIABLE);
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{size}")).unwrap(),
                );
                return response;
            }
        },
        None => (0, size),
    };
    let status = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let media_type = content_type(&path);
    let review_page = view.review
        && media_type.starts_with("text/html")
        && request
            .headers()
            .get("sec-fetch-dest")
            .is_some_and(|dest| dest == "iframe")
        && range.is_none();
    let (body, wire_length) = if request.method() == Method::HEAD {
        (empty_body(), length)
    } else {
        #[cfg(not(target_family = "wasm"))]
        let mut file = tokio::fs::File::from_std(file);
        #[cfg(not(target_family = "wasm"))]
        if start != 0 && file.seek(io::SeekFrom::Start(start)).await.is_err() {
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
        #[cfg(target_family = "wasm")]
        let mut file = file.at(start);
        let (prefix, consumed) = if review_page {
            match review::read_prefix(&mut file, length, &view.workbench_origin).await {
                Ok((prefix, consumed)) => (Some(prefix), consumed),
                Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
            }
        } else {
            (None, 0)
        };
        let wire_length = length - consumed + prefix.as_ref().map_or(0, |chunk| chunk.len() as u64);
        let stream = futures_util::stream::iter(prefix.map(Ok))
            .chain(ReaderStream::with_capacity(
                file.take(length - consumed),
                CHUNK_SIZE,
            ))
            // Keep the read budget for the lifetime of the HTTP body.
            .map(move |chunk| {
                let _permit = &permit;
                chunk
            })
            .map_ok(Frame::data);
        (StreamBody::new(stream).boxed_unsync(), wire_length)
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_LENGTH, wire_length)
        .header(header::CONTENT_TYPE, media_type)
        .header(header::ACCEPT_RANGES, "bytes");
    if range.is_some() {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", start + length - 1),
        );
    }
    let mut response = response.body(body).expect("valid static response headers");
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, view.frame_policy.clone());
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        "cross-origin-embedder-policy",
        HeaderValue::from_static("require-corp"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    if review_page {
        review::headers(headers, &view);
    }
    response
}

fn has_view_cookie(headers: &hyper::HeaderMap, expected: &str) -> bool {
    let mut values = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|header| header.split(';'))
        .filter_map(|item| {
            let (name, value) = item.trim().split_once('=')?;
            (name == COOKIE_NAME).then_some(value)
        });
    values
        .next()
        .is_some_and(|value| bool::from(value.as_bytes().ct_eq(expected.as_bytes())))
        && values.next().is_none()
}

fn redeem_code(body: &[u8], expected: &[u8; 32], redeemed: &AtomicBool) -> bool {
    let Some(code) = body.strip_prefix(FORM_PREFIX) else {
        return false;
    };
    code.len() == SECRET_BYTES
        && code
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && bool::from(Sha256::digest(code).as_slice().ct_eq(expected))
        && !redeemed.swap(true, Ordering::AcqRel)
}

async fn bootstrap(request: Request<Incoming>, view: &View) -> Response<Body> {
    if Instant::now() >= view.bootstrap_deadline
        || request.method() != Method::POST
        || request.uri().query().is_some()
        || request.headers().get(header::ORIGIN) != Some(&view.workbench_origin)
        || request.headers().get(header::CONTENT_TYPE)
            != Some(&HeaderValue::from_static(
                "application/x-www-form-urlencoded",
            ))
    {
        return empty(StatusCode::FORBIDDEN);
    }
    let body = Limited::new(request.into_body(), FORM_PREFIX.len() + SECRET_BYTES);
    let collected = tokio::time::timeout(TLS_TIMEOUT, body.collect()).await;
    let Ok(Ok(body)) = collected else {
        return empty(StatusCode::FORBIDDEN);
    };
    if Instant::now() >= view.bootstrap_deadline
        || !redeem_code(
            &body.to_bytes(),
            &view.bootstrap_digest,
            &view.bootstrap_redeemed,
        )
    {
        return empty(StatusCode::FORBIDDEN);
    }
    let max_age = view
        .deadline
        .saturating_duration_since(Instant::now())
        .as_secs();
    if max_age == 0 {
        return empty(StatusCode::FORBIDDEN);
    }
    let mut response = empty(StatusCode::SEE_OTHER);
    let headers = response.headers_mut();
    headers.insert(header::LOCATION, view.location.clone());
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE_NAME}={}; Max-Age={max_age}; Secure; HttpOnly; SameSite=Lax; Path=/",
            view.cookie,
        ))
        .expect("cookie contains only ASCII"),
    );
    if view.review {
        review::headers(headers, view);
    }
    response
}

fn empty(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CONTENT_SECURITY_POLICY, FRAME_POLICY)
        .body(empty_body())
        .unwrap()
}

fn empty_body() -> Body {
    Empty::new().map_err(|error| match error {}).boxed_unsync()
}

fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (low, high) = value.strip_prefix("bytes=")?.split_once('-')?;
    if low.is_empty() {
        let length: u64 = high.parse().ok()?;
        let length = length.min(size);
        return (length != 0).then(|| (size - length, length));
    }
    let start: u64 = low.parse().ok()?;
    let last = size.checked_sub(1)?;
    let end = if high.is_empty() {
        last
    } else {
        high.parse::<u64>().ok()?.min(last)
    };
    (start <= end).then(|| (start, end - start + 1))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .to_str()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("ogg") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bootstrap_cannot_be_replayed_or_consumed_with_an_invalid_code() {
        let code = "e4".repeat(32);
        let digest = Sha256::digest(code.as_bytes()).into();
        let redeemed = AtomicBool::new(false);
        assert!(!redeem_code(b"code=short", &digest, &redeemed));
        assert!(!redeem_code(
            format!("code={}", "aa".repeat(32)).as_bytes(),
            &digest,
            &redeemed,
        ));
        let form = format!("code={code}");
        assert!(redeem_code(form.as_bytes(), &digest, &redeemed));
        assert!(!redeem_code(form.as_bytes(), &digest, &redeemed));
    }

    #[test]
    fn share_scope_checks_the_resolved_file_and_requires_the_entry() {
        let entry = Path::new("nested/index.html");
        let scope = FileScope::from_command(
            Scope::Files {
                paths: vec!["nested/index.html".into(), "nested/data.bin".into()],
            },
            entry,
        )
        .unwrap();
        assert!(scope.permits(&request_path("/", entry).unwrap()));
        assert!(scope.permits(&request_path("/nested/%64ata.bin", entry).unwrap()));
        assert!(!scope.permits(&request_path("/nested/private.bin", entry).unwrap()));
        assert!(request_path("/nested/%2E%2E/private.bin", entry).is_none());
        assert!(FileScope::from_command(Scope::Files { paths: Vec::new() }, entry).is_err());
    }

    #[test]
    fn the_view_cookie_has_an_exact_name_and_a_single_value() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_static("other=secret"));
        assert!(!has_view_cookie(&headers, "secret"));
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("__Host-genehub-preview=secret"),
        );
        assert!(has_view_cookie(&headers, "secret"));
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("__Host-genehub-preview=wrong"),
        );
        assert!(!has_view_cookie(&headers, "secret"));
    }

    #[test]
    fn encoded_redirect_keeps_the_entry_directory() {
        let location = entry_location("站点/A B.html").unwrap();
        assert_eq!(location, "/%E7%AB%99%E7%82%B9/A%20B%2Ehtml");
        assert_eq!(
            request_path(location.to_str().unwrap(), Path::new("unused")).unwrap(),
            Path::new("站点/A B.html"),
        );
    }
}
