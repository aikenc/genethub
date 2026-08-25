//! Host-owned signed component discovery and cold activation.
//!
//! The Web/guest can request `check` or `apply`. They cannot name a URL, path,
//! version, channel or key.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use crate::abi;
use crate::artifact::{sha256_hex, ArtifactVerifier, SignedArtifact};
use crate::bindings::genehub::host::component_update as wit;
use crate::channel;
use crate::keys;
use crate::store::ArtifactStore;
use crate::version::ProductVersion;

const RELEASE_MANIFEST_SCHEMA: &str = "genehub.release-manifest.v2";
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_ARTIFACT_BYTES: usize = 32 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentManifest {
    schema: String,
    channel: String,
    release_version: String,
    app_abi_hash: String,
    web_protocol: u32,
    artifact: ArtifactDescriptor,
    #[allow(dead_code)]
    source: serde_json::Value,
    activation: ComponentActivation,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactDescriptor {
    sources: Vec<ArtifactSource>,
    sha256: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactSource {
    url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentActivation {
    enabled: bool,
    #[serde(default)]
    paused_reason: Option<String>,
}

struct Runtime {
    store: ArtifactStore,
    baseline_version: Option<ProductVersion>,
}

static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();

/// Where this build looks for signed component releases. Released channels
/// stamp their URLs at build time; a debug build additionally honours
/// `GENEHUB_COMPONENT_MANIFEST_URL` so the release specialty tests can point
/// a local build at a loopback release service. The variable is compiled out
/// of release builds, where a pre-settable update URL would be a back door.
fn manifest_urls() -> Vec<String> {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("GENEHUB_COMPONENT_MANIFEST_URL") {
        if !url.is_empty() {
            return vec![url];
        }
    }
    channel::COMPONENT_MANIFEST_URLS
        .iter()
        .map(|url| (*url).to_string())
        .collect()
}

/// Whether this build may consult the activation store and a release
/// manifest at all. A source build without an update source keeps its
/// file-watcher loop and never lets a downloaded component override the
/// checkout; naming an update source is what opts a debug build in.
pub fn has_update_source() -> bool {
    !manifest_urls().is_empty()
}

/// The version of the component this process actually loaded, recorded at
/// instantiate time from the signed envelope. Raw unsigned builds report
/// nothing, which the guest surfaces as a source build.
static RUNNING_VERSION: OnceLock<Mutex<Option<ProductVersion>>> = OnceLock::new();

pub fn note_running_component(bytes: &[u8]) {
    let version = SignedArtifact::from_single_file(bytes)
        .ok()
        .and_then(|signed| ProductVersion::parse(signed.envelope.release_version()).ok());
    let lock = RUNNING_VERSION.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock.lock() {
        *guard = version;
    }
}

fn running_version() -> Option<ProductVersion> {
    RUNNING_VERSION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// What the guest should report as the product version: the running
/// component's envelope version, or `0.0.0` for an unsigned source build.
pub fn running_version_string() -> String {
    running_version()
        .map(|version| version.to_string())
        .unwrap_or_else(|| "0.0.0".to_string())
}

fn runtime() -> Result<&'static Mutex<Runtime>> {
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }
    let opened = open_runtime()?;
    let _ = RUNTIME.set(Mutex::new(opened));
    RUNTIME
        .get()
        .ok_or_else(|| anyhow!("component update runtime failed to initialize"))
}

fn open_runtime() -> Result<Runtime> {
    let (key_id, key) = keys::trusted_key()?;
    let verifier = ArtifactVerifier::new(
        channel::MODULE_ID,
        channel::CHANNEL,
        abi::hex_digest(&abi::host_digest()),
        MAX_ARTIFACT_BYTES,
        [(key_id, key)],
    )
    .map_err(|error| anyhow!("{error}"))?;
    let root = store_root()?;
    let store = ArtifactStore::open(root, verifier).map_err(|error| anyhow!("{error}"))?;
    store
        .recover_candidate()
        .map_err(|error| anyhow!("recovering the signed component candidate: {error}"))?;
    let baseline_version = bundled_version()?;
    if let Some(baseline) = &baseline_version {
        store
            .advance_high_water(baseline)
            .map_err(|error| anyhow!("recording bundled component version: {error}"))?;
    }
    Ok(Runtime {
        store,
        baseline_version,
    })
}

fn bundled_version() -> Result<Option<ProductVersion>> {
    // Release builds stamp the bundled component's version at build time; a
    // debug build additionally honours the variable at runtime so the release
    // specialties can split the bundled line from the store without a stamped
    // rebuild. Release builds keep it a build-time fact.
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("GENEHUB_BUNDLED_RELEASE_VERSION") {
        return parse_bundled_version(if value.is_empty() {
            None
        } else {
            Some(value.as_str())
        });
    }
    parse_bundled_version(option_env!("GENEHUB_BUNDLED_RELEASE_VERSION"))
}

fn parse_bundled_version(raw: Option<&str>) -> Result<Option<ProductVersion>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    ProductVersion::parse(raw)
        .map(Some)
        .map_err(|_| anyhow!("GENEHUB_BUNDLED_RELEASE_VERSION must be a canonical Product Version"))
}

fn store_root() -> Result<PathBuf> {
    let data = std::env::var(channel::ENV_DATA_DIR)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            dirs_data().map(|root| {
                root.join(match channel::CHANNEL {
                    "stable" => "GeneHub",
                    "beta" => "GeneHub-beta",
                    "dev" => "GeneHub-dev",
                    _ => "GeneHub-local",
                })
            })
        })
        .ok_or_else(|| anyhow!("no data directory for the component update store"))?;
    Ok(data.join("component"))
}

fn dirs_data() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local").join("share"))
}

pub fn check() -> Result<wit::Status> {
    let runtime = runtime()?;
    let guard = runtime
        .lock()
        .map_err(|_| anyhow!("component update lock was poisoned"))?;
    let current = current_version(&guard)?;
    if !has_update_source() {
        return Ok(wit::Status {
            current_version: current,
            latest_version: None,
            newer: false,
            problem: Some("这个通道没有签名组件更新源：请从官方发布页手动更新".to_string()),
        });
    }
    drop(guard);
    let manifest = match fetch_manifest() {
        Ok(manifest) => manifest,
        Err(error) => {
            return Ok(wit::Status {
                current_version: current,
                latest_version: None,
                newer: false,
                problem: Some(error.to_string()),
            })
        }
    };
    if manifest.schema != RELEASE_MANIFEST_SCHEMA || manifest.channel != channel::CHANNEL {
        return Ok(wit::Status {
            current_version: current,
            latest_version: None,
            newer: false,
            problem: Some("更新清单不属于这个通道".to_string()),
        });
    }
    if !manifest.activation.enabled {
        return Ok(wit::Status {
            current_version: current,
            latest_version: Some(manifest.release_version),
            newer: false,
            problem: manifest.activation.paused_reason,
        });
    }
    let newer = match ProductVersion::parse(&manifest.release_version) {
        Ok(latest) => ProductVersion::parse(&current)
            .map(|current| latest > current)
            .unwrap_or(false),
        Err(_) => false,
    };
    Ok(wit::Status {
        current_version: current,
        latest_version: Some(manifest.release_version),
        newer,
        problem: None,
    })
}

pub fn apply(_request_id: &str) -> Result<()> {
    if !has_update_source() {
        bail!("这个通道没有签名组件更新源");
    }
    let manifest = fetch_manifest()?;
    if manifest.schema != RELEASE_MANIFEST_SCHEMA || manifest.channel != channel::CHANNEL {
        bail!("更新清单不属于这个通道");
    }
    if !manifest.activation.enabled {
        bail!(
            "{}",
            manifest
                .activation
                .paused_reason
                .unwrap_or_else(|| "该通道的组件更新已暂停".to_string())
        );
    }
    let abi_hash = abi::hex_digest(&abi::host_digest());
    if manifest.app_abi_hash != abi_hash {
        bail!("组件更新需要新的 App（ABI 摘要 {}）", manifest.app_abi_hash);
    }
    let manifest_version = ProductVersion::parse(&manifest.release_version)
        .map_err(|_| anyhow!("更新清单携带了非规范版本号"))?;
    // The high-water mark only fences versions the store has seen; a fresh
    // store has none, so a stale mirror could still serve a first download
    // older than what is running. The running line is the other fence: an
    // update must move past it, and an equal version is no update either.
    let runtime = runtime()?;
    let guard = runtime
        .lock()
        .map_err(|_| anyhow!("component update lock was poisoned"))?;
    if let Ok(running) = ProductVersion::parse(&current_version(&guard)?) {
        if manifest_version <= running {
            bail!(
                "更新清单的 {} 不比正在运行的 {} 新",
                manifest_version,
                running
            );
        }
    }
    let bytes = download_artifact(&manifest)?;
    // The manifest's artifact digest describes the downloaded bytes — the
    // signed file — so transport corruption is caught before the envelope is
    // even parsed. The envelope's own sha256/size cover the component inside
    // it, a different scale, and the signature binds the two together.
    if sha256_hex(&bytes) != manifest.artifact.sha256
        || bytes.len() as u64 != manifest.artifact.size
    {
        bail!("downloaded artifact does not match the signed manifest");
    }
    let signed = SignedArtifact::from_single_file(&bytes).map_err(|error| anyhow!("{error}"))?;
    if signed.envelope.release_version() != manifest.release_version
        || signed.envelope.app_abi_hash() != manifest.app_abi_hash
        || signed.envelope.web_protocol() != manifest.web_protocol
        || signed.envelope.channel() != manifest.channel
    {
        bail!("downloaded artifact does not match the signed manifest");
    }
    let verified = {
        let (key_id, key) = keys::trusted_key()?;
        ArtifactVerifier::new(
            channel::MODULE_ID,
            channel::CHANNEL,
            abi_hash,
            MAX_ARTIFACT_BYTES,
            [(key_id, key)],
        )
        .and_then(|verifier| verifier.verify(&signed))
        .map_err(|error| anyhow!("{error}"))?
    };
    // The verified digest covers the component inside the envelope while the
    // manifest digest covers the signed file on the wire; the signature
    // already proved they belong together, so there is nothing left to
    // cross-check here.
    guard
        .store
        .stage(&verified)
        .map_err(|error| anyhow!("staging artifact {}: {error}", verified.artifact_id()))?;
    guard
        .store
        .advance_high_water(&manifest_version)
        .map_err(|error| anyhow!("{error}"))?;
    guard
        .store
        .commit_candidate(&manifest_version)
        .map_err(|error| anyhow!("{error}"))?;
    Ok(())
}

/// Bytes the next daemon instantiate should use, if a signed active exists.
pub fn load_active_bytes() -> Result<Option<Vec<u8>>> {
    let runtime = runtime()?;
    let guard = runtime
        .lock()
        .map_err(|_| anyhow!("component update lock was poisoned"))?;
    // The store is a cache and the bundled component is the floor: an active
    // that no longer verifies — corrupted, or signed for another App ABI
    // after an App upgrade — must not keep the machine from starting. Fall
    // back to the bundled component and drop the unusable file.
    let active = match guard.store.load_active() {
        Ok(active) => active,
        Err(error) => {
            crate::load::debug_log(&format!(
                "the stored active component is unusable ({error}); falling back to the bundled one"
            ));
            guard.store.discard_active_quietly();
            return Ok(None);
        }
    };
    let Some(active) = active else {
        return Ok(None);
    };
    if let Some(baseline) = &guard.baseline_version {
        if active.envelope().version() < *baseline {
            return Ok(None);
        }
    }
    let file = SignedArtifact::new(active.envelope().clone(), active.component().to_vec())
        .to_single_file()
        .map_err(|error| anyhow!("encoding the active signed component: {error}"))?;
    Ok(Some(file))
}

fn current_version(runtime: &Runtime) -> Result<String> {
    // The running component's own envelope version is the honest answer; the
    // store and the bundled baseline only describe what *could* run.
    if let Some(running) = running_version() {
        return Ok(running.to_string());
    }
    let highest = runtime
        .store
        .highest_version()
        .map_err(|error| anyhow!("{error}"))?;
    let current = match (highest, &runtime.baseline_version) {
        (Some(highest), Some(baseline)) => highest.max(baseline.clone()),
        (Some(highest), None) => highest,
        (None, Some(baseline)) => baseline.clone(),
        (None, None) => return Ok("0.0.0".to_string()),
    };
    Ok(current.to_string())
}

fn fetch_manifest() -> Result<ComponentManifest> {
    let mut last_error = None;
    for url in manifest_urls() {
        match get_bytes(&url, MAX_MANIFEST_BYTES) {
            Ok(bytes) => {
                let manifest: ComponentManifest = serde_json::from_slice(&bytes)
                    .with_context(|| format!("parsing the release manifest from {url}"))?;
                return Ok(manifest);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("no stamped component manifest URL")))
}

fn download_artifact(manifest: &ComponentManifest) -> Result<Vec<u8>> {
    let mut last_error = None;
    for source in &manifest.artifact.sources {
        match get_bytes(&source.url, MAX_ARTIFACT_BYTES + 16 * 1024) {
            Ok(bytes) => return Ok(bytes),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("release manifest has no artifact source")))
}

fn get_bytes(url: &str, limit: usize) -> Result<Vec<u8>> {
    validate_url(url)?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.stop()
            } else if let Some(previous) = attempt.previous().last() {
                if previous.origin() != attempt.url().origin() {
                    attempt.error(anyhow!("component update refused a cross-origin redirect"))
                } else {
                    attempt.follow()
                }
            } else {
                attempt.follow()
            }
        }))
        .build()?;
    let response = client
        .get(url)
        .send()
        .with_context(|| format!("GET {url}"))?;
    if !response.status().is_success() {
        bail!("{url} returned {}", response.status());
    }
    let bytes = response.bytes()?.to_vec();
    if bytes.len() > limit {
        bail!("{url} exceeded the {limit} byte limit");
    }
    Ok(bytes)
}

fn validate_url(url: &str) -> Result<()> {
    let parsed = reqwest::Url::parse(url).with_context(|| format!("invalid update URL {url}"))?;
    if parsed.scheme() != "https"
        && !(cfg!(debug_assertions)
            && parsed.scheme() == "http"
            && parsed
                .host_str()
                .is_some_and(|host| host == "127.0.0.1" || host == "[::1]"))
    {
        bail!("component update URLs must be https");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        bail!("component update URLs must not contain credentials");
    }
    Ok(())
}

impl crate::load::Host {
    // Marker so component-update Host impl lives next to the other imports.
}

impl wit::Host for crate::load::Host {
    // Both verbs do blocking network and store IO (reqwest::blocking carries
    // its own runtime, which panics if it is dropped inside this async
    // context), so the work runs on the blocking pool rather than on the
    // executor that is driving the guest.
    async fn check(&mut self) -> Result<wit::Status, String> {
        tokio::task::spawn_blocking(|| check().map_err(|error| error.to_string()))
            .await
            .map_err(|error| format!("component update check task: {error}"))?
    }

    async fn apply(&mut self, request_id: String) -> Result<(), String> {
        tokio::task::spawn_blocking(move || apply(&request_id).map_err(|error| error.to_string()))
            .await
            .map_err(|error| format!("component update apply task: {error}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_version_is_absent_or_canonical() {
        assert_eq!(parse_bundled_version(None).unwrap(), None);
        assert_eq!(
            parse_bundled_version(Some("0.1.2")).unwrap(),
            Some(ProductVersion::parse("0.1.2").unwrap())
        );
        assert!(parse_bundled_version(Some("0.2.0-beta.1"))
            .unwrap()
            .is_some());
        for value in ["", "0", "42", "1.2", "01.2.3", "1.2.3 ", "v1.2.3"] {
            assert!(
                parse_bundled_version(Some(value)).is_err(),
                "accepted {value:?}"
            );
        }
    }

    #[test]
    fn update_sources_are_https_or_literal_loopback_in_debug_builds() {
        assert!(validate_url(
            "https://relay.genethub.com/artifacts/manifests/component/latest.json"
        )
        .is_ok());
        assert!(validate_url("https://user:secret@relay.genethub.com/update").is_err());
        assert!(validate_url("http://localhost:8080/update").is_err());
        assert!(validate_url("file:///tmp/update").is_err());
        if cfg!(debug_assertions) {
            assert!(validate_url("http://127.0.0.1:8080/update").is_ok());
        }
    }
}
