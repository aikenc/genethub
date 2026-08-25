use ed25519_dalek::{SigningKey, VerifyingKey};

const DEVELOPMENT_KEY_ID: &str = "dev-local";
const DEVELOPMENT_SEED: [u8; 32] = [7; 32];

/// One self-contained signing root for every channel. External key management
/// was removed on purpose; the stable line reintroduces it here when it
/// graduates.
pub fn trusted_key() -> Result<(String, VerifyingKey), anyhow::Error> {
    Ok((
        DEVELOPMENT_KEY_ID.to_string(),
        SigningKey::from_bytes(&DEVELOPMENT_SEED).verifying_key(),
    ))
}

pub fn development_signing_key() -> SigningKey {
    SigningKey::from_bytes(&DEVELOPMENT_SEED)
}

pub fn development_key_id() -> &'static str {
    DEVELOPMENT_KEY_ID
}
