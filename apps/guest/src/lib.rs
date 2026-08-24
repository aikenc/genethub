//! The one v2 artifact (`genehub_guest.wasm`).
//!
//! One component, two entries (`wit/genehub-host.wit` world `daemon`): the
//! shell picks one per OS process — `run` for the resident daemon, `agent-run`
//! for each agent it spawns. Nothing native is left to fall back to.

#![cfg(target_family = "wasm")]

/// Same 32 bytes the host baked from `wit/genehub-host.wit`. The shell reads
/// this custom section before instantiate so a stale pair fails closed.
#[used]
#[link_section = "genehub-abi"]
static ABI_DIGEST: [u8; 32] = *include_bytes!(concat!(env!("OUT_DIR"), "/genehub-abi.bin"));

use genet_wasi::wit::Guest;

struct GenehubGuest;

impl Guest for GenehubGuest {
    /// Resident daemon. "reload" asks the shell to re-read the component and
    /// instantiate it again in this same process; the daemon asks when the
    /// component file it was loaded from changes on disk (a dev rebuild, an
    /// installer's replace).
    fn run() -> Result<String, String> {
        runtime()?
            .block_on(genet_daemon::run::run())
            .map(|exit| match exit {
                genet_daemon::run::Exit::Shutdown => "shutdown".to_string(),
                genet_daemon::run::Exit::Reload => "reload".to_string(),
            })
            .map_err(|error| format!("{error:#}"))
    }

    /// One agent process: JSONL over stdio, exit code as the return value.
    fn agent_run() -> Result<u32, String> {
        Ok(runtime()?.block_on(genet_agent::run()) as u32)
    }
}

genet_wasi::wit::export!(GenehubGuest);

/// Both entries are `current_thread`: the instance runs on one fiber, and the
/// guest code was written against exactly that.
fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("guest runtime: {error}"))
}
