//! Host-owned signed guest discovery and cold activation.
//!
//! The Web/guest can request `check` or `apply`. They cannot name a URL, path,
//! revision, channel or key.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use crate::artifact::{ArtifactVerifier, SignedArtifact};
use crate::bindings::genehub::host::logic_update as wit;
use crate::channel;
use crate::keys;
use crate::store::ArtifactStore;

const LOGIC_SCHEMA: &str = "genehub.logic-manifest.v1";
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_ARTIFACT_BYTES: usize = 32 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogicManifest {
    schema: String,
    channel: String,
    logic_revision: u64,
    platform_abi: u32,
    protocol_version: u32,
    artifact: ArtifactDescriptor,
    #[allow(dead_code)]
    source: serde_json::Value,
    activation: LogicActivation,
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
struct LogicActivation {
    enabled: bool,
    #[serde(default)]
    paused_reason: Option<String>,
}

struct Runtime {
    store: ArtifactStore,
    baseline_revision: u64,
}

static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();

fn runtime() -> Result<&'static Mutex<Runtime>> {
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }
    let opened = open_runtime()?;
    let _ = RUNTIME.set(Mutex::new(opened));
    RUNTIME
        .get()
        .ok_or_else(|| anyhow!("logic update runtime failed to initialize"))
}

fn open_runtime() -> Result<Runtime> {
    let (key_id, key) = keys::trusted_key()?;
    let verifier = ArtifactVerifier::new(
        channel::MODULE_ID,
        channel::CHANNEL,
        channel::HOST_ABI,
        MAX_ARTIFACT_BYTES,
        [(key_id, key)],
    )
    .map_err(|error| anyhow!("{error}"))?;
    let root = store_root()?;
    let store = ArtifactStore::open(root, verifier).map_err(|error| anyhow!("{error}"))?;
    store
        .recover_candidate()
        .map_err(|error| anyhow!("recovering the signed guest candidate: {error}"))?;
    let baseline_revision = bundled_revision()?;
    if baseline_revision > 0 {
        store
            .advance_high_water(baseline_revision)
            .map_err(|error| anyhow!("recording bundled guest revision: {error}"))?;
    }
    Ok(Runtime {
        store,
        baseline_revision,
    })
}

fn bundled_revision() -> Result<u64> {
    parse_bundled_revision(option_env!("GENEHUB_BUNDLED_LOGIC_REVISION"))
}

fn parse_bundled_revision(raw: Option<&str>) -> Result<u64> {
    let Some(raw) = raw else {
        return Ok(0);
    };
    let revision = raw
        .parse::<u64>()
        .with_context(|| "GENEHUB_BUNDLED_LOGIC_REVISION must be a canonical positive integer")?;
    if revision == 0 || revision.to_string() != raw {
        bail!("GENEHUB_BUNDLED_LOGIC_REVISION must be a canonical positive integer");
    }
    Ok(revision)
}

fn store_root() -> Result<PathBuf> {
    let data = std::env::var(channel::ENV_DATA_DIR)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            dirs_data().map(|root| {
                root.join(match channel::CHANNEL {
                    "official" => "GeneHub",
                    "beta" => "GeneHub-beta",
                    "alpha" => "GeneHub-alpha",
                    _ => "GeneHub-dev",
                })
            })
        })
        .ok_or_else(|| anyhow!("no data directory for the guest update store"))?;
    Ok(data.join("logic"))
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
        .map_err(|_| anyhow!("logic update lock was poisoned"))?;
    let current = current_revision(&guard)?;
    if channel::LOGIC_MANIFEST_URLS.is_empty() {
        return Ok(wit::Status {
            current_revision: current,
            latest_revision: None,
            newer: false,
            problem: Some("这个通道没有签名 guest 更新源：请从官方发布页手动更新".to_string()),
        });
    }
    drop(guard);
    let manifest = match fetch_manifest() {
        Ok(manifest) => manifest,
        Err(error) => {
            return Ok(wit::Status {
                current_revision: current,
                latest_revision: None,
                newer: false,
                problem: Some(error.to_string()),
            })
        }
    };
    if manifest.schema != LOGIC_SCHEMA || manifest.channel != channel::CHANNEL {
        return Ok(wit::Status {
            current_revision: current,
            latest_revision: None,
            newer: false,
            problem: Some("更新清单不属于这个通道".to_string()),
        });
    }
    if !manifest.activation.enabled {
        return Ok(wit::Status {
            current_revision: current,
            latest_revision: Some(manifest.logic_revision),
            newer: false,
            problem: manifest.activation.paused_reason,
        });
    }
    Ok(wit::Status {
        current_revision: current,
        latest_revision: Some(manifest.logic_revision),
        newer: manifest.logic_revision > current,
        problem: None,
    })
}

pub fn apply(_request_id: &str) -> Result<()> {
    if channel::LOGIC_MANIFEST_URLS.is_empty() {
        bail!("这个通道没有签名 guest 更新源");
    }
    let manifest = fetch_manifest()?;
    if manifest.schema != LOGIC_SCHEMA || manifest.channel != channel::CHANNEL {
        bail!("更新清单不属于这个通道");
    }
    if !manifest.activation.enabled {
        bail!(
            "{}",
            manifest
                .activation
                .paused_reason
                .unwrap_or_else(|| "该通道的 guest 更新已暂停".to_string())
        );
    }
    if manifest.platform_abi != channel::HOST_ABI {
        bail!("guest 更新需要新的 host（ABI {}）", manifest.platform_abi);
    }
    let bytes = download_artifact(&manifest)?;
    let signed = SignedArtifact::from_single_file(&bytes).map_err(|error| anyhow!("{error}"))?;
    if signed.envelope.logic_revision() != manifest.logic_revision
        || signed.envelope.sha256() != manifest.artifact.sha256
        || signed.envelope.size() != manifest.artifact.size
        || signed.envelope.platform_abi() != manifest.platform_abi
        || signed.envelope.protocol_version() != manifest.protocol_version
        || signed.envelope.channel() != manifest.channel
    {
        bail!("downloaded artifact does not match the signed manifest");
    }
    let runtime = runtime()?;
    let guard = runtime
        .lock()
        .map_err(|_| anyhow!("logic update lock was poisoned"))?;
    let verified = {
        let (key_id, key) = keys::trusted_key()?;
        ArtifactVerifier::new(
            channel::MODULE_ID,
            channel::CHANNEL,
            channel::HOST_ABI,
            MAX_ARTIFACT_BYTES,
            [(key_id, key)],
        )
        .and_then(|verifier| verifier.verify(&signed))
        .map_err(|error| anyhow!("{error}"))?
    };
    guard
        .store
        .stage(&verified)
        .map_err(|error| anyhow!("{error}"))?;
    guard
        .store
        .advance_high_water(verified.envelope().logic_revision())
        .map_err(|error| anyhow!("{error}"))?;
    guard
        .store
        .commit_candidate(verified.envelope().logic_revision())
        .map_err(|error| anyhow!("{error}"))?;
    Ok(())
}

/// Bytes the next daemon instantiate should use, if a signed active exists.
pub fn load_active_bytes() -> Result<Option<Vec<u8>>> {
    let runtime = runtime()?;
    let guard = runtime
        .lock()
        .map_err(|_| anyhow!("logic update lock was poisoned"))?;
    let Some(active) = guard
        .store
        .load_active()
        .map_err(|error| anyhow!("loading the active signed guest: {error}"))?
    else {
        return Ok(None);
    };
    if active.envelope().logic_revision() < guard.baseline_revision {
        return Ok(None);
    }
    let file = SignedArtifact::new(active.envelope().clone(), active.component().to_vec())
        .to_single_file()
        .map_err(|error| anyhow!("encoding the active signed guest: {error}"))?;
    Ok(Some(file))
}

fn current_revision(runtime: &Runtime) -> Result<u64> {
    let highest = runtime
        .store
        .highest_revision()
        .map_err(|error| anyhow!("{error}"))?;
    Ok(highest.max(runtime.baseline_revision))
}

fn fetch_manifest() -> Result<LogicManifest> {
    let mut last_error = None;
    for url in channel::LOGIC_MANIFEST_URLS {
        match get_bytes(url, MAX_MANIFEST_BYTES) {
            Ok(bytes) => {
                let manifest: LogicManifest = serde_json::from_slice(&bytes)
                    .with_context(|| format!("parsing logic manifest from {url}"))?;
                return Ok(manifest);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("no stamped logic manifest URL")))
}

fn download_artifact(manifest: &LogicManifest) -> Result<Vec<u8>> {
    let mut last_error = None;
    for source in &manifest.artifact.sources {
        match get_bytes(&source.url, MAX_ARTIFACT_BYTES + 16 * 1024) {
            Ok(bytes) => return Ok(bytes),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("logic manifest has no artifact source")))
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
                    attempt.error(anyhow!("logic update refused a cross-origin redirect"))
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
        bail!("logic update URLs must be https");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        bail!("logic update URLs must not contain credentials");
    }
    Ok(())
}

impl crate::load::Host {
    // Marker so logic-update Host impl lives next to the other imports.
}

impl wit::Host for crate::load::Host {
    async fn check(&mut self) -> Result<wit::Status, String> {
        check().map_err(|error| error.to_string())
    }

    async fn apply(&mut self, request_id: String) -> Result<(), String> {
        apply(&request_id).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_revision_is_absent_or_canonical_and_positive() {
        assert_eq!(parse_bundled_revision(None).unwrap(), 0);
        assert_eq!(parse_bundled_revision(Some("42")).unwrap(), 42);
        for value in ["", "0", "01", "+1", "-1", "1 "] {
            assert!(
                parse_bundled_revision(Some(value)).is_err(),
                "accepted {value:?}"
            );
        }
    }

    #[test]
    fn update_sources_are_https_or_literal_loopback_in_debug_builds() {
        assert!(
            validate_url("https://relay.genethub.com/artifacts/manifests/logic/latest.json")
                .is_ok()
        );
        assert!(validate_url("https://user:secret@relay.genethub.com/update").is_err());
        assert!(validate_url("http://localhost:8080/update").is_err());
        assert!(validate_url("file:///tmp/update").is_err());
        if cfg!(debug_assertions) {
            assert!(validate_url("http://127.0.0.1:8080/update").is_ok());
        }
    }
}
