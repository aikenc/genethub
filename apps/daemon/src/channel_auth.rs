//! End-to-end authenticity for control channels carried by an untrusted Relay.
//!
//! Relay is allowed to observe routing metadata, delay bytes and drop a
//! connection. It is never allowed to manufacture a request, result or event.
//! A fresh two-nonce transcript derives a different key for every connection;
//! strict per-direction sequence numbers then make recorded frames unusable.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const HANDSHAKE_DOMAIN: &[u8] = b"genehub-channel-handshake-v1";
const KEY_DOMAIN: &[u8] = b"genehub-channel-key-v1";
const FRAME_DOMAIN: &[u8] = b"genehub-channel-frame-v1";

#[derive(Debug, Clone)]
pub struct SessionKey {
    mac_key: [u8; 32],
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
    let mac_key = authenticate_bytes(
        secret.as_bytes(),
        KEY_DOMAIN,
        &[
            b"authentication",
            context.as_bytes(),
            client_nonce.as_bytes(),
            server_nonce.as_bytes(),
        ],
    );
    SessionKey {
        mac_key,
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

pub fn frame_mac(
    key: &SessionKey,
    direction: Direction,
    sequence: u64,
    ciphertext: &str,
) -> String {
    authenticate(
        &key.mac_key,
        FRAME_DOMAIN,
        &[
            &genehub_proto::PROTOCOL_VERSION.to_be_bytes(),
            key.context.as_bytes(),
            direction.label(),
            &sequence.to_be_bytes(),
            ciphertext.as_bytes(),
        ],
    )
}

pub fn seal_frame(
    key: &SessionKey,
    direction: Direction,
    sequence: u64,
    plaintext: &str,
) -> Result<(String, String)> {
    let cipher = Aes256Gcm::new_from_slice(&key.encryption_key)
        .map_err(|_| anyhow!("invalid channel encryption key"))?;
    let aad = associated_data(key, direction, sequence);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce(direction, sequence)),
            Payload {
                msg: plaintext.as_bytes(),
                aad: &aad,
            },
        )
        .map_err(|_| anyhow!("channel encryption failed"))?;
    let ciphertext = URL_SAFE_NO_PAD.encode(ciphertext);
    let mac = frame_mac(key, direction, sequence, &ciphertext);
    Ok((ciphertext, mac))
}

pub fn open_frame(
    key: &SessionKey,
    direction: Direction,
    sequence: u64,
    ciphertext: &str,
    presented: &str,
) -> Result<String> {
    let expected = frame_mac(key, direction, sequence, ciphertext);
    if !constant_time_hex_eq(&expected, presented) {
        return Err(anyhow!("channel message authentication failed"));
    }
    let ciphertext = URL_SAFE_NO_PAD
        .decode(ciphertext)
        .map_err(|_| anyhow!("channel ciphertext is not valid base64url"))?;
    let cipher = Aes256Gcm::new_from_slice(&key.encryption_key)
        .map_err(|_| anyhow!("invalid channel encryption key"))?;
    let aad = associated_data(key, direction, sequence);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce(direction, sequence)),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| anyhow!("channel ciphertext authentication failed"))?;
    String::from_utf8(plaintext).map_err(|_| anyhow!("channel plaintext is not UTF-8"))
}

fn nonce(direction: Direction, sequence: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..4].copy_from_slice(match direction {
        Direction::ClientToDaemon => b"GHCD",
        Direction::DaemonToClient => b"GHDC",
    });
    nonce[4..].copy_from_slice(&sequence.to_be_bytes());
    nonce
}

fn associated_data(key: &SessionKey, direction: Direction, sequence: u64) -> Vec<u8> {
    let mut aad = Vec::new();
    append_field(&mut aad, FRAME_DOMAIN);
    append_field(&mut aad, &genehub_proto::PROTOCOL_VERSION.to_be_bytes());
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
    const VECTOR_PLAINTEXT: &str = r#"{"id":"vector","type":"connection.identity"}"#;

    #[test]
    fn channel_and_direction_are_part_of_every_mac() {
        let one = derive_key("secret", "hosted:one", "client", "server");
        let other = derive_key("secret", "hosted:other", "client", "server");
        let (ciphertext, mac) = seal_frame(&one, Direction::ClientToDaemon, 1, "payload").unwrap();
        assert_eq!(
            open_frame(&one, Direction::ClientToDaemon, 1, &ciphertext, &mac).unwrap(),
            "payload"
        );
        assert!(open_frame(&one, Direction::DaemonToClient, 1, &ciphertext, &mac).is_err());
        assert!(open_frame(&other, Direction::ClientToDaemon, 1, &ciphertext, &mac).is_err());
        assert!(open_frame(&one, Direction::ClientToDaemon, 2, &ciphertext, &mac).is_err());
        assert!(open_frame(&one, Direction::ClientToDaemon, 1, "changed", &mac).is_err());
    }

    /// Mirrored byte-for-byte in packages/web/src/devices/proof.test.ts.
    ///
    /// Round trips inside either implementation cannot detect a length prefix,
    /// protocol version, nonce layout or AAD field drifting on only one side.
    #[test]
    fn matches_the_web_channel_v2_golden_vectors() {
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
            hex(&key.mac_key),
            "71c25c4fdb1e9bb99d16a847a5c374e71024e40cddea2b9c6a45d7df125d4a7a"
        );
        assert_eq!(
            hex(&key.encryption_key),
            "ff8270f2ec546267347aaccd0178af62830df51be490248c916969f6ac43a550"
        );

        for (direction, expected_body, expected_mac) in [
            (
                Direction::ClientToDaemon,
                "mQ-ImSzrzMxYwp4U9arFZahyEjdPYdDAZ0fdvD0JbtoauaBNRGISBpoJWVMNNACBOMagpAVdy9Tft2yk",
                "d3011fb60bb148fc93edef330ce2b92cf6829ce31d5e72a7712157d5ad520633",
            ),
            (
                Direction::DaemonToClient,
                "ZockPFxM1fAFyOyk90K1zciLolBzZaASZncJirI8Wc6bsVHvyeUTszofYf7tFkiFKbSeyyVjb0EtbKz1",
                "4a2ab0f8cbe9651d20bd4a248b5a4eaa6626e6e509983ecefe900bfa5dfccb5a",
            ),
        ] {
            let (body, mac) = seal_frame(&key, direction, 7, VECTOR_PLAINTEXT).unwrap();
            assert_eq!(body, expected_body);
            assert_eq!(mac, expected_mac);
            assert_eq!(
                open_frame(&key, direction, 7, expected_body, expected_mac).unwrap(),
                VECTOR_PLAINTEXT,
            );
        }
    }
}
