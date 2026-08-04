mod channel;
pub mod daemon;
mod tray;

use std::path::{Path, PathBuf};
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

/// Runs an installer the daemon already downloaded.
///
/// This is the whole of "立即安装" from the shell's side. The fetching is the
/// daemon's — it is the half that exists on every platform, and the half a
/// phone can watch — and the shell's only contribution is that it can start a
/// process, which a web page cannot.
///
/// Nothing here replaces our own files. That is the installer's job.
///
/// The path is checked against the one directory the daemon writes installers
/// into, because it arrives over a connection this window does not own: a
/// relayed client is a stranger until proven otherwise, and "run this file"
/// is the one message we must never take at face value.
#[tauri::command]
fn install_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = updates_dir(&app)?;
    let file = std::fs::canonicalize(&path).map_err(|_| format!("找不到安装包 {path}"))?;
    // Canonicalised on both sides, or a path that reaches the same file by a
    // different spelling — a symlink, an 8.3 name on Windows — compares unequal
    // while pointing exactly where the check was meant to stop it.
    let dir = std::fs::canonicalize(&dir).map_err(|error| error.to_string())?;
    if file.parent() != Some(dir.as_path()) {
        return Err(format!(
            "这个安装包不在 {} 的更新目录里，没有运行",
            channel::PRODUCT
        ));
    }
    if !file.is_file() {
        return Err(format!("{} 不是一个文件", file.display()));
    }

    tracing_line(&format!("running the installer at {}", file.display()));
    run_installer(&app, &file)?;
    if cfg!(windows) {
        stand_down(&app);
    }
    Ok(())
}

/// Starts the installer, on Windows with the flags that make it an *upgrade*.
///
/// The same three Tauri's own updater passes, and each one is here because of
/// something the plain double-click does:
///
/// - `/UPDATE` — install over the top. Without it the NSIS template finds the
///   previous version in the registry and offers only 「先卸载再安装」: it runs
///   the old uninstaller first, turning one operation into two that can fail
///   apart, on a machine that is then left with neither version. Nothing about
///   our upgrade needs it — same installer, same directory, and every file it
///   would remove is one the new version is about to write.
/// - `/P` — passive. A progress bar and no wizard, because there is nothing
///   left to ask: the only question was answered by pressing 立即安装.
/// - `/R` — start the app again afterwards, which the template honours in
///   passive and silent mode only. `/ARGS` with nothing after it says there are
///   no arguments to carry over, which is what an app started from a shortcut
///   has.
///
/// Everywhere else the download is a package rather than a program — a `.dmg`
/// is mounted, a `.deb` goes to whatever installs packages — and both talk to
/// the user themselves, so the file is simply opened.
///
/// `cfg!` rather than `#[cfg(windows)]`, here and below, because CI builds this
/// crate on Linux only: code behind an attribute nobody compiles is code whose
/// first compiler is the release that ships it.
fn run_installer(app: &tauri::AppHandle, file: &Path) -> Result<(), String> {
    if !cfg!(windows) {
        use tauri_plugin_opener::OpenerExt;
        return app
            .opener()
            .open_path(file.to_string_lossy().to_string(), None::<&str>)
            .map_err(|error| error.to_string());
    }

    std::process::Command::new(file)
        .args(["/UPDATE", "/P", "/R", "/ARGS"])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("安装包没能启动：{error}"))
}

/// Gets both halves out of the installer's way, and lets it bring us back.
///
/// The daemon goes first and goes politely, so an agent mid-turn is asked to
/// stop rather than cut off by `taskkill`. Then this process ends itself.
///
/// Leaving rather than waiting to be killed is the part that matters. The
/// installer we just started is a *child* of this process, and the hook that
/// clears the way for an upgrade kills what it finds by image name — asking for
/// the process tree there would take the installer down with the app, half way
/// through replacing it. `installer.nsh` no longer asks for the tree, and this
/// makes the question moot: by the time the hook runs there is nothing of ours
/// left to find. `/R` brings the new build up once the files are in place.
fn stand_down(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.daemon.stop();
    }
    app.exit(0);
}

/// The only directory this shell will run an executable out of.
///
/// The same one the daemon writes to (`Paths::updates_dir`), which holds
/// because the shell is what tells the daemon where its data lives.
fn updates_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(channel::DATA_DIR_NAME).join("updates"))
        .map_err(|error| error.to_string())
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
    let parsed = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "refusing to open {}: not a web address",
            parsed.scheme()
        ));
    }

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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppManifest {
    version: String,
    page: Option<String>,
    #[serde(default)]
    platforms: std::collections::HashMap<String, AppPlatform>,
}

#[derive(serde::Deserialize)]
struct AppPlatform {
    url: Option<String>,
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

/// Checks this desktop App, not whichever daemon the workbench is controlling.
/// A remote Linux daemon has a different version and no Windows installer, so
/// routing this through `update.check` hid stale client Apps.
#[tauri::command]
async fn app_update_status(app: tauri::AppHandle, manifest_url: String) -> AppUpdateStatus {
    let current = app.package_info().version.to_string();
    if manifest_url.is_empty() {
        return empty_app_status(current);
    }
    if !manifest_url.starts_with("https://github.com/aikenc/genethub/releases/") {
        return AppUpdateStatus {
            current,
            latest: None,
            newer: false,
            url: None,
            download_url: None,
            problem: Some("客户端 App 的更新地址不是 GeneHub 发布地址".to_string()),
        };
    }
    match fetch_app_manifest(&manifest_url).await {
        Ok(manifest) => app_status(&current, manifest),
        Err(problem) => AppUpdateStatus {
            current,
            latest: None,
            newer: false,
            url: None,
            download_url: None,
            problem: Some(problem),
        },
    }
}

fn empty_app_status(current: String) -> AppUpdateStatus {
    AppUpdateStatus {
        current,
        latest: None,
        newer: false,
        url: None,
        download_url: None,
        problem: None,
    }
}

async fn fetch_app_manifest(url: &str) -> Result<AppManifest, String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .header(reqwest::header::USER_AGENT, channel::CLI_BINARY)
        .send()
        .await
        .map_err(|error| format!("检查客户端 App 更新失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("发布服务器返回 {}", response.status()));
    }
    response
        .json()
        .await
        .map_err(|error| format!("更新清单无法读取：{error}"))
}

fn app_status(current: &str, manifest: AppManifest) -> AppUpdateStatus {
    let download_url = manifest
        .platforms
        .get("windows-x86_64")
        .and_then(|platform| platform.url.clone());
    AppUpdateStatus {
        current: current.to_string(),
        latest: Some(manifest.version.clone()),
        newer: is_newer(current, &manifest.version),
        url: manifest.page.or_else(|| download_url.clone()),
        download_url,
        problem: None,
    }
}

fn is_newer(current: &str, latest: &str) -> bool {
    if current == "0.0.0" {
        return false;
    }
    let parts = |version: &str| {
        version
            .trim_start_matches('v')
            .split('.')
            .map(|piece| {
                piece
                    .chars()
                    .take_while(|character| character.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect::<Vec<_>>()
    };
    let mine = parts(current);
    let theirs = parts(latest);
    let width = mine.len().max(theirs.len());
    (0..width)
        .map(|index| {
            (
                mine.get(index).unwrap_or(&0),
                theirs.get(index).unwrap_or(&0),
            )
        })
        .find(|(mine, theirs)| mine != theirs)
        .is_some_and(|(mine, theirs)| theirs > mine)
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
            pick_directory
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
mod update_tests {
    use super::*;

    fn manifest(version: &str) -> AppManifest {
        AppManifest {
            version: version.to_string(),
            page: Some("https://example.test/releases/v8".to_string()),
            platforms: std::collections::HashMap::from([
                (
                    "linux-x86_64".to_string(),
                    AppPlatform {
                        url: Some("https://example.test/genet.tar.gz".to_string()),
                    },
                ),
                (
                    "windows-x86_64".to_string(),
                    AppPlatform {
                        url: Some("https://example.test/GeneHub-setup.exe".to_string()),
                    },
                ),
            ]),
        }
    }

    #[test]
    fn app_check_uses_the_windows_asset_and_its_own_version() {
        let status = app_status("0.4.0-beta.7", manifest("0.4.0-beta.8"));
        assert!(status.newer);
        assert_eq!(status.current, "0.4.0-beta.7");
        assert_eq!(status.latest.as_deref(), Some("0.4.0-beta.8"));
        assert_eq!(
            status.download_url.as_deref(),
            Some("https://example.test/GeneHub-setup.exe")
        );
    }

    #[test]
    fn source_builds_are_not_told_to_replace_themselves() {
        assert!(!app_status("0.0.0", manifest("9.0.0")).newer);
    }
}
