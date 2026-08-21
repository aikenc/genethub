//! Where this shell looks for the guest components it loads.
//!
//! The CLI already located the daemon component to pass `--component`. The
//! nested agent process is a second invocation of this same binary, and it
//! needs to know which `.wasm` to instantiate without repeating argv.

use std::path::{Path, PathBuf};

fn is_file(path: &Path) -> bool {
    path.is_file()
}

fn first_file(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| is_file(path))
}

fn cargo_target(dir: &Path) -> Option<&Path> {
    let profile = dir.file_name()?.to_str()?;
    if profile != "debug" && profile != "release" {
        return None;
    }
    dir.parent()
}

/// Agent component to hand to a nested `genehub-host-dev --mode rpc ...`.
pub fn locate_agent(daemon_component: &Path) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("GENEHUB_DEV_AGENT_COMPONENT") {
        let path = PathBuf::from(path);
        if is_file(&path) {
            return Some(path);
        }
    }
    let mut candidates = Vec::new();
    if let Some(dir) = daemon_component.parent() {
        candidates.push(dir.join("genet-agent-dev.wasm"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("genet-agent-dev.wasm"));
            if let Some(target) = cargo_target(dir) {
                candidates.push(
                    target
                        .join("wasm32-wasip2")
                        .join("release")
                        .join("genet-agent-dev.wasm"),
                );
                candidates.push(
                    target
                        .join("wasm32-wasip2")
                        .join("debug")
                        .join("genet-agent-dev.wasm"),
                );
            }
        }
    }
    first_file(candidates)
}
