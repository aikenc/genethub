//! Load and run a guest Component.
//!
//! Syscall: `read(2)` the wasm bytes once. WASI gap: Component cannot
//! instantiate itself. Deletion: none — this is the shell.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use wasmtime::component::{Component, HasSelf, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::p2::bindings::Command;
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpCtxView, WasiHttpView};
use wasmtime_wasi_tls::{WasiTlsCtx, WasiTlsCtxBuilder, WasiTlsCtxView, WasiTlsView};

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

pub struct Host {
    pub table: ResourceTable,
    pub wasi: WasiCtx,
    pub http: WasiHttpCtx,
    pub http_hooks: crate::http_hooks::Hooks,
    pub tls: WasiTlsCtx,
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

impl WasiTlsView for Host {
    fn tls(&mut self) -> WasiTlsCtxView<'_> {
        WasiTlsCtxView {
            ctx: &mut self.tls,
            table: &mut self.table,
        }
    }
}

/// Which of the one component's entries this process exists to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// The resident daemon (`run`). May ask to reload in place.
    Daemon,
    /// One agent process (`agent-run`). Its return value is the exit code.
    Agent,
}

/// What the daemon entry said about the process' future.
enum DaemonExit {
    Shutdown,
    Reload,
}

/// Read bytes, compile in this process, instantiate, run the entry.
///
/// Never write a `.cwasm` beside the data dir: a file the guest (or anything
/// that can write the data dir) can replace is an exec path. The compiled
/// image lives in this process only. A built-in agent is another host process
/// and compiles from the same bytes; it does not deserialize a cache file.
///
/// Dev does not verify. Never `from_file`: that re-opens a path after the
/// buffer was inspected and is the TOCTOU the contract forbids.
pub fn run_component(path: &Path, guest_args: &[String], entry: Entry) -> Result<i32> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("host current_thread runtime")?
        .block_on(run_component_async(path, guest_args, entry))
}

async fn run_component_async(path: &Path, guest_args: &[String], entry: Entry) -> Result<i32> {
    let mut config = Config::new();
    config.wasm_component_model(true);
    // Cranelift stays at its default opt level: on a release-profile guest,
    // dropping to `None` saves ~0.04s of compile and costs guest code quality.
    // Wasmtime's own compile cache stays off (§5.1.6): a cache the runtime
    // trusts implicitly is an exec path. We do not add a file-backed dev
    // store either — the compiled image stays in this process.
    let engine = Engine::new(&config)?;
    match entry {
        Entry::Agent => {
            let component = load_component(&engine, path)?;
            let (store, linker) = build_instance(&engine, guest_args, None)?;
            run_agent(&engine, store, &linker, &component, path).await
        }
        Entry::Daemon => loop {
            // Bytes are re-read every round: "reload" exists so an update can
            // replace the artifact on disk and continue in this same pid.
            let component = load_component(&engine, path)?;
            let (store, linker) = build_instance(&engine, guest_args, Some(path))?;
            match run_daemon(&engine, store, &linker, &component).await? {
                DaemonExit::Shutdown => return Ok(0),
                DaemonExit::Reload => debug_log("guest asked to reload; re-instantiating"),
            }
        },
    }
}

/// The daemon entry: the v2 `run` export when the component has one, or
/// `wasi:cli/run` for a plain command component (the component-health probe).
async fn run_daemon(
    engine: &Engine,
    mut store: Store<Host>,
    linker: &Linker<Host>,
    component: &Component,
) -> Result<DaemonExit> {
    if exports(engine, component).iter().any(|name| name == "run") {
        let guest = match crate::bindings::Daemon::instantiate_async(&mut store, component, linker)
            .await
            .anyhow()
            .context("instantiate guest")
        {
            Ok(guest) => guest,
            Err(error) => return abandon_store(store, error),
        };
        match guest.call_run(&mut store).await {
            Ok(Ok(action)) => {
                return Ok(if action == "reload" {
                    DaemonExit::Reload
                } else {
                    DaemonExit::Shutdown
                });
            }
            Ok(Err(error)) => {
                return abandon_store(store, anyhow::anyhow!("guest run failed: {error}"))
            }
            Err(error) => {
                return abandon_store(store, anyhow::Error::from(error).context("guest run"))
            }
        }
    }
    let command = match Command::instantiate_async(&mut store, component, linker)
        .await
        .anyhow()
        .context("instantiate guest")
    {
        Ok(command) => command,
        Err(error) => return abandon_store(store, error),
    };
    match command.wasi_cli_run().call_run(&mut store).await {
        Ok(Ok(())) => Ok(DaemonExit::Shutdown),
        Ok(Err(())) => abandon_store(store, anyhow::anyhow!("guest wasi:cli/run returned error")),
        Err(error) => abandon_store(store, anyhow::Error::from(error).context("wasi:cli/run")),
    }
}

/// The agent entry. There is no command fallback here: an agent that is not
/// the v2 component is a packaging bug, not a shape to accommodate.
async fn run_agent(
    engine: &Engine,
    mut store: Store<Host>,
    linker: &Linker<Host>,
    component: &Component,
    path: &Path,
) -> Result<i32> {
    if !exports(engine, component)
        .iter()
        .any(|name| name == "agent-run")
    {
        bail!(
            "{} has no agent-run export; the agent entry needs the v2 component",
            path.display()
        );
    }
    let guest = match crate::bindings::Daemon::instantiate_async(&mut store, component, linker)
        .await
        .anyhow()
        .context("instantiate guest")
    {
        Ok(guest) => guest,
        Err(error) => return abandon_store(store, error),
    };
    match guest.call_agent_run(&mut store).await {
        Ok(Ok(code)) => Ok(code as i32),
        Ok(Err(error)) => abandon_store(store, anyhow::anyhow!("guest agent-run failed: {error}")),
        Err(error) => abandon_store(store, anyhow::Error::from(error).context("guest agent-run")),
    }
}

/// A trap can leave the resource table inconsistent. Dropping that Store
/// often traps again (`resource has children`). The process is exiting;
/// forgetting the table lets the OS reclaim fds and child pids.
fn abandon_store<T>(store: Store<Host>, error: anyhow::Error) -> Result<T> {
    std::mem::forget(store);
    let message = format!("{error:#}");
    if message.contains("resource has children") {
        bail!(
            "guest dropped a host resource while child handles were still live; exiting so the supervisor can restart cleanly: {message}"
        );
    }
    Err(error)
}

/// The export names a component was built with, so the shell drives the entry
/// the artifact actually has instead of erroring opaquely out of instantiate.
fn exports(engine: &Engine, component: &Component) -> Vec<String> {
    component
        .component_type()
        .exports(engine)
        .map(|(name, _)| name.to_string())
        .collect()
}

/// A fresh Store and Linker. Every round of a reload gets its own: a Store
/// that already ran a guest holds that guest's state, and reload exists to
/// let go of it.
fn build_instance(
    engine: &Engine,
    guest_args: &[String],
    component_file: Option<&Path>,
) -> Result<(Store<Host>, Linker<Host>)> {
    let mut wasi = WasiCtxBuilder::new();
    wasi.inherit_stdio();
    // argv[0] is the guest's own name, not the shell's path: the guest parses
    // its arguments the same way it does when it runs as a native binary.
    wasi.arg("genehub-guest");
    for arg in guest_args {
        wasi.arg(arg);
    }
    // Not `inherit_env`: these names are the shell's own assertions about
    // itself, and an inherited copy wins over one set afterwards. Whoever
    // launched us must not be able to pre-set them.
    for (key, value) in std::env::vars() {
        if !matches!(
            key.as_str(),
            "GENEHUB_CLI"
                | crate::channel::ENV_HOST_PID
                | crate::channel::ENV_CWD
                | crate::channel::ENV_CLI
                | crate::channel::ENV_COMPONENT_FILE
        ) {
            wasi.env(key, crate::guest_paths::env_value_for_guest(value));
        }
    }
    wasi.inherit_network();
    // Separate switch from `inherit_network`, which only installs a permissive
    // address check. Without this the guest's listener bind fails outright.
    wasi.allow_tcp(true);
    wasi.allow_ip_name_lookup(true);
    // Preopen is a Store lifetime constant. Host root on Unix; each Windows
    // volume as `/c`, `/d`, … so a tempfile on C: is reachable when the
    // checkout lives on D:. Cannot add dirs later.
    crate::guest_paths::preopen_host_filesystem(&mut wasi)?;
    // GENEHUB_CLI names the front-door CLI, so the guest can reach product
    // surface (`genet session context`, `genet agent-serve`). Whoever launched
    // the shell says which CLI that is; a shell launched by hand answers for
    // itself.
    let cli = std::env::var(crate::channel::ENV_CLI)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok());
    if let Some(cli) = cli {
        wasi.env(
            "GENEHUB_CLI",
            crate::guest_paths::env_value_for_guest(cli.to_string_lossy()),
        );
    }
    // The guest has no pid of its own, and the process a local client can see
    // holding the listening socket is this one. See the v2 proposal §6.9.
    wasi.env(crate::channel::ENV_HOST_PID, std::process::id().to_string());
    // WASI reaches the filesystem through preopens, so a component has no
    // working directory and inherits none. Whoever launched the shell did pick
    // one, though, and relative paths in a request are meant against it.
    if let Ok(cwd) = std::env::current_dir() {
        wasi.env(
            crate::channel::ENV_CWD,
            crate::guest_paths::env_value_for_guest(cwd.to_string_lossy()),
        );
    }
    // The daemon watches this file and asks for an in-place reload when it
    // changes — the dev rebuild loop and a replaced install both ride it.
    if let Some(component) = component_file {
        wasi.env(
            crate::channel::ENV_COMPONENT_FILE,
            crate::guest_paths::env_value_for_guest(component.to_string_lossy()),
        );
    }

    let store = Store::new(
        engine,
        Host {
            table: ResourceTable::new(),
            wasi: wasi.build(),
            http: WasiHttpCtx::new(),
            http_hooks: crate::http_hooks::Hooks,
            tls: WasiTlsCtxBuilder::new().build(),
        },
    );
    let mut linker = Linker::new(engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)
        .anyhow()
        .context("wasi linker")?;
    // TLS, DNS and the socket all live out here; the guest gets the protocol
    // only. This is the §6.5 split.
    wasmtime_wasi_http::p2::add_only_http_to_linker_async(&mut linker)
        .anyhow()
        .context("wasi:http linker")?;
    // Same split one layer down, for the wire `wasi:http` does not cover:
    // WebSocket has no upgrade in `wasi:http` 0.2, so Fabric's `wss://` is a
    // socket the guest opens and a handshake the host performs. `wasi:tls` is
    // still gated as an unstable proposal, so the feature has to be asked for
    // by name.
    let mut tls = wasmtime_wasi_tls::p2::LinkOptions::default();
    tls.tls(true);
    wasmtime_wasi_tls::p2::add_to_linker(&mut linker, &tls)
        .anyhow()
        .context("wasi:tls linker")?;
    crate::bindings::genehub::host::process::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| {
        state
    })
    .anyhow()
    .context("process linker")?;
    crate::bindings::genehub::host::file_lock::add_to_linker::<_, HasSelf<_>>(
        &mut linker,
        |state| state,
    )
    .anyhow()
    .context("file-lock linker")?;
    crate::bindings::genehub::host::fs_perms::add_to_linker::<_, HasSelf<_>>(
        &mut linker,
        |state| state,
    )
    .anyhow()
    .context("fs-perms linker")?;
    crate::bindings::genehub::host::pty::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
        .anyhow()
        .context("pty linker")?;
    crate::bindings::genehub::host::isolation::add_to_linker::<_, HasSelf<_>>(
        &mut linker,
        |state| state,
    )
    .anyhow()
    .context("isolation linker")?;
    crate::bindings::genehub::host::rtc::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
        .anyhow()
        .context("rtc linker")?;
    crate::bindings::genehub::host::logic_update::add_to_linker::<_, HasSelf<_>>(
        &mut linker,
        |state| state,
    )
    .anyhow()
    .context("logic-update linker")?;
    Ok((store, linker))
}

/// Compile in memory from the bytes we just read. No file cache.
fn load_component(engine: &Engine, path: &Path) -> Result<Component> {
    // Source builds keep their file-watcher loop and never consult a release
    // activation store. Published channels are compile-time identities and
    // are the only binaries that may select a downloaded signed guest.
    let active = if crate::channel::CHANNEL == "dev" {
        None
    } else {
        crate::update::load_active_bytes()?
    };
    let bytes = match active {
        Some(active) => active,
        None => std::fs::read(path).with_context(|| format!("reading {}", path.display()))?,
    };
    crate::abi::assert_digest_if_present(&bytes)?;
    debug_log(&format!("compiling {}-byte component", bytes.len()));
    let component = Component::from_binary(engine, &bytes)
        .anyhow()
        .context("Component::from_binary")?;
    require_product_digest(&bytes, engine, &component)?;
    Ok(component)
}

/// The v2 product guest exports `agent-run`. A plain `wasi:cli/run` probe
/// does not, and must not be forced through the ABI stamp.
fn require_product_digest(bytes: &[u8], engine: &Engine, component: &Component) -> Result<()> {
    if exports(engine, component)
        .iter()
        .any(|name| name == "agent-run")
    {
        crate::abi::assert_paired(bytes)?;
    }
    Ok(())
}

/// Progress is silent by default: this process' stderr belongs to the guest's
/// owner, and a daemon adapter that reads a crashed agent's last words should
/// never find the shell's compile log there. `GENEHUB_HOST_DEBUG=1` opts in.
fn debug_log(message: &str) {
    if std::env::var_os("GENEHUB_HOST_DEBUG").is_some_and(|value| !value.is_empty()) {
        eprintln!("genehub-host: {message}");
    }
}
