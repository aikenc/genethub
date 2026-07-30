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
        "open_window",
        "pick_directory",
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
