use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::AppState;

pub const TRAY_ID: &str = "genethub-tray";

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
    let pair = MenuItem::with_id(app, "pair", "连接到 Hub", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 GeneHub", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &pair,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("GeneHub")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "pair" => {
                show_main_window(app);
                let _ = app.emit_to("main", "genehub://pair", ());
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
