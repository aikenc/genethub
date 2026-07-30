//! Whether a newer build has been published.
//!
//! What gets asked is a plain file at a fixed address, not an API. The GitHub API
//! counts sixty requests an hour against the *address* they come from, and
//! everyone behind one office router shares that address — a limit worth avoiding
//! even for something a person triggers by hand. The release workflow publishes
//! the file under a name with no version in it, which is what makes the address
//! stay put (`.github/workflows/release.yml`).
//!
//! It lives in the daemon rather than in the desktop shell for two reasons: the
//! shell exists on Windows only, and Linux reaches the same workbench in a
//! browser; and this way the outbound call needs no exception in the shell's CSP,
//! which lists loopback and nothing else.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use genehub_proto::UpdateStatus;
use serde::Deserialize;

/// Where the published builds announce themselves.
///
/// The open repository's own releases rather than a service: a copy of this
/// daemon should not have to reach anybody's control plane to learn that a newer
/// copy of itself exists.
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/aikenc/genethub/releases/latest/download/latest.json";

/// Long enough for a slow link, short enough that the window says something
/// while the person who clicked is still looking at it. A timeout rather than a
/// retry, for the same reason.
const TIMEOUT: Duration = Duration::from_secs(10);

/// Shaped like a Tauri updater manifest, because that is the shape the release
/// already publishes and one file is enough for both readers. Unknown fields are
/// ignored, so signatures and other platforms can appear in it without this
/// having to know about them first.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    /// The release page: notes and checksums, which is what a person deciding
    /// whether to upgrade actually wants to read.
    #[serde(default)]
    page: Option<String>,
    /// Keyed the way an updater keys them, e.g. `windows-x86_64`.
    #[serde(default)]
    platforms: HashMap<String, Platform>,
}

#[derive(Debug, Deserialize)]
struct Platform {
    #[serde(default)]
    url: Option<String>,
}

/// Asks, and turns whatever comes back into something a screen can show.
///
/// A failure is part of the answer rather than an error, because every outcome
/// here ends up as one line under a button: not reaching the release host is
/// something to say out loud, not something to log and then render "up to date".
pub async fn check(manifest_url: &str, current: &str) -> UpdateStatus {
    match fetch(manifest_url).await {
        Ok(manifest) => status(current, &manifest),
        Err(error) => UpdateStatus {
            current: current.to_string(),
            latest: None,
            newer: false,
            url: None,
            problem: Some(format!("{error:#}")),
        },
    }
}

async fn fetch(url: &str) -> Result<Manifest> {
    let response = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()?
        .get(url)
        // Named, because a request with no user agent is one some hosts refuse,
        // and because whoever reads the release host's logs should be able to
        // tell what asked.
        .header(
            reqwest::header::USER_AGENT,
            format!("genet-daemon/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
        .context("asking where the newest version is")?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "the release host answered {} for {url}",
            response.status()
        ));
    }
    response
        .json()
        .await
        .context("reading what the newest version is")
}

fn status(current: &str, manifest: &Manifest) -> UpdateStatus {
    UpdateStatus {
        current: current.to_string(),
        latest: Some(manifest.version.clone()),
        newer: is_newer(current, &manifest.version),
        // The page ahead of the installer: someone deciding whether to upgrade
        // wants the notes, and handing over a direct download starts something
        // they have not agreed to yet.
        url: manifest
            .page
            .clone()
            .or_else(|| manifest.platforms.get(&platform_key())?.url.clone()),
        problem: None,
    }
}

/// How an updater manifest names this machine, so one file can serve every
/// platform.
fn platform_key() -> String {
    let os = match std::env::consts::OS {
        // What Tauri calls it, and this file is shaped like Tauri's.
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// Whether `latest` is a later version than `current`.
///
/// Compared as numbers rather than as text, because "0.1.9" sorts *after*
/// "0.1.10" as a string — and that is the exact pair this repository was next in
/// line to ship.
fn is_newer(current: &str, latest: &str) -> bool {
    // A build the release workflow never stamped calls itself 0.0.0
    // (`scripts/version.sh`), and it is behind nothing: whoever compiled it has
    // the source in front of them, and pointing that person at an installer is
    // telling them to replace their own tree with an older one.
    if parts(current).iter().all(|piece| *piece == 0) {
        return false;
    }
    let mine = parts(current);
    let theirs = parts(latest);
    let width = mine.len().max(theirs.len());
    // Zero-padded to one width so that 0.2 and 0.2.0 are the same version
    // instead of the shorter one losing.
    let pad = |mut version: Vec<u64>| {
        version.resize(width, 0);
        version
    };
    pad(theirs) > pad(mine)
}

/// The leading numbers of a version. Anything else — a `-rc1`, a `+build` — is
/// dropped rather than ranked: this compares releases, and the tags this
/// repository publishes are numbers all the way down.
fn parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|piece| {
            piece
                .chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str) -> Manifest {
        Manifest {
            version: version.to_string(),
            page: Some("https://example.test/releases/tag/v9".to_string()),
            platforms: HashMap::new(),
        }
    }

    /// The trap this whole function exists for: as text, 0.1.9 is the larger one.
    #[test]
    fn a_tenth_release_is_newer_than_a_ninth() {
        assert!(is_newer("0.1.9", "0.1.10"));
        assert!(!is_newer("0.1.10", "0.1.9"));
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        assert!(!is_newer("0.1.17", "0.1.17"));
        assert!(!is_newer("0.1.17", "v0.1.17"));
        // Trailing zeros are not a release either.
        assert!(!is_newer("0.2", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2"));
    }

    /// A build from source can be ahead of everything published. Telling that
    /// person to upgrade would be telling them to go backwards.
    #[test]
    fn a_build_ahead_of_the_release_is_not_asked_to_upgrade() {
        assert!(!is_newer("0.2.0", "0.1.17"));
    }

    /// The version in the tree is 0.0.0 until the release workflow stamps a tag
    /// in, so this is what every developer's own build reports — and none of them
    /// should be told to go and install something.
    #[test]
    fn a_build_nobody_released_is_never_behind() {
        assert!(!is_newer("0.0.0", "0.1.18"));
        let status = status("0.0.0", &manifest("0.1.18"));
        assert!(!status.newer);
        // The newest release is still reported: "which version is out there" is a
        // fair question to ask from a source build, and answering it is not the
        // same as telling anyone to switch.
        assert_eq!(status.latest.as_deref(), Some("0.1.18"));
    }

    #[test]
    fn a_newer_release_carries_somewhere_to_go() {
        let status = status("0.1.17", &manifest("0.1.18"));
        assert!(status.newer);
        assert_eq!(status.latest.as_deref(), Some("0.1.18"));
        assert_eq!(
            status.url.as_deref(),
            Some("https://example.test/releases/tag/v9")
        );
        assert!(status.problem.is_none());
    }

    /// With no page in the file, the platform's own installer is the answer —
    /// otherwise the workbench would report a new version and no way to it.
    #[test]
    fn without_a_page_the_installer_for_this_platform_is_used() {
        let mut manifest = manifest("0.1.18");
        manifest.page = None;
        manifest.platforms.insert(
            platform_key(),
            Platform {
                url: Some("https://example.test/setup.exe".to_string()),
            },
        );
        assert_eq!(
            status("0.1.17", &manifest).url.as_deref(),
            Some("https://example.test/setup.exe")
        );
    }

    /// The manifest is the release's, not ours: it will grow fields, and a daemon
    /// that refused to parse the file the day a signature appeared in it would
    /// report "cannot check" to everyone at once.
    #[test]
    fn fields_this_version_does_not_know_are_ignored() {
        let manifest: Manifest = serde_json::from_str(
            r#"{
                "version": "0.1.18",
                "pub_date": "2026-07-30T00:00:00Z",
                "notes": "",
                "page": "https://example.test/tag",
                "platforms": {
                    "windows-x86_64": {
                        "url": "https://example.test/setup.exe",
                        "signature": "not-checked-here"
                    }
                }
            }"#,
        )
        .expect("a manifest with extra fields still parses");
        assert_eq!(manifest.version, "0.1.18");
        assert_eq!(manifest.page.as_deref(), Some("https://example.test/tag"));
    }

    /// Reaching nothing must not read as "you are up to date".
    #[tokio::test]
    async fn a_check_that_reached_nothing_says_so() {
        // Port 0 is not a place anything listens, so this fails without a
        // network and without a fixture pretending to be GitHub.
        let status = check("http://127.0.0.1:0/latest.json", "0.1.17").await;
        assert_eq!(status.current, "0.1.17");
        assert!(status.latest.is_none());
        assert!(!status.newer);
        assert!(status.problem.is_some());
    }
}
