use anyhow::{anyhow, Context, Result};
use genehub_proto::{DeviceAuth, InviteAuth, PeerAuth, PeerHello, PeerWelcome, TransportKind};
use genet_daemon_logic_api::PlatformReply;

use crate::channel_auth::{self, SessionKey};
use crate::dataplane::endpoint::PeerAccess;
use crate::state::Shared;
use crate::transport::admission::Admission;

pub struct AcceptedPeer {
    pub welcome: PeerWelcome,
    pub key: SessionKey,
    pub access: PeerAccess,
}

/// Performs one PSK mutual handshake before any business stream exists.
pub async fn accept(
    state: &Shared,
    transport: TransportKind,
    admission: Admission,
    hello_wire: &[u8],
    workspace_id: Option<String>,
    workspace_handle: Option<String>,
) -> Result<AcceptedPeer> {
    if hello_wire.is_empty() || hello_wire.len() > genehub_proto::MAX_EXCHANGE_HEAD_BYTES {
        anyhow::bail!("peer hello exceeds its bounded field");
    }
    let hello: PeerHello = serde_json::from_slice(hello_wire)?;
    if hello.version != genehub_proto::DATA_PLANE_VERSION {
        anyhow::bail!(
            "data-plane version mismatch: daemon={}, peer={}",
            genehub_proto::DATA_PLANE_VERSION,
            hello.version
        );
    }
    if hello.client_name.is_empty() || hello.client_name.len() > 80 {
        anyhow::bail!("invalid peer client name");
    }
    let server_nonce = uuid::Uuid::new_v4().simple().to_string();
    let (proof, key, device_id, bootstrap_invite) = match (&hello.auth, &admission) {
        (
            PeerAuth::Loopback {
                context,
                nonce,
                proof,
            },
            Admission::Loopback { server_proof },
        ) if transport == TransportKind::Loopback && context == "loopback" => {
            channel_auth::verify_proof(
                &channel_auth::client_proof(server_proof, context, nonce),
                proof,
            )?;
            (
                channel_auth::server_proof(server_proof, context, nonce, &server_nonce),
                channel_auth::derive_key(server_proof, context, nonce, &server_nonce),
                None,
                None,
            )
        }
        (
            PeerAuth::Device {
                device_id,
                nonce,
                proof,
            },
            Admission::DeviceRequired,
        ) => {
            let reply = state
                .logic
                .as_ref()
                .context("portable daemon logic is unavailable")?
                .authenticate_device(
                    DeviceAuth {
                        device_id: device_id.clone(),
                        nonce: nonce.clone(),
                        proof: proof.clone(),
                    },
                    server_nonce.clone(),
                )
                .await?;
            match reply {
                PlatformReply::Authenticated {
                    subject_id,
                    proof,
                    encryption_key,
                    context,
                } => (
                    proof,
                    SessionKey::from_portable(encryption_key, context),
                    Some(subject_id),
                    None,
                ),
                _ => {
                    return Err(anyhow!(
                        "portable device authentication returned the wrong value"
                    ))
                }
            }
        }
        (
            PeerAuth::Hosted {
                capability_id,
                nonce,
                proof,
            },
            Admission::Rtc {
                capability_id: expected,
                secret,
                expires_at,
            },
        ) if capability_id == expected && std::time::Instant::now() < *expires_at => {
            let context = channel_auth::hosted_context(capability_id);
            channel_auth::verify_proof(
                &channel_auth::client_proof(secret, &context, nonce),
                proof,
            )?;
            (
                channel_auth::server_proof(secret, &context, nonce, &server_nonce),
                channel_auth::derive_key(secret, &context, nonce, &server_nonce),
                None,
                None,
            )
        }
        (
            PeerAuth::Hosted {
                capability_id,
                nonce,
                proof,
            },
            Admission::Fabric {
                capability_id: expected,
                secret,
                expires_at,
            },
        ) if capability_id == expected && std::time::Instant::now() < *expires_at => {
            let context = channel_auth::hosted_context(capability_id);
            channel_auth::verify_proof(
                &channel_auth::client_proof(secret, &context, nonce),
                proof,
            )?;
            (
                channel_auth::server_proof(secret, &context, nonce, &server_nonce),
                channel_auth::derive_key(secret, &context, nonce, &server_nonce),
                None,
                None,
            )
        }
        (
            PeerAuth::Invite {
                invite_id,
                nonce,
                proof,
            },
            Admission::DeviceRequired,
        ) => {
            let reply = state
                .logic
                .as_ref()
                .context("portable daemon logic is unavailable")?
                .authenticate_invite(
                    InviteAuth {
                        invite_id: invite_id.clone(),
                        nonce: nonce.clone(),
                        proof: proof.clone(),
                    },
                    server_nonce.clone(),
                )
                .await?;
            match reply {
                PlatformReply::Authenticated {
                    subject_id,
                    proof,
                    encryption_key,
                    context,
                } => (
                    proof,
                    SessionKey::from_portable(encryption_key, context),
                    None,
                    Some(subject_id),
                ),
                _ => {
                    return Err(anyhow!(
                        "portable invitation authentication returned the wrong value"
                    ))
                }
            }
        }
        _ => return Err(anyhow!("peer authentication does not match this admission")),
    };

    Ok(AcceptedPeer {
        welcome: PeerWelcome {
            version: genehub_proto::DATA_PLANE_VERSION,
            server_nonce,
            proof,
        },
        key,
        access: PeerAccess {
            transport,
            device_id,
            workspace_id,
            workspace_handle,
            bootstrap_invite,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn loopback_is_a_full_mutual_psk_handshake() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let secret = "one-use-server-proof";
        let nonce = "00112233445566778899aabbccddeeff";
        let hello = PeerHello {
            version: genehub_proto::DATA_PLANE_VERSION,
            client_name: "test".into(),
            auth: PeerAuth::Loopback {
                context: "loopback".into(),
                nonce: nonce.into(),
                proof: channel_auth::client_proof(secret, "loopback", nonce),
            },
            rtc_supported: true,
        };
        let accepted = accept(
            &state,
            TransportKind::Loopback,
            Admission::Loopback {
                server_proof: secret.into(),
            },
            &serde_json::to_vec(&hello).unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        channel_auth::verify_proof(
            &channel_auth::server_proof(secret, "loopback", nonce, &accepted.welcome.server_nonce),
            &accepted.welcome.proof,
        )
        .unwrap();
    }
}
