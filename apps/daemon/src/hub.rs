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
}

#[derive(Debug, Deserialize)]
struct Directory {
    machines: Vec<HubMachine>,
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
            .get(self.url(&format!(
                "/api/machines/{}/directory",
                enrollment.daemon_id
            )))
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

    /// A one-time address for reaching one of them through the forwarding layer.
    pub async fn ticket(&self, enrollment: &Enrollment, machine_id: &str) -> Result<HubTicket> {
        let response = self
            .http
            .post(self.url(&format!(
                "/api/machines/{}/tickets",
                enrollment.daemon_id
            )))
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
            daemon_id: daemon_id.to_string(),
            secret,
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
}
