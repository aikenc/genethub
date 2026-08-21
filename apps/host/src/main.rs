//! Native shell for GeneHub Wasm v2.
//!
//! This binary is the OS entry. It must not grow Session / Agent / Hub /
//! workspace / provider types. `CHANNEL` is compile-time `dev`: no verify.

mod load;

use std::env;
use std::path::PathBuf;
use std::process;

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("run") => {
            let component = parse_component(args).unwrap_or_else(|error| {
                eprintln!("{error}");
                process::exit(2);
            });
            if let Err(error) = load::run_component(&component) {
                eprintln!("{error:#}");
                process::exit(4);
            }
        }
        Some("--version" | "-V") => println!("{}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("usage: genehub-host-dev run --component <path.wasm>");
            process::exit(2);
        }
    }
}

fn parse_component(mut args: impl Iterator<Item = String>) -> Result<PathBuf, String> {
    match (args.next().as_deref(), args.next()) {
        (Some("--component"), Some(path)) => Ok(PathBuf::from(path)),
        _ => Err("usage: genehub-host-dev run --component <path.wasm>".into()),
    }
}
