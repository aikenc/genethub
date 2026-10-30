//! One authenticated carrier owns one endpoint. A replacement never resumes it.
use super::authenticated_channel::{
    authenticated_channel, AuthenticatedReader, AuthenticatedWriter, Role,
};
use super::endpoint::{Carrier, CarrierKind, PeerAccess};
use super::logical_wire::{self, Message};
use crate::{channel_auth::SessionKey, state::Shared};
use anyhow::{anyhow, bail, Result};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteClass {
    Ordinary,
    Control,
}

async fn read_control(reader: &mut AuthenticatedReader) -> Result<Message> {
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(10), reader.receive())
        .await??
        .ok_or_else(|| anyhow!("carrier closed during connection admission"))?;
    logical_wire::decode(&bytes)
}

pub(crate) async fn serve(
    state: Shared,
    key: SessionKey,
    mut access: PeerAccess,
    carrier: Carrier,
    kind: CarrierKind,
) -> Result<()> {
    let (mut reader, mut writer) = authenticated_channel(key, carrier, Role::Server);
    let admitted = async {
        let Message::Create { policy } = read_control(&mut reader).await? else {
            bail!("expected CREATE for a new connection");
        };
        let direct_only = match policy.as_str() {
            "relay-allowed" => false,
            "direct-only" => true,
            _ => bail!("invalid connection policy"),
        };
        state.logical_connections.create(&access, kind, direct_only)
    }
    .await;
    let connection = match admitted {
        Ok(connection) => connection,
        Err(error) => {
            let code = if error.to_string().contains("admission exhausted") {
                "ResourceExhausted"
            } else {
                "AdmissionRejected"
            };
            let _ = writer
                .send(&logical_wire::encode(&Message::Error {
                    code: code.into(),
                })?)
                .await;
            // Preserve the explicit refusal until the carrier has consumed it.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), reader.receive()).await;
            return Err(error);
        }
    };
    access.logical_id = Some(connection.id.clone());
    // No endpoint may migrate to another carrier; directness is now physical.
    access.direct_only = matches!(kind, CarrierKind::Rtc)
        || access.transport == genehub_proto::TransportKind::Loopback;
    writer
        .send(&logical_wire::encode(&Message::Created {
            id: connection.id.clone(),
        })?)
        .await?;
    let result = super::endpoint::serve_streams(state, access, reader, writer, kind).await;
    if let Err(error) = &result {
        tracing::warn!(id = %connection.id, reason = %error, "connection ended");
    }
    result
}

pub(crate) async fn client(
    key: SessionKey,
    carrier: Carrier,
) -> Result<(AuthenticatedReader, AuthenticatedWriter)> {
    let (mut reader, mut writer) = authenticated_channel(key, carrier, Role::Client);
    writer
        .send(&logical_wire::encode(&Message::Create {
            policy: "relay-allowed".into(),
        })?)
        .await?;
    match read_control(&mut reader).await? {
        Message::Created { id } if id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit()) => {
            Ok((reader, writer))
        }
        Message::Error { code } => bail!("connection admission refused: {code}"),
        _ => bail!("invalid connection CREATED response"),
    }
}
