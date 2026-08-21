//! Load and run a guest Component.
//!
//! Syscall: `read(2)` the wasm bytes once. WASI gap: Component cannot
//! instantiate itself. Deletion: none — this is the shell.

use std::path::Path;

use anyhow::{bail, Context, Result};
use wasmtime::component::{Component, HasSelf, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::p2::bindings::Command;
use wasmtime_wasi::{FsPerms, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpCtxView, WasiHttpView};

/// `wasmtime::Error` deliberately does not implement `std::error::Error` — it
/// would collide with `anyhow`'s blanket conversion — so `anyhow::Context` does
/// not apply to it. `?` alone works; anything wanting `.context` needs this hop.
trait Anyhow<T> {
    fn anyhow(self) -> std::result::Result<T, anyhow::Error>;
}

impl<T> Anyhow<T> for std::result::Result<T, wasmtime::Error> {
    fn anyhow(self) -> std::result::Result<T, anyhow::Error> {
        self.map_err(anyhow::Error::from)
    }
}

/// Compile-time channel. Official/beta verification is a later crate path.
/// A runtime skip flag must never appear here — it would leak into release.
const CHANNEL: &str = "dev";

pub struct Host {
    pub table: ResourceTable,
    pub wasi: WasiCtx,
    pub http: WasiHttpCtx,
    pub http_hooks: crate::http_hooks::Hooks,
}

impl WasiView for Host {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for Host {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: &mut self.http_hooks,
        }
    }
}

/// Read bytes, `Component::from_binary`, then `wasi:cli/run`.
///
/// Dev does not verify. Never `from_file`: that re-opens a path after the
/// buffer was inspected and is the TOCTOU the contract forbids.
pub fn run_component(path: &Path, guest_args: &[String]) -> Result<()> {
    let _ = CHANNEL;
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("host current_thread runtime")?
        .block_on(run_component_async(&bytes, guest_args))
}

async fn run_component_async(bytes: &[u8], guest_args: &[String]) -> Result<()> {
    let mut config = Config::new();
    config.async_support(true);
    config.wasm_component_model(true);
    // Cranelift stays at its default opt level: on a release-profile guest,
    // dropping to `None` saves ~0.04s of compile and costs guest code quality.
    // Compile cache stays off (§5.1.6): cached machine code is an exec path.
    let engine = Engine::new(&config)?;
    eprintln!("genehub-host: compiling {}-byte component", bytes.len());
    let component = Component::from_binary(&engine, bytes)
        .anyhow()
        .context("Component::from_binary")?;
    eprintln!("genehub-host: compiled; instantiating");

    let mut wasi = WasiCtxBuilder::new();
    wasi.inherit_stdio();
    // argv[0] is the guest's own name, not the shell's path: the guest parses
    // its arguments the same way it does when it runs as a native binary.
    wasi.arg(path_name(bytes));
    for arg in guest_args {
        wasi.arg(arg);
    }
    // Not `inherit_env`: these two names are the shell's own assertions about
    // itself, and an inherited copy wins over one set afterwards. Whoever
    // launched us must not be able to pre-set them.
    for (key, value) in std::env::vars() {
        if !matches!(
            key.as_str(),
            "GENEHUB_CLI"
                | "GENEHUB_DEV_HOST_PID"
                | "GENEHUB_DEV_CWD"
                | "GENET_AGENT_DEV_COMMAND"
                | "GENEHUB_DEV_COMPONENT"
        ) {
            wasi.env(key, value);
        }
    }
    wasi.inherit_network();
    // Separate switch from `inherit_network`, which only installs a permissive
    // address check. Without this the guest's listener bind fails outright.
    wasi.allow_tcp(true);
    wasi.allow_ip_name_lookup(true);
    // Preopen is a Store lifetime constant. Host root now; guest product
    // code still does workspace checks. Cannot add dirs later.
    wasi.preopened_dir("/", "/", FsPerms::ReadWrite)
        .anyhow()
        .context("preopen host root")?;
    if let Ok(cli) = std::env::current_exe() {
        wasi.env("GENEHUB_CLI", cli.to_string_lossy());
        // The guest names an executable, not a (host, wasm) pair. This binary
        // with GENEHUB_DEV_COMPONENT in the OS environment is the agent.
        wasi.env("GENET_AGENT_DEV_COMMAND", cli.to_string_lossy());
    }
    // The guest has no pid of its own, and the process a local client can see
    // holding the listening socket is this one. See the v2 proposal §6.9.
    wasi.env("GENEHUB_DEV_HOST_PID", std::process::id().to_string());
    // WASI reaches the filesystem through preopens, so a component has no
    // working directory and inherits none. Whoever launched the shell did pick
    // one, though, and relative paths in a request are meant against it.
    if let Ok(cwd) = std::env::current_dir() {
        wasi.env("GENEHUB_DEV_CWD", cwd.to_string_lossy());
    }

    let mut store = Store::new(
        &engine,
        Host {
            table: ResourceTable::new(),
            wasi: wasi.build(),
            http: WasiHttpCtx::new(),
            http_hooks: crate::http_hooks::Hooks::default(),
        },
    );
    let mut linker = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)
        .anyhow()
        .context("wasi linker")?;
    // TLS, DNS and the socket all live out here; the guest gets the protocol
    // only. This is the §6.5 split.
    wasmtime_wasi_http::p2::add_only_http_to_linker_async(&mut linker)
        .anyhow()
        .context("wasi:http linker")?;
    crate::bindings::genehub::host::process::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
        .anyhow()
        .context("process linker")?;
    crate::bindings::genehub::host::file_lock::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
        .anyhow()
        .context("file-lock linker")?;
    crate::bindings::genehub::host::fs_perms::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
        .anyhow()
        .context("fs-perms linker")?;
    crate::bindings::genehub::host::pty::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
        .anyhow()
        .context("pty linker")?;

    let command = Command::instantiate_async(&mut store, &component, &linker)
        .await
        .anyhow()
        .context("instantiate guest")?;
    eprintln!("genehub-host: running wasi:cli/run");
    let status = command
        .wasi_cli_run()
        .call_run(&mut store)
        .await
        .anyhow()
        .context("wasi:cli/run")?;
    match status {
        Ok(()) => Ok(()),
        Err(()) => bail!("guest wasi:cli/run returned error"),
    }
}

/// The guest's `argv[0]`. It is only ever read back as a program name, so the
/// component's own identity is more useful here than the shell's path.
fn path_name(_bytes: &[u8]) -> &'static str {
    "genehub-guest"
}
