mod hub;
mod sidecar;
mod tray;

use std::path::PathBuf;

use tauri::{Manager, WindowEvent};

use sidecar::Sidecar;

const DEFAULT_HUB_URL: &str = "https://hub.genethub.com";

pub struct AppState {
    pub sidecar: Sidecar,
    pub hub_url: String,
}

#[tauri::command]
fn hub_url(state: tauri::State<'_, AppState>) -> String {
    state.hub_url.clone()
}

#[tauri::command]
fn daemon_running(state: tauri::State<'_, AppState>) -> bool {
    state.sidecar.is_running()
}

#[tauri::command]
fn relationship_state(state: tauri::State<'_, AppState>) -> String {
    hub::relationship_state(&state.sidecar, &state.hub_url)
}

#[tauri::command]
fn start_pairing(state: tauri::State<'_, AppState>) -> Result<hub::PairingStarted, String> {
    hub::start_pairing(&state.sidecar, &state.hub_url)
}

/// Resolves a binary that ships next to the executable, falling back to PATH so
/// `tauri dev` works without a packaged bundle.
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
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main_window(app);
        }))
        .setup(|app| {
            let handle = app.handle();
            let paseo = bundled_binary(handle, if cfg!(windows) { "paseo.exe" } else { "paseo" })
                .ok_or("找不到内置的 paseo 可执行文件")?;
            let pi = bundled_binary(handle, if cfg!(windows) { "pi.exe" } else { "pi" });
            let home = app.path().app_data_dir()?.join("paseo");

            let state = AppState {
                sidecar: Sidecar::new(paseo, pi, home),
                hub_url: std::env::var("GENEHUB_HUB_URL").unwrap_or_else(|_| DEFAULT_HUB_URL.into()),
            };
            if let Err(error) = state.sidecar.start() {
                eprintln!("daemon 启动失败: {error}");
            }
            app.manage(state);

            tray::build(handle)?;
            tray::set_status(handle, "启动中");
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
            hub_url,
            daemon_running,
            relationship_state,
            start_pairing
        ])
        .build(tauri::generate_context!())
        .expect("failed to build GeneHub")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.sidecar.stop();
                }
            }
        });
}
