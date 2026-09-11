//! Status-first Desktop navigation directive.
//!
//! The native shell knows only `{ navigate, complete, retryAfterMillis }`.
//! Hub state, claim links and retry policy stay here so the WebView can
//! change without replacing the Tauri binary.

use genehub_proto::{HubClaim, HubStatus, Reply, Request};
use serde_json::json;
use url::Url;

use crate::channel;

use super::output::{self, CliFailure};
use super::rpc::Rpc;

pub async fn desktop(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("route") => route(&args[1..]).await,
        _ => super::usage(),
    }
}

async fn route(args: &[String]) -> i32 {
    // No flags: startup and the tray's "重新登录官网" run this same route. The
    // one-use claim link below is not an occasional recovery side effect — it
    // is how the WebView gets a session at all. A bare workbench URL for an
    // already-paired daemon landed the window on the signed-out page whenever
    // the cookie jar was empty (fresh install, expired session), and nothing
    // in the window could fix that itself (fb__Y-nM9ptEeYt).
    if !args.is_empty() {
        return output::fail(CliFailure::invalid_args(
            "desktop route accepts no arguments",
        ));
    }
    let Some(web_url) = channel_web_url() else {
        return output::fail(CliFailure::business(
            "unsupportedChannel",
            format!("unknown application channel {}", channel::CHANNEL),
            None,
        ));
    };
    let hub_url = match resolve_hub_url() {
        Ok(value) => Some(value),
        Err(error) if channel::CHANNEL == "local" && error.code == "invalidArgs" => None,
        Err(error) => return output::fail(error),
    };
    let Some(hub_url) = hub_url else {
        return output::succeed(
            "desktop.route",
            desktop_directive(web_url.to_string(), true, None),
        );
    };

    let rpc = match Rpc::connect_or_exit().await {
        Ok(rpc) => rpc,
        Err(code) => return code,
    };
    let status = match rpc.call(Request::HubStatus).await {
        Ok(Reply::HubStatus(status)) => status,
        Ok(other) => {
            return output::fail(CliFailure::business(
                "internal",
                format!("unexpected reply for hub.status: {other:?}"),
                None,
            ))
        }
        Err(error) => {
            return output::fail(CliFailure::business("internal", format!("{error:#}"), None))
        }
    };

    match status {
        // A paired daemon is proof of ownership, and the claim link it mints
        // is one-use and redeemed immediately in this machine's own window —
        // so every launch signs the WebView back in, whatever happened to the
        // cookie jar since the last one.
        HubStatus::Paired { machine_id, .. } => {
            let workbench = match workbench_url(web_url, &machine_id) {
                Ok(value) => value,
                Err(error) => return output::fail(error),
            };
            match rpc.call(Request::HubClaimLink).await {
                Ok(Reply::HubClaim {
                    claim: HubClaim { claim_url, .. },
                    ..
                }) => match claim_url_with_next(&claim_url, &workbench) {
                    Ok(navigate) => {
                        output::succeed("desktop.route", desktop_directive(navigate, true, None))
                    }
                    Err(error) => output::fail(error),
                },
                Ok(other) => output::fail(CliFailure::business(
                    "internal",
                    format!("unexpected reply for hub.link: {other:?}"),
                    None,
                )),
                Err(error) => {
                    output::fail(CliFailure::business("internal", format!("{error:#}"), None))
                }
            }
        }
        HubStatus::Pairing {
            verification_uri_complete,
            ..
        } => output::succeed(
            "desktop.route",
            desktop_directive(verification_uri_complete, false, Some(2_000)),
        ),
        HubStatus::Unpaired | HubStatus::Failed { .. } => match rpc
            .call(Request::HubPair {
                hub_url,
                display_name: None,
            })
            .await
        {
            Ok(Reply::HubStatus(HubStatus::Pairing {
                verification_uri_complete,
                ..
            })) => output::succeed(
                "desktop.route",
                desktop_directive(verification_uri_complete, false, Some(2_000)),
            ),
            Ok(other) => output::fail(CliFailure::business(
                "internal",
                format!("unexpected reply for hub.pair: {other:?}"),
                None,
            )),
            Err(error) => {
                output::fail(CliFailure::business("internal", format!("{error:#}"), None))
            }
        },
    }
}

fn channel_web_url() -> Option<&'static str> {
    let stamped = channel::WEB_APP_URL;
    if stamped.is_empty() {
        None
    } else {
        Some(stamped)
    }
}

fn resolve_hub_url() -> Result<String, CliFailure> {
    if let Ok(url) = std::env::var(channel::ENV_HUB_URL) {
        if !url.trim().is_empty() {
            return Ok(url);
        }
    }
    if channel::DEFAULT_HUB_URL.is_empty() {
        return Err(CliFailure::invalid_args(format!(
            "this is a dev build with no default Hub — pass the address, or set {}",
            channel::ENV_HUB_URL
        )));
    }
    Ok(channel::DEFAULT_HUB_URL.to_string())
}

fn desktop_directive(
    navigate: String,
    complete: bool,
    retry_after_millis: Option<u64>,
) -> serde_json::Value {
    json!({
        "navigate": navigate,
        "complete": complete,
        "retryAfterMillis": retry_after_millis,
    })
}

fn workbench_url(base: &str, machine_id: &str) -> Result<String, CliFailure> {
    let mut url = Url::parse(base).map_err(|error| {
        CliFailure::business("internal", format!("invalid workbench URL: {error}"), None)
    })?;
    url.query_pairs_mut()
        .append_pair("desktopMachine", machine_id);
    Ok(url.into())
}

fn claim_url_with_next(value: &str, workbench: &str) -> Result<String, CliFailure> {
    let mut claim = Url::parse(value).map_err(|error| {
        CliFailure::business("internal", format!("invalid claim URL: {error}"), None)
    })?;
    claim.query_pairs_mut().append_pair("next", workbench);
    Ok(claim.into())
}

#[cfg(test)]
mod tests {
    use super::{claim_url_with_next, desktop_directive, workbench_url};

    #[test]
    fn desktop_and_hub_navigation_shapes_are_built_in_the_cli() {
        let directive = desktop_directive(
            "https://relay.genethub.com/app?desktopMachine=m1".into(),
            true,
            None,
        );
        assert_eq!(
            directive["navigate"],
            "https://relay.genethub.com/app?desktopMachine=m1"
        );
        assert_eq!(directive["complete"], true);
        assert_eq!(
            workbench_url("https://relay.genethub.com/app", "m1").unwrap(),
            "https://relay.genethub.com/app?desktopMachine=m1"
        );
    }

    #[test]
    fn the_startup_navigation_is_a_claim_link_carrying_the_workbench_as_next() {
        // The whole point of the Paired branch: the window lands signed in,
        // then continues to the machine it is running on.
        assert_eq!(
            claim_url_with_next(
                "https://relay.genethub.com/link/tok_1",
                "https://relay.genethub.com/app?desktopMachine=m1",
            )
            .unwrap(),
            "https://relay.genethub.com/link/tok_1?next=https%3A%2F%2Frelay.genethub.com%2Fapp%3FdesktopMachine%3Dm1"
        );
    }
}
