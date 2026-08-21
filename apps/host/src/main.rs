//! Native shell for GeneHub Wasm v2.
//!
//! This binary is the OS entry. It must not grow Session / Agent / Hub /
//! workspace / provider types. `CHANNEL` is compile-time `dev`: no verify.

mod bindings;
mod file_lock;
mod fs_perms;
mod http_hooks;
mod layout;
mod load;
mod process;
mod pty;

use std::env;
use std::path::PathBuf;

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("run") => {
            let (component, guest_args) = parse_component(args).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(2);
            });
            prepare_nested_agent(&component);
            run_and_exit(&component, &guest_args);
        }
        Some("--version" | "-V") => println!("{}", env!("CARGO_PKG_VERSION")),
        other => {
            // Nested agent: the daemon guest spawns this binary with agent argv
            // (`--mode rpc ...`). The component lives in GENEHUB_DEV_COMPONENT
            // because the guest can only name an executable, not a (host, wasm)
            // pair.
            let component = env::var("GENEHUB_DEV_COMPONENT").unwrap_or_default();
            if component.is_empty() {
                eprintln!("{USAGE}");
                std::process::exit(2);
            }
            let mut guest_args = Vec::new();
            if let Some(first) = other {
                guest_args.push(first.to_string());
            }
            guest_args.extend(args);
            run_and_exit(std::path::Path::new(&component), &guest_args);
        }
    }
}

fn run_and_exit(component: &std::path::Path, guest_args: &[String]) {
    if let Err(error) = load::run_component(component, guest_args) {
        eprintln!("{error:#}");
        std::process::exit(4);
    }
    // Leave the moment the guest is done. Everything it held — the
    // listener, the single-instance lock — is already released, and a
    // client that just watched the lock drop will look for this pid
    // next. Dropping a Store and a tokio runtime first would keep the
    // process visible for a few hundred milliseconds after it has
    // stopped being the daemon, which on native is not a state that
    // exists: there the lock and the process end together.
    let _ = std::io::Write::flush(&mut std::io::stderr());
    let _ = std::io::Write::flush(&mut std::io::stdout());
    std::process::exit(0);
}

/// Point nested spawns of this binary at the agent component. The guest
/// adapter names an executable; this is how that executable knows which
/// `.wasm` it is.
fn prepare_nested_agent(daemon_component: &std::path::Path) {
    if let Ok(exe) = env::current_exe() {
        env::set_var("GENET_AGENT_DEV_COMMAND", &exe);
    }
    if let Some(agent) = crate::layout::locate_agent(daemon_component) {
        env::set_var("GENEHUB_DEV_COMPONENT", &agent);
        env::set_var("GENEHUB_DEV_AGENT_COMPONENT", &agent);
    }
}

const USAGE: &str = "usage: genehub-host-dev run --component <path.wasm> [-- <guest args>]";

/// Anything after `--` belongs to the guest, which reads it as its own argv.
fn parse_component(mut args: impl Iterator<Item = String>) -> Result<(PathBuf, Vec<String>), String> {
    let path = match (args.next().as_deref(), args.next()) {
        (Some("--component"), Some(path)) => PathBuf::from(path),
        _ => return Err(USAGE.into()),
    };
    let guest = match args.next().as_deref() {
        None => Vec::new(),
        Some("--") => args.collect(),
        Some(other) => return Err(format!("unexpected argument {other:?}\n{USAGE}")),
    };
    Ok((path, guest))
}
