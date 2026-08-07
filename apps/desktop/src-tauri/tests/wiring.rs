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
        "pick_workspace_file",
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

/// The page reaches opener/dialog/notification only through the narrow Rust
/// commands above. Granting each plugin's default frontend capability as well
/// would let a compromised renderer bypass URL validation and invoke arbitrary
/// operating-system protocol handlers directly.
#[test]
fn privileged_plugins_are_not_exposed_directly_to_the_renderer() {
    let raw =
        std::fs::read_to_string(repo().join("apps/desktop/src-tauri/capabilities/default.json"))
            .expect("read desktop capabilities");
    let capability: serde_json::Value =
        serde_json::from_str(&raw).expect("parse desktop capabilities");
    let permissions = capability["permissions"]
        .as_array()
        .expect("desktop permissions are an array");

    for forbidden in ["opener:default", "dialog:default", "notification:default"] {
        assert!(
            !permissions.iter().any(|value| value == forbidden),
            "{forbidden} lets renderer JavaScript bypass the shell's validated command"
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
    // overwrite, so every one of them has to be stopped first. The names come
    // from the defines, not literals: the two channels install side by side,
    // and scripts/channel.mjs rewrites the defines for a release build.
    //
    // The daemon is the exception, and the exception is the point: it is the
    // same `genet` binary every CLI client runs, so it is stopped by the pid
    // in its lock file — an image-name kill would take a running
    // `genet session send --wait` down with it (`genethub-cli.md` §2).
    let agent = nsis_define(&script, "GH_AGENT_EXE");
    assert!(
        script.contains("/T /IM ${GH_AGENT_EXE}"),
        "genet-agent ({agent}) ships in the bundle but the installer never stops it"
    );
    assert!(
        script.contains("/F /T /PID"),
        "the daemon is not stopped by its lock-file pid any more"
    );
    assert!(
        script.contains("daemon.lock"),
        "the installer does not read the daemon's lock file to find its pid"
    );
    assert!(
        !script.contains("/IM ${GH_CLI_EXE}"),
        "the daemon is killed by image name again — that takes CLI clients down with it"
    );

    // The lock lives in the daemon's own data directory, so the define has to
    // name the same directory the daemon's channel constants do — a drift here
    // is the installer reading the other channel's lock, or nobody's.
    let daemon_channel = read(repo().join("apps/daemon/src/channel.rs"));
    let data_dir = daemon_channel
        .lines()
        .find_map(|line| line.strip_prefix("pub const DATA_DIR_NAME: &str = "))
        .expect("the daemon's channel has no DATA_DIR_NAME")
        .trim()
        .trim_matches(|c| c == '"' || c == ';');
    assert_eq!(
        nsis_define(&script, "GH_DATA_DIR_NAME"),
        data_dir,
        "the installer looks for daemon.lock somewhere the daemon does not write it"
    );
}

/// The shell restarts the daemon about a second after it dies, on purpose: that
/// is what keeps a machine reachable. It also means an installer that stops the
/// daemon and not its supervisor gets a brand-new daemon holding the file it is
/// about to write — the same failure, one second later, which is exactly what
/// happened when this hook was first written.
#[test]
fn the_installer_stops_the_supervisor_before_the_thing_it_supervises() {
    let script = installer_hook();
    // The define has to name the executable the build actually ships: a define
    // that drifted from mainBinaryName kills a process no machine has, which
    // is the v0.1.7 bug wearing a new hat.
    assert_eq!(
        nsis_define(&script, "GH_DESKTOP_EXE"),
        format!("{}.exe", installed_exe()),
        "the installer's name for the app is not the executable the build ships"
    );

    // The kill lines, not any mention of the names: the comment above them
    // explains this in prose and would otherwise decide the ordering. The
    // daemon's stop is the lock-file pid kill — it is the same binary as every
    // CLI client, so there is no image name to look for (`genethub-cli.md` §2).
    let app = script
        .find("/IM ${GH_DESKTOP_EXE}")
        .expect("the app itself is never stopped, so it will revive the daemon");
    let daemon = script
        .find("/F /T /PID")
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

/// A path received from the workbench or Relay must never become a child
/// process before releases have an independent signing root.
#[test]
fn automatic_update_commands_fail_closed_without_network_or_execution() {
    let shell = read(repo().join("apps/desktop/src-tauri/src/lib.rs"));
    assert!(shell.contains("fn install_update(_app"));
    assert!(shell.contains("Err(AUTOMATIC_UPDATE_DISABLED.to_string())"));
    assert!(!shell.contains("std::process::Command::new(file)"));
    assert!(!shell.contains("fetch_app_manifest"));
    assert!(shell.contains("download_url: None"));
}

/// The failure this whole arrangement is shaped around.
///
/// A manually launched installer still stops the app before replacing files.
/// Keeping the app kill non-recursive avoids terminating unrelated child tools
/// that may have been launched from the workbench.
#[test]
fn the_hook_does_not_kill_the_installer_that_is_running_it() {
    let script = installer_hook();
    let exe = "/IM ${GH_DESKTOP_EXE}";
    let line = script
        .lines()
        .find(|line| line.contains(exe))
        .expect("the app itself is never stopped, so it will revive the daemon");
    assert!(
        !line.contains("/T"),
        "the hook kills the app's whole process tree ({line}), which includes \
         the installer the user started from inside the app"
    );
    // The daemon still goes down with everything it spawned: an agent holds its
    // own executable open exactly the way the daemon does. The tree kill hangs
    // on the lock-file pid rather than an image name, because the daemon's
    // image name belongs to every CLI client too (`genethub-cli.md` §2).
    assert!(
        script.contains("/F /T /PID"),
        "the daemon is stopped without its children, so an agent it started \
         will still be holding a file the installer wants to write"
    );
}

/// The name the installed executable actually has.
///
/// Not the product name. `productName` is the install-directory / Start-menu
/// folder name (path-safe, no spaces); the window title carries the display
/// brand separately. The process is named after the Cargo binary unless
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

/// The value of a `!define NAME "value"` line in an NSIS script.
///
/// The hook names its processes through defines so `scripts/channel.mjs` can
/// stamp the beta names in; the tests resolve them rather than pinning the
/// literal, because the literal is exactly what a channel build changes.
fn nsis_define(script: &str, name: &str) -> String {
    script
        .lines()
        .find_map(|line| line.trim().strip_prefix(&format!("!define {name} ")))
        .unwrap_or_else(|| panic!("the hook has no !define {name}"))
        .trim()
        .trim_matches('"')
        .to_string()
}

/// The binaries the installer promises are inside it. Named in one place here
/// and in `apps/desktop/scripts/bundle.mjs`, which is where they are staged.
#[test]
fn the_bundle_carries_the_daemon_and_the_agent() {
    let config = config();
    assert_eq!(
        config["bundle"]["resources"]["bin/"],
        serde_json::json!("bin/"),
        "the daemon and agent are staged into src-tauri/bin by \
         apps/desktop/scripts/bundle.mjs; without this they are not in the installer"
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

#[test]
fn desktop_bundling_is_explicitly_limited_to_windows_and_macos() {
    let config = config();
    assert_eq!(
        config["bundle"]["targets"],
        serde_json::json!(["nsis", "dmg"]),
        "Linux ships daemon/CLI binaries, not a Tauri desktop package"
    );

    let script = read(repo().join("apps/desktop/scripts/bundle.mjs"));
    assert!(script.contains(r#"{ win32: "nsis", darwin: "dmg" }"#));
    assert!(
        script.contains("if (!platformBundle)")
            && script.contains("support only Windows and macOS"),
        "the bundle entry point must fail before building on unsupported hosts"
    );
    let executable = script
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
        .to_ascii_lowercase();
    for removed in ["dpkg-deb", "appimage", r#"linux: "deb""#] {
        assert!(
            !executable.contains(removed),
            "unsupported Linux desktop packaging leaked back in through {removed}"
        );
    }
}

/// The product's version is the git tag, and nothing in the tree may claim to be
/// a release.
///
/// Three files have to carry a literal — Cargo needs one, the installer needs one
/// — and all three are written by `scripts/version.mjs` from the tag as the release
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
    let stamper = repo().join("scripts/version.mjs");
    let script = std::fs::read_to_string(&stamper).expect("read the stamping script");

    let carriers = [
        (
            "Cargo.toml",
            declared_version(&read(repo().join("Cargo.toml"))),
        ),
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
             checkout cannot make — the tag is the version (scripts/version.mjs)"
        );
        assert!(
            script.contains(path),
            "{path} carries a version and the stamping script does not mention it, \
             so a release would ship whatever is written there"
        );
    }
}

/// The product's channel works the way its version does: the tree says `dev`,
/// and a release is the workflow stamping its channel in
/// (`scripts/channel.mjs`, modelled on `scripts/version.mjs`).
///
/// Checked here for the same reason as the version: a tree accidentally
/// committed half-stamped for a release channel is a release that renames
/// itself, kills the wrong processes and reads the wrong data directory. And
/// the official column of the table is frozen — those names are what
/// installed copies already answer to, so renaming one orphans every override
/// a user has set.
#[test]
fn the_tree_claims_to_be_dev_and_only_the_stamper_says_otherwise() {
    let stamper = read(repo().join("scripts/channel.mjs"));

    // Every generated module says dev, and the stamping script is what writes
    // each of them — a constants file nothing regenerates is one a release
    // build compiles straight past.
    let modules = [
        (
            "apps/daemon/src/channel.rs",
            "pub const CHANNEL: &str = \"dev\";",
        ),
        (
            "apps/agent/src/channel.rs",
            "pub const CHANNEL: &str = \"dev\";",
        ),
        (
            "apps/desktop/src-tauri/src/channel.rs",
            "pub const CHANNEL: &str = \"dev\";",
        ),
        (
            "packages/web/src/channel.ts",
            "export const CHANNEL: \"dev\" | \"official\" | \"beta\" | \"alpha\" = \"dev\";",
        ),
    ];
    for (path, marker) in modules {
        let body = read(repo().join(path));
        assert!(
            body.contains(marker),
            "{path} is not stamped dev — the tree ships the dev channel; \
             a release build stamps its own channel in CI (scripts/channel.mjs)"
        );
        assert!(
            stamper.contains(path),
            "{path} carries the channel and the stamping script does not write \
             it, so a release build would ship it saying whatever it says now"
        );
    }

    let config = config();
    // productName is the install-directory / application-bundle name, not the display
    // brand — those carry a space on beta/alpha/dev and would break unquoted
    // shells. It must match DATA_DIR_NAME and never contain whitespace.
    let data_dir = read(repo().join("apps/desktop/src-tauri/src/channel.rs"))
        .lines()
        .find_map(|line| line.strip_prefix("pub const DATA_DIR_NAME: &str = "))
        .expect("desktop channel has no DATA_DIR_NAME")
        .trim()
        .trim_matches(|c| c == '"' || c == ';')
        .to_string();
    assert_eq!(config["productName"], data_dir);
    assert_eq!(config["productName"], "GeneHub-dev");
    assert!(
        !config["productName"]
            .as_str()
            .expect("productName is a string")
            .contains(char::is_whitespace),
        "productName must be path-safe; a space lands the installer under a \
         directory that breaks unquoted shells"
    );
    assert_eq!(config["app"]["windows"][0]["title"], "GeneHub Dev");
    assert_eq!(config["identifier"], "com.genethub.desktop.dev");
    assert_eq!(config["mainBinaryName"], "genethub-desktop-dev");

    let installer = read(repo().join("scripts/install.sh"));
    assert!(
        installer.contains("# channel: dev") && installer.contains("channel=dev"),
        "install.sh is not stamped dev — the tree's installer must refuse to \
         run rather than quietly install a released line"
    );

    // The frozen column. These are the names already installed copies answer
    // to; the other columns may grow, this one may not move.
    let row = |key: &str| {
        // Line-anchored, or `hub_url` would match inside `env_hub_url` and the
        // row would come back as the environment-variable table — a test that
        // silently reads the wrong row is a test that passes by accident.
        let start = stamper
            .find(&format!("\n  {key}: {{"))
            .unwrap_or_else(|| panic!("scripts/channel.mjs has no {key} row"));
        let end = stamper[start..]
            .find('}')
            .map(|i| start + i)
            .expect("an unterminated row in the table");
        &stamper[start..end]
    };
    for (key, name) in [
        ("env_data_dir", "GENEHUB_DATA_DIR"),
        ("env_workspace_dir", "GENEHUB_WORKSPACE_DIR"),
        ("env_log", "GENEHUB_LOG"),
        ("env_machine_name", "GENEHUB_MACHINE_NAME"),
        ("env_agent_command", "GENET_AGENT_COMMAND"),
        ("env_agent_home", "GENET_AGENT_HOME"),
        ("env_download_base", "GENEHUB_DOWNLOAD_BASE"),
        ("env_bin_dir", "GENEHUB_BIN_DIR"),
        ("env_hub_url", "GENEHUB_HUB_URL"),
        ("identifier", "com.genethub.desktop"),
        ("cli_binary", "genet"),
        ("agent_binary", "genet-agent"),
        ("desktop_binary", "genethub-desktop"),
    ] {
        assert!(
            row(key).contains(&format!("official: \"{name}\"")),
            "the official column of scripts/channel.mjs moved: {key} no longer \
             stamps {name:?} — that is what installed copies already answer to, \
             and renaming it silently orphans every override a user has set"
        );
    }

    // The marked columns keep their marks: a channel whose binaries do not
    // carry its suffix is one whose installer kills another line's processes.
    for (key, dev, beta, alpha) in [
        ("cli_binary", "genet-dev", "genet-beta", "genet-alpha"),
        (
            "agent_binary",
            "genet-agent-dev",
            "genet-agent-beta",
            "genet-agent-alpha",
        ),
        (
            "desktop_binary",
            "genethub-desktop-dev",
            "genethub-desktop-beta",
            "genethub-desktop-alpha",
        ),
    ] {
        let row = row(key);
        for (channel, name) in [("dev", dev), ("beta", beta), ("alpha", alpha)] {
            assert!(
                row.contains(&format!("{channel}: \"{name}\"")),
                "the {channel} column of {key} lost its mark ({name})"
            );
        }
    }

    // dev updates from nowhere and points at no Hub: a source build is not on
    // the release scale, and pretending otherwise is how a dev daemon reads a
    // release's data or announces a downgrade as an upgrade.
    assert!(
        row("manifest_url").contains("dev: \"\""),
        "the dev column gained an update manifest — a source build must not \
         measure itself against any release"
    );
    assert!(
        row("hub_url").contains("dev: \"\""),
        "the dev column gained a default Hub — a source build points nowhere \
         unless told"
    );

    // Remote workbench dials the Hub's WSS itself. A released package whose
    // CSP lists only loopback signs tickets that can never be redeemed — the
    // WebView blocks the upgrade before the relay sees it. Dev stays
    // loopback-only; every shipping column must open https/wss.
    let connect_src = row("connect_src");
    assert!(
        connect_src.contains("dev: \"'self' ws://127.0.0.1:*"),
        "the dev column of connect_src must stay loopback-only"
    );
    for channel in ["official", "beta", "alpha"] {
        assert!(
            connect_src.contains(&format!("{channel}:")) && connect_src.contains("https: wss:"),
            "the {channel} column of connect_src must allow https/wss — \
             without them the desktop cannot open a remote workbench"
        );
    }
    let csp = config["app"]["security"]["csp"]
        .as_str()
        .expect("tauri.conf.json has no CSP");
    assert!(
        csp.contains("ws://127.0.0.1:*") && !csp.contains("https: wss:"),
        "the tree's CSP must be the dev (loopback-only) column — a release \
         stamps https/wss in via scripts/channel.mjs"
    );
    assert!(
        stamper.contains("\"csp\":"),
        "scripts/channel.mjs no longer stamps the CSP line, so a release \
         would ship a WebView that cannot reach the Hub"
    );

    // And the daemon the shell spawns has to hear the same override name the
    // daemon listens for, on every channel — a mismatch is the shell and the
    // daemon disagreeing about where the data lives.
    let shell = read(repo().join("apps/desktop/src-tauri/src/daemon.rs"));
    assert!(
        shell.contains("crate::channel::ENV_DATA_DIR"),
        "the shell names the data-dir override itself again instead of reading \
         the channel constants"
    );
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
