//! Pairing this machine with a Hub account.
//!
//! The daemon has no browser, so it cannot complete a redirect login. It asks
//! for a short code, shows it, and waits for a human to approve it somewhere
//! that does have a browser. Once approved it enrolls, which is what earns it
//! an uplink address and a credential.

use std::net::IpAddr;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use genehub_proto::{HubMachine, HubTicket};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::Enrollment;
use genet_daemon_logic_api::WorkspaceCatalog;

const HUB_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HUB_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_JSON_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_CHANNEL_ADMISSION_BYTES: usize = 4 * 1024;
const MAX_CONTROL_REDIRECTS: usize = 3;

/// What the user has to type in, and where.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_at: String,
    pub interval: u64,
}

/// A way into an identity that has no login: a one-time link, and the key that
/// gets it back if the link is lost.
///
/// This is the protocol type, deserialized straight from the Hub's answer.
/// Copying it into a local struct only to copy it back out again would give two
/// places for the field names to drift apart.
pub use genehub_proto::HubClaim as Trial;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PollReply {
    status: String,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    enrollment_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollReply {
    machine_id: String,
}

#[derive(Debug, Deserialize)]
struct Directory {
    machines: Vec<HubMachine>,
}

/// Short-lived, one-use admission for the node's endpoint-neutral Fabric WS.
/// The reusable enrollment secret is sent only to the Hub HTTP boundary and
/// never appears in the Relay URL or WebSocket headers.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FabricAdmission {
    pub url: String,
    pub admission_expires_at: String,
}

/// One-use E2E secret fetched by the target daemon. The opaque capability may
/// cross Relay; this value never does and must not implement `Debug`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelAdmissionReply {
    secret: String,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    workspace_handle: Option<String>,
    #[serde(default)]
    local_workspace_id: Option<String>,
}

/// One route-bound Fabric peer secret and its optional workspace scope.
/// Deliberately no Debug: it contains E2EE key material.
pub struct FabricPeerAdmission {
    pub secret: String,
    pub expires_at: Instant,
    pub workspace_handle: Option<String>,
    pub local_workspace_id: Option<String>,
}

pub struct Client {
    http: reqwest::Client,
    origin: String,
}

impl Client {
    pub fn new(origin: impl Into<String>) -> Self {
        Self::with_timeouts(origin, HUB_CONNECT_TIMEOUT, HUB_REQUEST_TIMEOUT)
    }

    fn with_timeouts(
        origin: impl Into<String>,
        connect_timeout: Duration,
        request_timeout: Duration,
    ) -> Self {
        Client {
            http: reqwest::Client::builder()
                .connect_timeout(connect_timeout)
                .timeout(request_timeout)
                .pool_idle_timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    let previous = attempt.previous();
                    let downgrade = previous.last().is_some_and(|prior| {
                        prior.scheme() == "https" && attempt.url().scheme() != "https"
                    });
                    let cross_origin = previous
                        .first()
                        .is_some_and(|initial| initial.origin() != attempt.url().origin());
                    if previous.len() >= MAX_CONTROL_REDIRECTS
                        || downgrade
                        || cross_origin
                        || validate_control_url(attempt.url()).is_err()
                    {
                        attempt.stop()
                    } else {
                        attempt.follow()
                    }
                }))
                .build()
                .expect("the Hub HTTP client configuration is valid"),
            origin: origin.into().trim_end_matches('/').to_string(),
        }
    }

    fn url(&self, path: &str) -> Result<reqwest::Url> {
        let url = reqwest::Url::parse(&format!("{}{path}", self.origin))
            .context("parsing the Hub URL")?;
        validate_control_url(&url)?;
        Ok(url)
    }

    /// Step one: ask for a code to show the user.
    pub async fn start_pairing(&self, display_name: &str) -> Result<PairingCode> {
        let response = self
            .http
            .post(self.url("/api/device-authorizations")?)
            .json(&serde_json::json!({ "displayName": display_name }))
            .send()
            .await
            .context("asking the Hub for a pairing code")?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "the Hub refused to start pairing: {}",
                response.status()
            ));
        }
        let code: PairingCode =
            read_json(response, MAX_JSON_RESPONSE_BYTES, "pairing code").await?;
        self.validate_browser_link(&code.verification_uri, "pairing verification URL")?;
        self.validate_browser_link(
            &code.verification_uri_complete,
            "complete pairing verification URL",
        )?;
        Ok(code)
    }

    /// Skips the human: takes a temporary identity and approves the pairing in
    /// one call, for someone who just wants to see the thing work.
    ///
    /// The device code is what makes this safe to expose. It never leaves this
    /// machine, so presenting it says "I am the machine that asked" — the same
    /// thing the approval screen establishes, without the screen.
    pub async fn claim_trial(&self, code: &PairingCode) -> Result<Trial> {
        let response = self
            .http
            .post(self.url("/api/trial")?)
            .json(&serde_json::json!({ "deviceCode": code.device_code }))
            .send()
            .await
            .context("asking the Hub for a trial identity")?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "the Hub refused to start a trial: {}",
                response.status()
            ));
        }
        let trial: Trial = read_json(response, MAX_JSON_RESPONSE_BYTES, "trial reply").await?;
        self.validate_browser_link(&trial.claim_url, "trial claim URL")?;
        Ok(trial)
    }

    /// A fresh one-time link into this machine's owner, proved by the uplink
    /// credential. What the tray's "open on another device" is made of.
    pub async fn claim_link(&self, enrollment: &Enrollment) -> Result<Trial> {
        let response = self
            .http
            .post(self.url(&format!(
                "/api/machines/{}/claim-link",
                enrollment.daemon_id
            ))?)
            .bearer_auth(&enrollment.secret)
            .send()
            .await
            .context("asking the Hub for a claim link")?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "the Hub refused to mint a link: {}",
                response.status()
            ));
        }
        let claim: Trial = read_json(response, MAX_JSON_RESPONSE_BYTES, "claim link reply").await?;
        self.validate_browser_link(&claim.claim_url, "claim URL")?;
        Ok(claim)
    }

    /// A Hub may tell the UI where to continue only on that same Hub origin.
    /// This is intentionally stricter than ordinary response parsing: these
    /// values become QR codes and operating-system browser actions, so a
    /// compromised or misconfigured Control must not smuggle a local-file,
    /// custom-protocol or cross-origin URL into the desktop shell.
    fn validate_browser_link(&self, value: &str, label: &str) -> Result<()> {
        if value.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
            return Err(anyhow!("{label} contains control characters"));
        }
        let base = reqwest::Url::parse(&self.origin).context("parsing the Hub origin")?;
        validate_control_url(&base)?;
        let target = reqwest::Url::parse(value).with_context(|| format!("parsing {label}"))?;
        if !target.username().is_empty() || target.password().is_some() {
            return Err(anyhow!("{label} cannot contain credentials"));
        }
        if target.origin() != base.origin() {
            // `base` already passed `validate_control_url` above, so a `http`
            // scheme here means it is a literal loopback address, not an
            // ordinary origin. A self-hosted daemon deliberately dials
            // Control over such an internal route while browsers are handed
            // the same deployment's public https origin
            // (`dev-workspace-design.md` — the two are split on purpose, not
            // a spoofed reply). Trusting the operator's own loopback
            // configuration and re-validating `target` on its own preserves
            // the actual protection this check exists for — no
            // `file:`/`javascript:`/credentialed/cross-scheme smuggling —
            // without demanding the two origins be identical.
            if base.scheme() != "http" {
                return Err(anyhow!("{label} must stay on the configured Hub origin"));
            }
            validate_control_url(&target)?;
        }
        Ok(())
    }

    /// Every machine this machine's owner has, as the Hub sees them.
    ///
    /// Proved by the same uplink credential as everything else here. That is a
    /// deliberate reuse rather than a shortcut: it already buys a claim link,
    /// and a claim link already buys one of the owner's device sessions — so
    /// nothing here is reachable that was not reachable before, and the client
    /// asking gets to stay a program with no account credential of its own.
    pub async fn machines(&self, enrollment: &Enrollment) -> Result<Vec<HubMachine>> {
        let response = self
            .http
            .get(self.url(&format!("/api/machines/{}/directory", enrollment.daemon_id))?)
            .bearer_auth(&enrollment.secret)
            .send()
            .await
            .context("asking the Hub for the machine list")?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "the Hub refused to list machines: {}",
                response.status()
            ));
        }
        let reply: Directory = read_json(response, MAX_JSON_RESPONSE_BYTES, "machine list").await?;
        Ok(reply.machines)
    }

    /// Publishes the complete safe workspace catalogue for this node.
    ///
    /// It intentionally remains a small HTTP bootstrap call during the Fabric
    /// migration. The body type has no field for an absolute path, and the
    /// node's existing credential is presented only as an Authorization
    /// header. Real-time operations use the single Fabric socket instead.
    pub async fn sync_workspace_catalog(
        &self,
        enrollment: &Enrollment,
        catalog: &WorkspaceCatalog,
        replaces_generation: Option<&str>,
    ) -> Result<()> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Upload<'a> {
            #[serde(flatten)]
            catalog: &'a WorkspaceCatalog,
            #[serde(skip_serializing_if = "Option::is_none")]
            replaces_generation: Option<&'a str>,
        }

        let response = self
            .http
            .put(self.url("/api/fabric/v2/workspace-catalog")?)
            .bearer_auth(&enrollment.secret)
            .json(&Upload {
                catalog,
                replaces_generation,
            })
            .send()
            .await
            .context("publishing the workspace catalogue")?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "the Hub refused the workspace catalogue: {}",
                response.status()
            ));
        }
        Ok(())
    }

    /// Exchanges the reusable node credential for one Relay-safe admission.
    ///
    /// The daemon does not dial or attach business handlers in this phase; the
    /// method pins the trust boundary for that next step so no implementation
    /// needs to expose `Enrollment::secret` to a Relay.
    pub async fn fabric_admission(&self, enrollment: &Enrollment) -> Result<FabricAdmission> {
        let response = self
            .http
            .post(self.url("/api/fabric/v2/endpoints")?)
            .bearer_auth(&enrollment.secret)
            .json(&serde_json::json!({}))
            .send()
            .await
            .context("requesting a one-use Fabric admission")?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "the Hub refused Fabric admission: {}",
                response.status()
            ));
        }
        read_json(response, MAX_JSON_RESPONSE_BYTES, "Fabric admission reply").await
    }

    /// Redeems a route-bound Fabric peer capability after Relay spent its route.
    pub async fn fabric_peer_admission(
        &self,
        enrollment: &Enrollment,
        capability_id: &str,
    ) -> Result<Option<FabricPeerAdmission>> {
        let request = self
            .http
            .post(self.url("/api/fabric/v2/peer-admissions/redeem")?)
            .bearer_auth(&enrollment.secret)
            .json(&serde_json::json!({
                "daemonId": enrollment.daemon_id,
                "capabilityId": capability_id,
            }))
            .send();
        let response = tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .context("Fabric peer admission request timed out")?
            .context("requesting Fabric peer admission")?;
        if matches!(response.status().as_u16(), 401 | 403 | 404) {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(anyhow!(
                "the Hub refused Fabric peer admission: {}",
                response.status()
            ));
        }
        let reply: ChannelAdmissionReply = read_json(
            response,
            MAX_CHANNEL_ADMISSION_BYTES,
            "Fabric peer admission reply",
        )
        .await?;
        validate_channel_secret(&reply.secret)?;
        let expires = reply
            .expires_at
            .ok_or_else(|| anyhow!("the Hub omitted the Fabric route expiry"))?;
        let expires = chrono::DateTime::parse_from_rfc3339(&expires)
            .context("parsing the Fabric peer expiry")?
            .with_timezone(&chrono::Utc);
        let remaining = (expires - chrono::Utc::now())
            .to_std()
            .map_err(|_| anyhow!("the Hub returned an expired Fabric route"))?;
        if remaining.is_zero() {
            return Err(anyhow!("the Hub returned an expired Fabric route"));
        }
        if reply.workspace_handle.is_some() != reply.local_workspace_id.is_some() {
            return Err(anyhow!(
                "the Hub returned an incomplete Fabric workspace scope"
            ));
        }
        Ok(Some(FabricPeerAdmission {
            secret: reply.secret,
            expires_at: Instant::now() + remaining,
            workspace_handle: reply.workspace_handle,
            local_workspace_id: reply.local_workspace_id,
        }))
    }

    /// A one-time address for reaching one of them through the forwarding layer.
    pub async fn ticket(&self, enrollment: &Enrollment, machine_id: &str) -> Result<HubTicket> {
        let response = self
            .http
            .post(self.url(&format!("/api/machines/{}/tickets", enrollment.daemon_id))?)
            .bearer_auth(&enrollment.secret)
            .json(&serde_json::json!({ "machineId": machine_id }))
            .send()
            .await
            .context("asking the Hub for a connection ticket")?;
        if !response.status().is_success() {
            // The status is worth carrying: 409 means that machine is offline,
            // which is a fact about the world rather than a fault, and the only
            // thing the person on the other end can act on.
            return Err(match response.status().as_u16() {
                404 => anyhow!("这台机器不在你的账号下了"),
                409 => anyhow!("那台机器现在不在线"),
                other => anyhow!("the Hub refused to issue a ticket: {other}"),
            });
        }
        read_json(response, MAX_JSON_RESPONSE_BYTES, "connection ticket").await
    }

    /// Step two: wait for the human. Returns the enrollment token.
    pub async fn await_approval(&self, code: &PairingCode) -> Result<String> {
        let mut interval = Duration::from_secs(code.interval.max(1));
        loop {
            let response = self
                .http
                .post(self.url("/api/device-authorizations/poll")?)
                .json(&serde_json::json!({ "deviceCode": code.device_code }))
                .send()
                .await
                .context("polling the Hub")?;
            if !response.status().is_success() {
                return Err(anyhow!(
                    "the Hub refused the approval poll: {}",
                    response.status()
                ));
            }
            let reply: PollReply =
                read_json(response, MAX_JSON_RESPONSE_BYTES, "approval poll reply").await?;

            if let Some(seconds) = reply.interval {
                interval = Duration::from_secs(seconds.max(1));
            }

            match reply.status.as_str() {
                "approved" => {
                    return reply
                        .enrollment_token
                        .ok_or_else(|| anyhow!("the Hub approved pairing without a token"))
                }
                "pending" => tokio::time::sleep(interval).await,
                "denied" => return Err(anyhow!("the pairing request was declined")),
                "expired" => {
                    return Err(anyhow!("the pairing code expired before it was approved"))
                }
                other => return Err(anyhow!("the Hub reported an unexpected status '{other}'")),
            }
        }
    }

    /// Step three: register the machine and mint the uplink credential.
    ///
    /// The secret is generated here and never sent: the Hub stores only its
    /// hash, so a leak of the Hub's database does not hand out uplinks.
    pub async fn enroll(
        &self,
        enrollment_token: &str,
        daemon_id: &str,
        public_key: &str,
    ) -> Result<Enrollment> {
        let secret = uuid::Uuid::new_v4().simple().to_string();
        let verifier = verifier_for(&secret);

        let response = self
            .http
            .post(self.url("/api/machines/enroll")?)
            .bearer_auth(enrollment_token)
            .json(&serde_json::json!({
                "daemonId": daemon_id,
                "publicKey": public_key,
                "credentialVerifier": verifier,
                "platform": std::env::consts::OS,
            }))
            .send()
            .await
            .context("enrolling with the Hub")?;

        if !response.status().is_success() {
            return Err(anyhow!("the Hub refused enrollment: {}", response.status()));
        }
        let reply: EnrollReply =
            read_json(response, MAX_JSON_RESPONSE_BYTES, "enrollment reply").await?;
        Ok(Enrollment {
            hub_url: self.origin.clone(),
            machine_id: reply.machine_id,
            daemon_id: daemon_id.to_string(),
            secret,
            workspace_catalog_generation: None,
        })
    }

    /// Unenrolls, using the uplink credential as proof of ownership.
    pub async fn unenroll(&self, enrollment: &Enrollment) -> Result<()> {
        let response = self
            .http
            .delete(self.url(&format!("/api/machines/{}", enrollment.daemon_id))?)
            .bearer_auth(&enrollment.secret)
            .send()
            .await
            .context("unenrolling from the Hub")?;
        if !response.status().is_success() && response.status().as_u16() != 404 {
            return Err(anyhow!(
                "the Hub refused to unenroll: {}",
                response.status()
            ));
        }
        Ok(())
    }
}

fn validate_channel_secret(secret: &str) -> Result<()> {
    if !(43..=128).contains(&secret.len())
        || !secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        anyhow::bail!("the Hub returned a weak or malformed channel secret");
    }
    Ok(())
}

fn validate_control_url(url: &reqwest::Url) -> Result<()> {
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(anyhow!(
            "Hub URLs cannot contain credentials, query parameters, or fragments"
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("the Hub URL has no host"))?
        .trim_start_matches('[')
        .trim_end_matches(']');
    let loopback = host
        .parse::<IpAddr>()
        .ok()
        .is_some_and(|address| address.is_loopback());
    match url.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        "http" => Err(anyhow!(
            "remote Hub credentials require https; plaintext http is allowed only for a literal loopback IP"
        )),
        other => Err(anyhow!("unsupported Hub URL scheme '{other}'")),
    }
}

async fn read_json<T: DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
    label: &str,
) -> Result<T> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(anyhow!("the Hub {label} is too large"));
    }
    let mut body = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.with_context(|| format!("reading the Hub {label}"))?;
        let next = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| anyhow!("the Hub {label} is too large"))?;
        if next > limit {
            return Err(anyhow!("the Hub {label} is too large"));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).with_context(|| format!("parsing the Hub {label}"))
}

/// Base64url of the SHA-256 of the secret. Must match what the Hub computes.
pub fn verifier_for(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    base64url(&digest)
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(triple >> 6) as usize & 0x3f] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[triple as usize & 0x3f] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_verifier_matches_the_hub_side_construction() {
        // Cross-checked against `createHash("sha256").update(x).digest("base64url")`.
        assert_eq!(
            verifier_for("hello"),
            "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"
        );
        assert_eq!(
            verifier_for(""),
            "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
        );
    }

    #[test]
    fn base64url_pads_nothing_and_uses_the_url_alphabet() {
        assert_eq!(base64url(b"a"), "YQ");
        assert_eq!(base64url(b"ab"), "YWI");
        assert_eq!(base64url(b"abc"), "YWJj");
        assert!(!base64url(&[0xfb, 0xff]).contains('+'));
    }

    #[test]
    fn hub_api_urls_keep_the_deployment_subpath() {
        let client = Client::new("https://myteam.devcloud.woa.com/relay-dev-0/");
        assert_eq!(
            client.url("/api/device-authorizations").unwrap().as_str(),
            "https://myteam.devcloud.woa.com/relay-dev-0/api/device-authorizations"
        );
    }

    #[test]
    fn credentialed_control_urls_require_https_except_literal_loopback() {
        for accepted in [
            "https://hub.example/api",
            "http://127.0.0.1:8080/api",
            "http://127.99.1.2/api",
            "http://[::1]:8080/api",
        ] {
            let url = reqwest::Url::parse(accepted).unwrap();
            assert!(validate_control_url(&url).is_ok(), "{accepted}");
        }
        for rejected in [
            "http://localhost/api",
            "http://192.168.1.2/api",
            "http://10.0.0.1/api",
            "http://hub.example/api",
            "ftp://hub.example/api",
            "https://user:pass@hub.example/api",
            "https://hub.example/api?secret=x",
            "https://hub.example/api#fragment",
        ] {
            let url = reqwest::Url::parse(rejected).unwrap();
            assert!(validate_control_url(&url).is_err(), "{rejected}");
        }
    }

    #[test]
    fn browser_links_must_be_same_origin_web_urls() {
        let client = Client::new("https://hub.example/subpath");
        for accepted in [
            "https://hub.example/activate",
            "https://hub.example/activate?code=AAAA-BBBB",
            "https://hub.example/link/once#continue",
        ] {
            assert!(
                client.validate_browser_link(accepted, "test URL").is_ok(),
                "{accepted}"
            );
        }
        for rejected in [
            "http://hub.example/activate",
            "https://other.example/link/once",
            "https://user:password@hub.example/link/once",
            "file:///tmp/payload",
            "smb://files.example/payload",
            "search-ms:query=payload",
            "javascript:alert(1)",
            "data:text/html,payload",
            "https://hub.example/link/once\r\nfile:///tmp/payload",
        ] {
            assert!(
                client.validate_browser_link(rejected, "test URL").is_err(),
                "{rejected}"
            );
        }

        let local = Client::new("http://127.0.0.1:8787/subpath");
        assert!(local
            .validate_browser_link("http://127.0.0.1:8787/link/once", "local URL")
            .is_ok());
        // A dev/self-hosted daemon dialing Control over an internal loopback
        // route legitimately gets back a claim link on the deployment's
        // public https origin instead — the split is intentional
        // (`dev-workspace-design.md`), not a spoofed reply, so it must still
        // be accepted as long as the link itself is a safe https URL.
        assert!(local
            .validate_browser_link(
                "https://myteam.devcloud.woa.com/relay-dev-chat/link/once",
                "trial claim URL"
            )
            .is_ok());
        // The relaxation is specific to a `base` that is itself a literal
        // loopback address; it must not let a loopback-looking `target`
        // smuggle past a scheme this check still has to reject.
        assert!(local
            .validate_browser_link("file:///tmp/payload", "unsafe target")
            .is_err());
        assert!(local
            .validate_browser_link("http://192.168.1.2/link/once", "non-loopback http target")
            .is_err());
        assert!(local
            .validate_browser_link("http://localhost:8787/link/once", "local URL")
            .is_err());
    }

    #[tokio::test]
    async fn json_responses_reject_declared_and_streamed_oversize_bodies() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut declared, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 2048];
            let _ = declared.read(&mut request).await.unwrap();
            declared
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        MAX_JSON_RESPONSE_BYTES + 1
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();

            let (mut streamed, _) = listener.accept().await.unwrap();
            let _ = streamed.read(&mut request).await.unwrap();
            streamed
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            let chunk = vec![b'x'; 64 * 1024];
            for _ in 0..=MAX_JSON_RESPONSE_BYTES / chunk.len() {
                if streamed
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
                if streamed.write_all(&chunk).await.is_err()
                    || streamed.write_all(b"\r\n").await.is_err()
                {
                    break;
                }
            }
        });
        let client = Client::new(&origin);

        let declared = client.start_pairing("oversize").await.unwrap_err();
        assert!(format!("{declared:#}").contains("too large"));
        let streamed = client.start_pairing("oversize").await.unwrap_err();
        assert!(format!("{streamed:#}").contains("too large"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn workspace_catalog_upload_is_path_free_and_uses_the_node_credential() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0u8; 8192];
            let mut used = 0usize;
            loop {
                let read = socket.read(&mut buffer[used..]).await.unwrap();
                if read == 0 {
                    break;
                }
                used += read;
                let request = String::from_utf8_lossy(&buffer[..used]);
                let Some(header_end) = request.find("\r\n\r\n") else {
                    continue;
                };
                let length = request[..header_end]
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if used >= header_end + 4 + length {
                    break;
                }
            }
            let request = String::from_utf8(buffer[..used].to_vec()).unwrap();
            let _ = seen_tx.send(request);
            socket
                .write_all(
                    b"HTTP/1.1 204 No Content\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });

        let enrollment = Enrollment {
            hub_url: origin.clone(),
            machine_id: "mch_private".into(),
            daemon_id: "dmn_private".into(),
            secret: "node-secret".into(),
            workspace_catalog_generation: Some("wcg_previous".into()),
        };
        let catalog = WorkspaceCatalog {
            generation: "wcg_public".into(),
            revision: 7,
            workspaces: vec![genet_daemon_logic_api::CatalogWorkspace {
                local_workspace_id: "w_opaque".into(),
                reported_name: "Project".into(),
                is_git_repo: true,
            }],
        };

        Client::new(&origin)
            .sync_workspace_catalog(&enrollment, &catalog, Some("wcg_previous"))
            .await
            .unwrap();
        let request = seen_rx.await.unwrap();
        assert!(request.starts_with("PUT /api/fabric/v2/workspace-catalog "));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer node-secret"));
        let body = request.split("\r\n\r\n").nth(1).unwrap();
        let json: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(json["generation"], "wcg_public");
        assert_eq!(json["replacesGeneration"], "wcg_previous");
        assert_eq!(json["revision"], 7);
        assert_eq!(json["workspaces"][0]["localWorkspaceId"], "w_opaque");
        assert!(json.get("machineId").is_none());
        assert!(json.get("daemonId").is_none());
        assert!(
            !body.contains("/"),
            "no local path may enter the catalogue body"
        );
    }

    #[tokio::test]
    async fn node_fabric_admission_keeps_the_reusable_secret_at_the_hub_boundary() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0u8; 4096];
            let used = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8(buffer[..used].to_vec()).unwrap();
            let _ = seen_tx.send(request);
            let body = r#"{"url":"wss://relay.example/fabric/v2?ticket=one-use","admissionExpiresAt":"2030-01-01T00:00:00.000Z"}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let enrollment = Enrollment {
            hub_url: origin.clone(),
            machine_id: "mch_private".into(),
            daemon_id: "dmn_private".into(),
            secret: "long-lived-node-secret".into(),
            workspace_catalog_generation: None,
        };

        let admission = Client::new(&origin)
            .fabric_admission(&enrollment)
            .await
            .unwrap();
        assert_eq!(
            admission.url,
            "wss://relay.example/fabric/v2?ticket=one-use"
        );
        assert_eq!(admission.admission_expires_at, "2030-01-01T00:00:00.000Z");
        let request = seen_rx.await.unwrap();
        assert!(request.starts_with("POST /api/fabric/v2/endpoints "));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer long-lived-node-secret"));
        assert!(!admission.url.contains("long-lived-node-secret"));
    }

    #[tokio::test]
    async fn a_hub_that_accepts_tcp_but_never_answers_hits_the_request_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let held = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });

        let error =
            Client::with_timeouts(origin, Duration::from_millis(50), Duration::from_millis(50))
                .start_pairing("deadline test")
                .await
                .unwrap_err();

        assert!(
            format!("{error:#}").contains("asking the Hub for a pairing code"),
            "the failing operation remains actionable: {error:#}"
        );
        held.abort();
    }
}
