use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::AppState;

pub const TRAY_ID: &str = crate::channel::TRAY_ID;

/// The status line, kept so it can be rewritten as the daemon comes and goes.
///
/// It used to read "starting" forever, which is worse than showing nothing: the
/// tray is where someone looks when the window is closed and they want to know
/// whether their machine is still reachable.
struct Status<R: Runtime>(Mutex<MenuItem<R>>);

pub fn set_status<R: Runtime>(app: &AppHandle<R>, text: &str) {
    if let Some(status) = app.try_state::<Status<R>>() {
        let item = status.0.lock().expect("status lock");
        let _ = item.set_text(text);
    }
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "本机状态：启动中", false, None::<&str>)?;
    app.manage(Status(Mutex::new(status.clone())));
    let pair = MenuItem::with_id(app, "pair", "连接到 Hub", true, None::<&str>)?;
    let claim = MenuItem::with_id(app, "claim", "重新登录官网", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
    // In the tray rather than only in the workbench: the times someone wants the
    // logs include the times the window will not show anything useful.
    let logs = MenuItem::with_id(app, "logs", "打开日志目录", true, None::<&str>)?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        format!("退出 {}", crate::channel::PRODUCT),
        true,
        None::<&str>,
    )?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &pair,
            &claim,
            &update,
            &logs,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(crate::channel::PRODUCT)
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "pair" => {
                show_main_window(app);
                crate::start_auth(app);
            }
            "claim" => {
                show_main_window(app);
                crate::start_claim(app);
            }
            "update" => {
                use tauri_plugin_opener::OpenerExt;
                let _ = app
                    .opener()
                    .open_url(crate::channel::APP_DOWNLOAD_URL, None::<&str>);
            }
            "logs" => {
                let dir = crate::logs_dir(app);
                let _ = std::fs::create_dir_all(&dir);
                use tauri_plugin_opener::OpenerExt;
                let _ = app
                    .opener()
                    .open_path(dir.to_string_lossy().to_string(), None::<&str>);
            }
            "quit" => {
                // Stopping the daemon before exiting is the whole contract of the
                // tray: no tray icon means no background agent host.
                if let Some(state) = app.try_state::<AppState>() {
                    state.daemon.stop();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
