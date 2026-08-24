//! Offline release tooling for the signed client component.
//!
//! These commands deliberately live in the host crate so the producer and
//! consumer share the exact envelope parser and the exact WIT ABI digest.
//! They do not contact a release service or mutate the local activation store.

use std::path::Path;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;

use crate::artifact::{ArtifactEnvelope, SignedArtifact};
use crate::version::ProductVersion;
use crate::{abi, channel, keys};

pub const SIGNING_KEY_ENV: &str = "GENEHUB_COMPONENT_SIGNING_KEY";

pub fn run(arguments: &[String]) -> Result<(), String> {
    match arguments {
        [command, input, output, artifact_channel, version, key_id] if command == "pack" => {
            let encoded = std::env::var(SIGNING_KEY_ENV).map_err(|_| {
                format!("{SIGNING_KEY_ENV} must contain a base64-no-pad 32-byte Ed25519 seed")
            })?;
            let key = parse_signing_key(&encoded)?;
            pack(
                input,
                output,
                artifact_channel,
                parse_release_version(version)?,
                key_id,
                &key,
            )
        }
        [command, input, output, version] if command == "pack-dev" => pack(
            input,
            output,
            "dev",
            parse_release_version(version)?,
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
            "usage:\n  genehub-host pack <raw.wasm> <signed.wasm> <channel> <release-version> <key-id>\n  genehub-host pack-dev <raw.wasm> <signed.wasm> <release-version>\n  genehub-host inspect <signed.wasm>\n  genehub-host public-key\n  genehub-host dev-public-key\n\npack/public-key read the secret seed from {SIGNING_KEY_ENV}; pack-dev is never for a release"
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
            "releaseVersion": envelope.release_version(),
            "appAbiHash": envelope.app_abi_hash(),
            "webProtocol": envelope.web_protocol(),
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
    version: ProductVersion,
    key_id: &str,
    key: &SigningKey,
) -> Result<(), String> {
    let component = std::fs::read(input.as_ref())
        .map_err(|error| format!("reading {}: {error}", input.as_ref().display()))?;
    let envelope = ArtifactEnvelope::unsigned(
        channel::MODULE_ID,
        artifact_channel,
        version.to_string(),
        abi::hex_digest(&abi::host_digest()),
        genehub_proto::WEB_PROTOCOL_VERSION,
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

fn parse_release_version(value: &str) -> Result<ProductVersion, String> {
    ProductVersion::parse(value)
        .map_err(|_| "release version must be a canonical Product Version".to_string())
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
    fn release_versions_are_canonical() {
        assert_eq!(parse_release_version("0.1.2").unwrap().to_string(), "0.1.2");
        assert!(parse_release_version("0.2.0-beta.1").is_ok());
        for value in ["0", "1.2", "01.2.3", "+1", "-1", "1 ", "x"] {
            assert!(parse_release_version(value).is_err(), "accepted {value:?}");
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
