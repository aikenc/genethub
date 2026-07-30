pub mod daemon;
mod tray;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager, WindowEvent};

use daemon::{Daemon, Endpoint};

pub struct AppState {
    pub daemon: Arc<Daemon>,
}

/// Where the workbench should connect.
///
/// The frontend's browser host reads this from a URL fragment; here it comes
/// straight from the process we started, which is why the desktop needs no
/// pairing before it can be used at all.
#[tauri::command]
fn daemon_endpoint(state: tauri::State<'_, AppState>) -> Option<Endpoint> {
    state.daemon.endpoint()
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
fn restart_daemon(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Endpoint, String> {
    let restarted = state.daemon.restart();
    announce(&app, &restarted);
    restarted
}

/// Tells the workbench where the daemon is now, and the tray how it is doing.
///
/// A restart means a new port and a new token, so a client that is not told
/// simply retries an address that will never answer again.
fn announce(app: &tauri::AppHandle, endpoint: &Result<Endpoint, String>) {
    match endpoint {
        Ok(endpoint) => {
            tray::set_status(app, "本机状态：运行中");
            let _ = app.emit("genehub://daemon", endpoint.clone());
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
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
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
    let parsed = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refusing to open {}: not a web address", parsed.scheme()));
    }

    // Reused rather than stacked: pressing the button twice should bring the
    // window forward, not leave a pile of half-finished logins behind.
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW) {
        existing.navigate(parsed).map_err(|error| error.to_string())?;
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(&app, LOGIN_WINDOW, tauri::WebviewUrl::External(parsed))
        .title("登录 GeneHub")
        .inner_size(480.0, 680.0)
        .resizable(true)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

const LOGIN_WINDOW: &str = "hub-login";

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
async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
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
            let data_dir = app.path().app_data_dir()?.join("GeneHub");
            let _ = std::fs::create_dir_all(&data_dir);
            log_to(data_dir.join("shell.log"));
            tracing_line(&format!("数据目录 {}", data_dir.display()));

            let name = if cfg!(windows) {
                "genet-daemon.exe"
            } else {
                "genet-daemon"
            };
            // A missing binary used to end `setup`, which means the app does not
            // open at all — the one failure mode with nowhere to put an
            // explanation. Now it opens and says so: `start` fails naming the
            // path it looked at, which is what someone would need to check.
            let binary = bundled_binary(handle, name).unwrap_or_else(|| {
                let expected = app
                    .path()
                    .resource_dir()
                    .map(|dir| dir.join("bin").join(name))
                    .unwrap_or_else(|_| PathBuf::from(name));
                tracing_line(&format!("找不到内置的 {name}，期望在 {}", expected.display()));
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

            announce(handle, &started);

            let watcher = handle.clone();
            daemon.watch(move |change| match change {
                daemon::Watch::Lost => {
                    tray::set_status(&watcher, "本机状态：正在恢复…");
                    tracing_line("daemon 不再响应，正在重启");
                }
                daemon::Watch::Restarted(endpoint) => announce(&watcher, &Ok(endpoint)),
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
            open_window,
            notify,
            pick_directory
        ])
        .build(tauri::generate_context!())
        .expect("failed to build GeneHub")
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
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).create(true).open(path) {
            use std::io::Write;
            let _ = writeln!(file, "{message}");
        }
    }
}
