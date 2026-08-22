//! Hub commands (`genethub-cli.md` §4.1).
//!
//! These talk to the local daemon over WebSocket and let a headless machine
//! enroll without a tray: `hub login` prints a browser URL; a human opens it
//! elsewhere; `--wait` blocks until the daemon is paired.

use std::time::{Duration, Instant};

use crate::channel;
use genehub_proto::{HubClaim, HubStatus, Reply, Request};

use super::rpc::Rpc;
use super::{fail, ok, EXIT_FAILED, EXIT_INVALID_ARGS};

const WAIT_POLL: Duration = Duration::from_secs(2);
/// Pairing codes expire on the Hub side in minutes; this is how long the CLI
/// will sit for `--wait` before giving up and telling the caller to retry.
const WAIT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub async fn hub(args: &[String]) -> i32 {
    let Some(verb) = args.first().map(String::as_str) else {
        return super::usage();
    };
    match verb {
        "status" => {
            if args.len() != 1 {
                return super::usage();
            }
            status().await
        }
        "login" => login(&args[1..]).await,
        "link" => {
            if args.len() != 1 {
                return super::usage();
            }
            link().await
        }
        "unpair" => {
            if args.len() != 1 {
                return super::usage();
            }
            unpair().await
        }
        _ => super::usage(),
    }
}

async fn status() -> i32 {
    let rpc = match Rpc::connect_or_exit().await {
        Ok(rpc) => rpc,
        Err(code) => return code,
    };
    match rpc.call(Request::HubStatus).await {
        Ok(Reply::HubStatus(status)) => ok(serde_json::to_value(status).unwrap_or_default()),
        Ok(other) => fail(
            "internal",
            &format!("unexpected reply for hub.status: {other:?}"),
            EXIT_FAILED,
        ),
        Err(error) => fail("internal", &format!("{error:#}"), EXIT_FAILED),
    }
}

/// `genet hub login [--hub <url>] [--name <display>] [--wait]`
///
/// Prints a frozen JSON object with `url` = the Hub's
/// `verificationUriComplete` — never assembled by us (`genethub-cli.md` §4.1).
async fn login(args: &[String]) -> i32 {
    let options = match LoginOptions::parse(args) {
        Ok(options) => options,
        Err(message) => return fail("invalid_args", &message, EXIT_INVALID_ARGS),
    };
    warn_if_cross_channel(&options.hub_url);

    let rpc = match Rpc::connect_or_exit().await {
        Ok(rpc) => rpc,
        Err(code) => return code,
    };
    let current = match fetch_status(&rpc).await {
        Ok(status) => status,
        Err(error) => return fail("internal", &error, EXIT_FAILED),
    };

    // Already paired: no-op that returns the current status, so a script can
    // re-run login safely (`genethub-cli.md` §4.1).
    if let HubStatus::Paired { .. } = &current {
        super::emit_stderr("already paired; nothing to do");
        return ok(login_payload(&current, None));
    }

    let status = match &current {
        HubStatus::Pairing { .. } => {
            super::emit_stderr("pairing already in progress; reusing the open code");
            current
        }
        _ => match rpc
            .call(Request::HubPair {
                hub_url: options.hub_url.clone(),
                display_name: options.name.clone(),
            })
            .await
        {
            Ok(Reply::HubStatus(status)) => status,
            Ok(other) => {
                return fail(
                    "internal",
                    &format!("unexpected reply for hub.pair: {other:?}"),
                    EXIT_FAILED,
                )
            }
            Err(error) => {
                let message = error.to_string();
                if message.contains("already paired") {
                    match fetch_status(&rpc).await {
                        Ok(status) => return ok(login_payload(&status, None)),
                        Err(error) => return fail("internal", &error, EXIT_FAILED),
                    }
                }
                let message = bare(&message);
                return fail(map_hub_error(message), message, EXIT_FAILED);
            }
        },
    };

    let payload = login_payload(&status, None);
    if let Some(url) = payload.get("url").and_then(|value| value.as_str()) {
        super::emit_stderr(format!(
            "open this URL in a browser to approve the machine:\n{url}"
        ));
    }

    if !options.wait {
        return ok(payload);
    }

    wait_until_settled(&rpc, payload).await
}

async fn link() -> i32 {
    let rpc = match Rpc::connect_or_exit().await {
        Ok(rpc) => rpc,
        Err(code) => return code,
    };
    match rpc.call(Request::HubClaimLink).await {
        Ok(Reply::HubClaim { status, claim }) => {
            let payload = login_payload(&status, Some(&claim));
            if let Some(url) = payload.get("url").and_then(|value| value.as_str()) {
                super::emit_stderr(format!("open this URL on another device:\n{url}"));
            }
            ok(payload)
        }
        Ok(other) => fail(
            "internal",
            &format!("unexpected reply for hub.claimLink: {other:?}"),
            EXIT_FAILED,
        ),
        Err(error) => {
            let raw = error.to_string();
            let message = bare(&raw);
            if message.contains("还没有连到 Hub") {
                fail("hub_unpaired", message, EXIT_FAILED)
            } else {
                fail("internal", message, EXIT_FAILED)
            }
        }
    }
}

/// The RPC layer prefixes errors with the daemon's code name ("internal: …").
/// Commands that re-map the error to their own frozen code must not leak that
/// prefix into the message — `hub_unpaired` reading "internal: …" is the
/// contract contradicting itself.
fn bare(message: &str) -> &str {
    match message.split_once(": ") {
        Some((
            "bad_request" | "unauthorized" | "not_found" | "conflict" | "unsupported" | "forbidden"
            | "internal" | "protocol_mismatch",
            rest,
        )) => rest,
        _ => message,
    }
}

async fn unpair() -> i32 {
    let rpc = match Rpc::connect_or_exit().await {
        Ok(rpc) => rpc,
        Err(code) => return code,
    };
    match rpc.call(Request::HubUnpair).await {
        Ok(Reply::HubStatus(status)) => ok(serde_json::to_value(status).unwrap_or_default()),
        Ok(other) => fail(
            "internal",
            &format!("unexpected reply for hub.unpair: {other:?}"),
            EXIT_FAILED,
        ),
        Err(error) => fail("internal", &format!("{error:#}"), EXIT_FAILED),
    }
}

/// Shared by `genet status` so the overview can attach a hub summary without
/// inventing a second code path.
#[allow(dead_code)]
pub async fn status_value() -> Option<serde_json::Value> {
    let rpc = Rpc::connect().await.ok()?;
    match rpc.call(Request::HubStatus).await.ok()? {
        Reply::HubStatus(status) => serde_json::to_value(status).ok(),
        _ => None,
    }
}

struct LoginOptions {
    hub_url: String,
    name: Option<String>,
    wait: bool,
}

impl LoginOptions {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut hub_url = None;
        let mut name = None;
        let mut wait = false;
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--hub" => {
                    i += 1;
                    let value = args.get(i).ok_or_else(|| "--hub needs a URL".to_string())?;
                    hub_url = Some(value.clone());
                }
                "--name" => {
                    i += 1;
                    let value = args
                        .get(i)
                        .ok_or_else(|| "--name needs a display name".to_string())?;
                    name = Some(value.clone());
                }
                "--wait" => wait = true,
                other => return Err(format!("unknown argument: {other}")),
            }
            i += 1;
        }
        Ok(Self {
            hub_url: resolve_hub_url(hub_url)?,
            name,
            wait,
        })
    }
}

fn resolve_hub_url(explicit: Option<String>) -> Result<String, String> {
    if let Some(url) = explicit {
        return Ok(url);
    }
    if let Ok(url) = std::env::var(channel::ENV_HUB_URL) {
        if !url.trim().is_empty() {
            return Ok(url);
        }
    }
    // A dev build points nowhere on its own: naming an address beats being
    // told "relative URL without a base" three steps later.
    if channel::DEFAULT_HUB_URL.is_empty() {
        return Err(format!(
            "this is a dev build with no default Hub — pass the address, or set {}",
            channel::ENV_HUB_URL
        ));
    }
    Ok(channel::DEFAULT_HUB_URL.to_string())
}

fn warn_if_cross_channel(hub_url: &str) {
    let lower = hub_url.to_ascii_lowercase();
    let looks_beta = lower.contains("relay-beta") || lower.contains("beta.");
    match channel::CHANNEL {
        "official" if looks_beta => {
            super::emit_stderr(format!(
                "warning: official build pointing at a beta/self-built Hub ({hub_url})"
            ));
        }
        "beta" if lower.contains("relay.genethub.com") && !looks_beta => {
            super::emit_stderr(format!(
                "warning: beta build pointing at the official Hub ({hub_url})"
            ));
        }
        _ => {}
    }
}

async fn fetch_status(rpc: &Rpc) -> Result<HubStatus, String> {
    match rpc.call(Request::HubStatus).await {
        Ok(Reply::HubStatus(status)) => Ok(status),
        Ok(other) => Err(format!("unexpected reply for hub.status: {other:?}")),
        Err(error) => Err(format!("{error:#}")),
    }
}

/// Frozen stdout shape for `hub login` / `hub link` (`genethub-cli.md` §4.1).
fn login_payload(status: &HubStatus, claim: Option<&HubClaim>) -> serde_json::Value {
    if let Some(claim) = claim {
        let hub_url = match status {
            HubStatus::Paired { hub_url, .. }
            | HubStatus::Pairing { hub_url, .. }
            | HubStatus::Failed { hub_url, .. } => hub_url.clone(),
            HubStatus::Unpaired => String::new(),
        };
        return serde_json::json!({
            "kind": "claim",
            "hubUrl": hub_url,
            "url": claim.claim_url,
            "userCode": null,
            "expiresAt": claim.expires_at,
            "status": status_name(status),
            "recoveryKey": claim.recovery_key,
            "hub": status,
        });
    }

    match status {
        HubStatus::Pairing {
            hub_url,
            user_code,
            verification_uri_complete,
            expires_at,
            ..
        } => serde_json::json!({
            "kind": "pair",
            "hubUrl": hub_url,
            "url": verification_uri_complete,
            "userCode": user_code,
            "expiresAt": expires_at,
            "status": "pairing",
        }),
        HubStatus::Paired {
            hub_url,
            machine_id,
            online,
        } => serde_json::json!({
            "kind": "pair",
            "hubUrl": hub_url,
            "url": null,
            "userCode": null,
            "expiresAt": null,
            "status": "paired",
            "machineId": machine_id,
            "online": online,
        }),
        HubStatus::Failed { hub_url, message } => serde_json::json!({
            "kind": "pair",
            "hubUrl": hub_url,
            "url": null,
            "userCode": null,
            "expiresAt": null,
            "status": "failed",
            "message": message,
        }),
        HubStatus::Unpaired => serde_json::json!({
            "kind": "pair",
            "hubUrl": null,
            "url": null,
            "userCode": null,
            "expiresAt": null,
            "status": "unpaired",
        }),
    }
}

fn status_name(status: &HubStatus) -> &'static str {
    match status {
        HubStatus::Unpaired => "unpaired",
        HubStatus::Pairing { .. } => "pairing",
        HubStatus::Paired { .. } => "paired",
        HubStatus::Failed { .. } => "failed",
    }
}

async fn wait_until_settled(rpc: &Rpc, initial: serde_json::Value) -> i32 {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        match fetch_status(rpc).await {
            Ok(status @ HubStatus::Paired { .. }) => {
                return ok(login_payload(&status, None));
            }
            Ok(HubStatus::Failed { message, .. }) => {
                return fail("hub_unreachable", &message, EXIT_FAILED)
            }
            Ok(HubStatus::Pairing { expires_at, .. }) => {
                if Instant::now() >= deadline {
                    return fail(
                        "hub_unreachable",
                        &format!("pairing timed out (code expires at {expires_at})"),
                        EXIT_FAILED,
                    );
                }
            }
            Ok(HubStatus::Unpaired) => {
                // Race: we saw pairing, then it flipped briefly — keep waiting
                // until the deadline rather than pretending success.
                if Instant::now() >= deadline {
                    return ok(initial);
                }
            }
            Err(error) => return fail("daemon_unreachable", &error, super::EXIT_UNREACHABLE),
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
}

fn map_hub_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("connect")
        || lower.contains("timed out")
        || lower.contains("dns")
        || lower.contains("hub")
    {
        "hub_unreachable"
    } else {
        "internal"
    }
}
