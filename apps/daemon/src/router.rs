//! Opaque request bridge between authenticated transports and signed Wasm.
//!
//! Native code supplies stable caller/route facts and bounded bytes. It never
//! deserializes a business operation, reply, error or event.

use std::sync::Arc;

use genehub_proto::TransportKind;
use genet_daemon_logic_api::{CarrierResponse, RequestRoute};
use tokio::sync::broadcast;

use crate::state::Shared;

pub enum SideEffect {
    None,
    Subscribe {
        session_id: String,
        receiver: broadcast::Receiver<Vec<u8>>,
    },
    Unsubscribe {
        session_id: String,
    },
}

pub struct Handled {
    pub response: CarrierResponse,
    pub effect: SideEffect,
}

fn failed(error: anyhow::Error) -> Handled {
    let error = serde_json::json!({
        "code": "internal",
        "message": format!("portable daemon application failed: {error:#}"),
    });
    Handled {
        response: CarrierResponse {
            status: 500,
            body: Vec::new(),
            error: Some(serde_json::to_vec(&error).expect("static platform error is JSON")),
        },
        effect: SideEffect::None,
    }
}

pub async fn handle(
    state: &Shared,
    transport: TransportKind,
    caller: genet_daemon_logic_api::CallerContext,
    route: RequestRoute,
    body: Vec<u8>,
) -> Handled {
    let Some(logic) = state.logic.as_ref() else {
        return failed(anyhow::anyhow!(
            "no verified daemon logic artifact is active"
        ));
    };
    match logic.route(transport, caller, route, body).await {
        Ok(routed) => Handled {
            response: routed.response,
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
    fn vm_failures_are_explicit_opaque_errors() {
        let handled = failed(anyhow::anyhow!("guest trapped"));
        assert_eq!(handled.response.status, 500);
        assert!(String::from_utf8(handled.response.error.unwrap())
            .unwrap()
            .contains("guest trapped"));
    }
}
