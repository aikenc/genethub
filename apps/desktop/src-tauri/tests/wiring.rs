//! What the window needs from the shell before either of them runs.
//!
//! The workbench and this shell are built separately and only meet in a packaged
//! app, so the things they agree about are agreed nowhere — no compiler sees both
//! sides. That is how the app shipped deciding it was a browser: the frontend
//! looks for `window.__TAURI__`, Tauri 2 only injects it when asked, and nothing
//! anywhere said so. These read the two files and check they still say the same
//! thing.

use std::path::{Path, PathBuf};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn config() -> serde_json::Value {
    let raw = std::fs::read_to_string(repo().join("apps/desktop/src-tauri/tauri.conf.json"))
        .expect("read tauri.conf.json");
    serde_json::from_str(&raw).expect("parse tauri.conf.json")
}

/// Without this the packaged app takes the browser path, looks for an address in
/// the URL of a page that has no URL, and tells the user there is no machine to
/// connect to — on a machine whose daemon is running perfectly.
#[test]
fn the_frontend_can_tell_it_is_not_in_a_browser() {
    let config = config();
    assert_eq!(
        config["app"]["withGlobalTauri"],
        serde_json::json!(true),
        "packages/web/src/host/index.ts decides which shell it is in by the \
         presence of window.__TAURI__, and Tauri only injects that when \
         withGlobalTauri is on"
    );

    let host = std::fs::read_to_string(repo().join("packages/web/src/host/index.ts"))
        .expect("read the host layer");
    assert!(
        host.contains("window.__TAURI__"),
        "the frontend no longer keys off window.__TAURI__, so this test is \
         pinning the wrong thing — check what it detects now"
    );
}

/// Each of these is invoked by name from the frontend, where a typo is a runtime
/// error in a window with no console.
#[test]
fn every_command_the_workbench_calls_exists_here() {
    let shell = std::fs::read_to_string(repo().join("apps/desktop/src-tauri/src/lib.rs"))
        .expect("read the shell");
    let host = std::fs::read_to_string(repo().join("packages/web/src/host/index.ts"))
        .expect("read the host layer");

    let registered: Vec<&str> = shell
        .split_once("generate_handler![")
        .expect("the shell registers commands")
        .1
        .split_once(']')
        .expect("an unterminated generate_handler!")
        .0
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();

    for command in [
        "daemon_endpoint",
        "daemon_problem",
        "restart_daemon",
        "notify",
        "open_external",
        "install_update",
        "open_window",
        "open_logs",
        "pick_directory",
        "app_version",
        "window_minimize",
        "window_toggle_maximize",
        "window_is_maximized",
        "window_close",
        "set_window_background",
    ] {
        assert!(
            host.contains(&format!("\"{command}\"")),
            "{command} is registered but nothing calls it — either the frontend \
             lost a feature or this list is stale"
        );
        assert!(
            shell.contains(&format!("fn {command}(")),
            "the frontend calls {command} and this shell has no such command"
        );
        assert!(
            registered.contains(&command),
            "{command} exists but is not in generate_handler! ({registered:?}), \
             so calling it fails at runtime"
        );
    }
}

/// Turning the decorations off takes away the only way the OS gives anyone to
/// move, maximise or close the window — so the page has to put all three back,
/// and the shell has to permit the drag. Any one of the three missing is a
/// window that cannot be got rid of, which is worse than the white title bar
/// this arrangement exists to remove.
#[test]
fn a_window_with_no_decorations_draws_its_own_title_bar() {
    let config = config();
    let window = &config["app"]["windows"][0];
    assert_eq!(
        window["decorations"],
        serde_json::json!(false),
        "the window uses the system title bar again, which takes its colour \
         from the OS and not from the workbench — if that is deliberate, \
         packages/web/src/shell/TitleBar.tsx is now a second one"
    );
    assert!(
        window["backgroundColor"].is_string(),
        "with no decorations the window's own colour is what shows before the \
         page paints and along the edge while it is being resized"
    );

    let bar = read(repo().join("packages/web/src/shell/TitleBar.tsx"));
    assert!(
        bar.contains("data-tauri-drag-region"),
        "nothing in the title bar is draggable, so the window cannot be moved"
    );

    let capabilities = read(repo().join("apps/desktop/src-tauri/capabilities/default.json"));
    assert!(
        capabilities.contains("core:window:allow-start-dragging"),
        "the drag region is drawn but the shell refuses the drag it asks for"
    );
}

/// An upgrade replaces files the running daemon is holding open, and Windows
/// refuses. The installer has to stop what we ship before it writes.
#[test]
fn the_windows_installer_stops_the_daemon_before_replacing_it() {
    let script = installer_hook();

    assert!(
        script.contains("NSIS_HOOK_PREINSTALL"),
        "the hook runs nowhere before the install"
    );
    // Every executable staged into the bundle is a file the installer will
    // overwrite, so every one of them has to be stopped first.
    for binary in ["genet-daemon.exe", "genet-agent.exe"] {
        assert!(
            script.contains(binary),
            "{binary} ships in the bundle but the installer never stops it"
        );
    }
}

/// The shell restarts the daemon about a second after it dies, on purpose: that
/// is what keeps a machine reachable. It also means an installer that stops the
/// daemon and not its supervisor gets a brand-new daemon holding the file it is
/// about to write — the same failure, one second later, which is exactly what
/// happened when this hook was first written.
#[test]
fn the_installer_stops_the_supervisor_before_the_thing_it_supervises() {
    let script = installer_hook();
    let exe = format!("/IM {}.exe", installed_exe());
    // The kill lines, not any mention of the names: the comment above them
    // explains this in prose and would otherwise decide the ordering.
    let app = script
        .find(&exe)
        .expect("the app itself is never stopped, so it will revive the daemon");
    let daemon = script
        .find("/IM genet-daemon.exe")
        .expect("the daemon is never stopped");
    assert!(
        app < daemon,
        "the daemon is stopped before its supervisor, which will simply start another one"
    );

    // And the wait afterwards asks the file rather than guessing a duration: how
    // long a handle takes to close, a scanner to let go, or a respawn to finish
    // are not knowable from here.
    assert!(
        script.contains("FileOpen"),
        "the hook sleeps for a guessed interval instead of checking that the file \
         it is about to write is free"
    );

    let supervisor = std::fs::read_to_string(repo().join("apps/desktop/src-tauri/src/daemon.rs"))
        .expect("read the supervisor");
    assert!(
        supervisor.contains("fn watch"),
        "nothing supervises the daemon any more, so this test's premise is stale"
    );
}

/// The name the installed executable actually has.
///
/// Not the product name. `productName` is what the Start menu and the installer
/// title show; the process is named after the Cargo binary unless
/// `mainBinaryName` overrides it. v0.1.7 shipped a hook that killed
/// `GeneHub.exe`, which exists on no machine, and the upgrade failed with the
/// same "Error opening file for writing" it was written to prevent — while a
/// test asserting the product name passed.
fn installed_exe() -> String {
    if let Some(name) = config()["mainBinaryName"].as_str() {
        return name.to_string();
    }
    let cargo = std::fs::read_to_string(repo().join("apps/desktop/src-tauri/Cargo.toml"))
        .expect("read Cargo.toml");
    let package = cargo.find("[package]").expect("no [package] section");
    cargo[package..]
        .lines()
        .find_map(|line| line.strip_prefix("name = "))
        .expect("the package has no name")
        .trim()
        .trim_matches('"')
        .to_string()
}

fn installer_hook() -> String {
    let config = config();
    let hook = config["bundle"]["windows"]["nsis"]["installerHooks"]
        .as_str()
        .expect("no installer hooks: an upgrade will fail on a running daemon");
    std::fs::read_to_string(repo().join("apps/desktop/src-tauri").join(hook))
        .expect("the hook file named in the config is missing")
}

/// The binaries the installer promises are inside it. Named in one place here
/// and in `scripts/bundle.sh`, which is where they are staged.
#[test]
fn the_bundle_carries_the_daemon_and_the_agent() {
    let config = config();
    assert_eq!(
        config["bundle"]["resources"]["bin/"],
        serde_json::json!("bin/"),
        "the daemon and agent are staged into src-tauri/bin by \
         scripts/bundle.sh; without this they are not in the installer"
    );

    // Windows needs an .ico: Tauri embeds it in the executable and the installer,
    // and a list of PNGs alone fails the build there — on the one platform this
    // repository cannot build locally.
    let icons = config["bundle"]["icon"]
        .as_array()
        .expect("bundle.icon is a list")
        .iter()
        .filter_map(|entry| entry.as_str())
        .collect::<Vec<_>>();
    assert!(
        icons.iter().any(|icon| icon.ends_with(".ico")),
        "no .ico among {icons:?}"
    );
    for icon in icons {
        assert!(
            repo().join("apps/desktop/src-tauri").join(icon).is_file(),
            "{icon} is listed but missing"
        );
    }
}


/// The product's version is the git tag, and nothing in the tree may claim to be
/// a release.
///
/// Three files have to carry a literal — Cargo needs one, the installer needs one
/// — and all three are written by `scripts/version.sh` from the tag as the release
/// is built. In the tree they stay at 0.0.0, "never released", because the version
/// a human maintains is the version that goes wrong: these sat at 0.1.0 through
/// seventeen tagged releases while every installed copy reported 0.1.0 to its own
/// workbench.
///
/// Checked here rather than only in the workflow: a number edited back in by hand
/// should fail on the machine it was typed on, not one release later.
#[test]
fn nothing_in_the_tree_claims_to_be_a_release() {
    const UNRELEASED: &str = "0.0.0";
    let stamper = repo().join("scripts/version.sh");
    let script = std::fs::read_to_string(&stamper).expect("read the stamping script");

    let carriers = [
        ("Cargo.toml", declared_version(&read(repo().join("Cargo.toml")))),
        (
            "apps/desktop/src-tauri/Cargo.toml",
            declared_version(&read(repo().join("apps/desktop/src-tauri/Cargo.toml"))),
        ),
        (
            "apps/desktop/src-tauri/tauri.conf.json",
            config()["version"].as_str().unwrap_or_default().to_string(),
        ),
    ];

    for (path, version) in carriers {
        assert_eq!(
            version, UNRELEASED,
            "{path} says {version}, which is a claim about a release that this \
             checkout cannot make — the tag is the version (scripts/version.sh)"
        );
        assert!(
            script.contains(path),
            "{path} carries a version and the stamping script does not mention it, \
             so a release would ship whatever is written there"
        );
    }
}

fn read(path: PathBuf) -> String {
    std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("read {}", path.display()))
}

/// The `version` of the first block in a manifest.
fn declared_version(manifest: &str) -> String {
    manifest
        .lines()
        // Stops at the dependency tables so that a dependency's version, which is
        // written inline rather than on its own line, cannot answer either way.
        .take_while(|line| !line.contains("dependencies]"))
        .find_map(|line| line.strip_prefix("version = "))
        .map(|value| value.trim().trim_matches('"').to_string())
        .expect("a manifest with no version in it")
}

/// The tray asks and the workbench answers, which works only while both halves
/// spell the event the same way — and nothing checks that at build time, because
/// one side is Rust and the other is TypeScript.
///
/// Worth pinning for this item in particular: a menu item whose event nobody
/// listens for is a click that does nothing, and "nothing happened" is exactly
/// what "已经是最新的了" looks like from the outside.
#[test]
fn the_tray_can_ask_for_an_update_check_and_the_workbench_is_listening() {
    let tray = std::fs::read_to_string(repo().join("apps/desktop/src-tauri/src/tray.rs"))
        .expect("read the tray");
    let host = std::fs::read_to_string(repo().join("packages/web/src/host/index.ts"))
        .expect("read the host layer");

    assert!(
        tray.contains("检查更新"),
        "the tray has no way to ask whether there is a newer build"
    );
    assert!(
        tray.contains("genehub://update"),
        "the menu item does not emit anything, so pressing it does nothing"
    );
    assert!(
        host.contains("genehub://update"),
        "the tray emits genehub://update and the workbench listens for something \
         else, which is a menu item that silently does nothing"
    );
}

/// The logs are what someone attaches to a report, and the tray is where they look
/// when the window has nothing useful to show. Both halves write into one
/// directory so that opening it shows the whole story rather than one side of it.
#[test]
fn the_logs_are_one_directory_the_tray_can_open() {
    let shell = std::fs::read_to_string(repo().join("apps/desktop/src-tauri/src/lib.rs"))
        .expect("read the shell");
    let tray = std::fs::read_to_string(repo().join("apps/desktop/src-tauri/src/tray.rs"))
        .expect("read the tray");
    let supervisor = std::fs::read_to_string(repo().join("apps/desktop/src-tauri/src/daemon.rs"))
        .expect("read the supervisor");

    assert!(
        tray.contains("打开日志目录"),
        "the tray has no way to the logs"
    );
    assert!(
        shell.contains(r#"join("logs").join("shell.log")"#),
        "the shell writes its log outside the directory the tray opens"
    );
    assert!(
        supervisor.contains("startup.log"),
        "the daemon's stderr and its own log file would land on the same path, \
         and the shell truncates on every start"
    );
}
