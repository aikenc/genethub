//! Minimal native shell: supervise the daemon, enroll the machine, then act as
//! an ordinary browser for the channel-stamped product Web.

mod channel;
pub mod daemon;
mod tray;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{Manager, WindowEvent};

use daemon::Daemon;

const AUTH_POLL: Duration = Duration::from_secs(2);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_CLI_OUTPUT_BYTES: usize = 64 * 1024;

pub struct AppState {
    pub daemon: Arc<Daemon>,
    binary: PathBuf,
    data_dir: PathBuf,
    auth_in_flight: AtomicBool,
}

/// Begins first-run authentication in the main WebView. No renderer command is
/// involved: the remote page receives neither Tauri globals nor capabilities.
pub(crate) fn start_auth(app: &tauri::AppHandle) {
    start_auth_flow(app, false);
}

/// Explicit recovery action for a paired daemon whose WebView is signed into
/// no account or the wrong account. Unlike ordinary startup, this may mint a
/// one-use owner claim link and therefore only runs from the tray command.
pub(crate) fn start_claim(app: &tauri::AppHandle) {
    start_auth_flow(app, true);
}

fn start_auth_flow(app: &tauri::AppHandle, claim_existing: bool) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state.auth_in_flight.swap(true, Ordering::SeqCst) {
        tray::show_main_window(app);
        return;
    }
    let binary = state.binary.clone();
    let data_dir = state.data_dir.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let routed =
            initial_route(&binary, &data_dir, claim_existing).and_then(|route| match route {
                InitialRoute::Ready(url) => navigate(&app, url),
                InitialRoute::Pairing(url) => {
                    navigate(&app, url)?;
                    wait_for_pairing(&app, &binary, &data_dir)
                }
            });
        if let Err(error) = routed {
            tracing_line(&format!("登录官网失败: {error}"));
            show_boot_error(&app, &error);
        }
        if let Some(state) = app.try_state::<AppState>() {
            state.auth_in_flight.store(false, Ordering::SeqCst);
        }
    });
}

enum InitialRoute {
    Ready(tauri::Url),
    Pairing(tauri::Url),
}

fn initial_route(
    binary: &Path,
    data_dir: &Path,
    claim_existing: bool,
) -> Result<InitialRoute, String> {
    // Source builds intentionally have no public Hub. They still exercise the
    // remote-page shell against the local dev URL, without acquiring a native
    // JavaScript bridge.
    if channel::HUB_URL.is_empty() {
        return Ok(InitialRoute::Ready(workbench_url(None)?));
    }

    let login = cli_json(
        binary,
        data_dir,
        &["hub", "login", "--hub", channel::HUB_URL],
    )?;
    if let Some(machine_id) = paired_machine(&login) {
        if claim_existing {
            let claim = cli_json(binary, data_dir, &["hub", "link"])?;
            let url = claim
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| "daemon 没有返回认领链接".to_string())?;
            return Ok(InitialRoute::Ready(claim_url(url, &machine_id)?));
        }
        // The persistent WebView normally keeps its website cookie. If it does
        // not, the ordinary website login owns recovery; minting a machine
        // claim on every launch would turn startup into a repeated rebind flow.
        return Ok(InitialRoute::Ready(workbench_url(Some(&machine_id))?));
    }

    let url = login
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| login_problem(&login))?;
    Ok(InitialRoute::Pairing(external_web_url(url)?))
}

fn wait_for_pairing(app: &tauri::AppHandle, binary: &Path, data_dir: &Path) -> Result<(), String> {
    let deadline = Instant::now() + AUTH_TIMEOUT;
    while Instant::now() < deadline {
        std::thread::sleep(AUTH_POLL);
        let status = cli_json(binary, data_dir, &["hub", "status"])?;
        if let Some(machine_id) = paired_machine(&status) {
            return navigate(app, workbench_url(Some(&machine_id))?);
        }
        if status_name(&status) == Some("failed") {
            return Err(login_problem(&status));
        }
    }
    Err("登录等待超时，请从托盘重新选择“连接到 Hub”".to_string())
}

fn cli_json(binary: &Path, data_dir: &Path, args: &[&str]) -> Result<Value, String> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .env(channel::ENV_DATA_DIR, data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("无法运行 {}: {error}", binary.display()))?;
    if output.stdout.len() > MAX_CLI_OUTPUT_BYTES || output.stderr.len() > MAX_CLI_OUTPUT_BYTES {
        return Err("CLI 登录输出超过安全上限".to_string());
    }
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("CLI 登录失败（{}）", output.status)
        } else {
            message
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("CLI 登录响应不是 JSON: {error}"))
}

fn status_name(value: &Value) -> Option<&str> {
    value
        .get("status")
        .or_else(|| value.get("state"))
        .and_then(Value::as_str)
}

fn paired_machine(value: &Value) -> Option<String> {
    (status_name(value) == Some("paired"))
        .then(|| {
            value
                .get("machineId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .flatten()
}

fn login_problem(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("daemon 没有返回可打开的登录地址")
        .to_string()
}

fn workbench_url(machine_id: Option<&str>) -> Result<tauri::Url, String> {
    let mut url = external_web_url(channel::WEB_APP_URL)?;
    if let Some(machine_id) = machine_id {
        url.query_pairs_mut()
            .append_pair("desktopMachine", machine_id);
    }
    Ok(url)
}

fn claim_url(value: &str, machine_id: &str) -> Result<tauri::Url, String> {
    let mut claim = external_web_url(value)?;
    let workbench = workbench_url(Some(machine_id))?;
    let mut next = workbench.path().to_string();
    if let Some(query) = workbench.query() {
        next.push('?');
        next.push_str(query);
    }
    claim.query_pairs_mut().append_pair("next", &next);
    Ok(claim)
}

fn navigate(app: &tauri::AppHandle, url: tauri::Url) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    window.navigate(url).map_err(|error| error.to_string())?;
    tray::show_main_window(app);
    Ok(())
}

fn show_boot_error(app: &tauri::AppHandle, message: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let encoded = serde_json::to_string(message).unwrap_or_else(|_| "\"启动失败\"".to_string());
    let _ = window.eval(&format!(
        "const node=document.getElementById('status');if(node)node.textContent={encoded};"
    ));
    tray::show_main_window(app);
}

/// Only fixed HTTPS product pages and literal-loopback development pages may
/// replace the bundled boot surface.
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
        "http" => Err("refusing plaintext HTTP outside a literal loopback address".to_string()),
        scheme => Err(format!("refusing to navigate to {scheme}:")),
    }
}

pub fn logs_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(channel::DATA_DIR_NAME).join("logs"))
        .unwrap_or_else(|_| PathBuf::from("logs"))
}

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
            let data_dir = app.path().app_data_dir()?.join(channel::DATA_DIR_NAME);
            let _ = std::fs::create_dir_all(data_dir.join("logs"));
            log_to(data_dir.join("logs").join("shell.log"));

            let name = if cfg!(windows) {
                format!("{}.exe", channel::CLI_BINARY)
            } else {
                channel::CLI_BINARY.to_string()
            };
            let binary = bundled_binary(handle, &name).unwrap_or_else(|| {
                app.path()
                    .resource_dir()
                    .map(|dir| dir.join("bin").join(&name))
                    .unwrap_or_else(|_| PathBuf::from(&name))
            });

            tray::build(handle)?;
            let daemon = Arc::new(Daemon::new(binary.clone(), data_dir.clone()));
            let started = daemon.start();
            app.manage(AppState {
                daemon: Arc::clone(&daemon),
                binary,
                data_dir,
                auth_in_flight: AtomicBool::new(false),
            });
            announce(handle, started.as_ref().map(|_| ()).map_err(Clone::clone));

            let watcher = handle.clone();
            daemon.watch(move |change| match change {
                daemon::Watch::Lost => tray::set_status(&watcher, "本机状态：正在恢复…"),
                daemon::Watch::Restarted(_) => announce(&watcher, Ok(())),
                daemon::Watch::Failed(error) => announce(&watcher, Err(error)),
            });
            match started {
                Ok(_) => start_auth(handle),
                Err(error) => show_boot_error(handle, &format!("daemon 启动失败: {error}")),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
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

fn announce(app: &tauri::AppHandle, result: Result<(), String>) {
    match result {
        Ok(()) => tray::set_status(app, "本机状态：运行中"),
        Err(error) => {
            tray::set_status(app, "本机状态：已停止");
            tracing_line(&format!("daemon 启动失败: {error}"));
        }
    }
}

static LOG: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

fn log_to(path: PathBuf) {
    let _ = std::fs::write(&path, "");
    *LOG.lock().expect("log lock") = Some(path);
}

fn tracing_line(message: &str) {
    eprintln!("[genehub] {message}");
    if let Some(path) = LOG.lock().expect("log lock").clone() {
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
    use super::{claim_url, external_web_url};

    #[test]
    fn navigation_accepts_only_https_or_literal_loopback_http() {
        assert!(external_web_url("https://hub.example/app").is_ok());
        assert!(external_web_url("http://127.0.0.1:5173/app").is_ok());
        for rejected in [
            "http://hub.example/app",
            "http://localhost:5173/app",
            "file:///tmp/payload",
            "javascript:alert(1)",
            "https://user:password@hub.example/app",
        ] {
            assert!(external_web_url(rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn claim_redirect_enters_the_selected_desktop_machine() {
        let url = claim_url("https://hub.example/link/once", "machine-1").unwrap();
        assert_eq!(
            url.query_pairs().find(|(key, _)| key == "next").unwrap().1,
            "/app?desktopMachine=machine-1"
        );
    }
}
