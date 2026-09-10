//! A physical, already-authenticated record channel. Logical stream tables and
//! peer services deliberately live outside these halves. New handshakes create
//! new halves with new keys; record counters cannot be reset or cloned.

use anyhow::{anyhow, Result};
use tokio::sync::mpsc;

use crate::channel_auth::{self, Direction, SessionKey};

const CARRIER_QUEUE: usize = 16;

/// Bounded, message-preserving encrypted record transport.
pub struct Carrier {
    pub inbound: mpsc::Receiver<Vec<u8>>,
    pub outbound: mpsc::Sender<Vec<u8>>,
}

pub fn carrier_channels() -> (mpsc::Sender<Vec<u8>>, mpsc::Receiver<Vec<u8>>, Carrier) {
    let (inbound_tx, inbound) = mpsc::channel(CARRIER_QUEUE);
    let (outbound, outbound_rx) = mpsc::channel(CARRIER_QUEUE);
    (inbound_tx, outbound_rx, Carrier { inbound, outbound })
}

pub(crate) enum Role {
    Client,
    Server,
}

pub(crate) struct AuthenticatedReader {
    inbound: mpsc::Receiver<Vec<u8>>,
    key: SessionKey,
    direction: Direction,
    sequence: u64,
    closed: bool,
}

pub(crate) struct AuthenticatedWriter {
    outbound: mpsc::Sender<Vec<u8>>,
    key: SessionKey,
    direction: Direction,
    sequence: u64,
    closed: bool,
}

pub(crate) fn authenticated_channel(
    key: SessionKey,
    carrier: Carrier,
    role: Role,
) -> (AuthenticatedReader, AuthenticatedWriter) {
    let (inbound, outbound) = match role {
        Role::Client => (Direction::DaemonToClient, Direction::ClientToDaemon),
        Role::Server => (Direction::ClientToDaemon, Direction::DaemonToClient),
    };
    (
        AuthenticatedReader {
            inbound: carrier.inbound,
            key: key.clone(),
            direction: inbound,
            sequence: 0,
            closed: false,
        },
        AuthenticatedWriter {
            outbound: carrier.outbound,
            key,
            direction: outbound,
            sequence: 0,
            closed: false,
        },
    )
}

impl AuthenticatedReader {
    /// Cancellation-safe at select!: the only await precedes record custody.
    /// Authentication failure is terminal for this channel, never a skipped seq.
    pub(crate) async fn receive(&mut self) -> Result<Option<Vec<u8>>> {
        if self.closed {
            return Ok(None);
        }
        let Some(record) = self.inbound.recv().await else {
            self.closed = true;
            return Ok(None);
        };
        let result = (|| {
            self.sequence = self
                .sequence
                .checked_add(1)
                .ok_or_else(|| anyhow!("secure record sequence exhausted"))?;
            channel_auth::open_data_record(&self.key, self.direction, self.sequence, &record)
        })();
        if result.is_err() {
            self.closed = true;
            self.inbound.close();
        }
        result.map(Some)
    }
}

impl AuthenticatedWriter {
    /// Reserve carrier capacity before allocating a nonce. Cancellation while
    /// waiting cannot consume a record sequence and leave an unfillable gap.
    pub(crate) async fn send(&mut self, plaintext: &[u8]) -> Result<()> {
        if self.closed {
            anyhow::bail!("authenticated channel writer is closed");
        }
        let permit = match self.outbound.reserve().await {
            Ok(permit) => permit,
            Err(_) => {
                self.closed = true;
                anyhow::bail!("peer carrier closed");
            }
        };
        let result = (|| {
            self.sequence = self
                .sequence
                .checked_add(1)
                .ok_or_else(|| anyhow!("secure record sequence exhausted"))?;
            channel_auth::seal_data_record(&self.key, self.direction, self.sequence, plaintext)
        })();
        match result {
            Ok(record) => {
                permit.send(record);
                Ok(())
            }
            Err(error) => {
                self.closed = true;
                Err(error)
            }
        }
    }
}

// Native-intrinsic: cancellation of a borrowed Tokio reservation and nonce
// allocation order cannot be observed through the product's JS RPC boundary.
#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    fn key() -> SessionKey {
        channel_auth::derive_key("test-secret", "loopback", "client-nonce", "server-nonce")
    }

    #[tokio::test]
    async fn cancelled_capacity_wait_does_not_consume_a_nonce() {
        let (_inbound, mut outbound, carrier) = carrier_channels();
        let session = key();
        let (_reader, mut writer) = authenticated_channel(session.clone(), carrier, Role::Client);
        for _ in 0..CARRIER_QUEUE {
            writer.send(&[1]).await.unwrap();
        }
        assert!(writer.send(&[2]).now_or_never().is_none());
        let first = outbound.recv().await.unwrap();
        assert_eq!(
            channel_auth::open_data_record(&session, Direction::ClientToDaemon, 1, &first).unwrap(),
            [1]
        );
        writer.send(&[3]).await.unwrap();
        for seq in 2..=CARRIER_QUEUE + 1 {
            let record = outbound.recv().await.unwrap();
            let plaintext = channel_auth::open_data_record(
                &session,
                Direction::ClientToDaemon,
                seq as u64,
                &record,
            )
            .unwrap();
            assert_eq!(
                plaintext,
                if seq == CARRIER_QUEUE + 1 {
                    vec![3]
                } else {
                    vec![1]
                }
            );
        }
    }

    #[tokio::test]
    async fn cancelled_read_does_not_consume_a_nonce_and_replay_is_terminal() {
        let (inbound, _outbound, carrier) = carrier_channels();
        let session = key();
        let (mut reader, _writer) = authenticated_channel(session.clone(), carrier, Role::Server);
        assert!(reader.receive().now_or_never().is_none());
        let wire =
            channel_auth::seal_data_record(&session, Direction::ClientToDaemon, 1, &[9]).unwrap();
        inbound.send(wire.clone()).await.unwrap();
        assert_eq!(reader.receive().await.unwrap(), Some(vec![9]));
        inbound.send(wire).await.unwrap();
        assert!(reader.receive().await.is_err());
        assert!(reader.receive().await.unwrap().is_none());
        assert!(inbound.send(vec![0]).await.is_err());
    }
}
