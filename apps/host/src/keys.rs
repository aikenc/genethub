use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{SigningKey, VerifyingKey};

use crate::channel;

const DEVELOPMENT_KEY_ID: &str = "dev-local";
const DEVELOPMENT_SEED: [u8; 32] = [7; 32];

/// Independent signing root for guest artifacts. Official/beta/alpha pin a
/// public key into this host binary; dev uses a fixed local seed.
pub fn trusted_key() -> Result<(String, VerifyingKey)> {
    if channel::CHANNEL == "dev" {
        return Ok((
            DEVELOPMENT_KEY_ID.to_string(),
            SigningKey::from_bytes(&DEVELOPMENT_SEED).verifying_key(),
        ));
    }
    let key_id = option_env!("GENEHUB_GUEST_WASM_KEY_ID")
        .filter(|value| !value.is_empty())
        .context("release build has no pinned guest Wasm key id")?;
    let encoded = option_env!("GENEHUB_GUEST_WASM_PUBLIC_KEY")
        .filter(|value| !value.is_empty())
        .context("release build has no pinned guest Wasm public key")?;
    let bytes = STANDARD_NO_PAD
        .decode(encoded)
        .context("decoding pinned guest Wasm public key")?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow!("guest Wasm public key must be 32 bytes"))?;
    let key = VerifyingKey::from_bytes(&bytes).context("reading guest Wasm public key")?;
    Ok((key_id.to_string(), key))
}

pub fn development_signing_key() -> SigningKey {
    SigningKey::from_bytes(&DEVELOPMENT_SEED)
}

pub fn development_key_id() -> &'static str {
    DEVELOPMENT_KEY_ID
}
