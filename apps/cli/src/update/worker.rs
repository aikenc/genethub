use super::*;

fn save(dir: &Path, progress: &mut Progress, phase: &str) -> Result<()> {
    progress.phase = phase.into();
    progress.updated_at_ms = records::now_ms();
    records::write(&dir.join("progress.json"), progress)
}
pub(super) async fn run(paths: &Paths, id: &str) -> Result<()> {
    let dir = records::job(&paths.root, id)?;
    let request: Request = records::read(&dir.join("request.json"))?;
    anyhow::ensure!(
        request.schema == "genehub.update-request.v1"
            && request.channel == channel::CHANNEL
            && request.request_id == id,
        "worker request identity mismatch"
    );
    let _lease = exclusive(&records::root(&paths.root).join("execution.lock"))?;
    let mut progress: Progress = records::read(&dir.join("progress.json"))?;
    if progress.terminal() {
        return Ok(());
    }
    let recovering = progress.state == "recovering";
    anyhow::ensure!(
        progress.state == "accepted" || recovering,
        "interrupted update needs inspection before recovery; not repeating installation"
    );
    progress.worker_pid = Some(std::process::id());
    progress.state = "running".into();
    if !recovering {
        save(&dir, &mut progress, "preparing")?;
    } else {
        records::write(&dir.join("progress.json"), &progress)?;
    }
    let heartbeat_path = dir.join("heartbeat.json");
    let heartbeat = tokio::spawn(async move {
        loop {
            let _ = records::write(&heartbeat_path, &json!({"atMs":records::now_ms()}));
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    let result = if recovering {
        verify_recovery(&request, &mut progress).await
    } else {
        perform(paths, &request, &dir, &mut progress).await
    };
    if let Err(error) = result {
        progress.state = if progress.app_applied {
            "partial"
        } else {
            "failed"
        }
        .into();
        progress.error = Some(format!("{error:#}"));
    } else {
        progress.state = "succeeded".into();
    }
    progress.running = runtime().await.ok();
    save(&dir, &mut progress, "finished")?;
    heartbeat.abort();
    Ok(())
}
async fn perform(
    paths: &Paths,
    request: &Request,
    dir: &Path,
    progress: &mut Progress,
) -> Result<()> {
    let initial = runtime().await?;
    anyhow::ensure!(
        initial.instance_id == request.from.instance_id,
        "selected daemon instance changed before handoff"
    );
    if request.kind == "app"
        && request
            .app
            .as_ref()
            .is_some_and(|a| newer(&a.version, &initial.app_version))
    {
        install::preflight(&request.cli, &initial).await?;
        install::prepare(paths, request).await?;
        save(dir, progress, "stopping")?;
        install::stop(paths, request).await?;
        save(dir, progress, "installing")?;
        let installed: Result<RuntimeIdentity> = async {
            install::replace(paths, request, false)?;
            save(dir, progress, "starting")?;
            install::start(paths, request)?;
            let expected = &request.app.as_ref().context("App target")?.version;
            await_runtime(
                |r| r.app_version == *expected && r.instance_id != initial.instance_id,
                Duration::from_secs(60),
            )
            .await
        }
        .await;
        match installed {
            Ok(running) => {
                progress.running = Some(running);
                progress.app_applied = true;
                save(dir, progress, "appReady")?;
            }
            Err(error) => {
                // Do not roll old software over a daemon that has already
                // started and may have migrated data. A wrong running identity
                // is reported for recovery rather than blindly downgrading it.
                if genet_frontdoor::lifecycle::instance_locked(paths)?
                    || dir.join("startup-observed.json").exists()
                {
                    progress.rollback = Some(
                        "notAttempted: a new daemon started or data is in use; data compatibility requires inspection"
                            .into(),
                    );
                    return Err(error.context("new App could not be verified"));
                }
                let recovery: Result<()> = async {
                    install::replace(paths, request, true)?;
                    install::start(paths, request)?;
                    await_runtime(
                        |r| r.app_version == initial.app_version,
                        Duration::from_secs(60),
                    )
                    .await?;
                    Ok(())
                }
                .await;
                progress.rollback = Some(match recovery {
                    Ok(()) => "restored".into(),
                    Err(e) => format!("failed: {e:#}"),
                });
                return Err(error.context("App installation failed"));
            }
        }
    }
    save(dir, progress, "liveCheck")?;
    let host = if progress.app_applied {
        request.host.clone()
    } else {
        dir.join(exe_name("host"))
    };
    let manifest = if request.kind == "live" {
        request.live.clone().context("missing pinned Live target")?
    } else {
        match host_call(
            &host,
            &["check".into(), request.component.to_string_lossy().into()],
        )
        .await
        {
            Ok(m) => m,
            Err(error) if !progress.app_applied => return Err(error),
            Err(error) => {
                return Err(error.context("App installed; compatible Live discovery failed"))
            }
        }
    };
    let target = manifest["releaseVersion"]
        .as_str()
        .context("Live target version missing")?;
    let current = runtime().await?;
    if !newer(target, &current.component_version) {
        return Ok(());
    }
    anyhow::ensure!(
        manifest["appRequired"] != true,
        "appRequired: component needs a newer App"
    );
    records::write(&dir.join("live-manifest.json"), &manifest)?;
    // appRequired is a local check result, not a member of the signed manifest.
    let mut raw = manifest.clone();
    raw.as_object_mut()
        .context("component manifest is not an object")?
        .remove("appRequired");
    records::write(&dir.join("live-manifest.json"), &raw)?;
    save(dir, progress, "downloadingLive")?;
    host_call(
        &host,
        &[
            "apply".into(),
            request.component.to_string_lossy().into(),
            dir.join("live-manifest.json").to_string_lossy().into(),
        ],
    )
    .await?;
    save(dir, progress, "activatingLive")?;
    // The signed store already committed. If the reply is lost, the worker
    // keeps polling the actual runtime; it never downloads/applies again.
    let _ = crate::invoke::update_call(
        vec!["update".into(), "reload".into(), request.request_id.clone()],
        false,
    )
    .await;
    let expected_hash = manifest
        .pointer("/artifact/sha256")
        .and_then(Value::as_str)
        .context("Live digest missing")?;
    let running = await_runtime(
        |r| {
            r.component_version == target
                && r.component_sha256.as_deref() == Some(expected_hash)
                && r.instance_id != current.instance_id
        },
        Duration::from_secs(90),
    )
    .await?;
    progress.running = Some(running);
    progress.live_applied = true;
    Ok(())
}
async fn await_runtime(
    predicate: impl Fn(&RuntimeIdentity) -> bool,
    timeout: Duration,
) -> Result<RuntimeIdentity> {
    let end = std::time::Instant::now() + timeout;
    loop {
        if let Ok(running) = runtime().await {
            if predicate(&running) {
                return Ok(running);
            }
        }
        anyhow::ensure!(
            std::time::Instant::now() < end,
            "new daemon did not publish the expected authenticated running identity before timeout"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn verify_recovery(request: &Request, progress: &mut Progress) -> Result<()> {
    let phase = progress.phase.clone();
    let running = await_runtime(|_| true, Duration::from_secs(90)).await?;
    if request.kind == "app" {
        let target = request
            .app
            .as_ref()
            .context("App recovery target missing")?;
        anyhow::ensure!(
            running.app_version == target.version,
            "recovered App does not run its pinned target"
        );
        progress.app_applied = true;
    }
    if let Some(manifest) = &request.live {
        let target = manifest["releaseVersion"]
            .as_str()
            .context("Live recovery target missing")?;
        let hash = manifest
            .pointer("/artifact/sha256")
            .and_then(Value::as_str)
            .context("Live recovery digest missing")?;
        anyhow::ensure!(
            running.component_version == target
                && running.component_sha256.as_deref() == Some(hash),
            "interrupted Live activation was not verified; not issuing a second apply"
        );
        progress.live_applied = true;
    } else if request.kind == "app" && phase != "finished" {
        progress.running = Some(running);
        bail!("App recovered; the optional Live leg was interrupted and needs an explicit new Live request");
    }
    progress.running = Some(running);
    Ok(())
}
