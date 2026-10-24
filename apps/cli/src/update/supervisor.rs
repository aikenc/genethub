//! OS-owned workers and explicit manual-daemon startup adapters.
use super::*;
use std::process::{Command, Stdio};

pub(super) fn clean(command: &mut Command, paths: &Paths, cli: &Path) {
    for key in [
        "GENEHUB_SESSION_ID",
        "GENEHUB_CONTROLLER_TOKEN",
        "GENEHUB_EVIDENCE_SCOPE",
        "GENEHUB_SKILLS_DIR",
        "GENET_WORKSPACE_ROOT",
    ] {
        command.env_remove(key);
    }
    command
        .env(channel::ENV_DATA_DIR, &paths.root)
        .env(channel::ENV_CLI, cli)
        .env("GENEHUB_CLI", cli);
    command.stdin(Stdio::null());
}
#[cfg(target_os = "macos")]
fn label(paths: &Paths, id: &str) -> String {
    format!(
        "com.genethub.{}.update.{}",
        channel::CHANNEL,
        worker_key(paths, id)
    )
}
#[cfg(target_os = "macos")]
fn domain() -> Result<String> {
    let uid = Command::new("/usr/bin/id").arg("-u").output()?;
    anyhow::ensure!(uid.status.success(), "could not determine launchd user");
    let uid = String::from_utf8(uid.stdout)?.trim().to_string();
    let gui = format!("gui/{uid}");
    if Command::new("/bin/launchctl")
        .args(["print", &gui])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?
        .success()
    {
        Ok(gui)
    } else {
        Ok(format!("user/{uid}"))
    }
}
#[cfg(target_os = "macos")]
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
#[cfg(target_os = "macos")]
fn launchd(
    paths: &Paths,
    name: &str,
    args: &[String],
    plist: &Path,
    log: &Path,
    cli: &Path,
) -> Result<()> {
    let mut env = vec![
        (
            channel::ENV_DATA_DIR.to_string(),
            paths.root.to_string_lossy().into_owned(),
        ),
        (
            channel::ENV_CLI.to_string(),
            cli.to_string_lossy().into_owned(),
        ),
        ("GENEHUB_CLI".into(), cli.to_string_lossy().into_owned()),
    ];
    for key in [
        "HOME",
        "PATH",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_RUNTIME_DIR",
        "GENEHUB_PYTHON_CACHE",
        "GENEHUB_PYTHON_MIRRORS",
    ] {
        if let Ok(v) = std::env::var(key) {
            env.push((key.into(), v));
        }
    }
    #[cfg(debug_assertions)]
    for key in [
        "GENEHUB_APP_MANIFEST_URL",
        "GENEHUB_COMPONENT_MANIFEST_URL",
        "GENEHUB_BUNDLED_RELEASE_VERSION",
    ] {
        if let Ok(v) = std::env::var(key) {
            env.push((key.into(), v));
        }
    }
    let strings = args
        .iter()
        .map(|s| format!("<string>{}</string>", xml(s)))
        .collect::<String>();
    let env = env
        .iter()
        .map(|(k, v)| format!("<key>{}</key><string>{}</string>", xml(k), xml(v)))
        .collect::<String>();
    std::fs::write(plist,format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array>{strings}</array><key>EnvironmentVariables</key><dict>{env}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>",xml(name),xml(&log.to_string_lossy()),xml(&log.to_string_lossy())))?;
    genet_frontdoor::perms::restrict_to_owner(plist)?;
    let target = format!("{}/{}", domain()?, name);
    let prior = Command::new("/bin/launchctl")
        .args(["print", &target])
        .output()?;
    if prior.status.success() {
        let text = String::from_utf8_lossy(&prior.stdout);
        anyhow::ensure!(
            !text.lines().any(|line| line.trim().starts_with("pid = ")),
            "a previous instance of this launchd job is still running"
        );
        let out = Command::new("/bin/launchctl")
            .args(["bootout", &target])
            .output()?;
        anyhow::ensure!(
            out.status.success(),
            "could not retire the previous stopped launchd job"
        );
    }
    let output = Command::new("/bin/launchctl")
        .arg("bootstrap")
        .arg(domain()?)
        .arg(plist)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "launchd could not take ownership: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
fn worker_key(paths: &Paths, id: &str) -> String {
    digest(format!("{}\0{id}", paths.root.display()).as_bytes())[..20].into()
}
fn systemd_available() -> bool {
    cfg!(target_os = "linux")
        && Command::new("systemctl")
            .args(["--user", "show-environment"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}
fn set_systemd_env(command: &mut Command, paths: &Paths, cli: &Path) {
    for (key, value) in [
        (
            channel::ENV_DATA_DIR,
            paths.root.to_string_lossy().into_owned(),
        ),
        (channel::ENV_CLI, cli.to_string_lossy().into_owned()),
        ("GENEHUB_CLI", cli.to_string_lossy().into_owned()),
    ] {
        command.arg(format!("--setenv={key}={value}"));
    }
    for key in [
        "HOME",
        "PATH",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_RUNTIME_DIR",
        "GENEHUB_PYTHON_CACHE",
        "GENEHUB_PYTHON_MIRRORS",
    ] {
        if let Ok(v) = std::env::var(key) {
            command.arg(format!("--setenv={key}={v}"));
        }
    }
    #[cfg(debug_assertions)]
    for key in [
        "GENEHUB_APP_MANIFEST_URL",
        "GENEHUB_COMPONENT_MANIFEST_URL",
        "GENEHUB_BUNDLED_RELEASE_VERSION",
    ] {
        if let Ok(v) = std::env::var(key) {
            command.arg(format!("--setenv={key}={v}"));
        }
    }
}
pub(super) fn launch(paths: &Paths, id: &str) -> Result<()> {
    let dir = records::job(&paths.root, id)?;
    let request: Request = records::read(&dir.join("request.json"))?;
    let worker = dir.join(exe_name("worker"));
    #[cfg(target_os = "macos")]
    return launchd(
        paths,
        &label(paths, id),
        &[
            worker.to_string_lossy().into(),
            "update".into(),
            "__run".into(),
            id.into(),
        ],
        &dir.join("worker.plist"),
        &dir.join("worker.log"),
        &request.cli,
    );
    #[cfg(target_os = "linux")]
    {
        if systemd_available() {
            let mut c = Command::new("systemd-run");
            c.args(["--user", "--collect", "--quiet"]).arg(format!(
                "--unit=genehub-{}-update-{}",
                channel::CHANNEL,
                worker_key(paths, id)
            ));
            set_systemd_env(&mut c, paths, &request.cli);
            c.arg(&worker).args(["update", "__run", id]);
            let output = c.output()?;
            anyhow::ensure!(
                output.status.success(),
                "systemd worker failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            return Ok(());
        }
        anyhow::ensure!(
            crate::control::installed_service().is_none(),
            "the installed service manager is unavailable; old daemon is unchanged"
        );
        // A manual daemon has no service cgroup to escape. setsid is the same
        // independent-session boundary used for native child ownership.
        let mut c = Command::new(worker);
        c.args(["update", "__run", id]);
        clean(&mut c, paths, &request.cli);
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("worker.log"))?;
        c.stdout(log.try_clone()?).stderr(log);
        use std::os::unix::process::CommandExt;
        unsafe {
            c.pre_exec(genet_native::process_group::own_session);
        }
        c.spawn()?;
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    bail!("no independent update worker for this platform")
}
pub(super) fn start_manual(paths: &Paths, request: &Request) -> Result<()> {
    #[cfg(target_os = "macos")]
    let dir = records::job(&paths.root, &request.request_id)?;
    #[cfg(target_os = "macos")]
    let attempt = uuid::Uuid::new_v4().simple().to_string();
    #[cfg(target_os = "macos")]
    return launchd(
        paths,
        &format!(
            "{}.daemon.{}",
            label(paths, &request.request_id),
            &attempt[..8]
        ),
        &[
            request.cli.to_string_lossy().into(),
            "daemon".into(),
            "run".into(),
        ],
        &dir.join(format!("daemon-{attempt}.plist")),
        &dir.join("daemon.log"),
        &request.cli,
    );
    #[cfg(target_os = "linux")]
    {
        if systemd_available() {
            let mut c = Command::new("systemd-run");
            c.args(["--user", "--collect", "--quiet"]).arg(format!(
                "--unit=genehub-{}-updated-daemon-{}-{}",
                channel::CHANNEL,
                worker_key(paths, &request.request_id),
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            ));
            set_systemd_env(&mut c, paths, &request.cli);
            c.arg(&request.cli).args(["daemon", "run"]);
            let output = c.output()?;
            anyhow::ensure!(
                output.status.success(),
                "manual daemon could not start: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            return Ok(());
        }
        let mut c = Command::new(&request.cli);
        c.args(["daemon", "start"]);
        clean(&mut c, paths, &request.cli);
        let out = c.output()?;
        anyhow::ensure!(
            out.status.success(),
            "manual daemon start failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    bail!("manual startup unsupported")
}
