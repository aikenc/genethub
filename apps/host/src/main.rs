//! Native shell for GeneHub Wasm v2.
//!
//! This binary is the OS entry. It must not grow Session / Agent / Hub /
//! workspace / provider types. `CHANNEL` is compile-time `dev`: no verify.

mod abi;
mod bindings;
mod channel;
mod file_lock;
mod fs_perms;
mod http_hooks;
mod isolation;
mod load;
mod process;
mod pty;
mod rtc;

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
            run_and_exit(&component, &guest_args, entry);
        }
        Some("--version" | "-V") => println!("{}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
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

const USAGE: &str =
    "usage: genehub-host-dev run --component <path.wasm> [--entry daemon|agent] [-- <guest args>]";

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
