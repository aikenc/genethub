mod channel;
pub mod daemon;
mod tray;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager, WindowEvent};

use daemon::{Daemon, DialEndpoint};

pub struct AppState {
    pub daemon: Arc<Daemon>,
}

/// Where the workbench should connect.
///
/// The frontend's browser host reads this from a URL fragment; here it comes
/// straight from the process we started, which is why the desktop needs no
/// pairing before it can be used at all.
#[tauri::command]
fn daemon_endpoint(state: tauri::State<'_, AppState>) -> Option<DialEndpoint> {
    state.daemon.dial_endpoint()
}

#[tauri::command]
fn daemon_running(state: tauri::State<'_, AppState>) -> bool {
    state.daemon.is_running()
}

/// Why there is no endpoint, for the window to show.
///
/// The window is the only place a desktop user can be told anything: this is a
/// GUI process, so everything written to stderr goes to a stream nobody reads.
#[tauri::command]
fn daemon_problem(state: tauri::State<'_, AppState>) -> Option<String> {
    state.daemon.problem()
}

/// Restarts the daemon after a crash, without making the user reinstall.
#[tauri::command]
fn restart_daemon(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let restarted = state.daemon.restart().map(|_| ());
    announce(&app, &restarted);
    restarted
}

/// Tells the workbench where the daemon is now, and the tray how it is doing.
///
/// A restart means a new port and every reconnect needs a fresh admission, so
/// a client that is not told simply retries an address that will never answer.
fn announce(app: &tauri::AppHandle, endpoint: &Result<(), String>) {
    match endpoint {
        Ok(()) => {
            tray::set_status(app, "本机状态：运行中");
            // This event is only an invalidation signal. The workbench calls
            // `daemon_endpoint` afterwards, which mints a fresh one-use URL;
            // putting an admission in the event would create an unused second
            // credential and tempt consumers to reuse it on reconnect.
            let _ = app.emit("genehub://daemon", ());
        }
        Err(error) => {
            tray::set_status(app, "本机状态：已停止");
            tracing_line(&format!("daemon 启动失败: {error}"));
        }
    }
}

/// Opens a link in the user's real browser.
///
/// For links that are about the wider world — documentation, a release page.
/// Anything that is part of getting signed in goes to `open_window` instead.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = external_web_url(&url)?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// The workbench can ask the operating system to open a web page, not an
/// arbitrary OS protocol handler. Model-authored content and Hub replies both
/// cross this boundary, so `file:`, custom schemes and public plaintext HTTP
/// must fail before they reach ShellExecute/open(1).
fn external_web_url(url: &str) -> Result<tauri::Url, String> {
    if url.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err("refusing a web address containing control characters".to_string());
    }
    let parsed = tauri::Url::parse(url).map_err(|error| error.to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("refusing a web address containing credentials".to_string());
    }
    let literal_loopback = parsed
        .host_str()
        .and_then(|host| {
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .ok()
        })
        .is_some_and(|address| address.is_loopback());
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if literal_loopback => Ok(parsed),
        "http" => {
            Err("refusing plaintext HTTP outside a literal loopback address; use HTTPS".to_string())
        }
        scheme => Err(format!(
            "refusing to open {scheme}: only HTTPS and literal-loopback HTTP are allowed"
        )),
    }
}

const AUTOMATIC_UPDATE_DISABLED: &str =
    "自动安装尚未启用：请从官方发布页手动下载，并核对 SHA256SUMS";

/// Never executes an update until releases have an independently pinned
/// signing root. A digest delivered beside a binary is corruption detection,
/// not proof that the publisher intended those bytes.
#[tauri::command]
fn install_update(_app: tauri::AppHandle, _path: String) -> Result<(), String> {
    Err(AUTOMATIC_UPDATE_DISABLED.to_string())
}

/// The buttons our own title bar draws.
///
/// The window has no decorations of its own (`tauri.conf.json`), because a
/// native title bar is the one strip of the app that cannot be told what colour
/// to be: on every Windows machine set to the light system theme it came out
/// white above a dark workbench, and no amount of styling on our side reached
/// it. Drawing it ourselves is what makes the shell and its contents one thing
/// — and the price is that minimise, maximise and close have to be wired by
/// hand, which is all this trio is.
#[tauri::command]
fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

/// Returns the state it left the window in, so the button can redraw itself
/// without a second round trip.
#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(|error| error.to_string())?;
    Ok(!maximized)
}

#[tauri::command]
fn window_is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

/// `close`, deliberately, and not `hide`.
///
/// Keeping the daemon alive when the window goes away is decided in one place,
/// the `CloseRequested` handler, and this goes through it. A button that hid the
/// window directly would work today and drift the day that decision changes.
#[tauri::command]
fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

/// Keeps the frame the OS paints in step with the palette the page is using.
///
/// Only visible for a moment at a time — while a window is being resized, the
/// compositor fills the not-yet-painted edge with this colour — but a dark strip
/// chasing the pointer around a light workbench is exactly the kind of seam this
/// whole change exists to remove.
#[tauri::command]
fn set_window_background(window: tauri::Window, dark: bool) -> Result<(), String> {
    let colour = if dark {
        tauri::window::Color(24, 27, 26, 255)
    } else {
        tauri::window::Color(253, 253, 252, 255)
    };
    window
        .set_background_color(Some(colour))
        .map_err(|error| error.to_string())
}

/// Reveals the log directory in the file manager.
///
/// The tray has this too, and for the same reason: when something is wrong the
/// files are what someone attaches to a report, and asking a person to find
/// `%APPDATA%\\GeneHub\\logs` by hand is asking them not to bother.
#[tauri::command]
fn open_logs(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = logs_dir(&app);
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// Where both halves write. Derived rather than remembered so the tray can ask
/// for it before, and after, the daemon has managed to start.
pub fn logs_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(channel::DATA_DIR_NAME).join("logs"))
        .unwrap_or_else(|_| PathBuf::from("logs"))
}

/// Opens a link in a window of this app.
///
/// Signing in happens here rather than in the system browser. Being bounced out
/// of an app you just installed, to a browser, to come back and find out whether
/// it worked, is the worst minute of the whole journey — and this app is a
/// browser already, so there is nothing to be gained by borrowing another one.
///
/// The window is plain and separate on purpose: the page loaded in it is a web
/// page from the Hub, and it has no business reaching the workbench's own
/// window. It carries its own cookies, so a session started here is still there
/// the next time this window opens.
#[tauri::command]
fn open_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = external_web_url(&url)?;

    // Reused rather than stacked: pressing the button twice should bring the
    // window forward, not leave a pile of half-finished logins behind.
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW) {
        existing
            .navigate(parsed)
            .map_err(|error| error.to_string())?;
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(&app, LOGIN_WINDOW, tauri::WebviewUrl::External(parsed))
        .title(format!("登录 {}", channel::PRODUCT))
        .inner_size(480.0, 680.0)
        .resizable(true)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

const LOGIN_WINDOW: &str = "hub-login";

/// This shell's own version, for the About section to print.
///
/// Reported separately from the daemon's even though one release ships a single
/// number for both (`release.yml`, job `version`), because they are two
/// executables and an upgrade that failed to replace one of them is exactly what
/// leaves them disagreeing — `installer.nsh` exists because the daemon holds its
/// own file open while an installer wants to overwrite it. Printing both numbers
/// is what turns that into something a person can see rather than puzzle over.
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateStatus {
    current: String,
    latest: Option<String>,
    newer: bool,
    url: Option<String>,
    download_url: Option<String>,
    problem: Option<String>,
}

/// Automatic discovery is disabled together with automatic installation.
/// Returning a fixed human-facing page keeps the UI useful without accepting
/// an executable URL from a manifest, machine or Relay message.
#[tauri::command]
async fn app_update_status(app: tauri::AppHandle, _manifest_url: String) -> AppUpdateStatus {
    let current = app.package_info().version.to_string();
    AppUpdateStatus {
        current,
        latest: None,
        newer: false,
        url: Some("https://github.com/aikenc/genethub/releases".to_string()),
        download_url: None,
        problem: Some(AUTOMATIC_UPDATE_DISABLED.to_string()),
    }
}

#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: Option<String>) {
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app.notification().builder().title(title);
    if let Some(body) = body {
        builder = builder.body(body);
    }
    let _ = builder.show();
}

/// A native folder picker, so adding a project does not mean typing a path.
#[tauri::command]
async fn pick_directory(
    app: tauri::AppHandle,
    initial_directory: Option<String>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file();
    if let Some(directory) = initial_directory
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
    {
        dialog = dialog.set_directory(directory);
    }
    dialog.pick_folder(move |picked| {
        let _ = tx.send(picked.and_then(|path| path.into_path().ok()));
    });
    rx.await
        .ok()
        .flatten()
        .map(|path| path.to_string_lossy().into_owned())
}

/// A separate native action mirrors VS Code's "Open Workspace from File".
/// Native dialogs cannot portably select either a directory or a file in one
/// gesture, so the workbench presents the two adjacent choices.
#[tauri::command]
async fn pick_workspace_file(
    app: tauri::AppHandle,
    initial_directory: Option<String>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("VS Code Workspace", &["code-workspace"]);
    if let Some(directory) = initial_directory
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
    {
        dialog = dialog.set_directory(directory);
    }
    dialog.pick_file(move |picked| {
        let _ = tx.send(picked.and_then(|path| path.into_path().ok()));
    });
    rx.await
        .ok()
        .flatten()
        .map(|path| path.to_string_lossy().into_owned())
}

/// Resolves a binary shipped beside the executable, falling back to PATH so
/// `tauri dev` works against a `cargo build` without a packaged bundle.
fn bundled_binary(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join("bin").join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    which_in_path(name)
}

fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main_window(app);
        }))
        .setup(|app| {
            let handle = app.handle();
            let data_dir = app.path().app_data_dir()?.join(channel::DATA_DIR_NAME);
            let _ = std::fs::create_dir_all(&data_dir);
            // The same `logs/` the daemon writes into. One place to open, and one
            // place to attach to a report: the shell's account of the startup and
            // the daemon's account of the rest belong next to each other.
            let _ = std::fs::create_dir_all(data_dir.join("logs"));
            log_to(data_dir.join("logs").join("shell.log"));
            tracing_line(&format!("数据目录 {}", data_dir.display()));

            let name = if cfg!(windows) {
                format!("{}.exe", channel::CLI_BINARY)
            } else {
                channel::CLI_BINARY.to_string()
            };
            // A missing binary used to end `setup`, which means the app does not
            // open at all — the one failure mode with nowhere to put an
            // explanation. Now it opens and says so: `start` fails naming the
            // path it looked at, which is what someone would need to check.
            let binary = bundled_binary(handle, &name).unwrap_or_else(|| {
                let expected = app
                    .path()
                    .resource_dir()
                    .map(|dir| dir.join("bin").join(&name))
                    .unwrap_or_else(|_| PathBuf::from(&name));
                tracing_line(&format!(
                    "找不到内置的 {name}，期望在 {}",
                    expected.display()
                ));
                expected
            });

            // Before the daemon, deliberately. Starting it waits up to twenty
            // seconds for it to report a port, and on a first run that wait is
            // real: two brand-new unsigned executables get scanned, and a
            // firewall may be asking about one of them. Building the tray after
            // that meant the first-ever launch had no tray at all for as long as
            // it took — the one moment someone is looking for reassurance that
            // something is running. The status line already says "启动中"; this
            // is what it was written for.
            tray::build(handle)?;

            let daemon = Arc::new(Daemon::new(binary, data_dir));
            let started = daemon.start();
            match &started {
                Ok(endpoint) => tracing_line(&format!(
                    "daemon listening on {} ({:?})",
                    endpoint.port,
                    daemon.origin()
                )),
                Err(error) => tracing_line(&format!("daemon 启动失败: {error}")),
            }
            app.manage(AppState {
                daemon: Arc::clone(&daemon),
            });

            let announced = started.as_ref().map(|_| ()).map_err(Clone::clone);
            announce(handle, &announced);

            let watcher = handle.clone();
            daemon.watch(move |change| match change {
                daemon::Watch::Lost => {
                    tray::set_status(&watcher, "本机状态：正在恢复…");
                    tracing_line("daemon 不再响应，正在重启");
                }
                daemon::Watch::Restarted(_) => announce(&watcher, &Ok(())),
                daemon::Watch::Failed(error) => announce(&watcher, &Err(error)),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the daemon alive; quitting is only ever
            // done from the tray, so remote access never disappears by accident.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            daemon_endpoint,
            daemon_running,
            daemon_problem,
            restart_daemon,
            open_external,
            install_update,
            open_window,
            open_logs,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_close,
            set_window_background,
            app_version,
            app_update_status,
            notify,
            pick_directory,
            pick_workspace_file
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the app")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.daemon.stop();
                }
            }
        });
}

/// Where the shell's own account of the startup goes.
///
/// Set once the data directory is known. A packaged GUI app has no console, so
/// without a file the answer to "it does not start" is "nobody can tell you why"
/// — and the person who can read this file is the only one who can see that
/// machine.
static LOG: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

fn log_to(path: PathBuf) {
    let _ = std::fs::write(&path, "");
    *LOG.lock().expect("log lock") = Some(path);
}

fn tracing_line(message: &str) {
    eprintln!("[genehub] {message}");
    let path = LOG.lock().expect("log lock").clone();
    if let Some(path) = path {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
        {
            use std::io::Write;
            let _ = writeln!(file, "{message}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::external_web_url;

    #[test]
    fn the_shell_opens_only_encrypted_or_literal_loopback_web_addresses() {
        for accepted in [
            "https://hub.example.com/link/once?next=%2Faccount#done",
            "http://127.0.0.1:8787/link/once",
            "http://127.42.0.9:8787/link/once",
            "http://[::1]:8787/link/once",
        ] {
            assert!(external_web_url(accepted).is_ok(), "{accepted}");
        }

        for rejected in [
            "file:///tmp/payload",
            "smb://files.example/payload",
            "data:text/html,payload",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "http://hub.example.com/link/once",
            "http://192.168.1.8/link/once",
            "http://localhost:8787/link/once",
            "https://user:password@hub.example.com/link/once",
            "https://hub.example.com/link/once\r\nfile:///tmp/payload",
        ] {
            assert!(external_web_url(rejected).is_err(), "{rejected}");
        }
    }
}
