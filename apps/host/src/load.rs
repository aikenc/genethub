//! Load and run a guest Component.
//!
//! Syscall: `read(2)` the wasm bytes once. WASI gap: Component cannot
//! instantiate itself. Deletion: none — this is the shell.

use std::path::Path;

use anyhow::{bail, Context, Result};
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::p2::bindings::Command;
use wasmtime_wasi::{DirPerms, FilePerms, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

/// Compile-time channel. Official/beta verification is a later crate path.
/// A runtime skip flag must never appear here — it would leak into release.
const CHANNEL: &str = "dev";

struct Host {
    table: ResourceTable,
    wasi: WasiCtx,
}

impl WasiView for Host {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

/// Read bytes, `Component::from_binary`, then `wasi:cli/run`.
///
/// Dev does not verify. Never `from_file`: that re-opens a path after the
/// buffer was inspected and is the TOCTOU the contract forbids.
pub fn run_component(path: &Path) -> Result<()> {
    let _ = CHANNEL;
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("host current_thread runtime")?
        .block_on(run_component_async(&bytes))
}

async fn run_component_async(bytes: &[u8]) -> Result<()> {
    let mut config = Config::new();
    config.async_support(true);
    config.wasm_component_model(true);
    // Compile cache stays off (§5.1.6): cached machine code is an exec path.
    let engine = Engine::new(&config)?;
    let component = Component::from_binary(&engine, bytes).context("Component::from_binary")?;

    let mut wasi = WasiCtxBuilder::new();
    wasi.inherit_stdio();
    wasi.inherit_env();
    wasi.inherit_network();
    wasi.allow_ip_name_lookup(true);
    // Preopen is a Store lifetime constant. Host root now; guest product
    // code still does workspace checks. Cannot add dirs later.
    wasi.preopened_dir("/", "/", DirPerms::all(), FilePerms::all())
        .context("preopen host root")?;
    if let Ok(cli) = std::env::current_exe() {
        wasi.env("GENEHUB_CLI", cli.to_string_lossy());
    }

    let mut store = Store::new(
        &engine,
        Host {
            table: ResourceTable::new(),
            wasi: wasi.build(),
        },
    );
    let mut linker = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker).context("wasi linker")?;

    let command = Command::instantiate_async(&mut store, &component, &linker)
        .await
        .context("instantiate guest")?;
    let status = command
        .wasi_cli_run()
        .call_run(&mut store)
        .await
        .context("wasi:cli/run")?;
    match status {
        Ok(()) => Ok(()),
        Err(()) => bail!("guest wasi:cli/run returned error"),
    }
}
