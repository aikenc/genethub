use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

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
    let claim = MenuItem::with_id(app, "claim", "重新生成认领链接", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 GeneHub", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &claim,
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
            "claim" => {
                show_main_window(app);
                let _ = app.emit_to("main", "genethub://claim-link", ());
            }
            "quit" => {
                // Stopping the daemon before exiting is the whole contract of the
                // tray: no tray icon means no background agent host.
                if let Some(state) = app.try_state::<AppState>() {
                    state.sidecar.stop();
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

pub fn set_status<R: Runtime>(app: &AppHandle<R>, text: &str) {
    let _ = app;
    let _ = text;
    // Menu item text updates land with the status polling work in D2; the item is
    // already in place so the layout does not shift when it starts updating.
}
