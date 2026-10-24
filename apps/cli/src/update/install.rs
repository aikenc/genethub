//! Prepare all bytes first, then replace only this installation's channel files.
use super::*;
use crate::control::{Manager, Service};
use std::process::Command;

pub(super) async fn preflight(cli: &Path, from: &RuntimeIdentity) -> Result<()> {
    anyhow::ensure!(
        !cli.components()
            .any(|p| p.as_os_str().to_string_lossy().ends_with(".app")),
        "desktop App installation is not supported by this CLI package updater"
    );
    let parent = cli.parent().context("CLI has no installation directory")?;
    let probe = parent.join(format!(".update-write-{}", uuid::Uuid::new_v4().simple()));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .context("needsInteraction: installation directory is not writable")?;
    drop(file);
    std::fs::remove_file(probe)?;
    if let Some(service) = crate::control::installed_service() {
        verify_manager(&service, from.pid)?;
    }
    Ok(())
}
fn verify_manager(service: &Service, pid: u32) -> Result<()> {
    let output = match service.manager {
        Manager::Systemd => Command::new("systemctl")
            .args([
                "--user",
                "show",
                &service.name,
                "--property=MainPID",
                "--value",
            ])
            .output()?,
        Manager::Launchd => Command::new("/bin/launchctl")
            .args(["print", &launchd_target(&service.name)?])
            .output()?,
    };
    anyhow::ensure!(
        output.status.success(),
        "the configured daemon supervisor is unavailable; old daemon is unchanged"
    );
    let text = String::from_utf8(output.stdout)?;
    let found = match service.manager {
        Manager::Systemd => text.trim().parse::<u32>().ok(),
        Manager::Launchd => text.lines().find_map(|l| {
            l.trim()
                .strip_prefix("pid = ")
                .and_then(|s| s.trim().parse().ok())
        }),
    };
    anyhow::ensure!(
        found == Some(pid),
        "supervisorMismatch: installed service does not own the selected daemon PID"
    );
    Ok(())
}
fn launchd_target(name: &str) -> Result<String> {
    let out = Command::new("/usr/bin/id").arg("-u").output()?;
    anyhow::ensure!(out.status.success(), "cannot determine launchd user");
    Ok(format!(
        "gui/{}/{}",
        String::from_utf8(out.stdout)?.trim(),
        name
    ))
}
pub(super) async fn prepare(paths: &Paths, request: &Request) -> Result<()> {
    let app = request.app.as_ref().context("missing pinned App target")?;
    let dir = records::job(&paths.root, &request.request_id)?;
    let bytes = fetch(&app.url, app.size as usize).await?;
    anyhow::ensure!(
        bytes.len() as u64 == app.size && digest(&bytes) == app.sha256,
        "App archive checksum/length mismatch; old daemon is unchanged"
    );
    let unpack = dir.join("unpacked");
    std::fs::create_dir_all(&unpack)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes.as_slice()));
    let mut total = 0u64;
    let mut count = 0usize;
    for entry in archive.entries()? {
        let mut entry = entry?;
        count += 1;
        anyhow::ensure!(count <= 4096, "too many archive entries");
        let path = entry.path()?.into_owned();
        anyhow::ensure!(
            !path.is_absolute()
                && path
                    .components()
                    .all(|p| matches!(p, std::path::Component::Normal(_))),
            "unsafe App archive path"
        );
        let kind = entry.header().entry_type();
        anyhow::ensure!(
            kind.is_file() || kind.is_dir(),
            "App archive contains a link or unsupported entry"
        );
        total = total
            .checked_add(entry.size())
            .context("App archive size overflow")?;
        anyhow::ensure!(
            total <= 1024 * 1024 * 1024,
            "unpacked App exceeds size limit"
        );
        anyhow::ensure!(
            entry.unpack_in(&unpack)?,
            "App archive escaped staging directory"
        );
    }
    for name in [
        channel::CLI_BINARY,
        channel::HOST_BINARY,
        channel::COMPONENT_FILE,
    ] {
        let name = if cfg!(windows) && !name.ends_with(".wasm") {
            format!("{name}.exe")
        } else {
            name.into()
        };
        let path = unpack.join(name);
        anyhow::ensure!(
            std::fs::symlink_metadata(&path)?.is_file(),
            "package is missing a regular required file"
        );
    }
    for name in [channel::CLI_BINARY, channel::HOST_BINARY] {
        let out = tokio::process::Command::new(unpack.join(name))
            .arg("--version")
            .output()
            .await?;
        anyhow::ensure!(
            out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == app.version,
            "App binary version does not match manifest"
        );
    }
    let output = tokio::process::Command::new(unpack.join(channel::HOST_BINARY))
        .arg("inspect")
        .arg(unpack.join(channel::COMPONENT_FILE))
        .output()
        .await?;
    anyhow::ensure!(
        output.status.success(),
        "packaged component cannot be inspected"
    );
    let identity: Value = serde_json::from_slice(&output.stdout)?;
    anyhow::ensure!(
        identity["channel"] == channel::CHANNEL && identity["releaseVersion"] == app.version,
        "bundled component channel/version mismatch"
    );
    let script = unpack.join("python-runtime/install-python.sh");
    anyhow::ensure!(
        script.is_file(),
        "App package has no Python runtime installer"
    );
    let runtime_dir = paths
        .root
        .join("agents/runtime/releases")
        .join(&request.request_id);
    let output = tokio::process::Command::new("/bin/sh")
        .arg(script)
        .arg(&runtime_dir)
        .output()
        .await?;
    anyhow::ensure!(
        output.status.success(),
        "Python preparation failed before stopping old daemon: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let pointer: Value = records::read(&runtime_dir.join("python.json"))?;
    let python = pointer["python"]
        .as_str()
        .context("runtime installer returned no interpreter")?;
    let probe = tokio::process::Command::new(python)
        .args(["-c", "import sys; assert sys.version_info >= (3, 9)"])
        .output()
        .await?;
    anyhow::ensure!(
        probe.status.success(),
        "prepared Python runtime does not start"
    );
    records::write(&dir.join("python.json"), &pointer)?;
    let backup = dir.join("backup");
    std::fs::create_dir_all(&backup)?;
    for (source, name) in files(request)? {
        std::fs::copy(source, backup.join(name))?;
    }
    let prior = paths.root.join("agents/runtime/python.json");
    if prior.is_file() {
        std::fs::copy(prior, backup.join("python.json"))?;
    }
    records::write(
        &dir.join("prepared.json"),
        &json!({"ready":true,"hadPython":backup.join("python.json").is_file()}),
    )?;
    Ok(())
}
fn files(request: &Request) -> Result<Vec<(PathBuf, String)>> {
    let bin = request.cli.parent().context("CLI has no directory")?;
    // Installation only supports the real adjacent channel layout. A Cargo
    // checkout/component override is not an installed App to overwrite.
    anyhow::ensure!(
        request.host.parent() == Some(bin) && request.component.parent() == Some(bin),
        "App update requires the adjacent CLI/Host/component installation layout"
    );
    anyhow::ensure!(
        request.cli.file_name().and_then(|s| s.to_str()) == Some(channel::CLI_BINARY)
            && request.host.file_name().and_then(|s| s.to_str()) == Some(channel::HOST_BINARY)
            && request.component.file_name().and_then(|s| s.to_str())
                == Some(channel::COMPONENT_FILE),
        "installation filenames do not match this channel"
    );
    Ok(vec![
        (request.cli.clone(), channel::CLI_BINARY.into()),
        (request.host.clone(), channel::HOST_BINARY.into()),
        (request.component.clone(), channel::COMPONENT_FILE.into()),
    ])
}
pub(super) async fn stop(paths: &Paths, request: &Request) -> Result<()> {
    let current = runtime().await?;
    anyhow::ensure!(
        current.instance_id == request.from.instance_id,
        "daemon instance changed before installation; resubmit with a new request after inspection"
    );
    if let Some(service) = crate::control::installed_service() {
        verify_manager(&service, current.pid)?;
        let output = match service.manager {
            Manager::Systemd => Command::new("systemctl")
                .args(["--user", "stop", &service.name])
                .output()?,
            Manager::Launchd => Command::new("/bin/launchctl")
                .args(["bootout", &launchd_target(&service.name)?])
                .output()?,
        };
        anyhow::ensure!(
            output.status.success(),
            "daemon supervisor stop failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    } else {
        let mut command = Command::new(&request.cli);
        command.args(["daemon", "stop"]);
        supervisor::clean(&mut command, paths, &request.cli);
        let out = command.output()?;
        anyhow::ensure!(
            out.status.success(),
            "selected daemon did not stop: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while genet_frontdoor::lifecycle::instance_locked(paths)? {
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "old daemon lock remained held"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}
pub(super) fn replace(paths: &Paths, request: &Request, rollback: bool) -> Result<()> {
    let dir = records::job(&paths.root, &request.request_id)?;
    let source = dir.join(if rollback { "backup" } else { "unpacked" });
    // The daemon is stopped: no watcher can observe a partially replaced set.
    for (target, name) in files(request)? {
        let staged = target.with_file_name(format!(".{}.{}.incoming", name, request.request_id));
        std::fs::copy(source.join(name), &staged)?;
        std::fs::File::open(&staged)?.sync_all()?;
        std::fs::rename(staged, target)?;
    }
    let pointer = dir.join(if rollback {
        "backup/python.json"
    } else {
        "python.json"
    });
    let target = paths.root.join("agents/runtime/python.json");
    if pointer.is_file() {
        let value: Value = records::read(&pointer)?;
        records::write(&target, &value)?;
    } else if rollback && target.is_file() {
        std::fs::remove_file(target)?;
    }
    Ok(())
}
pub(super) fn start(paths: &Paths, request: &Request) -> Result<()> {
    if let Some(service) = crate::control::installed_service() {
        let output = match service.manager {
            Manager::Systemd => Command::new("systemctl")
                .args(["--user", "start", &service.name])
                .output()?,
            Manager::Launchd => {
                let target = launchd_target(&service.name)?;
                let domain = target.rsplit_once('/').context("launchd target")?.0;
                Command::new("/bin/launchctl")
                    .arg("bootstrap")
                    .arg(domain)
                    .arg(service.file)
                    .output()?
            }
        };
        anyhow::ensure!(
            output.status.success(),
            "daemon supervisor start failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    } else {
        supervisor::start_manual(paths, request)
    }
}
