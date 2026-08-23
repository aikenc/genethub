//! Locate the v2 shell and its one component, then become them.
//!
//! `genet daemon run` / `start` are no longer a native daemon, and the agent
//! is no longer a second artifact: both are entries of `genehub_guest.wasm`
//! under `genehub-host-local`. A missing artifact is a start failure, not a
//! silent fall back to a native binary.

use std::path::{Path, PathBuf};
use std::process::Command;

use genet_daemon::channel;

use crate::{fail, EXIT_FAILED};

pub struct Guest {
    pub host: PathBuf,
    pub component: PathBuf,
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

fn host_name() -> String {
    if cfg!(windows) {
        format!("{}.exe", channel::HOST_BINARY)
    } else {
        channel::HOST_BINARY.to_string()
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
            format!(
                "{} is missing; build it with `cargo build -p genehub-host --release`",
                host_name()
            )
        })?;

    let mut components = vec![dir.join("genehub_guest.wasm")];
    if let Some(target) = target {
        components.push(
            target
                .join("wasm32-wasip2")
                .join("release")
                .join("genehub_guest.wasm"),
        );
        components.push(
            target
                .join("wasm32-wasip2")
                .join("debug")
                .join("genehub_guest.wasm"),
        );
    }
    let component = std::env::var("GENEHUB_LOCAL_COMPONENT")
        .ok()
        .filter(|value| !value.is_empty())
        // The bring-up name, still honoured so older runbooks keep working.
        .or_else(|| std::env::var("GENEHUB_LOCAL_DAEMON_COMPONENT").ok())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| is_file(path))
        .or_else(|| first_file(components))
        .ok_or_else(|| {
            "genehub_guest.wasm is missing; build it with `cargo build -p genehub-guest --release --target wasm32-wasip2`"
                .to_string()
        })?;

    Ok(Guest { host, component })
}

/// Whoever spawns the shell tells it which CLI is the front door; the shell
/// hands that to the guest as `GENEHUB_CLI`.
fn cli_env(command: &mut Command) {
    if let Ok(cli) = std::env::current_exe() {
        command.env(channel::ENV_CLI, cli);
    }
}

fn host_command(guest: &Guest) -> Command {
    let mut command = Command::new(&guest.host);
    command.args(["run", "--component"]).arg(&guest.component);
    cli_env(&mut command);
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
    exec_host(&guest, load::Entry::Daemon, &[])
}

/// `genet agent-serve --mode rpc ...`: the agent entry of the same component.
/// Not in the usage text — the daemon's adapter spawns this; `genet agent`
/// stays the client verb it already was.
pub fn become_agent(args: &[String]) -> i32 {
    let guest = match locate() {
        Ok(guest) => guest,
        Err(error) => fail("internal", &error, EXIT_FAILED),
    };
    exec_host(&guest, load::Entry::Agent, args)
}

pub fn spawn_command() -> Result<Command, String> {
    if let Ok(override_command) = std::env::var(channel::ENV_DAEMON_COMMAND) {
        if !override_command.is_empty() {
            let mut command = Command::new(override_command);
            cli_env(&mut command);
            return Ok(command);
        }
    }
    Ok(host_command(&locate()?))
}

// Mirror of the shell's own `load::Entry`, spelled out here so the CLI does
// not depend on the host crate.
mod load {
    pub enum Entry {
        Daemon,
        Agent,
    }

    impl Entry {
        pub fn flag(&self) -> &'static str {
            match self {
                Entry::Daemon => "daemon",
                Entry::Agent => "agent",
            }
        }
    }
}

fn exec_host(guest: &Guest, entry: load::Entry, guest_args: &[String]) -> i32 {
    let mut args = vec![
        "run".into(),
        "--component".into(),
        guest.component.to_string_lossy().into_owned(),
        "--entry".into(),
        entry.flag().into(),
        "--".into(),
    ];
    args.extend(guest_args.iter().cloned());
    exec_binary(guest.host.clone(), &args)
}

fn exec_binary(exe: PathBuf, args: &[String]) -> i32 {
    let mut command = Command::new(&exe);
    command.args(args);
    cli_env(&mut command);
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
