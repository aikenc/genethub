//! An independent native app; the daemon only sees a registered Preview service.
mod engine;
mod guard;
mod h264;
mod media;
mod preview;
mod state;
use anyhow::{bail, Context, Result};
use engine::{Config, Display, Engine};
use fs2::FileExt;
use std::{collections::HashMap, path::PathBuf};

fn arguments() -> Result<(HashMap<String, String>, Vec<String>)> {
    let mut values = HashMap::new();
    let mut flags = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if [
            "--help",
            "--version",
            "--probe",
            "--share",
            "--allow-control",
            "--input-guard",
            "--headless",
        ]
        .contains(&arg.as_str())
        {
            flags.push(arg);
        } else if [
            "--engine",
            "--request-permission",
            "--entry",
            "--daemon-root",
            "--display",
            "--width",
            "--height",
            "--fps",
            "--bitrate",
            "--port",
            "--display-key",
        ]
        .contains(&arg.as_str())
        {
            let value = args.next().context("option requires a value")?;
            if values.insert(arg, value).is_some() {
                bail!("duplicate option");
            }
        } else {
            bail!("unknown option: {arg}");
        }
    }
    Ok((values, flags))
}
fn integer(values: &HashMap<String, String>, name: &str, default: i32) -> Result<i32> {
    values
        .get(name)
        .map(|x| x.parse().with_context(|| format!("invalid {name}")))
        .unwrap_or(Ok(default))
}
pub(crate) fn user_lock(name: &str) -> Result<std::fs::File> {
    let local = dirs::data_local_dir()
        .context("local app data directory unavailable")?
        .join("GeneHubCapture");
    genet_frontdoor::perms::ensure_real_directory(&local)?;
    genet_frontdoor::perms::restrict_dir_to_owner(&local)?;
    let lock_path = local.join(name);
    if lock_path.exists() {
        genet_frontdoor::perms::reject_link_or_reparse(
            &lock_path,
            &genet_frontdoor::perms::sensitive_metadata(&lock_path)?,
        )?;
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)?;
    genet_frontdoor::perms::restrict_to_owner(&lock_path)?;
    lock.try_lock_exclusive()
        .with_context(|| format!("Capture lock is busy: {name}"))?;
    Ok(lock)
}
#[tokio::main]
async fn main() -> Result<()> {
    let (values, flags) = arguments()?;
    if flags.iter().any(|x| x == "--version") {
        println!(
            "GeneHub Capture {} (native ABI 5)",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    if flags.iter().any(|x| x == "--help") {
        println!("GeneHub Capture\n  --probe [--engine <library>]\n  --request-permission screen|input  explicit macOS settings action; waits up to 120 seconds; no management window\n  --entry <index.html> --daemon-root <actual-data-dir> [--display <id>]\n  --headless              explicit automation mode; otherwise show local management\n  --share                 explicitly share the selected display (default off)\n  --allow-control         explicitly allow services clients to acquire input (default off)\n  --width 1920 --height 1080 --fps 30 --bitrate 8000\n  --engine <library>      native library beside this executable by default\n\nSharing grants the registered application to clients holding existing services access.\nNo per-device desktop view/control grants are introduced. Ctrl+C stops Capture, not your software.");
        return Ok(());
    }
    if values.contains_key("--request-permission")
        && (flags.iter().any(|flag| flag != "--headless")
            || values
                .keys()
                .any(|key| key != "--request-permission" && key != "--engine"))
    {
        bail!("permission settings action cannot be combined with probe or capture options");
    }
    let default = std::env::current_exe()?
        .parent()
        .context("executable directory")?
        .join(if cfg!(windows) {
            "genehub-capture-engine.dll"
        } else if cfg!(target_os = "macos") {
            "libgenehub-capture-engine.dylib"
        } else {
            "libgenehub-capture-engine.so"
        });
    let engine_path = values.get("--engine").map(PathBuf::from).unwrap_or(default);
    if flags.iter().any(|x| x == "--input-guard") {
        return guard::run(
            &engine_path,
            integer(&values, "--display", -1)?,
            values
                .get("--display-key")
                .context("input guard target identity missing")?,
            integer(&values, "--width", 0)?,
            integer(&values, "--height", 0)?,
        );
    }
    let engine = Engine::open(&engine_path)?;
    if let Some(permission) = values.get("--request-permission") {
        let allowed = engine.request_permission(permission)?;
        println!(
            "{}",
            serde_json::json!({"permission":permission,"allowed":allowed})
        );
        return Ok(());
    }
    let mut probe = engine.probe()?;
    if flags.iter().any(|x| x == "--probe") {
        // The native probe enumerates encoder capabilities. The CLI reports
        // current desktop usability too, without caching a transient lock in
        // App's startup capability snapshot or requesting OS permissions.
        if probe.available {
            let mut first_error = None;
            let mut available = false;
            let mut input = false;
            for display in &probe.displays {
                match engine.preflight(&display.key, display.width, display.height, false) {
                    Ok(()) => {
                        available = true;
                        input |= engine
                            .preflight(&display.key, display.width, display.height, true)
                            .is_ok();
                    }
                    Err(error) => {
                        first_error.get_or_insert_with(|| error.to_string());
                    }
                }
            }
            probe.available = available;
            probe.input_permission &= input;
            if !available {
                probe.reason = first_error.unwrap_or_else(|| "target_changed".into());
            }
        }
        println!("{}", serde_json::to_string(&probe)?);
        return Ok(());
    }
    let shared = flags.iter().any(|x| x == "--share");
    let allow_control = flags.iter().any(|x| x == "--allow-control");
    if allow_control && !shared {
        bail!("--allow-control requires explicit --share");
    }
    if shared && !probe.available {
        bail!("capture unavailable: {}", probe.reason);
    }
    if allow_control && !probe.input_permission {
        bail!("OS input permission required; enable this Capture App in Accessibility settings before starting control");
    }
    let display_id = integer(&values, "--display", -1)?;
    let display = if display_id >= 0 {
        probe
            .displays
            .iter()
            .find(|d| d.id == display_id)
            .cloned()
            .context("selected display unavailable")?
    } else {
        probe.displays.first().cloned().unwrap_or(Display {
            id: -1,
            name: "Unavailable display".into(),
            width: 0,
            height: 0,
            key: String::new(),
        })
    };
    let config = Config {
        display_id: display.id,
        width: integer(&values, "--width", 1920)?,
        height: integer(&values, "--height", 1080)?,
        fps: integer(&values, "--fps", 30)?,
        bitrate_kbps: integer(&values, "--bitrate", 8000)?,
        input_only: 0,
        source_width: display.width as i32,
        source_height: display.height as i32,
    };
    if !(1..=120).contains(&config.fps)
        || !(256..=50000).contains(&config.bitrate_kbps)
        || !(0..=7680).contains(&config.width)
        || !(0..=4320).contains(&config.height)
    {
        bail!("capture profile outside supported limits");
    }
    let root = PathBuf::from(
        values
            .get("--daemon-root")
            .context("--daemon-root is required; use the daemon status dataDir")?,
    );
    let entry = PathBuf::from(
        values
            .get("--entry")
            .context("--entry must name the actual preview HTML")?,
    );
    // Main process and independent guard have separate OS-owned locks.
    let lock = user_lock("instance.lock")?;
    let port = integer(&values, "--port", 0)?;
    if !(0..=65535).contains(&port) {
        bail!("invalid port");
    }
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port as u16)).await?;
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let registration = preview::Registration::publish(
        &root,
        &entry,
        listener.local_addr()?.port(),
        &run_id,
        &secret,
    )?;
    let app = state::App::new(
        engine,
        config,
        display,
        probe,
        shared,
        allow_control,
        run_id,
    );
    println!(
        "{}",
        serde_json::json!({"ready":true,"protocol":"remote-desktop/1","shared":shared,"allowControl":allow_control,"runId":app.run_id})
    );
    let (shutdown, stop) = tokio::sync::oneshot::channel();
    let serving_app = app.clone();
    let server = tokio::spawn(async move {
        let result = preview::serve(listener, serving_app.clone(), secret, stop).await;
        serving_app
            .stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        result
    });
    if !flags.iter().any(|x| x == "--headless") {
        // Cocoa requires the process main thread. Tokio's other workers keep
        // the service, media and watchdog alive while the local event loop runs.
        extern "C" fn policy(context: *mut std::ffi::c_void, desired: i32) -> i32 {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let app = unsafe { &*(context as *const std::sync::Arc<state::App>) };
                app.policy((desired >= 0).then_some(desired))
            }))
            .unwrap_or(128)
        }
        let result = tokio::task::block_in_place(|| unsafe {
            app.engine.manage(
                &app.display.name,
                policy,
                (&app as *const std::sync::Arc<state::App>)
                    .cast_mut()
                    .cast(),
            )
        });
        let _ = shutdown.send(());
        server.await??;
        result?;
    } else {
        let _keep_shutdown_alive = shutdown;
        server.await??;
    }
    drop(registration);
    drop(lock);
    Ok(())
}
