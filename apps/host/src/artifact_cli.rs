//! Offline release tooling for the signed guest component.
//!
//! These commands deliberately live in the host crate so the producer and
//! consumer share the exact envelope parser. They do not contact a release
//! service or mutate the local activation store.

use std::path::Path;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;

use crate::artifact::{ArtifactEnvelope, SignedArtifact};
use crate::{channel, keys};

pub const SIGNING_KEY_ENV: &str = "GENEHUB_GUEST_WASM_SIGNING_KEY";

pub fn run(arguments: &[String]) -> Result<(), String> {
    match arguments {
        [command, input, output, artifact_channel, revision, key_id] if command == "pack" => {
            let encoded = std::env::var(SIGNING_KEY_ENV).map_err(|_| {
                format!("{SIGNING_KEY_ENV} must contain a base64-no-pad 32-byte Ed25519 seed")
            })?;
            let key = parse_signing_key(&encoded)?;
            pack(
                input,
                output,
                artifact_channel,
                parse_revision(revision)?,
                key_id,
                &key,
            )
        }
        [command, input, output, revision] if command == "pack-dev" => pack(
            input,
            output,
            "dev",
            parse_revision(revision)?,
            keys::development_key_id(),
            &keys::development_signing_key(),
        ),
        [command] if command == "dev-public-key" => {
            println!(
                "{}",
                STANDARD_NO_PAD.encode(keys::development_signing_key().verifying_key().to_bytes())
            );
            Ok(())
        }
        [command] if command == "public-key" => {
            let encoded = std::env::var(SIGNING_KEY_ENV).map_err(|_| {
                format!("{SIGNING_KEY_ENV} must contain a base64-no-pad 32-byte Ed25519 seed")
            })?;
            println!(
                "{}",
                STANDARD_NO_PAD.encode(parse_signing_key(&encoded)?.verifying_key().to_bytes())
            );
            Ok(())
        }
        [command, input] if command == "inspect" => inspect(input),
        _ => Err(format!(
            "usage:\n  genehub-host pack <raw.wasm> <signed.wasm> <channel> <logic-revision> <key-id>\n  genehub-host pack-dev <raw.wasm> <signed.wasm> <logic-revision>\n  genehub-host inspect <signed.wasm>\n  genehub-host public-key\n  genehub-host dev-public-key\n\npack/public-key read the secret seed from {SIGNING_KEY_ENV}; pack-dev is never for a release"
        )),
    }
}

fn inspect(input: impl AsRef<Path>) -> Result<(), String> {
    let file = std::fs::read(input.as_ref())
        .map_err(|error| format!("reading {}: {error}", input.as_ref().display()))?;
    let artifact = SignedArtifact::from_single_file(&file).map_err(|error| error.to_string())?;
    let envelope = artifact.envelope;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "moduleId": envelope.module_id(),
            "channel": envelope.channel(),
            "logicRevision": envelope.logic_revision(),
            "platformAbi": envelope.platform_abi(),
            "protocolVersion": envelope.protocol_version(),
            "componentSha256": envelope.sha256(),
            "componentSize": envelope.size(),
            "keyId": envelope.key_id(),
            "signedFileSize": file.len(),
        }))
        .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn pack(
    input: impl AsRef<Path>,
    output: impl AsRef<Path>,
    artifact_channel: &str,
    revision: u64,
    key_id: &str,
    key: &SigningKey,
) -> Result<(), String> {
    let component = std::fs::read(input.as_ref())
        .map_err(|error| format!("reading {}: {error}", input.as_ref().display()))?;
    let envelope = ArtifactEnvelope::unsigned(
        channel::MODULE_ID,
        artifact_channel,
        revision,
        channel::HOST_ABI,
        genehub_proto::PROTOCOL_VERSION,
        key_id,
        &component,
    )
    .map_err(|error| error.to_string())?;
    let signature = key.sign(
        &envelope
            .signing_payload()
            .map_err(|error| error.to_string())?,
    );
    let file = SignedArtifact::new(envelope.with_signature(&signature), component)
        .to_single_file()
        .map_err(|error| error.to_string())?;
    std::fs::write(output.as_ref(), file)
        .map_err(|error| format!("writing {}: {error}", output.as_ref().display()))
}

fn parse_revision(value: &str) -> Result<u64, String> {
    let revision = value
        .parse::<u64>()
        .map_err(|_| "logic revision must be a positive decimal integer".to_string())?;
    if revision == 0 || revision.to_string() != value {
        return Err("logic revision must be a canonical positive decimal integer".to_string());
    }
    Ok(revision)
}

fn parse_signing_key(encoded: &str) -> Result<SigningKey, String> {
    let bytes = STANDARD_NO_PAD
        .decode(encoded.trim())
        .map_err(|_| format!("{SIGNING_KEY_ENV} is not canonical base64-no-pad"))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| format!("{SIGNING_KEY_ENV} must decode to exactly 32 bytes"))?;
    Ok(SigningKey::from_bytes(&seed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_are_canonical_and_positive() {
        assert_eq!(parse_revision("42").unwrap(), 42);
        for value in ["0", "01", "+1", "-1", "1 ", "x"] {
            assert!(parse_revision(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn signing_seeds_have_one_canonical_size() {
        let encoded = STANDARD_NO_PAD.encode([9_u8; 32]);
        assert_eq!(parse_signing_key(&encoded).unwrap().to_bytes(), [9_u8; 32]);
        assert!(parse_signing_key("not base64").is_err());
        assert!(parse_signing_key(&STANDARD_NO_PAD.encode([9_u8; 31])).is_err());
    }
}
