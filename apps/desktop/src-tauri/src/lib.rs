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
/// Pairing sends them to the Hub to approve a code, and that has to happen
/// where their session already is — inside this window it would be a second,
/// signed-out browser.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
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
            let binary = bundled_binary(
                handle,
                if cfg!(windows) {
                    "genet-daemon.exe"
                } else {
                    "genet-daemon"
                },
            )
            .ok_or("找不到内置的 genet-daemon 可执行文件")?;

            let daemon = Arc::new(Daemon::new(
                binary,
                app.path().app_data_dir()?.join("GeneHub"),
            ));
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

            tray::build(handle)?;
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
            restart_daemon,
            open_external,
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

fn tracing_line(message: &str) {
    eprintln!("[genehub] {message}");
}
