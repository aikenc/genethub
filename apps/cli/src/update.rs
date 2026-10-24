//! Native, channel-local update entry. The worker survives the caller/guest.
mod install;
mod supervisor;
mod worker;

use anyhow::{bail, Context, Result};
use genet_frontdoor::{channel, managed_update as records, version::ProductVersion, Paths};
use records::{AppTarget, Progress, Request, RuntimeIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Default)]
struct Options {
    id: Option<String>,
    resume: Option<String>,
    wait: bool,
}
fn options(args: &[String]) -> Result<Options> {
    let mut out = Options::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--request-id" if out.id.is_none() => {
                out.id = Some(it.next().context("--request-id requires a value")?.clone())
            }
            "--resume-session" if out.resume.is_none() => {
                out.resume = Some(
                    it.next()
                        .context("--resume-session requires a value")?
                        .clone(),
                )
            }
            "--wait" if !out.wait => out.wait = true,
            _ => bail!("unknown update argument {arg}"),
        }
    }
    if let Some(id) = &out.id {
        records::valid_id(id)?;
    }
    if let Some(id) = &out.resume {
        records::valid_id(id)?;
    }
    Ok(out)
}
pub async fn run(args: &[String]) -> i32 {
    let result = execute(args).await;
    match result {
        Ok(value) => {
            println!(
                "{}",
                json!({"schema":"genet.cli/v1","type":if args.first().map(String::as_str)==Some("check"){"update.check"}else{"update.status"},"data":value})
            );
            crate::EXIT_OK
        }
        Err(error) => {
            let message = format!("{error:#}");
            let code = if message.contains("appRequired:") {
                "appRequired"
            } else if message.contains("requestIdConflict:") {
                "requestIdConflict"
            } else if message.contains("needsInteraction:") {
                "needsInteraction"
            } else if message.contains("updateBusy:") {
                "updateBusy"
            } else {
                "updateFailed"
            };
            crate::fail_envelope(genet_frontdoor::envelope::CliFailure::business(
                code, message, None,
            ))
        }
    }
}
async fn execute(args: &[String]) -> Result<Value> {
    let verb = args
        .first()
        .context("usage: update check|live|app|status")?;
    let paths = Paths::discover()?;
    if verb == "__run" {
        anyhow::ensure!(args.len() == 2, "invalid worker invocation");
        worker::run(&paths, &args[1]).await?;
        return records::receipt(&paths.root, &args[1]);
    }
    if verb == "check" {
        anyhow::ensure!(args.len() == 1, "update check takes no arguments");
        let guest = crate::wasm::locate().map_err(anyhow::Error::msg)?;
        let runtime = runtime().await?;
        let live = host_call(
            &guest.host,
            &["check".into(), guest.component.to_string_lossy().into()],
        )
        .await;
        let app = app_target().await;
        return Ok(json!({"channel":channel::CHANNEL,"current":runtime,
            "live":live.unwrap_or_else(|e|json!({"problem":format!("{e:#}")})),
            "app":app.map(|a|json!({"newer":newer(&a.version,&runtime.app_version),"target":a})).unwrap_or_else(|e|json!({"problem":format!("{e:#}")})),
            "interruptsSessions":true}));
    }
    let opts = options(&args[1..])?;
    if verb == "status" {
        anyhow::ensure!(
            opts.resume.is_none(),
            "status does not accept --resume-session"
        );
        let id = opts.id.context("status requires --request-id")?;
        return wait_receipt(&paths.root, &id, opts.wait).await;
    }
    anyhow::ensure!(
        verb == "live" || verb == "app",
        "usage: update check|live|app|status"
    );
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    bail!("native managed updates are currently available on Linux and macOS CLI installations");
    let id = opts
        .id
        .unwrap_or_else(|| format!("upd_{}", uuid::Uuid::new_v4().simple()));
    let dir = records::job(&paths.root, &id)?;
    paths.ensure()?;
    let _submission = exclusive(&records::root(&paths.root).join("submission.lock"))?;
    if dir.exists() {
        let old: Request = records::read(&dir.join("request.json"))?;
        anyhow::ensure!(
            old.kind == *verb
                && old.channel == channel::CHANNEL
                && opts
                    .resume
                    .as_ref()
                    .is_none_or(|s| Some(s) == old.resume_session.as_ref()),
            "requestIdConflict: this request ID already names different parameters"
        );
        drop(_submission);
        return wait_receipt(&paths.root, &id, opts.wait).await;
    }
    // Do not accept a second operation while an independent worker owns this
    // channel. A duplicate request above still returns its original receipt.
    let _probe = exclusive(&records::root(&paths.root).join("execution.lock"))?;
    let cli = std::env::current_exe()?.canonicalize()?;
    let scoped = own_session_environment(&cli);
    let resume = opts.resume.or_else(|| {
        scoped
            .then(|| std::env::var("GENEHUB_SESSION_ID").ok())
            .flatten()
    });
    let guest = crate::wasm::locate().map_err(anyhow::Error::msg)?;
    let from = runtime().await?;
    let app = if verb == "app" {
        Some(app_target().await?)
    } else {
        None
    };
    let live = if verb == "live" {
        Some(
            host_call(
                &guest.host,
                &["check".into(), guest.component.to_string_lossy().into()],
            )
            .await?,
        )
    } else {
        None
    };
    if let Some(v) = &live {
        anyhow::ensure!(
            v["appRequired"] != true,
            "appRequired: the available component needs a newer App"
        );
    }
    if verb == "app" {
        install::preflight(&cli, &from).await?;
    }
    std::fs::create_dir_all(&dir)?;
    let request = Request {
        schema: "genehub.update-request.v1".into(),
        request_id: id.clone(),
        channel: channel::CHANNEL.into(),
        kind: verb.clone(),
        created_at_ms: records::now_ms(),
        cli,
        host: guest.host.canonicalize()?,
        component: guest.component.canonicalize()?,
        from,
        resume_session: resume,
        app,
        live,
    };
    records::write(&dir.join("request.json"), &request)?;
    records::write(&dir.join("progress.json"), &Progress::accepted())?;
    let prepare: Result<()> = async {
        // Freeze both executables outside the install directory before handoff.
        std::fs::copy(&request.cli, dir.join(exe_name("worker")))?;
        std::fs::copy(&request.host, dir.join(exe_name("host")))?;
        crate::invoke::update_call(vec!["update".into(), "bind".into(), id.clone()], scoped)
            .await
            .map_err(anyhow::Error::msg)?;
        drop(_probe);
        supervisor::launch(&paths, &id)?;
        Ok(())
    }
    .await;
    drop(_submission);
    if let Err(error) = prepare {
        let mut progress = Progress::accepted();
        progress.state = "failed".into();
        progress.error = Some(format!("{error:#}"));
        records::write(&dir.join("progress.json"), &progress)?;
        return records::receipt(&paths.root, &id);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let p: Progress = records::read(&dir.join("progress.json"))?;
        if p.worker_pid.is_some() || p.terminal() {
            break;
        }
        if std::time::Instant::now() > deadline {
            // A delayed OS job may still start: leave the request accepted and
            // report unknown handoff rather than authorising another install.
            let mut value = records::receipt(&paths.root, &id)?;
            value["handoffPending"] = json!(true);
            return Ok(value);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    wait_receipt(&paths.root, &id, opts.wait).await
}
fn own_session_environment(cli: &Path) -> bool {
    std::env::var_os("GENEHUB_CLI")
        .and_then(|p| PathBuf::from(p).canonicalize().ok())
        .is_some_and(|p| p == cli)
        && std::env::var("GENEHUB_SESSION_ID").is_ok()
        && std::env::var("GENEHUB_CONTROLLER_TOKEN").is_ok()
}
pub(super) async fn runtime() -> Result<RuntimeIdentity> {
    let value = crate::invoke::update_call(vec!["update".into(), "runtime".into()], false)
        .await
        .map_err(anyhow::Error::msg)?;
    let result: RuntimeIdentity = serde_json::from_value(value)?;
    anyhow::ensure!(
        result.channel == channel::CHANNEL,
        "daemon channel mismatch"
    );
    Ok(result)
}
async fn wait_receipt(data: &Path, id: &str, wait: bool) -> Result<Value> {
    let end = std::time::Instant::now() + Duration::from_secs(if wait { 180 } else { 0 });
    loop {
        let dir = records::job(data, id)?;
        let mut progress: Progress = records::read(&dir.join("progress.json"))?;
        if progress.worker_pid.is_some() && !progress.terminal() {
            if let Ok(_lease) = exclusive(&records::root(data).join("execution.lock")) {
                progress.state = "interrupted".into();
                progress.error=Some("the update worker exited before recording a final result; inspect this request before recovery".into());
                progress.updated_at_ms = records::now_ms();
                records::write(&dir.join("progress.json"), &progress)?;
            }
        }
        let mut value = records::receipt(data, id)?;
        value["query"] = json!(format!(
            "{} update status --request-id {}",
            channel::CLI_BINARY,
            id
        ));
        if !wait || progress.terminal() || std::time::Instant::now() >= end {
            return Ok(value);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
pub(super) fn exclusive(path: &Path) -> Result<std::fs::File> {
    if let Some(parent) = path.parent() {
        genet_frontdoor::perms::ensure_real_directory(parent)?;
        genet_frontdoor::perms::restrict_dir_to_owner(parent)?;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    genet_frontdoor::perms::restrict_to_owner(path)?;
    fs2::FileExt::try_lock_exclusive(&file)
        .context("updateBusy: another updater owns this channel")?;
    Ok(file)
}
pub(super) fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    }
}
pub(super) async fn host_call(host: &Path, args: &[String]) -> Result<Value> {
    let output = tokio::process::Command::new(host)
        .env(channel::ENV_DATA_DIR, Paths::discover()?.root)
        .arg("component-update")
        .args(args)
        .output()
        .await?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}
pub(super) fn newer(latest: &str, current: &str) -> bool {
    ProductVersion::parse(latest)
        .ok()
        .zip(ProductVersion::parse(current).ok())
        .is_some_and(|(a, b)| a > b)
}
#[derive(Deserialize, Serialize)]
struct AppManifest {
    channel: String,
    version: String,
    platforms: std::collections::BTreeMap<String, AppAsset>,
}
#[derive(Deserialize, Serialize)]
struct AppAsset {
    url: String,
    sha256: String,
    size: u64,
    #[serde(default)]
    kind: Option<String>,
}
async fn app_target() -> Result<AppTarget> {
    let mut url = channel::DEFAULT_MANIFEST_URL.to_string();
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("GENEHUB_APP_MANIFEST_URL") {
        url = value;
    }
    anyhow::ensure!(!url.is_empty(), "this channel has no App update source");
    let manifest: AppManifest = serde_json::from_slice(&fetch(&url, 1024 * 1024).await?)?;
    anyhow::ensure!(
        manifest.channel == channel::CHANNEL,
        "App manifest channel mismatch"
    );
    ProductVersion::parse(&manifest.version)?;
    if channel::CHANNEL != "local" {
        anyhow::ensure!(
            if channel::CHANNEL == "stable" {
                !manifest.version.contains('-')
            } else {
                manifest
                    .version
                    .contains(&format!("-{}.", channel::CHANNEL))
            },
            "App version belongs to another channel"
        );
    }
    anyhow::ensure!(
        manifest
            .version
            .split('-')
            .next()
            .and_then(|b| b.rsplit('.').next())
            == Some("0"),
        "App manifest must name an App generation"
    );
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "aarch64") => "darwin-aarch64",
        _ => bail!("no CLI App package for this platform"),
    };
    let asset = manifest
        .platforms
        .get(platform)
        .context("the App manifest has no CLI package for this platform")?;
    anyhow::ensure!(
        asset.kind.as_deref() == Some("cli"),
        "the App asset is not a CLI installation package"
    );
    anyhow::ensure!(
        asset.sha256.len() == 64
            && asset.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            && asset.size > 0
            && asset.size <= 512 * 1024 * 1024,
        "invalid App integrity metadata"
    );
    validate_url(&asset.url)?;
    Ok(AppTarget {
        version: manifest.version,
        url: asset.url.clone(),
        sha256: asset.sha256.to_lowercase(),
        size: asset.size,
    })
}
fn validate_url(raw: &str) -> Result<()> {
    let url = genet_http::Url::parse(raw)?;
    anyhow::ensure!(
        url.username().is_empty() && url.password().is_none(),
        "update URLs must not contain credentials"
    );
    anyhow::ensure!(
        url.scheme() == "https"
            || cfg!(debug_assertions)
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "[::1]")),
        "update URLs require HTTPS"
    );
    Ok(())
}
pub(super) async fn fetch(url: &str, limit: usize) -> Result<Vec<u8>> {
    validate_url(url)?;
    let client = genet_http::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(genet_http::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || validate_url(attempt.url().as_str()).is_err() {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()?;
    let response = client.get(url).send().await?;
    anyhow::ensure!(
        response.status().is_success(),
        "update source returned {}",
        response.status()
    );
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= limit as u64),
        "update download exceeds size limit"
    );
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        anyhow::ensure!(
            bytes.len().saturating_add(chunk.len()) <= limit,
            "update download exceeds size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Called before the native CLI becomes a daemon after an OS restart. Never
/// replays installation: restore a set interrupted before any new start, or
/// leave installed bytes in place and delegate verification to a fresh worker.
pub(crate) fn recover_before_daemon() -> Result<Option<PathBuf>> {
    let paths = Paths::discover()?;
    if genet_frontdoor::lifecycle::instance_locked(&paths)? {
        return Ok(None);
    }
    let Ok(_lease) = exclusive(&records::root(&paths.root).join("execution.lock")) else {
        return Ok(None);
    };
    let cli = std::env::current_exe()?.canonicalize()?;
    let entries = match std::fs::read_dir(records::root(&paths.root).join("requests")) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut verify = None;
    let mut restored = false;
    for entry in entries.take(10000) {
        let dir = entry?.path();
        let Ok(request) = records::read::<Request>(&dir.join("request.json")) else {
            continue;
        };
        let Ok(mut progress) = records::read::<Progress>(&dir.join("progress.json")) else {
            continue;
        };
        if request.schema != "genehub.update-request.v1"
            || request.channel != channel::CHANNEL
            || request.cli != cli
            || progress.terminal() && progress.state != "interrupted"
        {
            continue;
        }
        if request.kind == "app" && matches!(progress.phase.as_str(), "stopping" | "installing") {
            if progress.phase == "installing" {
                install::replace(&paths, &request, true)?;
                restored = true;
                progress.rollback = Some("restoredBeforeRestart".into());
            }
            progress.state = "failed".into();
            progress.error = Some(
                "OS restart recovered an App transaction interrupted before new daemon startup"
                    .into(),
            );
            progress.updated_at_ms = records::now_ms();
            records::write(&dir.join("progress.json"), &progress)?;
        } else if matches!(
            progress.phase.as_str(),
            "starting" | "appReady" | "liveCheck" | "downloadingLive" | "activatingLive"
        ) {
            // A new daemon may already have used its data. Verify the current
            // installation; do not downgrade it or issue a second apply.
            progress.state = "recovering".into();
            progress.worker_pid = None;
            records::write(&dir.join("progress.json"), &progress)?;
            verify = Some(request.request_id.clone());
        } else {
            progress.state = "failed".into();
            progress.error = Some(
                "update preparation was interrupted; installed software was not replaced".into(),
            );
            progress.updated_at_ms = records::now_ms();
            records::write(&dir.join("progress.json"), &progress)?;
        }
    }
    drop(_lease);
    if let Some(id) = verify {
        supervisor::launch(&paths, &id)?;
    }
    Ok(restored.then_some(cli))
}
