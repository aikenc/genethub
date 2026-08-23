//! Minimal native shell: supervise the daemon and apply bounded presentation
//! directives produced by the signed Wasm application.

mod channel;
pub mod daemon;
mod tray;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{Manager, WindowEvent};

use daemon::Daemon;

const AUTH_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_CLI_OUTPUT_BYTES: usize = 64 * 1024;
const MIN_RETRY: Duration = Duration::from_millis(250);
const MAX_RETRY: Duration = Duration::from_secs(30);

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
        let routed = apply_application_routes(&app, &binary, &data_dir, claim_existing);
        if let Err(error) = routed {
            tracing_line(&format!("登录官网失败: {error}"));
            show_boot_error(&app, &error);
        }
        if let Some(state) = app.try_state::<AppState>() {
            state.auth_in_flight.store(false, Ordering::SeqCst);
        }
    });
}

#[derive(Deserialize)]
struct CliEnvelope {
    data: DesktopDirective,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopDirective {
    navigate: String,
    complete: bool,
    retry_after_millis: Option<u64>,
}

/// The shell knows only a generic navigation directive. Hub state, channel
/// endpoints, claim-link construction and retry policy all live in Wasm and
/// can change without replacing this binary.
fn apply_application_routes(
    app: &tauri::AppHandle,
    binary: &Path,
    data_dir: &Path,
    claim_existing: bool,
) -> Result<(), String> {
    let deadline = Instant::now() + AUTH_TIMEOUT;
    let mut previous = None;
    while Instant::now() < deadline {
        let directive = application_route(binary, data_dir, claim_existing)?;
        if previous.as_deref() != Some(&directive.navigate) {
            let target = external_web_url(&directive.navigate)?;
            ensure_web_reachable(&target)?;
            navigate(app, target)?;
            previous = Some(directive.navigate);
        }
        if directive.complete {
            return Ok(());
        }
        let retry = Duration::from_millis(directive.retry_after_millis.unwrap_or(2_000))
            .clamp(MIN_RETRY, MAX_RETRY);
        std::thread::sleep(retry);
    }
    Err("登录等待超时，请从托盘重新选择“连接到 Hub”".to_string())
}

fn application_route(
    binary: &Path,
    data_dir: &Path,
    claim_existing: bool,
) -> Result<DesktopDirective, String> {
    let mut command = Command::new(binary);
    command.args(["desktop", "route"]);
    if claim_existing {
        command.arg("--claim");
    }
    command
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
        return Err("Wasm 桌面指令输出超过安全上限".to_string());
    }
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("Wasm 桌面指令失败（{}）", output.status)
        } else {
            message
        });
    }
    serde_json::from_slice::<CliEnvelope>(&output.stdout)
        .map(|envelope| envelope.data)
        .map_err(|error| format!("Wasm 桌面指令不是有效 JSON: {error}"))
}

fn navigate(app: &tauri::AppHandle, url: tauri::Url) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    window.navigate(url).map_err(|error| error.to_string())?;
    tray::show_main_window(app);
    Ok(())
}

/// Keep the bundled boot surface visible when the website is offline. A
/// response with any HTTP status proves the origin is reachable; authentication
/// and application routing still belong to the page itself.
fn ensure_web_reachable(url: &tauri::Url) -> Result<(), String> {
    use std::net::{TcpStream, ToSocketAddrs};

    let host = url
        .host_str()
        .ok_or_else(|| "官网地址没有主机名".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "官网地址没有可连接端口".to_string())?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("官网暂时无法解析，仍停留在启动页: {error}"))?;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(5)) {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "官网暂时无法访问，仍停留在启动页: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "没有可用地址".to_string())
    ))
}

fn show_boot_error(app: &tauri::AppHandle, message: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let encoded = serde_json::to_string(message).unwrap_or_else(|_| "\"启动失败\"".to_string());
    let _ = window.eval(format!(
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
    use super::{external_web_url, CliEnvelope};

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
    fn shell_decodes_only_the_generic_wasm_navigation_directive() {
        let envelope: CliEnvelope = serde_json::from_value(serde_json::json!({
            "schema": "genet.cli/v1",
            "type": "desktop.route",
            "data": {
                "navigate": "https://hub.example/app",
                "complete": false,
                "retryAfterMillis": 750,
            }
        }))
        .unwrap();
        assert_eq!(envelope.data.navigate, "https://hub.example/app");
        assert!(!envelope.data.complete);
        assert_eq!(envelope.data.retry_after_millis, Some(750));
    }
}
