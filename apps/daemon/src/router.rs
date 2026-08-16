//! Thin request bridge between a transport connection and the signed Wasm app.
//!
//! The native daemon deliberately contains no second business router. If the
//! application is unavailable or traps, the request fails closed instead of
//! falling back to a stale native implementation.

use std::sync::Arc;

use genehub_proto::{ErrorCode, ProtocolError, Reply, Request, TransportKind};
use tokio::sync::broadcast;

use crate::state::Shared;

/// What a handled request may ask the connection to do beyond replying.
pub enum SideEffect {
    None,
    Subscribe {
        session_id: String,
        receiver: broadcast::Receiver<genehub_proto::SequencedEvent>,
    },
    Unsubscribe {
        session_id: String,
    },
}

pub struct Handled {
    pub reply: Result<Reply, ProtocolError>,
    pub effect: SideEffect,
}

fn failed(error: anyhow::Error) -> Handled {
    Handled {
        reply: Err(ProtocolError {
            code: ErrorCode::Internal,
            message: format!("portable daemon application failed: {error:#}"),
        }),
        effect: SideEffect::None,
    }
}

/// Routes every decoded RPC through the currently active signed application.
pub async fn handle(
    state: &Shared,
    transport: TransportKind,
    caller: genet_daemon_logic_api::CallerContext,
    request: Request,
) -> Handled {
    let Some(logic) = state.logic.as_ref() else {
        return failed(anyhow::anyhow!(
            "no verified daemon logic artifact is active"
        ));
    };
    match logic.route(transport, caller, request).await {
        Ok(routed) => Handled {
            reply: match routed.outcome {
                genet_daemon_logic_api::LogicOutcome::Reply(reply) => Ok(*reply),
                genet_daemon_logic_api::LogicOutcome::Error(error) => Err(error),
            },
            effect: portable_connection(routed.connection),
        },
        Err(error) => failed(error),
    }
}

fn portable_connection(connection: crate::logic::LogicConnection) -> SideEffect {
    match connection {
        crate::logic::LogicConnection::None => SideEffect::None,
        crate::logic::LogicConnection::Subscribe {
            session_id,
            receiver,
        } => SideEffect::Subscribe {
            session_id,
            receiver,
        },
        crate::logic::LogicConnection::Unsubscribe { session_id } => {
            SideEffect::Unsubscribe { session_id }
        }
    }
}

pub fn transport_for(remote: Option<std::net::IpAddr>) -> TransportKind {
    match remote {
        Some(ip) if ip.is_loopback() => TransportKind::Loopback,
        Some(_) => TransportKind::Lan,
        None => TransportKind::Forwarded,
    }
}

pub type SharedState = Arc<crate::state::AppState>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn loopback_and_lan_addresses_are_distinguished() {
        assert_eq!(
            transport_for(Some(IpAddr::V4(Ipv4Addr::LOCALHOST))),
            TransportKind::Loopback
        );
        assert_eq!(
            transport_for(Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)))),
            TransportKind::Lan
        );
        assert_eq!(transport_for(None), TransportKind::Forwarded);
    }

    #[test]
    fn vm_failures_are_explicit_and_never_fall_back() {
        let handled = failed(anyhow::anyhow!("guest trapped"));
        match handled.reply {
            Err(error) => {
                assert_eq!(error.code, ErrorCode::Internal);
                assert!(error.message.contains("guest trapped"));
            }
            Ok(_) => panic!("a failed guest returned a native business reply"),
        }
    }
}
