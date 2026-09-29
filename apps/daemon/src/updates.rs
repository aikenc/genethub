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
//! shell exists on Windows and macOS only (the stable macOS artifact still
//! depends on signing/notarization), while Linux reaches the same workbench in a
//! browser; and this way the outbound call needs no exception beyond what a
//! released shell already opens for Hub WSS (`scripts/channel.mjs` stamps
//! `https: wss:` into the shipping CSP — the tree's loopback-only CSP is the
//! dev column).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use genehub_proto::{ServerFrame, UpdateDownload, UpdateStatus};
use serde::Deserialize;

use crate::state::Shared;

/// Where the published builds announce themselves.
///
/// The open repository's own releases rather than a service: a copy of this
/// daemon should not have to reach anybody's control plane to learn that a newer
/// copy of itself exists. Per channel, so a beta never measures itself against
/// a stable release — the address lives with the other channel names.
pub use crate::channel::DEFAULT_MANIFEST_URL;

/// Long enough for a slow link, short enough that the window says something
/// while the person who clicked is still looking at it. A timeout rather than a
/// retry, for the same reason.
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

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
    validate_manifest_url(url)?;
    let response = crate::http::Client::builder()
        .timeout(TIMEOUT)
        .redirect(update_redirect_policy(true))
        .build()?
        .get(url)
        // Named, because a request with no user agent is one some hosts refuse,
        // and because whoever reads the release host's logs should be able to
        // tell what asked.
        .header(
            crate::http::header::USER_AGENT,
            format!(
                "{}/{}",
                crate::channel::CLI_BINARY,
                crate::version::app_version()
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
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MANIFEST_BYTES as u64)
    {
        bail!("the update manifest is larger than the safety limit");
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("reading what the newest version is")?;
        if body.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
            bail!("the update manifest is larger than the safety limit");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).context("reading what the newest version is")
}

fn validate_manifest_url(value: &str) -> Result<()> {
    let parsed = crate::http::Url::parse(value).context("reading the update manifest address")?;
    if !allowed_update_url(&parsed, true) {
        bail!("the update manifest must use https (plain http is loopback-only)");
    }
    Ok(())
}

fn allowed_update_url(url: &crate::http::Url, allow_loopback_http: bool) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    allow_loopback_http
        && url.scheme() == "http"
        && url
            .host_str()
            .and_then(parse_url_ip_literal)
            .is_some_and(|address| address.is_loopback())
}

fn parse_url_ip_literal(host: &str) -> Option<std::net::IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .ok()
}

/// Applies the same transport rule after every redirect. Checking only the
/// first URL would let an HTTPS endpoint downgrade the manifest to plaintext,
/// at which point an on-path attacker could replace both the digest and asset.
fn update_redirect_policy(allow_loopback_http: bool) -> crate::http::redirect::Policy {
    crate::http::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() < 5 && allowed_update_url(attempt.url(), allow_loopback_http) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

fn status(current: &str, manifest: &Manifest) -> UpdateStatus {
    UpdateStatus {
        current: current.to_string(),
        latest: Some(manifest.version.clone()),
        newer: is_newer(current, &manifest.version),
        // Discovery may still be useful to diagnostics, but an unsigned
        // manifest never gets to put an executable URL into an API response.
        url: manifest.page.clone(),
        download_url: None,
        // A reached manifest is a healthy check: `problem` is reserved for
        // "we could not find out", and the UI carries the manual-download
        // guidance on the `newer` branch instead.
        problem: None,
    }
}

/// Whether `latest` is a later version than `current`.
///
/// Compared with the one shared Product Version implementation, because this
/// answer decides whether a person is told to reinstall: a prerelease must
/// order before its release (0.8.0-beta.1 < 0.8.0), and "0.1.9" must sort
/// before "0.1.10" rather than after it as text would.
fn is_newer(current: &str, latest: &str) -> bool {
    // A build the release workflow never stamped calls itself 0.0.0
    // (`scripts/stamp-version.mjs`), and it is behind nothing: whoever compiled it has
    // the source in front of them, and pointing that person at an installer is
    // telling them to replace their own tree with an older one.
    if current == "0.0.0" {
        return false;
    }
    let Ok(mine) = genet_frontdoor::version::ProductVersion::parse(current) else {
        return false;
    };
    let Ok(theirs) = genet_frontdoor::version::ProductVersion::parse(latest) else {
        return false;
    };
    theirs > mine
}

/// Remembers the last update-download notice so the workbench can dismiss it.
///
/// Fetching the installer moved to the host updater. This only keeps the
/// dismissable state the router still publishes.
pub struct Downloader {
    state: Mutex<UpdateDownload>,
}

impl Downloader {
    pub fn new(_dir: PathBuf) -> Self {
        Downloader {
            state: Mutex::new(UpdateDownload::Idle),
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
}

fn publish(state: &Shared, download: UpdateDownload) {
    state.push(ServerFrame::UpdateDownloadChanged { download });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve_http_once(response: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request).await;
            socket.write_all(&response).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        format!("http://{address}/artifact")
    }

    async fn test_state(root: &Path) -> Shared {
        crate::AppState::build(crate::config::Paths::new(root))
            .await
            .unwrap()
            .0
    }

    fn manifest(version: &str) -> Manifest {
        Manifest {
            version: version.to_string(),
            page: Some("https://example.test/releases/tag/v9".to_string()),
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
    fn unsigned_discovery_never_returns_an_executable_url() {
        let status = status("0.1.17", &manifest("0.1.18"));
        assert!(status.newer);
        assert_eq!(status.latest.as_deref(), Some("0.1.18"));
        assert_eq!(
            status.url.as_deref(),
            Some("https://example.test/releases/tag/v9")
        );
        assert!(status.download_url.is_none());
        // A reached manifest is a healthy check: the UI carries the
        // manual-download guidance on the `newer` branch, and `problem` is
        // reserved for "we could not find out".
        assert!(status.problem.is_none());
    }

    /// With no independently trusted page, an installer URL from the unsigned
    /// manifest is still not an acceptable fallback.
    #[test]
    fn without_a_page_an_unsigned_installer_is_not_exposed() {
        let mut manifest = manifest("0.1.18");
        manifest.page = None;
        let status = status("0.1.17", &manifest);
        assert!(status.url.is_none());
        assert!(status.download_url.is_none());
        assert!(status.problem.is_none());
    }

    /// A prerelease orders before its release: a beta App must hear about the
    /// stable line shipping, and a stable build must never be told to
    /// downgrade into the beta line.
    #[test]
    fn a_prerelease_is_older_than_its_release() {
        assert!(is_newer("0.8.0-beta.1", "0.8.0"));
        assert!(!is_newer("0.8.0", "0.8.0-beta.1"));
        assert!(is_newer("0.8.0-beta.1", "0.8.0-beta.2"));
        assert!(!is_newer("0.8.0-beta.2", "0.8.0-beta.1"));
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
    fn update_manifests_require_tls_except_on_exact_ip_loopback() {
        validate_manifest_url("https://releases.example/latest.json").unwrap();
        validate_manifest_url("http://127.0.0.1:8080/latest.json").unwrap();
        validate_manifest_url("http://[::1]:8080/latest.json").unwrap();
        for refused in [
            "http://releases.example/latest.json",
            "http://192.168.1.20/latest.json",
            "http://localhost:8080/latest.json",
            "file:///tmp/latest.json",
        ] {
            assert!(
                validate_manifest_url(refused).is_err(),
                "{refused} was accepted"
            );
        }
    }

    #[test]
    fn update_redirects_cannot_downgrade_transport_security() {
        for accepted in [
            "https://objects.example/setup.exe",
            "https://releases.example/latest.json",
        ] {
            assert!(allowed_update_url(
                &crate::http::Url::parse(accepted).unwrap(),
                false
            ));
        }
        assert!(!allowed_update_url(
            &crate::http::Url::parse("http://objects.example/setup.exe").unwrap(),
            false
        ));
        assert!(allowed_update_url(
            &crate::http::Url::parse("http://127.0.0.1:8080/latest.json").unwrap(),
            true
        ));
        assert!(!allowed_update_url(
            &crate::http::Url::parse("http://127.0.0.1:8080/setup.exe").unwrap(),
            false
        ));
    }

    #[tokio::test]
    async fn a_manifest_redirect_to_insecure_remote_http_is_not_followed() {
        let response = b"HTTP/1.1 302 Found\r\nLocation: http://192.0.2.1/evil.json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec();
        let url = serve_http_once(response).await;
        let error = fetch(&url).await.unwrap_err();
        assert!(format!("{error:#}").contains("302"));
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

    /// The RPC the workbench's App row asks: the router hands the configured
    /// manifest address and this build's version to this module, and the
    /// answer is an `Update` reply — a failure included, because a check that
    /// reached nothing is something to say out loud.
    #[test]
    fn the_router_answers_an_app_check_with_this_machines_status() {
        // `router::handle` is one match over every request. In a debug build its
        // frame is larger than the default test-thread stack, so this runs on a
        // thread sized for that frame.
        let dir = tempfile::tempdir().unwrap();
        std::thread::Builder::new()
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(async move {
                    let state = test_state(dir.path()).await;
                    let handled = crate::router::handle(
                        &state,
                        genehub_proto::TransportKind::Loopback,
                        &crate::authz::Principal::LocalUser,
                        genehub_proto::Request::UpdateAppCheck,
                    )
                    .await;
                    // The tree's manifest URL is empty (local is not on a release scale),
                    // which is the one answer that needs no network: current, nothing to
                    // compare against, no problem to report.
                    let genehub_proto::Reply::Update(status) =
                        handled.reply.expect("an app check answers")
                    else {
                        panic!("an app check answers with an update status");
                    };
                    assert_eq!(status.current, state.version);
                    assert!(status.latest.is_none());
                    assert!(!status.newer);
                    assert!(status.problem.is_none());
                });
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
