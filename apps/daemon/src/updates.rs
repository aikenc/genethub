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
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use genehub_proto::{ServerFrame, UpdateDownload, UpdateStatus};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::state::Shared;

/// Where the published builds announce themselves.
///
/// The open repository's own releases rather than a service: a copy of this
/// daemon should not have to reach anybody's control plane to learn that a newer
/// copy of itself exists. Per channel, so a beta never measures itself against
/// an official release — the address lives with the other channel names.
pub use crate::channel::DEFAULT_MANIFEST_URL;

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
    // A dev build has no manifest to ask: it is not on the update scale at
    // all, and an empty URL failing to fetch would read as a network problem
    // rather than as "nothing to compare against".
    if manifest_url.is_empty() {
        return UpdateStatus {
            current: current.to_string(),
            latest: None,
            newer: false,
            url: None,
            download_url: None,
            problem: None,
        };
    }
    match fetch(manifest_url).await {
        Ok(manifest) => status(current, &manifest),
        Err(error) => UpdateStatus {
            current: current.to_string(),
            latest: None,
            newer: false,
            url: None,
            download_url: None,
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
            format!(
                "{}/{}",
                crate::channel::CLI_BINARY,
                env!("CARGO_PKG_VERSION")
            ),
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
    let download_url = manifest
        .platforms
        .get(&platform_key())
        .and_then(|platform| platform.url.clone());
    UpdateStatus {
        current: current.to_string(),
        latest: Some(manifest.version.clone()),
        newer: is_newer(current, &manifest.version),
        // The page is for reading; the installer is for the download button.
        // Falling back either way means "有新版本" is never a dead end.
        url: manifest.page.clone().or_else(|| download_url.clone()),
        download_url,
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
    // (`scripts/version.mjs`), and it is behind nothing: whoever compiled it has
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

/// How long a whole download may take. Generous: an installer is tens of
/// megabytes and the person who pressed the button has already been told this
/// runs in the background.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);

/// A ceiling on what we will write to someone's disk.
///
/// The manifest names the address, so this is only ever reached by a release
/// that went wrong or a host that went hostile — and either way, filling a
/// laptop's disk is not an outcome to leave to the other end's good behaviour.
const MOST_BYTES: u64 = 1_024 * 1_024 * 1_024;

/// How often progress is announced. Every chunk would be thousands of frames
/// per second down a relay for a bar that moves in pixels.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// Fetches the installer, and remembers how far it got.
///
/// The machine owns this rather than the desktop shell, for the same reasons
/// the check lives here: Linux reaches the same workbench through a browser,
/// and the shell's CSP lists loopback and nothing else. It also means the phone
/// that started a download can watch it finish.
pub struct Downloader {
    dir: PathBuf,
    state: Mutex<UpdateDownload>,
    /// Aborted only by finishing. Kept so a second request can tell a running
    /// fetch from a finished one without racing the state behind it.
    running: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Downloader {
    pub fn new(dir: PathBuf) -> Self {
        Downloader {
            dir,
            state: Mutex::new(UpdateDownload::Idle),
            running: Mutex::new(None),
        }
    }

    pub fn state(&self) -> UpdateDownload {
        self.state.lock().expect("download state").clone()
    }

    /// Drops the answer without dropping the file. See `Request::UpdateDismiss`.
    pub fn dismiss(&self, state: &Shared) -> UpdateDownload {
        let mut current = self.state.lock().expect("download state");
        // A fetch in flight is not something a toast can cancel: the request is
        // "stop telling me", and the honest way to stop telling someone about a
        // running download is to let it finish first.
        if matches!(*current, UpdateDownload::Fetching { .. }) {
            return current.clone();
        }
        *current = UpdateDownload::Idle;
        drop(current);
        publish(state, UpdateDownload::Idle);
        UpdateDownload::Idle
    }

    /// Starts fetching `url`, unless something is already happening.
    ///
    /// Idempotent on purpose. Two windows are two buttons, and the second press
    /// should join the first download rather than start a rival one writing to
    /// the same file.
    pub fn start(&self, state: &Shared, version: &str, url: &str) -> Result<UpdateDownload> {
        let mut current = self.state.lock().expect("download state");
        match &*current {
            UpdateDownload::Fetching { .. } => return Ok(current.clone()),
            // Already on disk, and the same build. Handing back `Ready` is what
            // makes "下载" on a second machine-wide client show the install
            // prompt instead of fetching a file that is already there.
            UpdateDownload::Ready { version: had, .. } if had == version => {
                return Ok(current.clone())
            }
            _ => {}
        }

        let target = target_path(&self.dir, url)?;
        let begun = UpdateDownload::Fetching {
            version: version.to_string(),
            received: 0,
            total: None,
        };
        *current = begun.clone();
        drop(current);
        publish(state, begun.clone());

        let handle = tokio::spawn({
            let state = state.clone();
            let version = version.to_string();
            let url = url.to_string();
            async move {
                let outcome = fetch_installer(&state, &version, &url, &target).await;
                let settled = match outcome {
                    Ok(()) => UpdateDownload::Ready {
                        version,
                        path: target.display().to_string(),
                    },
                    Err(error) => {
                        tracing::warn!("downloading the installer failed: {error:#}");
                        UpdateDownload::Failed {
                            version,
                            message: format!("{error:#}"),
                        }
                    }
                };
                *state.updates.state.lock().expect("download state") = settled.clone();
                *state.updates.running.lock().expect("download task") = None;
                publish(&state, settled);
            }
        });
        *self.running.lock().expect("download task") = Some(handle);

        Ok(begun)
    }
}

/// Where the file lands, and whether we are willing to fetch it at all.
///
/// Both checks were in the desktop shell before the machine did the fetching,
/// and both still matter: a scheme that is not https is a manifest pointing at
/// something other than a release, and a name with a separator in it is a path
/// we never agreed to write to.
fn target_path(dir: &Path, url: &str) -> Result<PathBuf> {
    let parsed = reqwest::Url::parse(url).with_context(|| format!("reading the address {url}"))?;
    if parsed.scheme() != "https" {
        bail!("拒绝下载：{} 不是 https 地址", parsed.scheme());
    }
    let name = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|name| !name.is_empty())
        .unwrap_or_default()
        .to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        bail!("下载地址里没有可用的文件名");
    }
    Ok(dir.join(name))
}

async fn fetch_installer(state: &Shared, version: &str, url: &str, target: &Path) -> Result<()> {
    let dir = target.parent().expect("the target has a directory");
    tokio::fs::create_dir_all(dir)
        .await
        .with_context(|| format!("creating {}", dir.display()))?;

    let mut response = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()?
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            format!(
                "{}/{}",
                crate::channel::CLI_BINARY,
                env!("CARGO_PKG_VERSION")
            ),
        )
        .send()
        .await
        .context("下载安装包")?;
    if !response.status().is_success() {
        bail!("下载失败：服务器返回 {}", response.status());
    }
    let total = response.content_length();
    if total.is_some_and(|bytes| bytes > MOST_BYTES) {
        bail!("下载失败：安装包大得不像话");
    }

    // Written to a sibling and renamed at the end, so an interrupted download
    // never looks like a finished installer to the next click.
    let partial = with_suffix(target, ".part");
    let mut file = tokio::fs::File::create(&partial)
        .await
        .with_context(|| format!("写入 {}", partial.display()))?;
    let mut received = 0u64;
    let mut announced = Instant::now();

    while let Some(chunk) = response.chunk().await.context("下载安装包")? {
        received += chunk.len() as u64;
        if received > MOST_BYTES {
            let _ = tokio::fs::remove_file(&partial).await;
            bail!("下载失败：安装包大得不像话");
        }
        file.write_all(&chunk).await.context("写入安装包")?;
        if announced.elapsed() >= PROGRESS_EVERY {
            announced = Instant::now();
            let progress = UpdateDownload::Fetching {
                version: version.to_string(),
                received,
                total,
            };
            *state.updates.state.lock().expect("download state") = progress.clone();
            publish(state, progress);
        }
    }

    if received == 0 {
        let _ = tokio::fs::remove_file(&partial).await;
        bail!("下载失败：文件是空的");
    }
    // Flushed before the rename, or the name appears over a file the OS has not
    // finished writing — and what runs then is half an installer.
    file.flush().await.context("写入安装包")?;
    file.sync_all().await.context("写入安装包")?;
    drop(file);
    tokio::fs::rename(&partial, target)
        .await
        .with_context(|| format!("重命名为 {}", target.display()))?;
    tracing::info!("downloaded the installer to {}", target.display());
    Ok(())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

fn publish(state: &Shared, download: UpdateDownload) {
    state.push(ServerFrame::UpdateDownloadChanged { download });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str) -> Manifest {
        Manifest {
            version: version.to_string(),
            page: Some("https://example.test/releases/tag/v9".to_string()),
            platforms: HashMap::from([(
                platform_key(),
                Platform {
                    url: Some("https://example.test/setup.exe".to_string()),
                },
            )]),
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
        // The installer is its own field: the download button must not open a
        // browser page just because the notes live there.
        assert_eq!(
            status.download_url.as_deref(),
            Some("https://example.test/setup.exe")
        );
        assert!(status.problem.is_none());
    }

    /// With no page in the file, the platform's own installer is the answer —
    /// otherwise the workbench would report a new version and no way to it.
    #[test]
    fn without_a_page_the_installer_for_this_platform_is_used() {
        let mut manifest = manifest("0.1.18");
        manifest.page = None;
        assert_eq!(
            status("0.1.17", &manifest).url.as_deref(),
            Some("https://example.test/setup.exe")
        );
        assert_eq!(
            status("0.1.17", &manifest).download_url.as_deref(),
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

    /// The manifest names the address, but the manifest is a file on the
    /// internet: everything about it that decides where bytes land on someone's
    /// disk gets checked here rather than trusted.
    #[test]
    fn only_an_https_address_with_a_plain_file_name_is_fetched() {
        let dir = Path::new("/data/updates");
        assert_eq!(
            target_path(dir, "https://example.test/v1/GeneHub-setup.exe").unwrap(),
            dir.join("GeneHub-setup.exe")
        );

        // Not https: a manifest that has been tampered with should not be able
        // to point this at anything it likes.
        assert!(target_path(dir, "http://example.test/setup.exe").is_err());
        assert!(target_path(dir, "file:///etc/passwd").is_err());
        // No name to write under. A trailing slash used to mean an empty file
        // name, which is a path that is just the directory.
        assert!(target_path(dir, "https://example.test/").is_err());
        // The last segment is a name and never a path. `..` is the one that
        // matters: it would write a directory up from where we agreed to.
        assert!(target_path(dir, "https://example.test/..").is_err());
    }

    /// The rename at the end is what makes a finished download tell itself
    /// apart from an interrupted one, so the two names must differ.
    #[test]
    fn a_download_in_progress_is_not_named_like_a_finished_one() {
        let target = Path::new("/data/updates/GeneHub-setup.exe");
        assert_eq!(
            with_suffix(target, ".part"),
            Path::new("/data/updates/GeneHub-setup.exe.part")
        );
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
