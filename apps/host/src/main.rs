//! Native shell for GeneHub Wasm v2.
//!
//! This binary is the OS entry. It must not grow Session / Agent / Hub /
//! workspace / provider types. `CHANNEL` is compile-time `dev`: no verify.

mod abi;
mod artifact;
mod artifact_cli;
mod bindings;
mod channel;
mod derived;
mod error;
mod file_lock;
mod fs_perms;
mod guest_paths;
mod http_hooks;
mod image_cache;
mod image_preview;
mod isolation;
mod keys;
mod load;
mod process;
mod pty;
mod rtc;
mod store;
mod update;
mod version;

use std::env;
use std::path::PathBuf;

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        // Before anything else, and deliberately before the tokio runtime the
        // guest needs: a process that has started a thread can no longer
        // create a user namespace, so the confinement wrapper has to be the
        // first thing this binary can become
        // (`packages/native/src/confine.rs`).
        //
        // The guest names whichever native front door the shell told it about,
        // and that may be this one, so this one has to answer to it too.
        Some(genet_native::confine::CONFINE_ARG) => {
            let rest: Vec<String> = args.collect();
            std::process::exit(genet_native::confine::confine_and_exec(&rest));
        }
        Some("run") => {
            let (component, entry, guest_args) = parse_run(args).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(2);
            });
            if matches!(entry, load::Entry::Daemon) {
                forget_launching_session();
            }
            run_and_exit(&component, &guest_args, entry);
        }
        Some("thumbnail") => {
            if let Err(error) = image_preview::thumbnail_cli(args) {
                eprintln!("error: {error}");
                std::process::exit(1);
            }
        }
        Some(command @ ("pack" | "inspect")) => {
            let mut artifact_args = vec![command.to_string()];
            artifact_args.extend(args);
            if let Err(error) = artifact_cli::run(&artifact_args) {
                eprintln!("error: {error}");
                std::process::exit(1);
            }
        }
        Some("--version" | "-V") => println!("{}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
}

/// What an Agent session hands each of its own processes. A daemon is often
/// started or restarted from inside one, and everything this process inherits
/// reaches every terminal, remote command and script the daemon starts: the
/// guest cannot take an inherited name away (`packages/wasi-guest`). Those
/// children would then speak for a session they are not part of, possibly on
/// another channel's daemon.
const SESSION_SCOPED: &[&str] = &[
    "GENEHUB_SESSION_ID",
    "GENEHUB_CONTROLLER_TOKEN",
    "GENEHUB_EVIDENCE_SCOPE",
    "GENEHUB_SKILLS_DIR",
    "GENET_WORKSPACE_ROOT",
];

/// `GENEHUB_CLI` is the session's front door too, except that Stable's
/// launcher names its own CLI to us under that very name.
fn launching_session_names(env_cli: &str) -> Vec<&'static str> {
    let mut names = SESSION_SCOPED.to_vec();
    if env_cli != "GENEHUB_CLI" {
        names.push("GENEHUB_CLI");
    }
    names
}

/// Must run while this process still has one thread.
fn forget_launching_session() {
    for name in launching_session_names(channel::ENV_CLI) {
        env::remove_var(name);
    }
}

fn run_and_exit(component: &std::path::Path, guest_args: &[String], entry: load::Entry) -> ! {
    let code = match load::run_component(component, guest_args, entry) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error:#}");
            if crate::abi::is_pairing_failure(&error) {
                crate::abi::EXIT_PAIRING
            } else {
                4
            }
        }
    };
    // Leave the moment the guest is done. Everything it held — the
    // listener, the single-instance lock — is already released, and a
    // client that just watched the lock drop will look for this pid
    // next. Dropping a Store and a tokio runtime first would keep the
    // process visible for a few hundred milliseconds after it has
    // stopped being the daemon, which on native is not a state that
    // exists: there the lock and the process end together.
    let _ = std::io::Write::flush(&mut std::io::stderr());
    let _ = std::io::Write::flush(&mut std::io::stdout());
    std::process::exit(code);
}

const USAGE: &str = "usage: genehub-host-local run --component <path.wasm> [--entry daemon|agent] [-- <guest args>]\n       genehub-host-local thumbnail --input <image> --output <file> --max-edge <pixels>";

/// Anything after `--` belongs to the guest, which reads it as its own argv.
fn parse_run(
    mut args: impl Iterator<Item = String>,
) -> Result<(PathBuf, load::Entry, Vec<String>), String> {
    let path = match (args.next().as_deref(), args.next()) {
        (Some("--component"), Some(path)) => PathBuf::from(path),
        _ => return Err(USAGE.into()),
    };
    let mut entry = load::Entry::Daemon;
    let guest: Vec<String> = loop {
        match args.next().as_deref() {
            None => break Vec::new(),
            Some("--") => break args.collect(),
            Some("--entry") => {
                entry = match args.next().as_deref() {
                    Some("daemon") => load::Entry::Daemon,
                    Some("agent") => load::Entry::Agent,
                    other => {
                        return Err(format!(
                            "--entry wants daemon or agent, got {}\n{USAGE}",
                            other.unwrap_or("nothing")
                        ))
                    }
                };
            }
            Some(other) => return Err(format!("unexpected argument {other:?}\n{USAGE}")),
        }
    };
    Ok((path, entry, guest))
}

#[cfg(test)]
mod tests {
    use super::launching_session_names;

    #[test]
    fn only_stable_keeps_an_inherited_front_door() {
        assert!(!launching_session_names("GENEHUB_CLI").contains(&"GENEHUB_CLI"));
        for env_cli in ["GENEHUB_LOCAL_CLI", "GENEHUB_DEV_CLI", "GENEHUB_BETA_CLI"] {
            let names = launching_session_names(env_cli);
            assert!(names.contains(&"GENEHUB_CLI"), "{env_cli}");
            assert!(names.contains(&"GENEHUB_SESSION_ID"), "{env_cli}");
            assert!(names.contains(&"GENEHUB_CONTROLLER_TOKEN"), "{env_cli}");
        }
    }
}
