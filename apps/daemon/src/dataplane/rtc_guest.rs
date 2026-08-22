//! The component carrier for `rtc`: the shell holds the connection.
//!
//! Only the connection differs from `rtc_host.rs`. Everything a peer is judged
//! by — the slot it has to win, the capability it has to present, the hello it
//! has to send before it is anything but a stranger — is decided here, exactly
//! as it is there, because none of it is knowledge the shell has.

use std::sync::{Arc, OnceLock};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    ErrorCode, ExchangeResponseHead, RtcNegotiationRequest, RtcNegotiationResponse, TransportKind,
};
use genet_wasi::rtc::{Config, Session, State};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::dataplane::endpoint::{self, PeerAccess, PeerServices, ServerStream};
use crate::dataplane::handshake;
use crate::transport::admission::Admission;

use super::{
    DATA_CHANNEL_LABEL, MAX_RTC_PEERS, RTC_ADMISSION_LIFETIME, RTC_CHANNEL_QUEUE,
    RTC_GATHER_TIMEOUT, RTC_HELLO_TIMEOUT, RTC_SIGNAL_BYTES, STUN_SERVER,
};

static RTC_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn slots() -> &'static Arc<Semaphore> {
    RTC_SLOTS.get_or_init(|| Arc::new(Semaphore::new(MAX_RTC_PEERS)))
}

pub(crate) async fn handle(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    match negotiate(stream, services).await {
        Ok(()) => Ok(()),
        Err(error) => {
            tracing::debug!(%error, "RTC negotiation refused");
            endpoint::send_error(
                stream,
                503,
                ErrorCode::Unsupported,
                "a direct RTC channel could not be established",
            )
            .await
        }
    }
}

async fn negotiate(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    let body = stream.read_body(RTC_SIGNAL_BYTES).await?;
    let request: RtcNegotiationRequest =
        serde_json::from_slice(&body).context("invalid RTC negotiation request")?;
    if request.sdp.is_empty() || request.sdp.len() > RTC_SIGNAL_BYTES {
        anyhow::bail!("invalid RTC offer size");
    }
    let slot = slots()
        .clone()
        .try_acquire_owned()
        .map_err(|_| anyhow!("RTC peer limit reached"))?;

    let capability_id = format!("rtc_{}", crate::devices::random_token());
    let secret = crate::devices::random_token();
    let admission = Admission::Rtc {
        capability_id: capability_id.clone(),
        secret: secret.clone(),
        expires_at: Instant::now() + RTC_ADMISSION_LIFETIME,
    };

    let session = Session::accept(
        &request.sdp,
        &Config {
            ice_servers: vec![STUN_SERVER.to_string()],
            channel_label: DATA_CHANNEL_LABEL.to_string(),
            gather_timeout: RTC_GATHER_TIMEOUT,
            max_message_bytes: genehub_proto::MAX_DATA_FRAME_BYTES,
            queue_depth: RTC_CHANNEL_QUEUE,
        },
    )?;
    // A little longer than the shell's own gathering timeout, so the answer
    // that timeout produces is still collected rather than raced away.
    let sdp = session
        .answer(RTC_GATHER_TIMEOUT + RTC_HELLO_TIMEOUT)
        .await?;

    let state = services.state.clone();
    let inherited = services.access.clone();
    tokio::spawn(async move {
        if let Err(error) = serve(session, slot, state, inherited, admission).await {
            tracing::debug!(%error, "RTC data channel stopped");
        }
    });

    let response = serde_json::to_vec(&RtcNegotiationResponse {
        sdp,
        capability_id,
        secret,
    })?;
    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::Value::Null,
            body_length: Some(response.len() as u64),
            error: None,
        })
        .await?;
    stream.write(&response).await?;
    stream.finish().await
}

/// Waits out the peer's hello, then carries records until either side stops.
///
/// Holding the session and the slot for the whole of it is what bounds an
/// unproven peer: a channel that never opens, or opens and says nothing, ends
/// at the hello timeout, and dropping the session there is what hangs up.
async fn serve(
    session: Session,
    _slot: OwnedSemaphorePermit,
    state: crate::state::Shared,
    inherited: PeerAccess,
    admission: Admission,
) -> Result<()> {
    let hello = tokio::time::timeout(RTC_HELLO_TIMEOUT, session.next())
        .await
        .map_err(|_| anyhow!("RTC peer hello timed out"))?
        .ok_or_else(|| anyhow!("RTC data channel closed before hello"))?;

    let mut accepted = handshake::accept(
        &state,
        TransportKind::Forwarded,
        admission,
        &hello,
        inherited.workspace_id.clone(),
        inherited.workspace_handle.clone(),
    )?;
    // The short-lived RTC secret is a transport upgrade, not new authority.
    // Preserve the authenticated base peer's device and workspace scope.
    accepted.access = PeerAccess {
        transport: TransportKind::Forwarded,
        ..inherited
    };
    session.send(&serde_json::to_vec(&accepted.welcome)?)?;

    let (inbound, outbound, carrier) = endpoint::carrier_channels();
    let mut endpoint = tokio::spawn(endpoint::serve(
        state,
        accepted.key,
        accepted.access,
        carrier,
        endpoint::CarrierKind::Rtc,
    ));
    let carried = carry(&session, inbound, outbound);
    tokio::select! {
        result = &mut endpoint => result.context("RTC endpoint task stopped")??,
        result = carried => result?,
    }
    endpoint.abort();
    Ok(())
}

/// Moves records between the channel and the endpoint until one of them ends.
///
/// One task rather than a reader and a writer, because the channel is polled
/// rather than awaited: two tasks would be two timers waiting on the same
/// connection. While records are moving it does not wait at all; it only backs
/// off once both directions are quiet.
async fn carry(
    session: &Session,
    inbound: tokio::sync::mpsc::Sender<Vec<u8>>,
    mut outbound: tokio::sync::mpsc::Receiver<Vec<u8>>,
) -> Result<()> {
    loop {
        let mut moved = false;
        while let Some(record) = session.receive() {
            moved = true;
            if inbound.send(record).await.is_err() {
                return Ok(());
            }
        }
        loop {
            match outbound.try_recv() {
                Ok(record) => {
                    moved = true;
                    session.send(&record)?;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => return Ok(()),
            }
        }
        if session.state() == State::Closed {
            return Ok(());
        }
        if moved {
            crate::blocking::breathe().await;
        } else {
            genet_wasi::poll::idle().await;
        }
    }
}
