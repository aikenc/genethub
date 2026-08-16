//! Native patch discovery and cold activation.
//!
//! The Web can request `check` or `apply`; it cannot name a URL, path,
//! revision, channel or key. All discovery inputs are stamped into the App and
//! every downloaded application is admitted again by the Platform verifier.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use genehub_proto::{
    LogicIdentity, LogicManifest, PatchArtifactSummary, PatchAvailability, PatchBlockers,
    PatchControlRequest, PatchControlResponse, LOGIC_MANIFEST_SCHEMA,
};
use genet_daemon_platform::{ActiveLogic, SignedArtifact};
use tokio::sync::Mutex;

use crate::logic::{ApplyArtifact, LogicHost};

const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_ARTIFACT_BYTES: usize = 32 * 1024 * 1024;
const MAX_SIGNED_METADATA_BYTES: usize = 20 * 1024;
const MAX_REDIRECTS: usize = 3;
const IDEMPOTENCY_ENTRIES: usize = 128;

#[derive(Clone, Debug)]
pub struct PatchConfig {
    pub channel: String,
    pub logic_manifest_urls: Vec<String>,
    pub app_manifest_urls: Vec<String>,
    allow_test_http: bool,
}

impl PatchConfig {
    pub fn stamped() -> Self {
        Self {
            channel: crate::channel::CHANNEL.to_string(),
            logic_manifest_urls: crate::channel::LOGIC_MANIFEST_URLS
                .iter()
                .map(|value| (*value).to_string())
                .filter(|value| !value.is_empty())
                .collect(),
            app_manifest_urls: crate::channel::APP_MANIFEST_URLS
                .iter()
                .map(|value| (*value).to_string())
                .filter(|value| !value.is_empty())
                .collect(),
            allow_test_http: false,
        }
    }

    /// Builds a loopback-only feed for integration tests. Production builds do
    /// not contain this constructor, so an installed App can only use the
    /// release origins stamped into its Platform binary.
    #[cfg(any(test, debug_assertions))]
    #[doc(hidden)]
    pub fn for_integration_test(channel: &str, logic_manifest_url: String) -> Self {
        Self {
            channel: channel.to_string(),
            logic_manifest_urls: vec![logic_manifest_url],
            app_manifest_urls: vec!["https://app.example.test/latest.json".into()],
            allow_test_http: true,
        }
    }
}

pub struct PatchService {
    config: PatchConfig,
    client: reqwest::Client,
    mutation: Mutex<()>,
    completed: Mutex<VecDeque<(String, bool, PatchControlResponse)>>,
}

struct Inspection {
    active: LogicIdentity,
    highest: u64,
    availability: PatchAvailability,
    manifest: Option<LogicManifest>,
}

impl PatchService {
    pub fn new(config: PatchConfig) -> Result<Self> {
        for value in config
            .logic_manifest_urls
            .iter()
            .chain(config.app_manifest_urls.iter())
        {
            validate_url(value, config.allow_test_http)
                .with_context(|| format!("invalid stamped manifest URL {value}"))?;
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!(
                "GeneHub-Platform/{}/{}",
                env!("CARGO_PKG_VERSION"),
                config.channel
            ))
            .build()?;
        Ok(Self {
            config,
            client,
            mutation: Mutex::new(()),
            completed: Mutex::new(VecDeque::new()),
        })
    }

    pub async fn handle(
        &self,
        logic: &Arc<LogicHost>,
        request: PatchControlRequest,
    ) -> Result<PatchControlResponse> {
        match request {
            PatchControlRequest::Check => self.check(logic).await,
            PatchControlRequest::Apply {
                request_id,
                terminate_activities,
            } => {
                validate_request_id(&request_id)?;
                self.apply(logic, request_id, terminate_activities).await
            }
        }
    }

    pub async fn check(&self, logic: &Arc<LogicHost>) -> Result<PatchControlResponse> {
        let inspected = self.inspect(logic).await?;
        Ok(PatchControlResponse::Status {
            active: inspected.active,
            highest_accepted_revision: inspected.highest,
            availability: inspected.availability,
        })
    }

    async fn apply(
        &self,
        logic: &Arc<LogicHost>,
        request_id: String,
        terminate_activities: bool,
    ) -> Result<PatchControlResponse> {
        let _mutation = self.mutation.lock().await;
        if let Some(response) = self.cached(&request_id, terminate_activities).await? {
            return Ok(response);
        }
        let inspected = self.inspect(logic).await?;
        let PatchAvailability::Available { .. } = inspected.availability else {
            return Ok(PatchControlResponse::Status {
                active: inspected.active,
                highest_accepted_revision: inspected.highest,
                availability: inspected.availability,
            });
        };
        let manifest = inspected
            .manifest
            .context("available patch has no validated manifest")?;
        let artifact = self.download_artifact(&manifest).await?;
        match logic.apply_artifact(artifact, terminate_activities).await? {
            ApplyArtifact::Busy {
                readiness,
                native_resources,
            } => Ok(PatchControlResponse::Busy {
                active: identity(logic.active()?),
                blockers: PatchBlockers {
                    active_sessions: readiness.active_sessions,
                    terminals: readiness.terminals,
                    native_resources,
                },
            }),
            ApplyArtifact::Installed(active) => {
                let response = PatchControlResponse::Applied {
                    request_id: request_id.clone(),
                    active: identity(active),
                };
                let mut completed = self.completed.lock().await;
                completed.push_back((request_id, terminate_activities, response.clone()));
                while completed.len() > IDEMPOTENCY_ENTRIES {
                    completed.pop_front();
                }
                Ok(response)
            }
        }
    }

    async fn cached(
        &self,
        request_id: &str,
        terminate_activities: bool,
    ) -> Result<Option<PatchControlResponse>> {
        let completed = self.completed.lock().await;
        let Some((_, previous_force, response)) = completed
            .iter()
            .find(|(previous_id, _, _)| previous_id == request_id)
        else {
            return Ok(None);
        };
        if *previous_force != terminate_activities {
            return Err(anyhow!(
                "patch request id was already used with different options"
            ));
        }
        Ok(Some(response.clone()))
    }

    async fn inspect(&self, logic: &Arc<LogicHost>) -> Result<Inspection> {
        let active = logic.active()?;
        let highest = logic.highest_accepted_revision()?;
        if self.config.logic_manifest_urls.is_empty() {
            return Ok(Inspection {
                active: identity(active),
                highest,
                availability: PatchAvailability::Unconfigured,
                manifest: None,
            });
        }

        let mut failures = Vec::new();
        for url in &self.config.logic_manifest_urls {
            match self.fetch_manifest(url).await.and_then(|manifest| {
                self.validate_manifest(&manifest, &active, highest)?;
                Ok(manifest)
            }) {
                Ok(manifest) => {
                    let availability =
                        availability(&manifest, &active, &self.config.app_manifest_urls)?;
                    return Ok(Inspection {
                        active: identity(active),
                        highest,
                        manifest: matches!(availability, PatchAvailability::Available { .. })
                            .then_some(manifest),
                        availability,
                    });
                }
                Err(error) => failures.push(format!("{url}: {error:#}")),
            }
        }
        Err(anyhow!(
            "no stamped logic manifest was valid: {}",
            failures.join("; ")
        ))
    }

    async fn fetch_manifest(&self, url: &str) -> Result<LogicManifest> {
        let bytes = self.fetch_bounded(url, MAX_MANIFEST_BYTES, false).await?;
        serde_json::from_slice(&bytes).context("logic manifest is not canonical JSON data")
    }

    fn validate_manifest(
        &self,
        manifest: &LogicManifest,
        active: &ActiveLogic,
        highest: u64,
    ) -> Result<()> {
        if manifest.schema != LOGIC_MANIFEST_SCHEMA {
            return Err(anyhow!("unsupported logic manifest schema"));
        }
        if manifest.channel != self.config.channel || manifest.channel != active.channel {
            return Err(anyhow!("logic manifest channel does not match this App"));
        }
        if manifest.logic_revision == 0
            || manifest.platform_abi == 0
            || manifest.protocol_version == 0
        {
            return Err(anyhow!("logic manifest contains a zero identity field"));
        }
        if manifest.logic_revision < highest {
            return Err(anyhow!(
                "logic manifest revision {} is behind anti-replay fence {highest}",
                manifest.logic_revision
            ));
        }
        if manifest.logic_revision == active.revision
            && (manifest.artifact.sha256 != active.digest
                || manifest.platform_abi != active.platform_abi
                || manifest.protocol_version != active.protocol_version)
        {
            return Err(anyhow!(
                "logic manifest rebinds the active revision identity"
            ));
        }
        validate_descriptor(&manifest.artifact, self.config.allow_test_http)?;
        validate_source_revision(&manifest.source.open_sha, "open source SHA")?;
        validate_source_revision(&manifest.source.cloud_sha, "cloud source SHA")?;
        validate_digest(&manifest.source.lockfile_sha256, "lockfile digest")?;
        if manifest.activation.enabled == manifest.activation.paused_reason.is_some() {
            return Err(anyhow!(
                "logic activation must be enabled or carry one pause reason"
            ));
        }
        Ok(())
    }

    async fn download_artifact(&self, manifest: &LogicManifest) -> Result<SignedArtifact> {
        let limit = usize::try_from(manifest.artifact.size)
            .ok()
            .and_then(|size| size.checked_add(MAX_SIGNED_METADATA_BYTES))
            .filter(|size| *size <= MAX_ARTIFACT_BYTES + MAX_SIGNED_METADATA_BYTES)
            .context("logic artifact size exceeds the Platform limit")?;
        let mut failures = Vec::new();
        for source in &manifest.artifact.sources {
            match self.fetch_bounded(&source.url, limit, true).await {
                Ok(bytes) => match SignedArtifact::from_single_file(&bytes) {
                    Ok(artifact) => {
                        let envelope = &artifact.envelope;
                        if envelope.channel() != manifest.channel
                            || envelope.logic_revision() != manifest.logic_revision
                            || envelope.platform_abi() != manifest.platform_abi
                            || envelope.protocol_version() != manifest.protocol_version
                            || envelope.sha256() != manifest.artifact.sha256
                            || envelope.size() != manifest.artifact.size
                        {
                            failures.push(format!(
                                "{}: signed identity does not match the manifest",
                                source.url
                            ));
                            continue;
                        }
                        return Ok(artifact);
                    }
                    Err(error) => failures.push(format!("{}: {error}", source.url)),
                },
                Err(error) => failures.push(format!("{}: {error:#}", source.url)),
            }
        }
        Err(anyhow!(
            "no artifact source produced the declared signed bytes: {}",
            failures.join("; ")
        ))
    }

    async fn fetch_bounded(&self, url: &str, maximum: usize, artifact: bool) -> Result<Vec<u8>> {
        let mut current = url.to_string();
        let stamped_manifest = (!artifact).then(|| reqwest::Url::parse(url)).transpose()?;
        for redirects in 0..=MAX_REDIRECTS {
            validate_url(&current, self.config.allow_test_http)?;
            if artifact && !self.allowed_artifact_url(&current)? {
                return Err(anyhow!("artifact URL is outside stamped release origins"));
            }
            let response = self.client.get(&current).send().await?;
            if response.status().is_redirection() {
                if redirects == MAX_REDIRECTS {
                    return Err(anyhow!("release download redirected too many times"));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .context("release redirect has no valid Location")?;
                let redirected = reqwest::Url::parse(&current)?.join(location)?;
                if stamped_manifest
                    .as_ref()
                    .is_some_and(|stamped| !same_origin(stamped, &redirected))
                {
                    return Err(anyhow!(
                        "stamped manifest redirect crossed its trusted origin"
                    ));
                }
                current = redirected.to_string();
                continue;
            }
            if !response.status().is_success() {
                return Err(anyhow!("release source returned {}", response.status()));
            }
            if response
                .content_length()
                .is_some_and(|length| length > maximum as u64)
            {
                return Err(anyhow!("release body exceeds its declared byte limit"));
            }
            let mut stream = response.bytes_stream();
            let mut body = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                if body.len().saturating_add(chunk.len()) > maximum {
                    return Err(anyhow!("release body exceeds its byte limit"));
                }
                body.extend_from_slice(&chunk);
            }
            return Ok(body);
        }
        unreachable!("redirect loop returns or continues")
    }

    fn allowed_artifact_url(&self, candidate: &str) -> Result<bool> {
        let candidate = reqwest::Url::parse(candidate)?;
        let same_stamped_origin = self.config.logic_manifest_urls.iter().any(|manifest| {
            reqwest::Url::parse(manifest)
                .ok()
                .is_some_and(|manifest| same_origin(&manifest, &candidate))
        });
        let github_release = self.config.channel == "official"
            && candidate.host_str().is_some_and(|host| {
                host == "github.com"
                    || host == "objects.githubusercontent.com"
                    || host.ends_with(".githubusercontent.com")
            });
        Ok(same_stamped_origin || github_release)
    }
}

fn availability(
    manifest: &LogicManifest,
    active: &ActiveLogic,
    app_manifest_urls: &[String],
) -> Result<PatchAvailability> {
    if !manifest.activation.enabled {
        return Ok(PatchAvailability::Paused {
            reason: manifest
                .activation
                .paused_reason
                .clone()
                .context("disabled logic manifest has no pause reason")?,
        });
    }
    if manifest.platform_abi != active.platform_abi {
        return Ok(PatchAvailability::RequiresApp {
            required_platform_abi: manifest.platform_abi,
            app_manifest_urls: app_manifest_urls.to_vec(),
        });
    }
    if manifest.logic_revision == active.revision && manifest.artifact.sha256 == active.digest {
        return Ok(PatchAvailability::Current);
    }
    Ok(PatchAvailability::Available {
        artifact: PatchArtifactSummary {
            logic_revision: manifest.logic_revision,
            platform_abi: manifest.platform_abi,
            protocol_version: manifest.protocol_version,
            digest: manifest.artifact.sha256.clone(),
            size: manifest.artifact.size,
            open_source_sha: manifest.source.open_sha.clone(),
            cloud_source_sha: manifest.source.cloud_sha.clone(),
        },
    })
}

pub(crate) fn identity(active: ActiveLogic) -> LogicIdentity {
    LogicIdentity {
        channel: active.channel,
        logic_revision: active.revision,
        platform_abi: active.platform_abi,
        protocol_version: active.protocol_version,
        digest: active.digest,
        origin: format!("{:?}", active.origin).to_ascii_lowercase(),
    }
}

fn validate_request_id(value: &str) -> Result<()> {
    if (8..=96).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Ok(());
    }
    Err(anyhow!("patch request id is invalid"))
}

fn validate_descriptor(
    descriptor: &genehub_proto::ArtifactDescriptor,
    allow_test_http: bool,
) -> Result<()> {
    if descriptor.sources.is_empty() || descriptor.sources.len() > 4 {
        return Err(anyhow!("artifact must have one through four sources"));
    }
    validate_digest(&descriptor.sha256, "artifact digest")?;
    if descriptor.size == 0 || descriptor.size > MAX_ARTIFACT_BYTES as u64 {
        return Err(anyhow!("artifact size is outside the Platform limit"));
    }
    for source in &descriptor.sources {
        validate_url(&source.url, allow_test_http)?;
    }
    Ok(())
}

fn validate_digest(value: &str, label: &str) -> Result<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(());
    }
    Err(anyhow!("{label} is not lowercase SHA-256"))
}

fn validate_source_revision(value: &str, label: &str) -> Result<()> {
    if matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(());
    }
    Err(anyhow!("{label} is not a full lowercase Git object id"))
}

fn validate_url(value: &str, allow_test_http: bool) -> Result<()> {
    let url = reqwest::Url::parse(value)?;
    let test_http = allow_test_http
        && url.scheme() == "http"
        && url
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1"));
    if url.scheme() != "https" && !test_http {
        return Err(anyhow!("release URL must use HTTPS"));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.fragment().is_some()
    {
        return Err(anyhow!("release URL contains forbidden authority data"));
    }
    if !allow_test_http {
        if let Some(address) = url.host_str().and_then(|host| host.parse::<IpAddr>().ok()) {
            if address.is_loopback() || address.is_unspecified() || is_private(address) {
                return Err(anyhow!(
                    "release URL resolves to a forbidden literal address"
                ));
            }
        }
    }
    Ok(())
}

fn is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_private() || address.is_link_local(),
        IpAddr::V6(address) => address.is_unique_local() || address.is_unicast_link_local(),
    }
}

fn same_origin(left: &reqwest::Url, right: &reqwest::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{extract::State, response::Redirect, routing::get, Router};
    use ed25519_dalek::{Signer, SigningKey};
    use genehub_proto::{
        ArtifactDescriptor, ArtifactSource, LogicActivation, LogicManifest, PatchAvailability,
        SourceRevision,
    };
    use genet_daemon_platform::{
        ActiveLogic, ActiveOrigin, ArtifactEnvelope, SignedArtifact, LOGIC_ABI_VERSION,
    };

    use super::{availability, PatchConfig, PatchService, LOGIC_MANIFEST_SCHEMA};

    const MODULE_ID: &str = "genehub:daemon/logic";

    #[derive(Clone)]
    struct Bodies {
        manifest: Vec<u8>,
        artifact: Vec<u8>,
    }

    #[tokio::test]
    async fn manifest_and_signed_artifact_cross_check_byte_fields() {
        let signed = signed_artifact(2);
        let artifact_bytes = signed.to_single_file().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let manifest = manifest(&signed, format!("{origin}/logic.wasm"));
        let bodies = Arc::new(Bodies {
            manifest: serde_json::to_vec(&manifest).unwrap(),
            artifact: artifact_bytes,
        });
        let router = Router::new()
            .route(
                "/latest.json",
                get(|State(state): State<Arc<Bodies>>| async move { state.manifest.clone() }),
            )
            .route(
                "/logic.wasm",
                get(|State(state): State<Arc<Bodies>>| async move { state.artifact.clone() }),
            )
            .with_state(bodies);
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let service = PatchService::new(PatchConfig::for_integration_test(
            "dev",
            format!("{origin}/latest.json"),
        ))
        .unwrap();
        let fetched = service
            .fetch_manifest(&format!("{origin}/latest.json"))
            .await
            .unwrap();
        let downloaded = service.download_artifact(&fetched).await.unwrap();
        assert_eq!(downloaded.envelope.logic_revision(), 2);
        assert_eq!(downloaded.component, signed.component);
        server.abort();
    }

    #[tokio::test]
    async fn stamped_manifest_cannot_redirect_to_another_origin() {
        let signed = signed_artifact(2);
        let attacker_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let attacker_origin = format!("http://{}", attacker_listener.local_addr().unwrap());
        let attacker_manifest =
            serde_json::to_vec(&manifest(&signed, format!("{attacker_origin}/logic.wasm")))
                .unwrap();
        let attacker = Router::new().route(
            "/latest.json",
            get(move || {
                let body = attacker_manifest.clone();
                async move { body }
            }),
        );
        let attacker_server =
            tokio::spawn(async move { axum::serve(attacker_listener, attacker).await.unwrap() });

        let stamped_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stamped_origin = format!("http://{}", stamped_listener.local_addr().unwrap());
        let redirect_target = format!("{attacker_origin}/latest.json");
        let stamped = Router::new().route(
            "/latest.json",
            get(move || {
                let target = redirect_target.clone();
                async move { Redirect::temporary(&target) }
            }),
        );
        let stamped_server =
            tokio::spawn(async move { axum::serve(stamped_listener, stamped).await.unwrap() });

        let service = PatchService::new(PatchConfig::for_integration_test(
            "dev",
            format!("{stamped_origin}/latest.json"),
        ))
        .unwrap();
        let error = service
            .fetch_manifest(&format!("{stamped_origin}/latest.json"))
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("manifest redirect crossed its trusted origin"));

        stamped_server.abort();
        attacker_server.abort();
    }

    #[test]
    fn availability_has_only_current_patch_or_app_boundaries() {
        let signed = signed_artifact(2);
        let active = ActiveLogic {
            artifact_id: "id".into(),
            channel: "dev".into(),
            revision: 1,
            platform_abi: LOGIC_ABI_VERSION,
            protocol_version: genehub_proto::PROTOCOL_VERSION,
            digest: "0".repeat(64),
            origin: ActiveOrigin::Embedded,
        };
        let mut candidate = manifest(&signed, "https://release.example/logic.wasm".into());
        assert!(matches!(
            availability(
                &candidate,
                &active,
                &["https://release.example/app.json".into()]
            )
            .unwrap(),
            PatchAvailability::Available { .. }
        ));

        candidate.platform_abi += 1;
        assert!(matches!(
            availability(
                &candidate,
                &active,
                &["https://release.example/app.json".into()]
            )
            .unwrap(),
            PatchAvailability::RequiresApp { .. }
        ));

        candidate.activation = LogicActivation {
            enabled: false,
            paused_reason: Some("incident".into()),
        };
        assert!(matches!(
            availability(&candidate, &active, &[]).unwrap(),
            PatchAvailability::Paused { .. }
        ));
    }

    #[test]
    fn an_active_revision_cannot_be_rebound_to_another_identity() {
        let signed = signed_artifact(1);
        let active = ActiveLogic {
            artifact_id: "id".into(),
            channel: "dev".into(),
            revision: 1,
            platform_abi: LOGIC_ABI_VERSION,
            protocol_version: genehub_proto::PROTOCOL_VERSION,
            digest: signed.envelope.sha256().into(),
            origin: ActiveOrigin::Embedded,
        };
        let mut candidate = manifest(&signed, "http://127.0.0.1/logic.wasm".into());
        candidate.artifact.sha256 = "d".repeat(64);
        let service = PatchService::new(PatchConfig::for_integration_test(
            "dev",
            "http://127.0.0.1/latest.json".into(),
        ))
        .unwrap();

        let error = service
            .validate_manifest(&candidate, &active, 1)
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("rebinds the active revision identity"));
    }

    #[test]
    fn beta_artifacts_stay_on_the_stamped_website_origin() {
        let service = PatchService::new(PatchConfig::for_integration_test(
            "beta",
            "http://127.0.0.1/latest.json".into(),
        ))
        .unwrap();

        assert!(!service
            .allowed_artifact_url(
                "https://github.com/genethub-ai/genethub/releases/download/v1/logic.wasm",
            )
            .unwrap());
        assert!(service
            .allowed_artifact_url("http://127.0.0.1/logic.wasm")
            .unwrap());
    }

    fn signed_artifact(revision: u64) -> SignedArtifact {
        let component = b"\0asm\x01\0\0\0".to_vec();
        let key = SigningKey::from_bytes(&[7; 32]);
        let envelope = ArtifactEnvelope::unsigned(
            MODULE_ID,
            "dev",
            revision,
            LOGIC_ABI_VERSION,
            genehub_proto::PROTOCOL_VERSION,
            "dev-local",
            &component,
        )
        .unwrap();
        let signature = key.sign(&envelope.signing_payload().unwrap());
        SignedArtifact::new(envelope.with_signature(&signature), component)
    }

    fn manifest(artifact: &SignedArtifact, url: String) -> LogicManifest {
        LogicManifest {
            schema: LOGIC_MANIFEST_SCHEMA.into(),
            channel: artifact.envelope.channel().into(),
            logic_revision: artifact.envelope.logic_revision(),
            platform_abi: artifact.envelope.platform_abi(),
            protocol_version: artifact.envelope.protocol_version(),
            artifact: ArtifactDescriptor {
                sources: vec![ArtifactSource { url }],
                sha256: artifact.envelope.sha256().into(),
                size: artifact.envelope.size(),
            },
            source: SourceRevision {
                open_sha: "a".repeat(40),
                cloud_sha: "b".repeat(40),
                lockfile_sha256: "c".repeat(64),
            },
            activation: LogicActivation {
                enabled: true,
                paused_reason: None,
            },
        }
    }
}
