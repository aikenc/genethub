//! Contracts for the minimal Desktop shell.
//!
//! Native code supervises and enrolls the daemon, then displays the fixed
//! channel website as an ordinary browser. These tests pin the boundary because
//! Rust, Tauri configuration and the separately deployed Web have no shared type
//! checker.

use std::path::{Path, PathBuf};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn config() -> serde_json::Value {
    let raw = std::fs::read_to_string(repo().join("apps/desktop/src-tauri/tauri.conf.json"))
        .expect("read tauri.conf.json");
    serde_json::from_str(&raw).expect("parse tauri.conf.json")
}

/// The stable page is untrusted in exactly the same way as a page in Chrome:
/// it receives neither a Tauri global nor a command/capability surface.
#[test]
fn remote_product_web_has_no_native_bridge() {
    let config = config();
    assert_eq!(config["app"]["withGlobalTauri"], serde_json::json!(false));

    let host = read(repo().join("packages/workbench/src/host/index.ts"));
    assert!(host.contains("always an ordinary browser"));
    assert!(!host.contains("desktop ? desktopHost()"));

    let shell = read(repo().join("apps/desktop/src-tauri/src/lib.rs"));
    assert!(!shell.contains("generate_handler!"));
    assert!(!shell.contains("#[tauri::command]"));

    let title_bar = read(repo().join("packages/workbench/src/shell/TitleBar.tsx"));
    assert!(title_bar.contains("if (!controls) return null"));
}

/// Product Web is not an installer asset. The only bundled page explains native
/// startup failures before the shell applies a signed-Wasm navigation directive.
#[test]
fn the_bundle_contains_only_a_boot_surface_then_applies_the_wasm_route() {
    let config = config();
    assert_eq!(
        config["build"]["frontendDist"],
        serde_json::json!("../boot")
    );
    assert!(config["build"].get("beforeBuildCommand").is_none());
    // `beforeDevCommand` may start the Web dev server for `tauri dev`; it is
    // not an installer input. Only frontendDist and bundle resources decide
    // what ships in the App.
    assert!(!config["bundle"]["resources"]
        .to_string()
        .contains("packages/workbench"));

    let boot = read(repo().join("apps/desktop/boot/index.html"));
    assert!(boot.contains("GeneHub 正在启动"));
    assert!(!boot.contains("<script"));

    let shell = read(repo().join("apps/desktop/src-tauri/src/lib.rs"));
    assert!(shell.contains("command.args([\"desktop\", \"route\"]);"));
    assert!(!shell.contains("channel::WEB_APP_URL"));
    assert!(!shell.contains("HubStatus"));
    assert!(shell.contains("window.navigate(url)"));
    assert!(shell.contains("ensure_web_reachable(&target)?"));
}

#[test]
fn windows_runs_a_real_webview2_offline_and_remote_origin_gate() {
    let e2e = read(repo().join("apps/desktop/scripts/windows-webview-e2e.mjs"));
    assert!(e2e.contains("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"));
    assert!(e2e.contains("Runtime.evaluate"));
    assert!(e2e.contains("http://127.0.0.1:5173/app"));
    assert!(e2e.contains("globalThis.__TAURI__"));

    let release = read(repo().join(".github/workflows/release.yml"));
    assert!(release.contains("node apps/desktop/scripts/windows-webview-e2e.mjs"));
    assert!(release.contains("Real WebView2 keeps the offline boot page"));
}

#[test]
fn every_release_package_embeds_one_signed_component_and_pins_its_baseline() {
    let release = read(repo().join(".github/workflows/release.yml"));
    assert!(release.contains("signed_component:"));
    assert!(release.contains("name: guest-wasm-release"));
    assert!(release.contains("GENEHUB_COMPONENT_PUBLIC_KEY"));
    assert!(release.contains("GENEHUB_BUNDLED_RELEASE_VERSION"));
    assert!(release.contains("publish-prepared-component.mjs"));
    assert!(release
        .contains("cmp \"$GENEHUB_COMPONENT_WASM\" apps/desktop/src-tauri/bin/genehub_guest.wasm"));

    let bundle = read(repo().join("apps/desktop/scripts/bundle.mjs"));
    assert!(bundle.contains("process.env.GENEHUB_COMPONENT_WASM"));
    assert!(bundle.contains("preparedGuest ??"));
}

#[test]
fn machine_claim_is_an_explicit_tray_recovery_not_an_every_start_side_effect() {
    let shell = read(repo().join("apps/desktop/src-tauri/src/lib.rs"));
    let tray = read(repo().join("apps/desktop/src-tauri/src/tray.rs"));
    assert!(shell.contains("if claim_existing"));
    assert!(tray.contains("crate::start_claim(app)"));
    assert!(shell.contains("command.arg(\"--claim\")"));
    assert!(!shell.contains("HubClaim"));
}

#[test]
fn the_tray_uses_the_channel_stamped_app_download_page() {
    let tray = read(repo().join("apps/desktop/src-tauri/src/tray.rs"));
    let channel = read(repo().join("apps/desktop/src-tauri/src/channel.rs"));
    assert!(tray.contains("channel::APP_DOWNLOAD_URL"));
    assert!(channel.contains("pub const APP_DOWNLOAD_URL"));
    assert!(!tray.contains("open_url(\"https://genethub.com/download\""));
}

/// The boot page is remote code's only possible predecessor, so it does not need
/// any renderer permission either. Native tray actions stay in Rust.
#[test]
fn renderer_capabilities_are_empty() {
    let raw = read(repo().join("apps/desktop/src-tauri/capabilities/default.json"));
    let capability: serde_json::Value =
        serde_json::from_str(&raw).expect("parse desktop capabilities");
    assert_eq!(capability["permissions"], serde_json::json!([]));
}

#[test]
fn macos_bundle_explains_microphone_access_for_speech_input() {
    let plist = read(repo().join("apps/desktop/src-tauri/Info.plist"));
    assert!(plist.contains("NSMicrophoneUsageDescription"));
    assert!(plist.contains("语音转换为可编辑文字"));
}

/// An ordinary website must not draw or control native chrome. The OS owns the
/// title bar, movement, maximize and close actions.
#[test]
fn the_remote_page_uses_os_window_decorations() {
    let config = config();
    assert_eq!(
        config["app"]["windows"][0]["decorations"],
        serde_json::json!(true)
    );
    let capabilities = read(repo().join("apps/desktop/src-tauri/capabilities/default.json"));
    assert!(!capabilities.contains("core:window"));
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
    // The daemon is the same `genet` binary every CLI client and built-in
    // Agent role runs, so it is stopped by the pid
    // in its lock file — an image-name kill would take a running
    // `genet session send --wait` down with it (`genethub-cli.md` §2).
    assert!(!script.contains("GH_AGENT_EXE"));
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

    // The shell-supervised daemon's lock sits one level deeper: the shell's
    // app-data directory carries the bundle identifier on Windows (Tauri
    // `app_data_dir()` is `%APPDATA%/<identifier>`), and the shell always
    // starts its daemon with the data-dir override pointed there
    // (`daemon.rs` `spawn`). An installer that reads only the CLI location
    // finds no lock and skips the kill — then meets the supervised daemon
    // still holding the exe it is about to write, with a Retry that can
    // never help because the hook has already run.
    assert_eq!(
        nsis_define(&script, "GH_BUNDLE_ID"),
        config()["identifier"]
            .as_str()
            .expect("the config has no identifier"),
        "the installer's name for the shell's app-data level is not the bundle identifier"
    );
    assert!(
        script.contains("$APPDATA\\${GH_BUNDLE_ID}\\${GH_DATA_DIR_NAME}\\daemon.lock"),
        "the installer does not read the shell-supervised daemon's lock — \
         the daemon the tray app starts is the one it fails to stop"
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

/// An upgrade used to default to uninstalling the old version first — the
/// whole old uninstaller run for what a file overwrite does, and the heavier
/// failure mode while a daemon is still holding the install directory. The
/// vendored NSIS template flips that default (`; GH:` in PageReinstall); if
/// the config stops pointing at it, or a template resync drops the override,
/// upgrades quietly return to uninstall-first.
#[test]
fn the_windows_installer_defaults_upgrades_to_overwriting() {
    let config = config();
    let template = config["bundle"]["windows"]["nsis"]["template"]
        .as_str()
        .expect("no custom NSIS template: upgrades default to uninstall-first");
    let script = read(repo().join("apps/desktop/src-tauri").join(template));
    assert!(
        script.contains("; GH:"),
        "the vendored template lost the overwrite-by-default override — \
         resync it with the bundler's installer.nsi and re-apply the GH block"
    );
}

/// A normal first install ends by launching the shell, whose first action after
/// supervising the daemon is the auth-first route. The user may opt out on the
/// finish page, while unattended installs require the explicit `/R` flag.
#[test]
fn the_windows_installer_offers_launch_on_finish() {
    let config = config();
    let template = config["bundle"]["windows"]["nsis"]["template"]
        .as_str()
        .expect("no custom NSIS template");
    let script = read(repo().join("apps/desktop/src-tauri").join(template));
    assert!(script.contains("!define MUI_FINISHPAGE_RUN"));
    assert!(script.contains("!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary"));
    assert!(script.contains("Function RunMainBinary"));
    assert!(script.contains("nsis_tauri_utils::RunAsUser"));
}

/// The website cannot hand native code a file or URL to execute. App updates
/// remain an explicit trip to the channel-stamped download page.
#[test]
fn the_remote_renderer_cannot_install_an_update() {
    let shell = read(repo().join("apps/desktop/src-tauri/src/lib.rs"));
    assert!(!shell.contains("install_update"));
    assert!(!shell.contains("fetch_app_manifest"));
    assert!(!shell.contains("generate_handler!"));

    let tray = read(repo().join("apps/desktop/src-tauri/src/tray.rs"));
    assert!(tray.contains("channel::APP_DOWNLOAD_URL"));
    assert!(!tray.contains("open_url(\"https://genethub.com/download\""));
    assert!(tray.contains(".open_url("));
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
/// — and all three are written by `scripts/stamp-version.mjs` from the tag as the release
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
    let stamper = repo().join("scripts/stamp-version.mjs");
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
             checkout cannot make — the tag is the version (scripts/stamp-version.mjs)"
        );
        assert!(
            script.contains(path),
            "{path} carries a version and the stamping script does not mention it, \
             so a release would ship whatever is written there"
        );
    }
}

/// The product's channel works the way its version does: the tree says
/// `local`, and a release is the workflow stamping its channel in
/// (`scripts/channel.mjs`, modelled on `scripts/stamp-version.mjs`).
///
/// Checked here for the same reason as the version: a tree accidentally
/// committed half-stamped for a release channel is a release that renames
/// itself, kills the wrong processes and reads the wrong data directory. And
/// the stable column of the table keeps the unprefixed names — those are what
/// installed copies already answer to, so renaming one orphans every override
/// a user has set.
#[test]
fn the_tree_claims_to_be_local_and_only_the_stamper_says_otherwise() {
    let stamper = read(repo().join("scripts/channel.mjs"));

    // Every generated module says local, and the stamping script is what
    // writes each of them — a constants file nothing regenerates is one a
    // release build compiles straight past.
    let modules = [
        (
            "apps/daemon/src/channel.rs",
            "pub const CHANNEL: &str = \"local\";",
        ),
        (
            "apps/desktop/src-tauri/src/channel.rs",
            "pub const CHANNEL: &str = \"local\";",
        ),
        (
            "packages/workbench/src/channel.ts",
            "const STAMPED_CHANNEL: ReleaseChannel = \"local\";",
        ),
    ];
    for (path, marker) in modules {
        let body = read(repo().join(path));
        assert!(
            body.contains(marker),
            "{path} is not stamped local — the tree ships the local identity; \
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
    // brand — those carry a space on beta/dev/local and would break unquoted
    // shells. It must match DATA_DIR_NAME and never contain whitespace.
    let data_dir = read(repo().join("apps/desktop/src-tauri/src/channel.rs"))
        .lines()
        .find_map(|line| line.strip_prefix("pub const DATA_DIR_NAME: &str = "))
        .expect("desktop channel has no DATA_DIR_NAME")
        .trim()
        .trim_matches(|c| c == '"' || c == ';')
        .to_string();
    assert_eq!(config["productName"], data_dir);
    assert_eq!(config["productName"], "GeneHub-local");
    assert!(
        !config["productName"]
            .as_str()
            .expect("productName is a string")
            .contains(char::is_whitespace),
        "productName must be path-safe; a space lands the installer under a \
         directory that breaks unquoted shells"
    );
    assert_eq!(config["app"]["windows"][0]["title"], "GeneHub Local");
    assert_eq!(config["identifier"], "com.genethub.desktop.local");
    assert_eq!(config["mainBinaryName"], "genethub-desktop-local");

    let installer = read(repo().join("scripts/install.sh"));
    assert!(
        installer.contains("# channel: local") && installer.contains("channel=local"),
        "install.sh is not stamped local — the tree's installer must refuse to \
         run rather than quietly install a released line"
    );

    // The unprefixed column. These are the names already installed copies
    // answer to; the other columns may grow, this one does not move.
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
        ("env_download_base", "GENEHUB_DOWNLOAD_BASE"),
        ("env_bin_dir", "GENEHUB_BIN_DIR"),
        ("env_hub_url", "GENEHUB_HUB_URL"),
        ("identifier", "com.genethub.desktop"),
        ("cli_binary", "genet"),
        ("desktop_binary", "genethub-desktop"),
    ] {
        assert!(
            row(key).contains(&format!("stable: \"{name}\"")),
            "the stable column of scripts/channel.mjs moved: {key} no longer \
             stamps {name:?} — that is what installed copies already answer to, \
             and renaming it silently orphans every override a user has set"
        );
    }

    // The marked columns keep their marks: a channel whose binaries do not
    // carry its suffix is one whose installer kills another line's processes.
    for (key, local, beta, dev) in [
        ("cli_binary", "genet-local", "genet-beta", "genet-dev"),
        (
            "desktop_binary",
            "genethub-desktop-local",
            "genethub-desktop-beta",
            "genethub-desktop-dev",
        ),
    ] {
        let row = row(key);
        for (channel, name) in [("local", local), ("beta", beta), ("dev", dev)] {
            assert!(
                row.contains(&format!("{channel}: \"{name}\"")),
                "the {channel} column of {key} lost its mark ({name})"
            );
        }
    }

    // local updates from nowhere and points at no Hub: a source build is not
    // on the release scale. Component discovery is independent of the installer.
    assert!(
        row("component_manifest_urls").contains("local: []"),
        "the local column gained a signed component feed"
    );
    assert!(
        row("hub_url").contains("local: \"\""),
        "the local column gained a default Hub — a source build points nowhere \
         unless told"
    );

    // The native shell only chooses fixed origins. Once navigated, CSP belongs
    // to the website response, not to a channel-specific local Web bundle.
    let web = row("web_app_url");
    for channel in ["stable", "beta", "dev"] {
        assert!(web.contains(&format!("{channel}: \"https://")));
    }
    let csp = config["app"]["security"]["csp"]
        .as_str()
        .expect("tauri.conf.json has no CSP");
    assert!(
        !csp.contains("connect-src") && !stamper.contains("connect_src"),
        "the boot page regained channel-specific network authority"
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

/// App updates are outside the remotely loaded page's authority: the tray
/// opens the public download page and emits no private renderer event.
#[test]
fn the_tray_update_opens_the_channel_download_page() {
    let tray = read(repo().join("apps/desktop/src-tauri/src/tray.rs"));
    let host = read(repo().join("packages/workbench/src/host/index.ts"));

    assert!(tray.contains("检查更新"));
    assert!(tray.contains("channel::APP_DOWNLOAD_URL"));
    assert!(!tray.contains("open_url(\"https://genethub.com/download\""));
    assert!(!tray.contains("genehub://update"));
    // The live page is detectHost() → browserHost(). dest-2 still keeps
    // desktopHost() as a test helper; that leftover must not be the boot path.
    assert!(host.contains("always an ordinary browser"));
    assert!(!host.contains("desktop ? desktopHost()"));
    let browser = host
        .split("export function browserHost")
        .nth(1)
        .and_then(|rest| rest.split("export function desktopHost").next())
        .unwrap_or("");
    assert!(
        !browser.contains("genehub://"),
        "the remotely loaded page regained a genehub:// listener"
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
