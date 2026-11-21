//! Source-machine TLS and streaming file serving. The supervisor owns stdin
//! and writes view leases over a private pipe. TCP clients cannot register or
//! extend a lease, and closing the pipe shuts down the worker and all streams.

use std::collections::HashMap;
use std::convert::Infallible;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use futures_util::{StreamExt, TryStreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Empty, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{self, HeaderValue};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto;
use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, RwLock, Semaphore};
use tokio::time::Instant;
use tokio_rustls::TlsAcceptor;
use tokio_util::io::ReaderStream;

const MAX_COMMAND_BYTES: u64 = 16 * 1024;
const MAX_VIEWS: usize = 64;
const MAX_CONNECTIONS: usize = 128;
const MAX_READS_PER_SITE: usize = 16;
const MAX_PENDING_PER_SITE: usize = 64;
const MAX_LEASE: Duration = Duration::from_secs(3600);
const TLS_TIMEOUT: Duration = Duration::from_secs(8);
const READ_QUEUE_TIMEOUT: Duration = Duration::from_secs(5);
const CHUNK_SIZE: usize = 64 * 1024;

type Body = UnsyncBoxBody<Bytes, io::Error>;
type Views = Arc<RwLock<HashMap<String, Arc<View>>>>;

struct SiteBudget {
    reads: Arc<Semaphore>,
    pending: Semaphore,
}

struct View {
    root: PathBuf,
    directory: Dir,
    budget: Arc<SiteBudget>,
    entry: PathBuf,
    ancestor: HeaderValue,
    deadline: Instant,
    revoked: watch::Sender<bool>,
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
        ttl_seconds: u64,
    },
    Close {
        host: String,
    },
}

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

async fn serve(suffix: &str, tls: TlsAcceptor) -> Result<()> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    reply(serde_json::json!({ "port": listener.local_addr()?.port() }))?;
    let views = Views::default();
    tokio::select! {
        result = control_loop(suffix, &views) => result,
        result = accept_loop(listener, tls, &views) => result,
    }
}

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

async fn control_loop(suffix: &str, views: &Views) -> Result<()> {
    let mut control = BufReader::new(tokio::io::stdin());
    let mut command = Vec::new();
    loop {
        let mut bounded = (&mut control).take(MAX_COMMAND_BYTES);
        if bounded.read_until(b'\n', &mut command).await? == 0 {
            return Ok(());
        }
        if !command.ends_with(b"\n") {
            bail!("incomplete or oversized worker command");
        }
        let result = match serde_json::from_slice::<Control>(&command) {
            Ok(command) => apply(command, views, suffix).await,
            Err(_) => Err(anyhow::anyhow!("invalid command")),
        };
        command.clear();
        reply(serde_json::json!({
            "ok": result.is_ok(),
            "error": result.err().map(|error| error.to_string()),
        }))?;
    }
}

fn reply(value: serde_json::Value) -> Result<()> {
    use std::io::Write;
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{value}")?;
    stdout.flush()?;
    Ok(())
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
            ttl_seconds,
        } => {
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
            let ancestor = HeaderValue::from_str(&format!(
                "frame-ancestors {}",
                workbench_origin.trim_end_matches('/')
            ))?;
            let root = local_path(&root, true).context("invalid preview root")?;
            let entry = local_path(&entry, false).context("invalid preview entry")?;
            let path = workspace.join(&root);
            let (directory, entry) = tokio::task::spawn_blocking(move || {
                let directory = open_site(&workspace, &root).context("opening preview root")?;
                open_file(&directory, &entry).context("opening preview entry")?;
                Ok::<_, anyhow::Error>((directory, entry))
            })
            .await??;
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
                    })
                });
            views.insert(
                host,
                Arc::new(View {
                    root: path,
                    directory,
                    budget,
                    entry,
                    ancestor,
                    deadline: Instant::now() + ttl,
                    revoked: watch::channel(false).0,
                }),
            );
        }
        Control::Close { host } => {
            if let Some(view) = views.write().await.remove(&host) {
                view.revoked.send_replace(true);
            }
        }
    }
    Ok(())
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
        _ = builder.serve_connection(TokioIo::new(client), service) => {}
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
    if request.method() != Method::GET && request.method() != Method::HEAD {
        let mut response = empty(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let Some(path) = request_path(request.uri().path(), &view.entry) else {
        return empty(StatusCode::FORBIDDEN);
    };
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
    let opened = tokio::task::spawn_blocking({
        let view = view.clone();
        let path = path.clone();
        move || open_file(&view.directory, &path)
    })
    .await;
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
    let body = if request.method() == Method::HEAD {
        empty_body()
    } else {
        let mut file = tokio::fs::File::from_std(file);
        if start != 0 && file.seek(io::SeekFrom::Start(start)).await.is_err() {
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
        let stream = ReaderStream::with_capacity(file.take(length), CHUNK_SIZE)
            // Keep the read budget for the lifetime of the HTTP body.
            .map(move |chunk| {
                let _permit = &permit;
                chunk
            })
            .map_ok(Frame::data);
        StreamBody::new(stream).boxed_unsync()
    };
    let media_type = content_type(&path);
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_LENGTH, length)
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
    headers.insert(header::CONTENT_SECURITY_POLICY, view.ancestor.clone());
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
    // An isolated parent needs explicit opt-in for a cross-origin document.
    // The view's frame-ancestors header restricts which Workbench may embed it.
    let resource_policy = if media_type.starts_with("text/html") {
        "cross-origin"
    } else {
        "same-origin"
    };
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static(resource_policy),
    );
    response
}

fn empty(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
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
