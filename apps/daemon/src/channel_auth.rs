//! End-to-end authenticity for control channels carried by an untrusted Relay.
//!
//! Relay is allowed to observe routing metadata, delay bytes and drop a
//! connection. It is never allowed to manufacture a request, result or event.
//! A fresh two-nonce transcript derives a different key for every connection;
//! strict per-direction sequence numbers then make recorded frames unusable.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Result};
use hmac::{Hmac, Mac};
use sha2::Sha256;

const HANDSHAKE_DOMAIN: &[u8] = b"genehub-channel-handshake-v1";
const KEY_DOMAIN: &[u8] = b"genehub-channel-key-v1";
const DATA_RECORD_DOMAIN: &[u8] = b"genehub-data-record-v1";
const DATA_RECORD_MAGIC: [u8; 2] = *b"GH";
const DATA_RECORD_HEADER_BYTES: usize = 12;

#[derive(Debug, Clone)]
pub struct SessionKey {
    encryption_key: [u8; 32],
    context: String,
}

#[derive(Debug, Clone, Copy)]
pub enum Direction {
    ClientToDaemon,
    DaemonToClient,
}

impl Direction {
    fn label(self) -> &'static [u8] {
        match self {
            Self::ClientToDaemon => b"client-to-daemon",
            Self::DaemonToClient => b"daemon-to-client",
        }
    }
}

pub fn device_context(device_id: &str) -> String {
    format!("device:{device_id}")
}

pub fn hosted_context(capability_id: &str) -> String {
    format!("hosted:{capability_id}")
}

pub fn client_proof(secret: &str, context: &str, client_nonce: &str) -> String {
    authenticate(
        secret.as_bytes(),
        HANDSHAKE_DOMAIN,
        &[b"client", context.as_bytes(), client_nonce.as_bytes()],
    )
}

pub fn server_proof(secret: &str, context: &str, client_nonce: &str, server_nonce: &str) -> String {
    authenticate(
        secret.as_bytes(),
        HANDSHAKE_DOMAIN,
        &[
            b"server",
            context.as_bytes(),
            client_nonce.as_bytes(),
            server_nonce.as_bytes(),
        ],
    )
}

pub fn derive_key(
    secret: &str,
    context: &str,
    client_nonce: &str,
    server_nonce: &str,
) -> SessionKey {
    SessionKey {
        encryption_key: authenticate_bytes(
            secret.as_bytes(),
            KEY_DOMAIN,
            &[
                b"encryption",
                context.as_bytes(),
                client_nonce.as_bytes(),
                server_nonce.as_bytes(),
            ],
        ),
        context: context.to_string(),
    }
}

/// One bounded binary AEAD record used by every protocol-v3 carrier.
pub fn seal_data_record(
    key: &SessionKey,
    direction: Direction,
    sequence: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    if sequence == 0
        || plaintext.len() + DATA_RECORD_HEADER_BYTES + 16 > genehub_proto::MAX_DATA_FRAME_BYTES
    {
        return Err(anyhow!("invalid secure data record size or sequence"));
    }
    let cipher = Aes256Gcm::new_from_slice(&key.encryption_key)
        .map_err(|_| anyhow!("invalid channel encryption key"))?;
    let aad = data_record_associated_data(key, direction, sequence);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&data_record_nonce(direction, sequence)),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| anyhow!("data record encryption failed"))?;
    let mut wire = Vec::with_capacity(DATA_RECORD_HEADER_BYTES + ciphertext.len());
    wire.extend_from_slice(&DATA_RECORD_MAGIC);
    wire.push(genehub_proto::DATA_PLANE_VERSION as u8);
    wire.push(0);
    wire.extend_from_slice(&sequence.to_be_bytes());
    wire.extend_from_slice(&ciphertext);
    Ok(wire)
}

pub fn open_data_record(
    key: &SessionKey,
    direction: Direction,
    expected_sequence: u64,
    wire: &[u8],
) -> Result<Vec<u8>> {
    if expected_sequence == 0
        || wire.len() < DATA_RECORD_HEADER_BYTES + 16
        || wire.len() > genehub_proto::MAX_DATA_FRAME_BYTES
        || wire[..2] != DATA_RECORD_MAGIC
        || wire[2] != genehub_proto::DATA_PLANE_VERSION as u8
        || wire[3] != 0
        || u64::from_be_bytes(wire[4..12].try_into().unwrap()) != expected_sequence
    {
        return Err(anyhow!("invalid secure data record header"));
    }
    let cipher = Aes256Gcm::new_from_slice(&key.encryption_key)
        .map_err(|_| anyhow!("invalid channel encryption key"))?;
    let aad = data_record_associated_data(key, direction, expected_sequence);
    cipher
        .decrypt(
            Nonce::from_slice(&data_record_nonce(direction, expected_sequence)),
            Payload {
                msg: &wire[DATA_RECORD_HEADER_BYTES..],
                aad: &aad,
            },
        )
        .map_err(|_| anyhow!("data record authentication failed"))
}

fn data_record_nonce(direction: Direction, sequence: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..4].copy_from_slice(match direction {
        Direction::ClientToDaemon => b"G3CD",
        Direction::DaemonToClient => b"G3DC",
    });
    nonce[4..].copy_from_slice(&sequence.to_be_bytes());
    nonce
}

fn data_record_associated_data(key: &SessionKey, direction: Direction, sequence: u64) -> Vec<u8> {
    let mut aad = Vec::new();
    append_field(&mut aad, DATA_RECORD_DOMAIN);
    append_field(&mut aad, &genehub_proto::DATA_PLANE_VERSION.to_be_bytes());
    append_field(&mut aad, key.context.as_bytes());
    append_field(&mut aad, direction.label());
    append_field(&mut aad, &sequence.to_be_bytes());
    aad
}

fn append_field(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(&(value.len() as u64).to_be_bytes());
    output.extend_from_slice(value);
}

pub fn verify_proof(expected: &str, presented: &str) -> Result<()> {
    if !constant_time_hex_eq(expected, presented) {
        return Err(anyhow!("channel handshake authentication failed"));
    }
    Ok(())
}

fn authenticate(key: &[u8], domain: &[u8], fields: &[&[u8]]) -> String {
    hex(&authenticate_bytes(key, domain, fields))
}

fn authenticate_bytes(key: &[u8], domain: &[u8], fields: &[&[u8]]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    field(&mut mac, domain);
    for value in fields {
        field(&mut mac, value);
    }
    mac.finalize().into_bytes().into()
}

fn field(mac: &mut Hmac<Sha256>, value: &[u8]) {
    mac.update(&(value.len() as u64).to_be_bytes());
    mac.update(value);
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_hex_eq(expected: &str, presented: &str) -> bool {
    if expected.len() != presented.len() {
        return false;
    }
    expected
        .bytes()
        .zip(presented.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTOR_SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const VECTOR_CONTEXT: &str = "hosted:cap_golden";
    const VECTOR_CLIENT_NONCE: &str = "00112233445566778899aabbccddeeff";
    const VECTOR_SERVER_NONCE: &str = "ffeeddccbbaa99887766554433221100";

    #[test]
    fn binary_data_records_are_bounded_authenticated_and_sequenced() {
        let key = derive_key("secret", "hosted:one", "client", "server");
        let wire = seal_data_record(&key, Direction::DaemonToClient, 1, b"binary\0body").unwrap();
        assert_eq!(
            open_data_record(&key, Direction::DaemonToClient, 1, &wire).unwrap(),
            b"binary\0body"
        );
        assert!(open_data_record(&key, Direction::ClientToDaemon, 1, &wire).is_err());
        assert!(open_data_record(&key, Direction::DaemonToClient, 2, &wire).is_err());
    }

    /// Mirrored byte-for-byte in packages/web/src/devices/proof.test.ts.
    ///
    /// Round trips inside either implementation cannot detect a length prefix,
    /// protocol version, nonce layout or AAD field drifting on only one side.
    #[test]
    fn matches_the_web_protocol_v3_handshake_and_key_vectors() {
        assert_eq!(
            client_proof(VECTOR_SECRET, VECTOR_CONTEXT, VECTOR_CLIENT_NONCE),
            "2a0958501e684eb33817ddca6c2346e3a5f0d683b2c821666c0b045a5afe801b"
        );
        assert_eq!(
            server_proof(
                VECTOR_SECRET,
                VECTOR_CONTEXT,
                VECTOR_CLIENT_NONCE,
                VECTOR_SERVER_NONCE,
            ),
            "6e7af7a542b0ed092aa7017984d91e81d80c904663fa669945ef36fe042c3094"
        );

        let key = derive_key(
            VECTOR_SECRET,
            VECTOR_CONTEXT,
            VECTOR_CLIENT_NONCE,
            VECTOR_SERVER_NONCE,
        );
        assert_eq!(
            hex(&key.encryption_key),
            "ff8270f2ec546267347aaccd0178af62830df51be490248c916969f6ac43a550"
        );
        assert_eq!(
            hex(&seal_data_record(&key, Direction::ClientToDaemon, 7, b"binary\0body",).unwrap(),),
            "47480300000000000000000778bfb3552d1c1a17eac4131325b976445893ce649d9c4361da402a"
        );
    }
}
