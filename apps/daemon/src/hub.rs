//! Pairing this machine with a Hub account.
//!
//! The daemon has no browser, so it cannot complete a redirect login. It asks
//! for a short code, shows it, and waits for a human to approve it somewhere
//! that does have a browser. Once approved it enrolls, which is what earns it
//! an uplink address and a credential.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{HubMachine, HubTicket};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::Enrollment;
use crate::workspace::WorkspaceCatalog;

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
    uplink_url: String,
    #[serde(default)]
    fabric_url: Option<String>,
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

pub struct Client {
    http: reqwest::Client,
    origin: String,
}

impl Client {
    pub fn new(origin: impl Into<String>) -> Self {
        Client {
            http: reqwest::Client::new(),
            origin: origin.into().trim_end_matches('/').to_string(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin)
    }

    /// Step one: ask for a code to show the user.
    pub async fn start_pairing(&self, display_name: &str) -> Result<PairingCode> {
        let response = self
            .http
            .post(self.url("/api/device-authorizations"))
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
        response.json().await.context("reading the pairing code")
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
            .post(self.url("/api/trial"))
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
        response.json().await.context("reading the trial reply")
    }

    /// A fresh one-time link into this machine's owner, proved by the uplink
    /// credential. What the tray's "open on another device" is made of.
    pub async fn claim_link(&self, enrollment: &Enrollment) -> Result<Trial> {
        let response = self
            .http
            .post(self.url(&format!(
                "/api/machines/{}/claim-link",
                enrollment.daemon_id
            )))
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
        response.json().await.context("reading the link reply")
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
            .get(self.url(&format!("/api/machines/{}/directory", enrollment.daemon_id)))
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
        let reply: Directory = response.json().await.context("reading the machine list")?;
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
            .put(self.url("/api/fabric/v2/workspace-catalog"))
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
            .post(self.url("/api/fabric/v2/endpoints"))
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
        response
            .json()
            .await
            .context("reading the Fabric admission reply")
    }

    /// A one-time address for reaching one of them through the forwarding layer.
    pub async fn ticket(&self, enrollment: &Enrollment, machine_id: &str) -> Result<HubTicket> {
        let response = self
            .http
            .post(self.url(&format!("/api/machines/{}/tickets", enrollment.daemon_id)))
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
        response.json().await.context("reading the ticket")
    }

    /// Step two: wait for the human. Returns the enrollment token.
    pub async fn await_approval(&self, code: &PairingCode) -> Result<String> {
        let mut interval = Duration::from_secs(code.interval.max(1));
        loop {
            let reply: PollReply = self
                .http
                .post(self.url("/api/device-authorizations/poll"))
                .json(&serde_json::json!({ "deviceCode": code.device_code }))
                .send()
                .await
                .context("polling the Hub")?
                .json()
                .await
                .context("reading the poll reply")?;

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
            .post(self.url("/api/machines/enroll"))
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
        let reply: EnrollReply = response
            .json()
            .await
            .context("reading the enrollment reply")?;

        Ok(Enrollment {
            hub_url: self.origin.clone(),
            machine_id: reply.machine_id,
            uplink_url: reply.uplink_url,
            fabric_url: reply.fabric_url,
            daemon_id: daemon_id.to_string(),
            secret,
            workspace_catalog_generation: None,
        })
    }

    /// Unenrolls, using the uplink credential as proof of ownership.
    pub async fn unenroll(&self, enrollment: &Enrollment) -> Result<()> {
        let response = self
            .http
            .delete(self.url(&format!("/api/machines/{}", enrollment.daemon_id)))
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
        let client = Client::new("http://myteam.devcloud.woa.com/relay-dev-0/");
        assert_eq!(
            client.url("/api/device-authorizations"),
            "http://myteam.devcloud.woa.com/relay-dev-0/api/device-authorizations"
        );
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
            uplink_url: "ws://relay.test/forward/daemon".into(),
            fabric_url: Some("ws://relay.test/fabric/v2".into()),
            daemon_id: "dmn_private".into(),
            secret: "node-secret".into(),
            workspace_catalog_generation: Some("wcg_previous".into()),
        };
        let catalog = WorkspaceCatalog {
            generation: "wcg_public".into(),
            revision: 7,
            workspaces: vec![crate::workspace::CatalogWorkspace {
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
            uplink_url: "ws://relay.example/forward/daemon".into(),
            fabric_url: Some("ws://relay.example/fabric/v2".into()),
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
}
