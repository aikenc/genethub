//! What the operating system lets this machine's daemon do, and how to get the
//! rest granted with the fewest trips to the keyboard.
//!
//! The scope is deliberately small: GeneHub runs as one person's own always-on
//! server, so it needs three things — to *execute* its own programs, to *read
//! and write the disk*, and to *use the network*. Nothing here asks for the
//! camera or the microphone.
//!
//! Three kinds of answer exist and the page keeps them apart:
//! - **fix**: the daemon can repair it itself (re-sign its programs, clear a
//!   download quarantine);
//! - **prompt / settings**: only a person at the machine can finish it; the
//!   daemon opens the right dialog or settings page and then *checks again*;
//! - **command**: needs an administrator; the exact command is shown.
//!
//! "Asked" is never reported as "granted": every outcome comes with the state
//! re-read afterwards.
use crate::os_process::Command;
use crate::state::Shared;
use anyhow::{anyhow, Result};
use genehub_proto::{
    AccessAction, AccessItem, AccessOutcome, AccessOutcomeKind, AccessReport, AccessSetupResult,
    AccessState,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

const IDENTITY_SCRIPT: &str = include_str!("access/macos_identity.py");
const QUICK: Duration = Duration::from_secs(20);
/// A system dialog nobody answers must not hold the daemon: the earlier
/// removable-volume incident blocked `open()` for good behind an unseen prompt.
const DIALOG: Duration = Duration::from_secs(60);
const SETTLE: Duration = Duration::from_secs(130);
const MOST_OUTPUT: usize = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Platform {
    Mac,
    Windows,
    Wsl,
    Linux,
}

impl Platform {
    fn name(self) -> &'static str {
        match self {
            Platform::Mac => "macos",
            Platform::Windows => "windows",
            Platform::Wsl => "wsl",
            Platform::Linux => "linux",
        }
    }
}

pub struct Out {
    pub code: Option<i32>,
    pub text: String,
    pub timed_out: bool,
}

impl Out {
    fn ok(&self) -> bool {
        self.code == Some(0) && !self.timed_out
    }
}

async fn bounded(mut input: impl AsyncRead + Unpin) -> String {
    let mut data = Vec::new();
    let mut buffer = [0u8; 8192];
    while let Ok(count) = input.read(&mut buffer).await {
        if count == 0 || data.len() + count > MOST_OUTPUT {
            break;
        }
        data.extend_from_slice(&buffer[..count]);
    }
    String::from_utf8_lossy(&data).into_owned()
}

/// stdout and stderr together, and never longer than `limit`: the child is
/// killed when the timeout elapses, so a pending dialog cannot hang us.
pub async fn run(program: &str, args: &[&str], limit: Duration) -> Out {
    let spawned = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            return Out {
                code: None,
                text: format!("{program}: {error}"),
                timed_out: false,
            }
        }
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Out {
            code: None,
            text: "no output pipes".into(),
            timed_out: false,
        };
    };
    let finished = tokio::time::timeout(limit, async {
        let (out, err, status) = tokio::join!(bounded(stdout), bounded(stderr), child.wait());
        (out, err, status)
    })
    .await;
    match finished {
        Ok((out, err, status)) => Out {
            code: status.ok().and_then(|status| status.code()),
            text: format!("{out}{err}"),
            timed_out: false,
        },
        Err(_) => Out {
            code: None,
            text: String::new(),
            timed_out: true,
        },
    }
}

pub async fn platform() -> Platform {
    static PLATFORM: tokio::sync::OnceCell<Platform> = tokio::sync::OnceCell::const_new();
    *PLATFORM
        .get_or_init(|| async {
            if crate::guest_paths::windows_host() || cfg!(windows) {
                return Platform::Windows;
            }
            let kernel = run("/usr/bin/uname", &["-s"], QUICK).await;
            let kernel = if kernel.ok() {
                kernel.text
            } else {
                run("uname", &["-s"], QUICK).await.text
            };
            if kernel.trim() == "Darwin" {
                return Platform::Mac;
            }
            let version = std::fs::read_to_string("/proc/version").unwrap_or_default();
            if version.to_ascii_lowercase().contains("microsoft") {
                Platform::Wsl
            } else {
                Platform::Linux
            }
        })
        .await
}

// ---- persisted facts --------------------------------------------------------

/// Small, rebuildable record: what the system will not tell us afterwards.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Record {
    /// The requirement each program had when we last looked, to notice an
    /// identity change that silently invalidates earlier grants.
    requirements: BTreeMap<String, String>,
    /// Results of per-folder requests; macOS gives no silent way to read them.
    results: BTreeMap<String, String>,
    /// Set when programs were re-signed; cleared by the next daemon start.
    signed_before_boot: Option<String>,
}

fn boot() -> &'static str {
    static BOOT: OnceLock<String> = OnceLock::new();
    BOOT.get_or_init(|| chrono::Utc::now().to_rfc3339())
}

fn record_path(state: &Shared) -> PathBuf {
    state.paths.root.join("access").join("state.json")
}

fn load(state: &Shared) -> Record {
    std::fs::read_to_string(record_path(state))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(state: &Shared, record: &Record) {
    let path = record_path(state);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(record) {
        let _ = std::fs::write(path, text);
    }
}

// ---- macOS -----------------------------------------------------------------

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

async fn mac_locked() -> bool {
    let out = run(
        "/bin/sh",
        &[
            "-c",
            "/usr/sbin/ioreg -n Root -d1 -a | /usr/bin/grep -A1 CGSSessionScreenIsLocked",
        ],
        QUICK,
    )
    .await;
    out.text.contains("<true/>")
}

/// The programs macOS attributes this daemon's file and network access to: the
/// command-line front door (the launchd job's program, which stays the
/// *responsible process* even after it execs the host) and the host itself.
async fn mac_programs() -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(cli) = std::env::var("GENEHUB_CLI") {
        if let Some(dir) = Path::new(&cli).parent() {
            let listing = run("/bin/ls", &["-1", &dir.to_string_lossy()], QUICK).await;
            for name in listing.text.lines() {
                let name = name.trim();
                let wanted = (name.starts_with("genet") || name.starts_with("genehub-host"))
                    && !name.starts_with('.')
                    && !name.ends_with(".wasm")
                    && !name.contains(".sign-");
                if wanted {
                    found.push(dir.join(name).to_string_lossy().into_owned());
                }
            }
        }
    }
    let capture = format!(
        "{}/Applications/GeneHub Capture.app/Contents/MacOS/genehub-capture",
        home()
    );
    if run("/bin/test", &["-f", &capture], QUICK).await.ok() {
        found.push(capture);
    }
    found
}

fn script_path(state: &Shared) -> Result<PathBuf> {
    let path = state.paths.root.join("access").join("macos_identity.py");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::read_to_string(&path).ok().as_deref() != Some(IDENTITY_SCRIPT) {
        std::fs::write(&path, IDENTITY_SCRIPT)?;
    }
    Ok(crate::guest_paths::host_path(&path))
}

async fn identity(
    state: &Shared,
    args: &[&str],
    limit: Duration,
) -> Result<(Option<i32>, serde_json::Value)> {
    let script = script_path(state)?;
    let script = script.to_string_lossy().into_owned();
    let mut all = vec![script.as_str()];
    all.extend_from_slice(args);
    let out = run("/usr/bin/python3", &all, limit).await;
    if out.timed_out {
        return Err(anyhow!("the signing helper did not finish in time"));
    }
    let value = out
        .text
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .ok_or_else(|| {
            anyhow!(
                "the signing helper printed nothing usable: {}",
                out.text.trim()
            )
        })?;
    Ok((out.code, value))
}

fn item(
    id: &str,
    group: &str,
    label: &str,
    purpose: &str,
    state: AccessState,
    detail: impl Into<Option<String>>,
    action: AccessAction,
    recommended: bool,
) -> AccessItem {
    AccessItem {
        id: id.into(),
        group: group.into(),
        label: label.into(),
        purpose: purpose.into(),
        state,
        detail: detail.into(),
        holders: Vec::new(),
        action,
        recommended,
        command: None,
    }
}

async fn mac_items(state: &Shared) -> Vec<AccessItem> {
    let mut record = load(state);
    let programs = mac_programs().await;
    let mut items = Vec::new();

    // 1. Stable code identity: what lets every later grant survive an update.
    let mut identity_item = item(
        "mac.code-identity",
        "identity",
        "稳定的程序身份",
        "更新后保留已授予的权限；否则系统把新版本当成另一个程序，要重新授权。",
        AccessState::Unknown,
        "没有找到 GeneHub 的原生程序".to_string(),
        AccessAction::Fix,
        true,
    );
    let mut quarantined = Vec::new();
    // Wrapper scripts and the like are not what the system tracks.
    let mut native: Vec<String> = Vec::new();
    if !programs.is_empty() {
        let mut args = vec!["status"];
        args.extend(programs.iter().map(String::as_str));
        match identity(state, &args, QUICK).await {
            Ok((_, status)) => {
                let files: Vec<&serde_json::Value> = status["files"]
                    .as_array()
                    .map(|files| files.iter().filter(|file| file["macho"] == true).collect())
                    .unwrap_or_default();
                let unstable: Vec<String> = files
                    .iter()
                    .filter(|file| file["stable"] != true)
                    .filter_map(|file| file["path"].as_str().map(str::to_string))
                    .collect();
                for file in &files {
                    if file["quarantined"] == true {
                        if let Some(path) = file["path"].as_str() {
                            quarantined.push(path.to_string());
                        }
                    }
                }
                let changed: Vec<String> = files
                    .iter()
                    .filter_map(|file| {
                        let path = file["path"].as_str()?;
                        let requirement = file["requirement"].as_str()?;
                        let before = record.requirements.get(path)?;
                        (file["stable"] == true && before != requirement).then(|| path.to_string())
                    })
                    .collect();
                for file in &files {
                    if file["stable"] == true {
                        if let (Some(path), Some(requirement)) =
                            (file["path"].as_str(), file["requirement"].as_str())
                        {
                            record.requirements.insert(path.into(), requirement.into());
                        }
                    }
                }
                native = files
                    .iter()
                    .filter_map(|file| file["path"].as_str().map(str::to_string))
                    .collect();
                identity_item.holders = native.clone();
                if files.is_empty() {
                    identity_item.state = AccessState::Unknown;
                } else if !unstable.is_empty() {
                    identity_item.state = AccessState::Denied;
                    identity_item.detail = Some(format!(
                        "{} 个程序用临时签名，每次更新都会被系统当成新程序。点“申请”会用本机生成的证书签名（不需要 Apple ID）。",
                        unstable.len()
                    ));
                } else if !changed.is_empty() {
                    identity_item.state = AccessState::NeedsRecheck;
                    identity_item.detail = Some(
                        "程序身份发生过变化，之前授予的权限可能已失效，请重新检查下面的权限。"
                            .into(),
                    );
                } else if record
                    .signed_before_boot
                    .as_deref()
                    .is_some_and(|b| b == boot())
                {
                    identity_item.state = AccessState::NeedsRecheck;
                    identity_item.detail = Some("已签名，重启 daemon 后新身份才生效。".into());
                } else {
                    identity_item.state = AccessState::Granted;
                    identity_item.detail =
                        Some("所有程序使用同一个本机证书；更新后系统仍认作同一个程序。".into());
                }
            }
            Err(error) => identity_item.detail = Some(format!("无法检查：{error}")),
        }
    }
    save(state, &record);
    items.push(identity_item);

    // 2. Executable: nothing the system quarantined for being downloaded.
    let mut executable = item(
        "mac.executable",
        "identity",
        "允许运行",
        "从浏览器下载的程序带有隔离标记，首次运行会被系统拦下。",
        if quarantined.is_empty() {
            AccessState::Granted
        } else {
            AccessState::Denied
        },
        if quarantined.is_empty() {
            "没有被隔离的程序。".to_string()
        } else {
            format!("{} 个程序带有隔离标记。", quarantined.len())
        },
        AccessAction::Fix,
        true,
    );
    executable.holders = quarantined;
    items.push(executable);

    // 3. Full Disk Access: the one switch that covers every folder prompt.
    let probe = run(
        "/bin/sh",
        &[
            "-c",
            r#"/bin/dd if="$HOME/Library/Application Support/com.apple.TCC/TCC.db" of=/dev/null bs=1 count=1 2>&1"#,
        ],
        QUICK,
    )
    .await;
    let (fda, fda_detail) = if probe.ok() {
        (
            AccessState::Granted,
            "已授予：访问桌面、文稿、下载、外接盘等位置不再单独询问。".to_string(),
        )
    } else if probe.text.contains("Operation not permitted") {
        (
            AccessState::Denied,
            "未授予。授予后下面的文件夹授权都不用再点。".to_string(),
        )
    } else {
        (
            AccessState::Unknown,
            format!("无法判断：{}", probe.text.trim()),
        )
    };
    let mut full_disk = item(
        "mac.full-disk-access",
        "disk",
        "完全磁盘访问（推荐）",
        "Agent 读写桌面、文稿、下载、外接盘与其他 App 的数据时不再弹窗；锁屏时也不会卡住。",
        fda,
        fda_detail,
        AccessAction::Settings,
        true,
    );
    full_disk.holders = native
        .iter()
        .filter(|path| !path.contains(".app/"))
        .cloned()
        .collect();
    items.push(full_disk);

    // 4. Finer-grained alternatives; all covered by Full Disk Access.
    let covered = fda == AccessState::Granted;
    let h = home();
    let folders: [(&str, &str, String); 3] = [
        ("mac.folder.desktop", "桌面文件夹", format!("{h}/Desktop")),
        (
            "mac.folder.documents",
            "文稿文件夹",
            format!("{h}/Documents"),
        ),
        (
            "mac.folder.downloads",
            "下载文件夹",
            format!("{h}/Downloads"),
        ),
    ];
    for (id, label, _) in folders {
        items.push(fine_grained(state, id, label, covered));
    }
    items.push(fine_grained(
        state,
        "mac.removable-volumes",
        "外接盘与网络卷",
        covered,
    ));
    items.push(fine_grained(
        state,
        "mac.app-data",
        "其他 App 的数据",
        covered,
    ));

    // 5. Network: the application firewall, which is what can stop inbound use.
    let cli = std::env::var("GENEHUB_CLI").unwrap_or_default();
    let firewall = run(
        "/usr/libexec/ApplicationFirewall/socketfilterfw",
        &["--getglobalstate"],
        QUICK,
    )
    .await;
    let (firewall_state, firewall_detail, command) = if firewall.text.contains("disabled") {
        (
            AccessState::Granted,
            "系统防火墙已关闭，不会拦截入站连接。".to_string(),
            None,
        )
    } else if firewall.text.contains("enabled") {
        let blocked = run(
            "/usr/libexec/ApplicationFirewall/socketfilterfw",
            &["--getappblocked", &cli],
            QUICK,
        )
        .await;
        if blocked.text.contains("permitted") {
            (
                AccessState::Granted,
                "系统防火墙已开启，GeneHub 已被允许接受入站连接。".to_string(),
                None,
            )
        } else {
            (
                AccessState::Denied,
                "系统防火墙已开启，GeneHub 尚未被允许接受入站连接（局域网直连可能失败）。".to_string(),
                Some(format!("sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add '{cli}' --unblockapp '{cli}'")),
            )
        }
    } else {
        (
            AccessState::Unknown,
            "无法读取防火墙状态。".to_string(),
            None,
        )
    };
    let mut firewall_item = item(
        "mac.firewall",
        "network",
        "网络：系统防火墙",
        "手机和其他设备直连这台电脑时需要接受入站连接；只主动连出去不受影响。",
        firewall_state,
        firewall_detail,
        if command.is_some() {
            AccessAction::Command
        } else {
            AccessAction::None
        },
        false,
    );
    firewall_item.command = command;
    items.push(firewall_item);

    // 6. Optional: remote desktop (not part of the default set).
    items.extend(mac_capture_items().await);
    items
}

fn fine_grained(state: &Shared, id: &str, label: &str, covered: bool) -> AccessItem {
    let record = load(state);
    let (item_state, detail) = if covered {
        (AccessState::Granted, "已由“完全磁盘访问”覆盖。".to_string())
    } else {
        match record.results.get(id).map(String::as_str) {
            Some("granted") => (AccessState::Granted, "上次申请时已允许。".to_string()),
            Some("denied") => (
                AccessState::Denied,
                "上次申请被拒绝；到系统设置里重新开启。".to_string(),
            ),
            _ => (
                AccessState::NotDetermined,
                "系统不提供静默查询；点“申请”会在这台电脑上弹一次系统对话框。".to_string(),
            ),
        }
    };
    item(
        id,
        "disk",
        label,
        "只想按位置授权时用；一次授予“完全磁盘访问”就不需要这些。",
        item_state,
        detail,
        AccessAction::Prompt,
        false,
    )
}

fn capture_app() -> String {
    format!("{}/Applications/GeneHub Capture.app", home())
}

async fn mac_capture_items() -> Vec<AccessItem> {
    let app = capture_app();
    let purpose_screen = "远程桌面观看：采集这台电脑的屏幕。";
    let purpose_input = "远程桌面接管：向这台电脑发送键盘和鼠标。";
    if !run("/bin/test", &["-d", &app], QUICK).await.ok() {
        let missing = |id: &str, label: &str, purpose: &str| {
            item(
                id,
                "desktop",
                label,
                purpose,
                AccessState::NotApplicable,
                "未安装远程桌面组件（可选）。".to_string(),
                AccessAction::None,
                false,
            )
        };
        return vec![
            missing(
                "mac.screen-recording",
                "屏幕录制（远程桌面，可选）",
                purpose_screen,
            ),
            missing(
                "mac.accessibility",
                "辅助功能（远程桌面，可选）",
                purpose_input,
            ),
        ];
    }
    // Only a launch through LaunchServices is judged as Capture itself; running
    // the binary from a shell would be judged as whoever started the shell.
    let probe = run(
        "/bin/sh",
        &[
            "-c",
            r#"f=$(/usr/bin/mktemp /tmp/gh-capture.XXXXXX); /usr/bin/open -n -W --stdout "$f" --stderr /dev/null "$HOME/Applications/GeneHub Capture.app" --args --probe; /bin/cat "$f"; /bin/rm -f "$f""#,
        ],
        QUICK,
    )
    .await;
    let json: Option<serde_json::Value> = probe
        .text
        .lines()
        .find_map(|line| serde_json::from_str(line).ok());
    let (screen, input, why) = match json {
        Some(json) => {
            let reason = json["reason"].as_str().unwrap_or("").to_string();
            let available = json["available"] == true;
            let input = if json["inputPermission"] == true {
                AccessState::Granted
            } else {
                AccessState::Denied
            };
            if available {
                (AccessState::Granted, input, String::new())
            } else if reason.contains("Screen Recording") {
                (AccessState::Denied, input, String::new())
            } else {
                (
                    AccessState::Unknown,
                    AccessState::Unknown,
                    "屏幕锁定或没有图形会话，暂时无法判断。".to_string(),
                )
            }
        }
        None => (
            AccessState::Unknown,
            AccessState::Unknown,
            "无法运行远程桌面组件的检查。".to_string(),
        ),
    };
    let mut screen_item = item(
        "mac.screen-recording",
        "desktop",
        "屏幕录制（远程桌面，可选）",
        purpose_screen,
        screen,
        why.clone(),
        AccessAction::Prompt,
        false,
    );
    let mut input_item = item(
        "mac.accessibility",
        "desktop",
        "辅助功能（远程桌面，可选）",
        purpose_input,
        input,
        why,
        AccessAction::Prompt,
        false,
    );
    let holder = format!("{app}/Contents/MacOS/genehub-capture");
    screen_item.holders = vec![holder.clone()];
    input_item.holders = vec![holder];
    vec![screen_item, input_item]
}

async fn mac_request(state: &Shared, id: &str, locked: bool) -> AccessOutcome {
    let outcome = |kind, message: &str| AccessOutcome {
        id: id.into(),
        kind,
        message: message.into(),
    };
    let programs = mac_programs().await;
    match id {
        "mac.code-identity" => {
            let targets: Vec<&str> = programs.iter().map(String::as_str).collect();
            if targets.is_empty() {
                return outcome(AccessOutcomeKind::Failed, "没有找到需要签名的程序。");
            }
            let mut args = vec!["sign"];
            args.extend(targets);
            match identity(state, &args, Duration::from_secs(120)).await {
                Ok((Some(0), result)) => {
                    let signed = result["files"]
                        .as_array()
                        .map(|files| {
                            files
                                .iter()
                                .filter(|file| file["action"] == "signed")
                                .count()
                        })
                        .unwrap_or(0);
                    let mut record = load(state);
                    if signed > 0 {
                        record.signed_before_boot = Some(boot().to_string());
                    }
                    save(state, &record);
                    if signed > 0 {
                        outcome(AccessOutcomeKind::NeedsUser, &format!("已签名 {signed} 个程序。请先重启 daemon（桌面 App 退出再打开，或运行 genet daemon restart），新身份才生效；之后再授予磁盘权限，往后的更新就不会让它失效。"))
                    } else {
                        outcome(AccessOutcomeKind::Done, "程序身份已经是稳定的。")
                    }
                }
                Ok((Some(3), result)) => outcome(
                    AccessOutcomeKind::NeedsUser,
                    result["error"].as_str().unwrap_or(
                        "需要在这台电脑上确认一次系统提示（用于信任本机生成的签名证书）。",
                    ),
                ),
                Ok((_, result)) => outcome(
                    AccessOutcomeKind::Failed,
                    result["error"].as_str().unwrap_or("签名失败。"),
                ),
                Err(error) => outcome(AccessOutcomeKind::Failed, &error.to_string()),
            }
        }
        "mac.executable" => {
            let mut cleared = 0;
            for path in programs {
                if run(
                    "/usr/bin/xattr",
                    &["-d", "com.apple.quarantine", &path],
                    QUICK,
                )
                .await
                .ok()
                {
                    cleared += 1;
                }
            }
            outcome(
                AccessOutcomeKind::Done,
                &format!("已清除 {cleared} 个程序的隔离标记。"),
            )
        }
        "mac.full-disk-access" => {
            if locked {
                return outcome(
                    AccessOutcomeKind::Skipped,
                    "这台电脑已锁屏；请解锁后在系统设置里打开。",
                );
            }
            let pane = run(
                "/usr/bin/open",
                &["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"],
                QUICK,
            )
            .await;
            if !pane.ok() {
                return outcome(
                    AccessOutcomeKind::Failed,
                    &format!("无法打开系统设置：{}", pane.text.trim()),
                );
            }
            // Only a program the system can attribute the grant to is worth showing.
            let natives = {
                let mut args = vec!["status"];
                args.extend(programs.iter().map(String::as_str));
                match identity(state, &args, QUICK).await {
                    Ok((_, status)) => status["files"]
                        .as_array()
                        .map(|files| {
                            files
                                .iter()
                                .filter(|f| f["macho"] == true)
                                .filter_map(|f| f["path"].as_str().map(str::to_string))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default(),
                    Err(_) => programs.clone(),
                }
            };
            if let Some(first) = natives.iter().find(|path| !path.contains(".app/")) {
                let _ = run("/usr/bin/open", &["-R", first], QUICK).await;
            }
            outcome(AccessOutcomeKind::NeedsUser, "已打开“完全磁盘访问”并在访达里选中程序：把它拖进列表并打开开关（列表里的每个 genet / genehub-host 都加上更稳妥）。")
        }
        "mac.folder.desktop"
        | "mac.folder.documents"
        | "mac.folder.downloads"
        | "mac.removable-volumes"
        | "mac.app-data" => {
            if locked {
                return outcome(
                    AccessOutcomeKind::Skipped,
                    "这台电脑已锁屏，系统对话框没有人能点；解锁后再申请。",
                );
            }
            let h = home();
            let target = match id {
                "mac.folder.desktop" => format!("{h}/Desktop"),
                "mac.folder.documents" => format!("{h}/Documents"),
                "mac.folder.downloads" => format!("{h}/Downloads"),
                "mac.removable-volumes" => {
                    let volumes = run("/bin/sh", &["-c", "/bin/ls -1 /Volumes | /usr/bin/grep -v '^Macintosh HD' | /usr/bin/head -1"], QUICK).await;
                    let name = volumes.text.trim();
                    if name.is_empty() {
                        return outcome(AccessOutcomeKind::Skipped, "没有外接盘可用来申请。");
                    }
                    format!("/Volumes/{name}")
                }
                _ => {
                    let containers = run(
                        "/bin/sh",
                        &[
                            "-c",
                            "/bin/ls -1 \"$HOME/Library/Containers\" | /usr/bin/head -1",
                        ],
                        QUICK,
                    )
                    .await;
                    let name = containers.text.trim();
                    if name.is_empty() {
                        return outcome(
                            AccessOutcomeKind::Skipped,
                            "没有其他 App 的数据可用来申请。",
                        );
                    }
                    format!("{h}/Library/Containers/{name}")
                }
            };
            let touch = run("/bin/ls", &[&target], DIALOG).await;
            let mut record = load(state);
            let result = if touch.timed_out {
                outcome(
                    AccessOutcomeKind::NeedsUser,
                    "系统对话框还在等你点“允许”；点完后再检查一次。",
                )
            } else if touch.ok() {
                record.results.insert(id.into(), "granted".into());
                outcome(AccessOutcomeKind::Done, "已允许。")
            } else if touch.text.contains("Operation not permitted") {
                record.results.insert(id.into(), "denied".into());
                outcome(
                    AccessOutcomeKind::Denied,
                    "被拒绝；到系统设置“隐私与安全性”里重新开启。",
                )
            } else {
                outcome(AccessOutcomeKind::Failed, touch.text.trim())
            };
            save(state, &record);
            result
        }
        "mac.screen-recording" | "mac.accessibility" => {
            if locked {
                return outcome(AccessOutcomeKind::Skipped, "这台电脑已锁屏；解锁后再申请。");
            }
            let kind = if id == "mac.screen-recording" {
                "screen"
            } else {
                "input"
            };
            let app = capture_app();
            let asked = run(
                "/usr/bin/open",
                &["-n", "-W", &app, "--args", "--request-permission", kind],
                SETTLE,
            )
            .await;
            if asked.timed_out {
                outcome(
                    AccessOutcomeKind::NeedsUser,
                    "系统设置已打开，等待你在里面允许。",
                )
            } else if asked.ok() {
                outcome(
                    AccessOutcomeKind::NeedsUser,
                    "已发起申请；在系统设置里允许后，再点检查。",
                )
            } else {
                outcome(AccessOutcomeKind::Failed, asked.text.trim())
            }
        }
        _ => outcome(
            AccessOutcomeKind::Skipped,
            "这一项在 macOS 上不能由这里申请。",
        ),
    }
}

// ---- Windows and WSL ---------------------------------------------------------

const POWERSHELL_WSL: &str = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

async fn powershell(platform: Platform, script: &str, limit: Duration) -> Out {
    let program = if platform == Platform::Wsl {
        POWERSHELL_WSL
    } else {
        "powershell.exe"
    };
    run(
        program,
        &["-NoProfile", "-NonInteractive", "-Command", script],
        limit,
    )
    .await
}

fn cli_host_form() -> String {
    let cli = std::env::var("GENEHUB_CLI").unwrap_or_default();
    crate::guest_paths::host_form(&cli).into_owned()
}

async fn windows_items(platform: Platform) -> Vec<AccessItem> {
    let mut items = Vec::new();
    let cli = cli_host_form();
    let dir = Path::new(&cli)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let programs = format!("Get-ChildItem -LiteralPath '{dir}' -File | Where-Object {{ $_.Name -match '^(genet|genehub-host).*\\.exe$' }}");

    // Executable: Authenticode and the download mark (what SmartScreen reads).
    let signature = powershell(platform, &format!("{programs} | ForEach-Object {{ (Get-AuthenticodeSignature $_.FullName).Status.ToString() + '|' + $_.Name }}"), QUICK).await;
    let mut unsigned = Vec::new();
    for line in signature.text.lines() {
        if let Some((status, name)) = line.trim().split_once('|') {
            if status != "Valid" {
                unsigned.push(name.to_string());
            }
        }
    }
    items.push(item(
        "win.signature",
        "identity",
        "程序签名",
        "未签名的新版本会被 SmartScreen 和杀毒软件反复拦截、扫描。",
        if !signature.ok() {
            AccessState::Unknown
        } else if unsigned.is_empty() {
            AccessState::Granted
        } else {
            AccessState::Denied
        },
        if !signature.ok() {
            format!("无法检查：{}", signature.text.trim())
        } else if unsigned.is_empty() {
            "所有程序签名有效。".to_string()
        } else {
            format!(
                "未签名或签名无效：{}。需要使用官方发布的已签名安装包。",
                unsigned.join("、")
            )
        },
        AccessAction::None,
        false,
    ));
    let marked = powershell(platform, &format!("{programs} | Where-Object {{ Get-Content -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue }} | ForEach-Object {{ $_.Name }}"), QUICK).await;
    let marked_names: Vec<&str> = marked
        .text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    items.push(item(
        "win.executable",
        "identity",
        "允许运行",
        "从网上下载的程序带有“来自互联网”标记，首次运行会被系统拦下。",
        if !marked.ok() {
            AccessState::Unknown
        } else if marked_names.is_empty() {
            AccessState::Granted
        } else {
            AccessState::Denied
        },
        if marked_names.is_empty() {
            "没有带下载标记的程序。".to_string()
        } else {
            format!("带标记：{}。", marked_names.join("、"))
        },
        AccessAction::Fix,
        true,
    ));

    // Network: an inbound allow rule for the daemon's host, per program path.
    let host = format!("{dir}\\genehub-host.exe");
    let rule = powershell(platform, &format!(
        "$p=(Get-NetFirewallProfile | Where-Object Enabled -eq True).Count; if ($p -eq 0) {{ 'off' }} else {{ $r = Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True | Get-NetFirewallApplicationFilter | Where-Object {{ $_.Program -like '{dir}\\genehub-host*' }}; if ($r) {{ 'allowed' }} else {{ 'missing' }} }}"
    ), QUICK).await;
    let answer = rule.text.trim().to_string();
    let command = format!("New-NetFirewallRule -DisplayName 'GeneHub' -Direction Inbound -Program '{host}' -Action Allow -Profile Private");
    let mut firewall = item(
        "win.firewall",
        "network",
        "网络：Windows 防火墙",
        "手机和其他设备直连这台电脑需要接受入站连接；只主动连出去不受影响。",
        match answer.as_str() {
            "off" | "allowed" => AccessState::Granted,
            "missing" => AccessState::Denied,
            _ => AccessState::Unknown,
        },
        match answer.as_str() {
            "off" => "防火墙已关闭。".to_string(),
            "allowed" => "已有允许入站的规则。".to_string(),
            "missing" => {
                "防火墙已开启且没有 GeneHub 的入站规则。需要管理员在 PowerShell 中运行下面的命令。"
                    .to_string()
            }
            other => format!("无法检查：{other}"),
        },
        if answer == "missing" {
            AccessAction::Command
        } else {
            AccessAction::None
        },
        false,
    );
    if answer == "missing" {
        firewall.command = Some(command);
    }
    items.push(firewall);

    // Disk: Defender's Controlled Folder Access silently blocks writes.
    let folder = powershell(
        platform,
        "(Get-MpPreference).EnableControlledFolderAccess",
        QUICK,
    )
    .await;
    let value = folder.text.trim().to_string();
    let mut disk = item(
        "win.controlled-folder-access",
        "disk",
        "磁盘：受控文件夹访问",
        "Windows 安全中心开启该功能后，会无提示拦截对文档、桌面等位置的写入。",
        match value.as_str() {
            "0" => AccessState::Granted,
            "1" | "2" => AccessState::Denied,
            _ => AccessState::Unknown,
        },
        match value.as_str() {
            "0" => "未开启，不会拦截写入。".to_string(),
            "1" | "2" => {
                "已开启：对受保护文件夹的写入可能被拦截。把 GeneHub 加入允许列表（需要管理员）。"
                    .to_string()
            }
            _ => "无法读取（可能需要管理员权限）。".to_string(),
        },
        if matches!(value.as_str(), "1" | "2") {
            AccessAction::Command
        } else {
            AccessAction::None
        },
        true,
    );
    if matches!(value.as_str(), "1" | "2") {
        disk.command = Some(format!(
            "Add-MpPreference -ControlledFolderAccessAllowedApplications '{host}'"
        ));
    }
    items.push(disk);
    items
}

async fn wsl_items() -> Vec<AccessItem> {
    let mut items = Vec::new();
    // What really makes a WSL machine drop off: nothing keeps the daemon alive.
    let supervised = run("/bin/sh", &["-c", "systemctl --user list-unit-files 'genehub*.service' --no-legend 2>/dev/null | grep -c enabled"], QUICK).await;
    let count = supervised.text.trim().parse::<u32>().unwrap_or(0);
    items.push(item(
        "wsl.keep-alive",
        "identity",
        "常驻运行",
        "WSL 在没有进程时会被回收；由 systemd 托管 daemon，这台机器才能一直在线。",
        if count > 0 { AccessState::Granted } else { AccessState::Denied },
        if count > 0 { "daemon 已由 systemd 用户服务托管并设为自启。".to_string() } else { "没有找到已启用的 genehub 用户服务；手动启动的 daemon 会在 WSL 回收后离线。重新运行安装脚本（不要设置 GENEHUB_NO_SERVICE）即可注册。".to_string() },
        AccessAction::None,
        true,
    ));
    // Windows side, seen through interop: this is where WSL's network is decided.
    let hyperv = powershell(Platform::Wsl, "Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore | Select-Object -First 1 | ForEach-Object { $_.DefaultInboundAction.ToString() }", QUICK).await;
    let action = hyperv.text.trim().to_string();
    items.push(item(
        "wsl.windows-firewall",
        "network",
        "网络：Windows 对 WSL 的入站策略",
        "只主动连出去不受影响；手机或其他设备直连 WSL 里的服务时，需要 Windows 放行。",
        match action.as_str() { "Allow" => AccessState::Granted, "Block" => AccessState::Denied, _ => AccessState::Unknown },
        match action.as_str() {
            "Allow" => "Windows 允许入站到 WSL。".to_string(),
            "Block" => "Windows 默认阻止入站到 WSL：出站连接正常，局域网直连需要在 Windows 上放行（管理员）。".to_string(),
            _ => "无法读取 Windows 防火墙设置。".to_string(),
        },
        AccessAction::None,
        false,
    ));
    let mnt = run(
        "/bin/sh",
        &["-c", "ls /mnt/c/Users >/dev/null 2>&1 && echo ok"],
        QUICK,
    )
    .await;
    items.push(item(
        "wsl.windows-disk",
        "disk",
        "磁盘：访问 Windows 盘（/mnt/c）",
        "Agent 读写 Windows 一侧的文件需要它。",
        if mnt.text.contains("ok") {
            AccessState::Granted
        } else {
            AccessState::Denied
        },
        if mnt.text.contains("ok") {
            "可以访问。".to_string()
        } else {
            "/mnt/c 不可访问；检查 /etc/wsl.conf 的 automount 设置。".to_string()
        },
        AccessAction::None,
        false,
    ));
    items
}

async fn windows_request(platform: Platform, id: &str) -> AccessOutcome {
    let outcome = |kind, message: &str| AccessOutcome {
        id: id.into(),
        kind,
        message: message.into(),
    };
    if id == "win.executable" {
        let cli = cli_host_form();
        let dir = Path::new(&cli)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let script = format!("Get-ChildItem -LiteralPath '{dir}' -File | Where-Object {{ $_.Name -match '^(genet|genehub-host).*\\.exe$' }} | Unblock-File");
        let done = powershell(platform, &script, QUICK).await;
        return if done.ok() {
            outcome(AccessOutcomeKind::Done, "已清除下载标记。")
        } else {
            outcome(AccessOutcomeKind::Failed, done.text.trim())
        };
    }
    outcome(
        AccessOutcomeKind::Skipped,
        "这一项需要管理员在本机执行页面上给出的命令。",
    )
}

// ---- entry points -----------------------------------------------------------

pub async fn report(state: &Shared) -> AccessReport {
    let platform = platform().await;
    let locked = if platform == Platform::Mac {
        Some(mac_locked().await)
    } else {
        None
    };
    let items = match platform {
        Platform::Mac => mac_items(state).await,
        Platform::Windows => windows_items(platform).await,
        Platform::Wsl => wsl_items().await,
        Platform::Linux => Vec::new(),
    };
    AccessReport {
        platform: platform.name().into(),
        locked,
        items,
        checked_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

/// Ask for `ids` (every recommended item that is not yet fine when absent),
/// one at a time and in a fixed order, then read the state back.
pub async fn request(state: &Shared, ids: Option<Vec<String>>) -> AccessSetupResult {
    let platform = platform().await;
    let before = report(state).await;
    let wanted: Vec<String> = match ids {
        Some(ids) => ids,
        None => before
            .items
            .iter()
            .filter(|item| {
                item.recommended
                    && !matches!(
                        item.state,
                        AccessState::Granted | AccessState::NotApplicable
                    )
            })
            .map(|item| item.id.clone())
            .collect(),
    };
    let locked = before.locked.unwrap_or(false);
    let mut outcomes = Vec::new();
    for id in wanted {
        let current = before.items.iter().find(|item| item.id == id);
        let outcome = match current {
            None => AccessOutcome {
                id: id.clone(),
                kind: AccessOutcomeKind::Skipped,
                message: "这台机器上没有这一项。".into(),
            },
            Some(item) if item.state == AccessState::Granted && item.id != "mac.code-identity" => {
                AccessOutcome {
                    id: id.clone(),
                    kind: AccessOutcomeKind::Done,
                    message: "已经允许，无需再申请。".into(),
                }
            }
            Some(item) if item.action == AccessAction::Command => AccessOutcome {
                id: id.clone(),
                kind: AccessOutcomeKind::NeedsUser,
                message: "需要管理员运行页面上给出的命令。".into(),
            },
            Some(_) => match platform {
                Platform::Mac => mac_request(state, &id, locked).await,
                Platform::Windows | Platform::Wsl => windows_request(platform, &id).await,
                Platform::Linux => AccessOutcome {
                    id: id.clone(),
                    kind: AccessOutcomeKind::Skipped,
                    message: "这个系统没有需要配置的项目。".into(),
                },
            },
        };
        outcomes.push(outcome);
    }
    // Read it back: "asked" must never be shown as "granted".
    let report = report(state).await;
    for outcome in &mut outcomes {
        if outcome.kind == AccessOutcomeKind::Done {
            let still_missing = report.items.iter().any(|item| {
                item.id == outcome.id
                    && matches!(item.state, AccessState::Denied | AccessState::NeedsRecheck)
            });
            if still_missing {
                outcome.kind = AccessOutcomeKind::NeedsUser;
            }
        }
    }
    AccessSetupResult { outcomes, report }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_signing_helper_is_embedded() {
        assert!(IDENTITY_SCRIPT.contains("designated"));
        assert!(IDENTITY_SCRIPT.contains("sign-"));
    }

    #[test]
    fn a_stable_requirement_does_not_depend_on_the_binary_hash() {
        // The helper refuses to call a requirement stable if it names a cdhash.
        assert!(IDENTITY_SCRIPT.contains("\"cdhash\" not in info[\"requirement\"]"));
    }

    #[test]
    fn identifiers_are_derived_from_the_installed_name() {
        // Mirrors macos_identity.identifier_for: no content hash in the name.
        assert!(IDENTITY_SCRIPT.contains("def identifier_for(name)"));
    }
}
