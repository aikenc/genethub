//! Locate the v2 shell and its components, then become them.
//!
//! `genet daemon run` / `start` are no longer a native daemon. They load the
//! same guest the installer will ship. A missing artifact is a start failure,
//! not a silent fall back to the native binary.

use std::path::{Path, PathBuf};
use std::process::Command;

use genet_daemon::channel;

use crate::{fail, EXIT_FAILED};

pub struct Guest {
    pub host: PathBuf,
    pub daemon: PathBuf,
    pub agent: Option<PathBuf>,
}

fn is_file(path: &Path) -> bool {
    path.is_file()
}

fn first_file(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| is_file(path))
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// `target/{debug,release}` when this CLI was built by Cargo.
fn cargo_target(dir: &Path) -> Option<&Path> {
    let profile = dir.file_name()?.to_str()?;
    if profile != "debug" && profile != "release" {
        return None;
    }
    dir.parent()
}

fn host_name() -> &'static str {
    if cfg!(windows) {
        "genehub-host-dev.exe"
    } else {
        "genehub-host-dev"
    }
}

pub fn locate() -> Result<Guest, String> {
    let dir = exe_dir().ok_or_else(|| "could not locate our own binary".to_string())?;
    let target = cargo_target(&dir);

    let mut hosts = Vec::new();
    if let Some(target) = target {
        hosts.push(target.join("release").join(host_name()));
        hosts.push(target.join("debug").join(host_name()));
    }
    hosts.push(dir.join(host_name()));
    let host = std::env::var("GENEHUB_HOST")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| is_file(path))
        .or_else(|| first_file(hosts))
        .ok_or_else(|| {
            "genehub-host-dev is missing; build it with `cargo build -p genehub-host --release`"
                .to_string()
        })?;

    let mut daemons = vec![dir.join("genehub-daemon.wasm")];
    if let Some(target) = target {
        daemons.push(
            target
                .join("wasm32-wasip2")
                .join("release")
                .join("genehub-daemon.wasm"),
        );
        daemons.push(
            target
                .join("wasm32-wasip2")
                .join("debug")
                .join("genehub-daemon.wasm"),
        );
    }
    let daemon = std::env::var("GENEHUB_DEV_DAEMON_COMPONENT")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| is_file(path))
        .or_else(|| first_file(daemons))
        .ok_or_else(|| {
            "genehub-daemon.wasm is missing; build it with `cargo build -p genet-daemon --release --target wasm32-wasip2`"
                .to_string()
        })?;

    let mut agents = vec![dir.join("genet-agent-dev.wasm")];
    if let Some(target) = target {
        agents.push(
            target
                .join("wasm32-wasip2")
                .join("release")
                .join("genet-agent-dev.wasm"),
        );
        agents.push(
            target
                .join("wasm32-wasip2")
                .join("debug")
                .join("genet-agent-dev.wasm"),
        );
    }
    let agent = std::env::var("GENEHUB_DEV_AGENT_COMPONENT")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| is_file(path))
        .or_else(|| first_file(agents));

    Ok(Guest { host, daemon, agent })
}

/// Apply the env the nested agent host reads when it is spawned as a bare
/// binary (no `run --component`).
pub fn prepare_agent_env(command: &mut Command, guest: &Guest) {
    command.env("GENET_AGENT_DEV_COMMAND", &guest.host);
    if let Some(agent) = &guest.agent {
        command.env("GENEHUB_DEV_COMPONENT", agent);
        command.env("GENEHUB_DEV_AGENT_COMPONENT", agent);
    }
}

fn host_command(guest: &Guest) -> Command {
    let mut command = Command::new(&guest.host);
    command.args(["run", "--component"]).arg(&guest.daemon);
    prepare_agent_env(&mut command, guest);
    command
}

/// Foreground: replace this process with the shell. systemd and the desktop
/// sidecar both treat `daemon run` as "the pid that holds the listener".
pub fn become_daemon() -> i32 {
    if let Ok(override_command) = std::env::var(channel::ENV_DAEMON_COMMAND) {
        if !override_command.is_empty() {
            return exec_binary(PathBuf::from(override_command), &[]);
        }
    }
    let guest = match locate() {
        Ok(guest) => guest,
        Err(error) => fail("internal", &error, EXIT_FAILED),
    };
    exec_host(&guest)
}

pub fn spawn_command() -> Result<Command, String> {
    if let Ok(override_command) = std::env::var(channel::ENV_DAEMON_COMMAND) {
        if !override_command.is_empty() {
            let mut command = Command::new(override_command);
            if let Ok(guest) = locate() {
                prepare_agent_env(&mut command, &guest);
            }
            return Ok(command);
        }
    }
    Ok(host_command(&locate()?))
}

fn exec_host(guest: &Guest) -> i32 {
    exec_binary(
        guest.host.clone(),
        &[
            "run".into(),
            "--component".into(),
            guest.daemon.to_string_lossy().into_owned(),
        ],
    )
}

fn exec_binary(exe: PathBuf, args: &[String]) -> i32 {
    let mut command = Command::new(&exe);
    command.args(args);
    if let Ok(guest) = locate() {
        prepare_agent_env(&mut command, &guest);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        fail(
            "internal",
            &format!("could not exec {}: {error}", exe.display()),
            EXIT_FAILED,
        );
    }
    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => status.code().unwrap_or(EXIT_FAILED),
            Err(error) => fail(
                "internal",
                &format!("could not spawn {}: {error}", exe.display()),
                EXIT_FAILED,
            ),
        }
    }
}
